// Finding PrusaSlicer, OrcaSlicer and Bambu Studio on any Linux: PATH, apt, /opt, AppImages,
// Flatpak, custom paths, and how each runs headless. Fake file system + fake exec only.
import { describe, expect, it } from "vitest";
import { commandFor, detectAll, hintFor, parseSlicerVersion, SLICERS, versionAtLeast } from "@morphix/slicing";
import { fakeExec, fakeFs } from "./slicers-helpers";

const HOME = "/home/pi";
const env = (extra: Record<string, string> = {}) => ({ PATH: "/usr/local/bin:/usr/bin", HOME, ...extra });

describe("detection on $PATH", () => {
  it.each([
    ["prusaslicer", "/usr/bin/prusa-slicer"],
    ["prusaslicer", "/usr/local/bin/PrusaSlicer"],
    ["orcaslicer", "/usr/bin/orca-slicer"],
    ["orcaslicer", "/usr/local/bin/OrcaSlicer"],
    ["bambustudio", "/usr/bin/bambu-studio"],
    ["bambustudio", "/usr/local/bin/BambuStudio"],
  ] as const)("%s at %s", async (id, path) => {
    const { exec } = fakeExec();
    const s = await SLICERS[id].detect({ env: env({ DISPLAY: ":0" }), fs: fakeFs({ exec: [path] }), exec, skipVersion: true });
    expect(s).toMatchObject({ id, path, via: "path", version: null });
    expect(s?.baseArgs).toBeUndefined();
  });

  it("tells an apt install apart and reads the version from --help", async () => {
    const { exec, calls } = fakeExec({ banner: "PrusaSlicer-2.5.0+linux-armv7l-GTK3 based on Slic3r" });
    const s = await SLICERS.prusaslicer.detect({ env: env(), fs: fakeFs({ exec: ["/usr/bin/prusa-slicer"], other: ["/var/lib/dpkg/info/prusa-slicer.list"] }), exec });
    expect(s).toMatchObject({ via: "apt", version: "2.5.0+linux-armv7l-GTK3" });
    expect(calls).toEqual([{ file: "/usr/bin/prusa-slicer", args: ["--help"] }]);
  });

  it("finds installs under /opt", async () => {
    const s = await SLICERS.orcaslicer.detect({ env: env({ DISPLAY: ":0" }), fs: fakeFs({ exec: ["/opt/OrcaSlicer/bin/orca-slicer"] }), skipVersion: true });
    expect(s).toMatchObject({ path: "/opt/OrcaSlicer/bin/orca-slicer", via: "path" });
  });
});

describe("AppImages", () => {
  it("in ~/Applications, run directly when FUSE works", async () => {
    const app = `${HOME}/Applications/PrusaSlicer-2.9.2+linux-x64-GTK3.AppImage`;
    const s = await SLICERS.prusaslicer.detect({ env: env(), fs: fakeFs({ exec: [app, "/usr/bin/fusermount"], other: ["/dev/fuse"] }), skipVersion: true });
    expect(s).toMatchObject({ path: app, via: "appimage" });
    expect(s?.baseArgs).toBeUndefined();
  });

  it("without FUSE: --appimage-extract-and-run, and xvfb-run when there is no display", async () => {
    const app = `${HOME}/.local/bin/OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.3.0.AppImage`;
    const { exec, calls } = fakeExec({ banner: "OrcaSlicer-2.3.0: an advanced slicer" });
    const s = await SLICERS.orcaslicer.detect({ env: env(), fs: fakeFs({ exec: [app, "/usr/bin/xvfb-run"] }), exec });
    expect(s).toMatchObject({ path: "/usr/bin/xvfb-run", baseArgs: ["-a", app, "--appimage-extract-and-run"], via: "appimage", version: "2.3.0" });
    expect(s!.notes.join(" ")).toMatch(/FUSE.*xvfb-run/s);
    expect(calls[0]).toEqual({ file: "/usr/bin/xvfb-run", args: ["-a", app, "--appimage-extract-and-run", "--help"] });
  });

  it("in /opt, picking the highest version name", async () => {
    const fs = fakeFs({ exec: ["/opt/Bambu_Studio_linux_ubuntu-v01.09.07.52.AppImage", "/opt/Bambu_Studio_linux_ubuntu-v01.10.02.76.AppImage"], other: ["/dev/fuse"] });
    const s = await SLICERS.bambustudio.detect({ env: env({ WAYLAND_DISPLAY: "wayland-0" }), fs, skipVersion: true });
    expect(s?.path).toBe("/opt/Bambu_Studio_linux_ubuntu-v01.10.02.76.AppImage");
    expect(s?.baseArgs).toEqual(["--appimage-extract-and-run"]); // /dev/fuse but no fusermount
  });
});

