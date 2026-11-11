// Finding a slicer on any Linux machine: a custom path, $MORPHIX_* overrides, $PATH, /opt,
// AppImages (~/Applications, ~/.local/bin, /opt) and Flatpak. Also decides how to run it
// headless: AppImages without FUSE get --appimage-extract-and-run, and OrcaSlicer / Bambu
// Studio get wrapped in `xvfb-run -a` when there is no display (their CLI starts GTK).
import { constants as fsc } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import { defaultExec, parseSlicerVersion, type ExecFileFn } from "../slicer";
import type { SlicerId, SlicerInstall } from "./types";

/** File-system checks used by detection (tests pass a fake). */
export interface DetectFs {
  isExecutable(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  listDir(dir: string): Promise<string[]>;
}

export const realFs: DetectFs = {
  async isExecutable(p) {
    try {
      await access(p, fsc.X_OK);
      return (await stat(p)).isFile();
    } catch {
      return false;
    }
  },
  async exists(p) {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  },
  async listDir(d) {
    try {
      return await readdir(d);
    } catch {
      return [];
    }
  },
};

export interface DetectOptions {
  /** A file the user picked (setup page / MorphixConfig.slicer.paths). Checked first. */
  customPath?: string;
  exec?: ExecFileFn;
  /**
   * Directories searched for executables. Default: $PATH plus /usr/bin, /usr/local/bin,
   * /snap/bin. Giving it makes the search sandboxed: no /opt, no AppImage dirs unless
   * `appImageDirs` is given too (tests rely on this).
   */
  searchPath?: string[];
  /** Directories scanned for *.AppImage. Default: ~/Applications, ~/.local/bin, /opt, /opt/<sub>. */
  appImageDirs?: string[];
  env?: NodeJS.ProcessEnv;
  fs?: DetectFs;
  /** Skip running `--help` / `flatpak list` for versions (version is null). */
  skipVersion?: boolean;
  /** false = don't look for Flatpak apps. */
  flatpak?: boolean;
  /** "off" = never wrap in xvfb-run. */
  headless?: "auto" | "off";
}

/** An install plus what detection noticed (headless wrapping, fallbacks). */
export interface DetectedSlicer extends SlicerInstall {
  notes: string[];
}

export interface SlicerSpec {
  id: SlicerId;
  name: string;
  /** Executable names on $PATH. */
  names: string[];
  envVar: string;
  flatpakId: string;
  appImage: RegExp;
  /** Install dirs under /opt holding the binary (or bin/<binary>). */
  optDirs: string[];
  /** Debian package, to tell an apt install from a plain PATH one. */
  debPackage?: string;
  /** The CLI initialises GTK even when slicing: needs a display or xvfb-run. */
  needsDisplay: boolean;
}

export const SPECS: Record<SlicerId, SlicerSpec> = {
  prusaslicer: {
    id: "prusaslicer", name: "PrusaSlicer",
    names: ["prusa-slicer", "PrusaSlicer", "prusa-slicer-console", "PrusaSlicer.AppImage"],
    envVar: "MORPHIX_PRUSA_SLICER", flatpakId: "com.prusa3d.PrusaSlicer",
    appImage: /^PrusaSlicer.*\.AppImage$/i, optDirs: ["/opt/PrusaSlicer", "/opt/prusa-slicer"], debPackage: "prusa-slicer",
    needsDisplay: false,
  },
  orcaslicer: {
    id: "orcaslicer", name: "OrcaSlicer",
    names: ["orca-slicer", "OrcaSlicer", "orcaslicer", "OrcaSlicer.AppImage"],
    envVar: "MORPHIX_ORCA_SLICER", flatpakId: "io.github.softfever.OrcaSlicer",
    appImage: /^Orca_?Slicer.*\.AppImage$/i, optDirs: ["/opt/OrcaSlicer", "/opt/orca-slicer"],
    needsDisplay: true,
  },
  bambustudio: {
    id: "bambustudio", name: "Bambu Studio",
    names: ["bambu-studio", "BambuStudio", "bambustudio", "BambuStudio.AppImage"],
    envVar: "MORPHIX_BAMBU_STUDIO", flatpakId: "com.bambulab.BambuStudio",
    appImage: /^Bambu_?Studio.*\.AppImage$/i, optDirs: ["/opt/BambuStudio", "/opt/bambu-studio"],
    needsDisplay: true,
  },
};

const EXTRA_DIRS = ["/usr/bin", "/usr/local/bin", "/snap/bin"];

function searchDirs(o: DetectOptions, env: NodeJS.ProcessEnv): string[] {
  return o.searchPath ?? [...new Set([...(env.PATH ?? "").split(delimiter).filter(Boolean), ...EXTRA_DIRS])];
}

async function appImageDirs(o: DetectOptions, env: NodeJS.ProcessEnv, fs: DetectFs): Promise<string[]> {
  if (o.appImageDirs) return o.appImageDirs;
  if (o.searchPath) return [];
  const home = env.HOME;
  const dirs = home ? [join(home, "Applications"), join(home, ".local", "bin")] : [];
  dirs.push("/opt");
  for (const sub of await fs.listDir("/opt")) dirs.push(join("/opt", sub));
  return dirs;
}

/** First executable called `name` in `dirs`. */
export async function which(name: string, dirs: string[], fs: DetectFs): Promise<string | null> {
  for (const d of dirs) if (await fs.isExecutable(join(d, name))) return join(d, name);
  return null;
}

const isAppImage = (p: string) => /\.AppImage$/i.test(p);

/** Finds one slicer. Returns null when it isn't installed. */
export async function detectInstall(spec: SlicerSpec, o: DetectOptions = {}): Promise<DetectedSlicer | null> {
  const env = o.env ?? process.env;
  const fs = o.fs ?? realFs;
  const exec = o.exec ?? defaultExec;
  const dirs = searchDirs(o, env);
  const notes: string[] = [];
  let found: { path: string; via: SlicerInstall["via"] } | null = null;

  for (const [p, label] of [[o.customPath, "custom path"], [env[spec.envVar], spec.envVar]] as const) {
    if (!p || found) continue;
    if (await fs.isExecutable(p)) found = { path: p, via: "custom" };
    else notes.push(`${label} ${p} is not an executable file; searched the usual places instead`);
  }
  for (const d of dirs) {
    if (found) break;
    for (const n of spec.names) {
      const p = join(d, n);
      if (await fs.isExecutable(p)) {
        const apt = !!spec.debPackage && d === "/usr/bin" && (await fs.exists(`/var/lib/dpkg/info/${spec.debPackage}.list`));
        found = { path: p, via: isAppImage(p) ? "appimage" : apt ? "apt" : "path" };
        break;
      }
    }
  }
  if (!found && !o.searchPath) {
    for (const d of spec.optDirs) {
      if (found) break;
      for (const n of spec.names) {
        const p = (await which(n, [d, join(d, "bin")], fs));
        if (p) {
          found = { path: p, via: "path" };
          break;
        }
      }
    }
  }
  if (!found) {
    for (const d of await appImageDirs(o, env, fs)) {
      const hit = (await fs.listDir(d)).filter((n) => spec.appImage.test(n)).sort().reverse()[0]; // highest version name
      if (hit && (await fs.isExecutable(join(d, hit)))) {
        found = { path: join(d, hit), via: "appimage" };
        break;
      }
    }
  }

  let path: string;
  let baseArgs: string[] = [];
  let version: string | null = null;
  let via: SlicerInstall["via"];
  if (found) {
    path = found.path;
    via = found.via;
    if (isAppImage(path)) {
      const fuse = (await fs.exists("/dev/fuse")) && !!((await which("fusermount", dirs, fs)) ?? (await which("fusermount3", dirs, fs)));
      if (!fuse) {
        baseArgs = ["--appimage-extract-and-run"];
        notes.push("no FUSE on this machine: the AppImage runs with --appimage-extract-and-run (slower start; sudo apt install libfuse2 avoids it)");
      }
    }
  } else {
    if (o.flatpak === false) return null;
    const flatpak = await which("flatpak", dirs, fs);
    if (!flatpak) return null;
    const r = await exec(flatpak, ["list", "--app", "--columns=application,version"], { timeoutMs: 15000 });
    const row = r.stdout.split("\n").map((l) => l.trim().split(/\s+/)).find((cols) => cols[0] === spec.flatpakId);
    if (!row) return null;
    path = flatpak;
    baseArgs = ["run", spec.flatpakId];
    version = row[1] ?? null;
    via = "flatpak";
    notes.push("Flatpak: Morphix grants the job folders with --filesystem when it slices");
  }

  if (spec.needsDisplay && o.headless !== "off" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    const xvfb = await which("xvfb-run", dirs, fs);
    if (xvfb) {
      baseArgs = ["-a", path, ...baseArgs];
      path = xvfb;
      notes.push(`no display: ${spec.name} runs inside xvfb-run -a`);
    } else notes.push(`no display and no xvfb-run: if ${spec.name} fails to start headless, install xvfb (sudo apt install xvfb)`);
  }

  if (!version && !o.skipVersion) {
    const r = await exec(path, [...baseArgs, "--help"], { timeoutMs: 30000 });
    version = parseSlicerVersion(r.stdout + "\n" + r.stderr);
  }
  return { id: spec.id, path, ...(baseArgs.length ? { baseArgs } : {}), version, via, notes };
}

/**
 * The command line for one run: install.path + baseArgs + args. Flatpak gets read/write
 * access to `dirs` (the sandbox can't see /tmp or the data dir otherwise).
 */
export function commandFor(install: SlicerInstall, args: string[], dirs: string[] = []): { file: string; args: string[] } {
  const base = [...(install.baseArgs ?? [])];
  if (install.via === "flatpak") {
    const run = base.indexOf("run");
    base.splice(run + 1, 0, ...[...new Set(dirs)].map((d) => `--filesystem=${d}`));
  }
  return { file: install.path, args: [...base, ...args] };
}

/** Short label for logs and the UI ("OrcaSlicer 2.2.0 (flatpak)"). */
export function installLabel(s: SlicerInstall): string {
  return `${SPECS[s.id].name}${s.version ? ` ${s.version}` : ""} (${s.via}${s.via === "custom" ? `: ${basename(s.path)}` : ""})`;
}
