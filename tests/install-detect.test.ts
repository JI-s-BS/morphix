// install.sh --dry-run in a sandbox (temp HOME, fake uname/os-release/meminfo, fake sudo/apt):
// detection branches, refusal paths, and that a dry run changes nothing.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INSTALL_SH, OS, fakeBin, installSandbox } from "./install-helpers";

describe("install.sh detection (dry run)", () => {
  it.each([
    ["debian", OS.debian, "apt"],
    ["ubuntu", OS.ubuntu, "apt"],
    ["raspberry pi os", OS.raspbian, "apt"],
    ["fedora", OS.fedora, "dnf"],
    ["arch", OS.arch, "pacman"],
    ["manjaro (ID_LIKE=arch)", OS.manjaro, "pacman"],
  ])("%s uses %s", (_name, os, pkg) => {
    const s = installSandbox({ os });
    const r = s.run("--dry-run", "--user", "--with-prusaslicer");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`, ${pkg})`);
    expect(r.out).toMatch(new RegExp(`\\[dry-run\\] sudo .*${pkg === "apt" ? "apt-get install" : pkg === "dnf" ? "dnf install" : "pacman -S --needed"}.* prusa-slicer`));
    expect(readdirSync(s.home)).toEqual([]); // nothing written
  });

  it("warns on an untested relative of a supported distro", () => {
    const r = installSandbox({ os: OS.rocky }).run("--dry-run", "--user");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/Rocky Linux 9 is not tested; treating it like rhel \(dnf\)/);
  });

  it.each([["alpine", OS.alpine], ["opensuse", OS.opensuse]])("refuses %s with manual steps", (_n, os) => {
    const r = installSandbox({ os }).run("--dry-run", "--user");
    expect(r.status).toBe(3);
    expect(r.out).toContain("supports Debian, Ubuntu, Raspberry Pi OS (apt), Fedora (dnf) and Arch (pacman)");
    expect(r.out).toContain("npm run build:server");
    expect(r.out).toContain("docker compose up -d");
  });

  it.each([["x86_64", "x64"], ["aarch64", "arm64"], ["armv7l", "armv7l"]])("accepts %s", (arch) => {
    const r = installSandbox({ os: OS.debian, arch }).run("--dry-run", "--user");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`, ${arch}`);
  });

  it("downloads the official Node build for the arch when no Node 22 is on PATH", () => {
    const s = installSandbox({ os: OS.raspbian, arch: "aarch64" });
    // a node 18 on PATH is too old
    fakeBin(s.bin, "node", 'echo v18.19.0');
    fakeBin(s.bin, "npm", "exit 0");
    const r = s.run("--dry-run", "--user");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("download Node.js 22 LTS (linux-arm64) from https://nodejs.org/dist/latest-v22.x, verify it against SHASUMS256.txt");
  });

  it("refuses ARMv6 (Pi Zero / Pi 1) with a reason", () => {
    const r = installSandbox({ os: OS.raspbian, arch: "armv6l" }).run("--dry-run");
    expect(r.status).toBe(4);
    expect(r.out).toContain("ARMv6 board (Raspberry Pi Zero / Zero W / Pi 1)");
    expect(r.out).toContain("Zero 2 W");
  });

  it("refuses an unknown CPU", () => {
    const r = installSandbox({ os: OS.debian, arch: "riscv64" }).run("--dry-run");
    expect(r.status).toBe(4);
    expect(r.out).toContain("unsupported CPU architecture riscv64");
  });

  it("refuses too little RAM unless --force, and warns on low RAM", () => {
    const tiny = installSandbox({ os: OS.debian, ramMb: 512 });
    const r = tiny.run("--dry-run", "--user");
    expect(r.status).toBe(5);
    expect(r.out).toContain("needs about 1 GB of RAM and this machine has 512 MB");
    expect(tiny.run("--dry-run", "--user", "--force").status).toBe(0);
    expect(installSandbox({ os: OS.debian, ramMb: 1024 }).run("--dry-run", "--user").out).toContain("the build will be slow");
  });

  it("system dry run: creates the morphix user (dialout/video), /opt + /var/lib (0700), hardened service", () => {
    const r = installSandbox({ os: OS.debian }).run("--dry-run", "--auto-update", "--channel", "main");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/useradd --system .*morphix/);
    expect(r.out).toMatch(/install -d -m 0700 -o morphix -g morphix \/var\/lib\/morphix/);
    expect(r.out).toContain("/opt/morphix");
    expect(r.out).toContain("/etc/systemd/system/morphix.service (from packaging/systemd/morphix.service.in)");
    expect(r.out).toContain("enable morphix-update.timer");
    expect(r.out).toContain("update --channel main");
    expect(r.out).toContain("http://");
  });

  it("user dry run uses ~/.local paths and a user service", () => {
    const s = installSandbox({ os: OS.fedora });
    const r = s.run("--dry-run", "--user", "--skip-tests", "--port", "9090");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`${s.home}/.local/share/morphix-app`);
    expect(r.out).toContain(`${s.home}/.local/share/morphix (0700)`);
    expect(r.out).toContain("systemctl --user enable morphix.service");
    expect(r.out).toContain("update --channel stable --skip-tests");
    expect(r.out).toContain(":9090");
    expect(r.out).toContain("automatic updates: off");
  });

  it("rejects bad options", () => {
    const s = installSandbox({ os: OS.debian });
    expect(s.run("--channel", "beta").status).toBe(2);
    expect(s.run("--port", "abc").status).toBe(2);
    expect(s.run("--purge").status).toBe(2);
    expect(s.run("--bogus").status).toBe(2);
  });

  it("uninstall dry run keeps data unless --purge", () => {
    const s = installSandbox({ os: OS.debian });
    // pretend a user install exists
    mkdirSync(`${s.home}/.config/morphix`, { recursive: true });
    writeFileSync(`${s.home}/.config/morphix/install.conf`, "MODE=user\n");
    const keep = s.run("--uninstall", "--user", "--dry-run");
    expect(keep.status, keep.out).toBe(0);
    expect(keep.out).toContain(`rm -rf ${s.home}/.local/share/morphix-app`);
    expect(keep.out).not.toContain(`rm -rf ${s.home}/.local/share/morphix\n`);
    expect(keep.out).toContain("Your data is still in");
    const purge = s.run("--uninstall", "--purge", "--user", "--dry-run");
    expect(purge.out).toContain(`rm -rf ${s.home}/.local/share/morphix\n`);
  });

  it("uninstall without a terminal or --yes refuses instead of guessing", () => {
    const s = installSandbox({ os: OS.debian });
    mkdirSync(`${s.home}/.config/morphix`, { recursive: true });
    writeFileSync(`${s.home}/.config/morphix/install.conf`, "MODE=user\n");
    // setsid: no controlling terminal, so /dev/tty can't be opened
    const r = spawnSync("setsid", ["bash", INSTALL_SH, "--uninstall", "--user"], { env: s.env, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/add --yes|cancelled/);
  });
});