describe("Flatpak", () => {
  const list = "com.prusa3d.PrusaSlicer\t2.9.2\nio.github.softfever.OrcaSlicer\t2.3.0\ncom.bambulab.BambuStudio\t01.10.02.76\n";
  it.each([
    ["prusaslicer", "com.prusa3d.PrusaSlicer", "2.9.2"],
    ["orcaslicer", "io.github.softfever.OrcaSlicer", "2.3.0"],
    ["bambustudio", "com.bambulab.BambuStudio", "01.10.02.76"],
  ] as const)("%s as %s via `flatpak run`", async (id, app, version) => {
    const { exec, calls } = fakeExec({ flatpakList: list });
    const s = await SLICERS[id].detect({ env: env({ DISPLAY: ":0" }), fs: fakeFs({ exec: ["/usr/bin/flatpak"] }), exec });
    expect(s).toMatchObject({ id, path: "/usr/bin/flatpak", baseArgs: ["run", app], version, via: "flatpak" });
    expect(calls).toEqual([{ file: "/usr/bin/flatpak", args: ["list", "--app", "--columns=application,version"] }]); // version from the list, no --help
  });

  it("is skipped when the app isn't installed or flatpak: false", async () => {
    const fs = fakeFs({ exec: ["/usr/bin/flatpak"] });
    expect(await SLICERS.orcaslicer.detect({ env: env(), fs, exec: fakeExec({ flatpakList: "org.gimp.GIMP\t2.10\n" }).exec })).toBeNull();
    expect(await SLICERS.prusaslicer.detect({ env: env(), fs, flatpak: false, exec: fakeExec({ flatpakList: "com.prusa3d.PrusaSlicer\t2.9.2\n" }).exec })).toBeNull();
  });

  it("gets the job folders through --filesystem when it slices", () => {
    const cmd = commandFor({ id: "orcaslicer", path: "/usr/bin/xvfb-run", baseArgs: ["-a", "/usr/bin/flatpak", "run", "io.github.softfever.OrcaSlicer"], version: null, via: "flatpak" }, ["--slice", "0"], ["/data/job", "/data/job", "/data/models"]);
    expect(cmd).toEqual({ file: "/usr/bin/xvfb-run", args: ["-a", "/usr/bin/flatpak", "run", "--filesystem=/data/job", "--filesystem=/data/models", "io.github.softfever.OrcaSlicer", "--slice", "0"] });
  });
});

describe("custom paths and overrides", () => {
  it("prefers the custom path, and falls back with a note when it is wrong", async () => {
    const fs = fakeFs({ exec: ["/srv/slicers/orca", "/usr/bin/orca-slicer"] });
    expect(await SLICERS.orcaslicer.detect({ customPath: "/srv/slicers/orca", env: env({ DISPLAY: ":0" }), fs, skipVersion: true })).toMatchObject({ path: "/srv/slicers/orca", via: "custom" });
    const s = await SLICERS.orcaslicer.detect({ customPath: "/nope/orca", env: env({ DISPLAY: ":0" }), fs, skipVersion: true });
    expect(s).toMatchObject({ path: "/usr/bin/orca-slicer", via: "path" });
    expect(s!.notes[0]).toMatch(/\/nope\/orca is not an executable/);
  });

  it("honours MORPHIX_BAMBU_STUDIO", async () => {
    const s = await SLICERS.bambustudio.detect({ env: env({ MORPHIX_BAMBU_STUDIO: "/x/bambu", DISPLAY: ":0" }), fs: fakeFs({ exec: ["/x/bambu"] }), skipVersion: true });
    expect(s).toMatchObject({ path: "/x/bambu", via: "custom" });
  });

  it("PrusaSlicer is never wrapped in xvfb-run (its CLI needs no display)", async () => {
    const s = await SLICERS.prusaslicer.detect({ env: env(), fs: fakeFs({ exec: ["/usr/bin/prusa-slicer", "/usr/bin/xvfb-run"] }), skipVersion: true });
    expect(s).toMatchObject({ path: "/usr/bin/prusa-slicer" });
  });

  it("detectAll finds every slicer and passes each its custom path", async () => {
    const fs = fakeFs({ exec: ["/usr/bin/prusa-slicer", "/my/orca"] });
    const all = await detectAll({ env: env({ DISPLAY: ":0" }), fs, skipVersion: true, flatpak: false, paths: { orcaslicer: "/my/orca" } });
    expect(all.map((s) => [s.id, s.path])).toEqual([["prusaslicer", "/usr/bin/prusa-slicer"], ["orcaslicer", "/my/orca"]]);
  });
});

describe("versions and install hints", () => {
  it("parses every slicer's banner", () => {
    expect(parseSlicerVersion("BambuStudio-01.10.02.76:\nUsage: bambu-studio [ OPTIONS ]")).toBe("01.10.02.76");
    expect(parseSlicerVersion("OrcaSlicer-2.3.0:\nUsage")).toBe("2.3.0");
    expect(parseSlicerVersion("PrusaSlicer-2.9.2+linux-x64-GTK3 based on Slic3r")).toBe("2.9.2+linux-x64-GTK3");
    expect(versionAtLeast("2.5.0+linux", "2.6")).toBe(false);
    expect(versionAtLeast("2.9.2", "2.6")).toBe(true);
    expect(versionAtLeast(null, "2.6")).toBe(true);
  });

  it("says plainly that Orca and Bambu Studio have no arm64 Linux builds", () => {
    expect(hintFor("prusaslicer", { distro: "raspbian", arch: "arm64" })).toMatch(/sudo apt install prusa-slicer/);
    expect(hintFor("prusaslicer", { distro: "fedora" })).toMatch(/dnf install prusa-slicer/);
    expect(hintFor("orcaslicer", { distro: "debian", arch: "arm64" })).toMatch(/no official arm64/);
    expect(hintFor("bambustudio", { distro: "ubuntu", arch: "aarch64" })).toMatch(/no official arm64/);
    expect(SLICERS.orcaslicer.installHint({ distro: "ubuntu", arch: "x64" })).toMatch(/flatpak install flathub io\.github\.softfever\.OrcaSlicer.*xvfb/);
    expect(SLICERS.bambustudio.installHint({ distro: "arch", arch: "x86_64" })).toMatch(/bambustudio-bin/);
  });
});
