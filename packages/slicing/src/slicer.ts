// Wrapper around existing slicing engines (PrusaSlicer preferred, OrcaSlicer fallback).
// Runs them with execFile (never a shell). Morphix never implements slicing itself.
import { execFile } from "node:child_process";
import { constants as fsc } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { filamentProfile, orcaFilamentJson, writePrusaFilamentIni, type FilamentId, type FilamentProfile } from "./filaments";
import { orcaSpeedConfig, writeOrcaMachineWithZ, writePrusaSpeedIni, writePrusaZOffsetIni } from "./speed";
import { analyzeGcode, type GcodeEstimates } from "./gcode";
import { QD330_PLA_DEFAULTS, resolveProfilePaths, type SlicerProfilePaths } from "./profiles";

export type SlicerKind = "prusaslicer" | "orcaslicer";

export interface SlicerInfo {
  kind: SlicerKind;
  path: string;
  version: string | null;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Injectable process runner (tests pass a fake). Must not use a shell. */
export type ExecFileFn = (file: string, args: string[], opts: { timeoutMs: number; cwd?: string }) => Promise<ExecResult>;

export const defaultExec: ExecFileFn = (file, args, opts) =>
  new Promise((resolveP) => {
    execFile(file, args, { timeout: opts.timeoutMs, cwd: opts.cwd, maxBuffer: 32 * 1024 * 1024, shell: false, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
      resolveP({
        code: e ? (typeof e.code === "number" ? e.code : null) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "") + (e && typeof e.code === "string" ? `\n${e.code}: ${e.message}` : ""),
        timedOut: !!e?.killed && e?.signal === "SIGTERM",
      });
    });
  });

const EXECUTABLES: Record<SlicerKind, string[]> = {
  prusaslicer: ["prusa-slicer", "PrusaSlicer", "prusa-slicer-console", "PrusaSlicer.AppImage"],
  orcaslicer: ["orca-slicer", "OrcaSlicer", "orcaslicer", "OrcaSlicer.AppImage"],
};
const ENV_OVERRIDE: Record<SlicerKind, string> = { prusaslicer: "MORPHIX_PRUSA_SLICER", orcaslicer: "MORPHIX_ORCA_SLICER" };
const EXTRA_DIRS = ["/usr/bin", "/usr/local/bin", "/opt/PrusaSlicer", "/opt/OrcaSlicer", "/opt/orca-slicer/bin", "/snap/bin"];

export interface DetectOptions {
  exec?: ExecFileFn;
  /** PATH-like search list; defaults to $PATH plus common install dirs. */
  searchPath?: string[];
  /** Skip running `--help` to read versions (faster; version will be null). */
  skipVersion?: boolean;
  env?: NodeJS.ProcessEnv;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, fsc.X_OK);
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Finds installed slicers, PrusaSlicer first. Returns [] when none are installed. */
export async function detectSlicers(opts: DetectOptions = {}): Promise<SlicerInfo[]> {
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? defaultExec;
  const dirs = opts.searchPath ?? [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...EXTRA_DIRS];
  const found: SlicerInfo[] = [];
  for (const kind of ["prusaslicer", "orcaslicer"] as SlicerKind[]) {
    let path: string | null = null;
    const override = env[ENV_OVERRIDE[kind]];
    if (override && (await isExecutable(override))) path = override;
    for (const d of dirs) {
      if (path) break;
      for (const name of EXECUTABLES[kind]) {
        if (await isExecutable(join(d, name))) {
          path = join(d, name);
          break;
        }
      }
    }
    if (!path) continue;
    let version: string | null = null;
    if (!opts.skipVersion) {
      const r = await exec(path, ["--help"], { timeoutMs: 20000 });
      version = parseSlicerVersion(r.stdout + "\n" + r.stderr);
    }
    found.push({ kind, path, version });
  }
  return found;
}

export function parseSlicerVersion(text: string): string | null {
  const m = /(?:PrusaSlicer|OrcaSlicer)[-\s]v?(\d+\.\d+(?:\.\d+)?[\w.+-]*)/i.exec(text);
  return m ? m[1] : null;
}

export type SupportMode = "none" | "auto" | "buildplate";

export interface SliceOptions {
  stlPath: string;
  /** Directory for the output G-code (created if missing). Defaults to a fresh temp dir. */
  outDir?: string;
  slicer?: SlicerInfo;
  supports?: SupportMode;
  layerHeightMm?: number;
  infillPercent?: number;
  /** Brim width in mm (0 = no brim). Omitted: the profile's value (no brim). */
  brimWidthMm?: number;
  /** Perimeters / wall loops. Omitted: the profile's value (2). */
  perimeters?: number;
  /** Plate centre for PrusaSlicer --center (default 0,0: the QD330 bed is centre-origin, -110..110). */
  centerMm?: { x: number; y: number };
  /** Generic filament profile layered over the base profile (default PLA). */
  filament?: FilamentId;
  /** One print speed for every move, first layer included (mm/s, max 600). Omitted: profile speeds. */
  speedMmS?: number;
  /** Nozzle height above the bed for this slice (mm, -0.5 to 1). Omitted: the profile's z_offset. */
  zOffsetMm?: number;
  profilesDir?: string;
  timeoutMs?: number;
  exec?: ExecFileFn;
  /** Options for auto-detection when `slicer` is not given. */
  detect?: DetectOptions;
}

export type SliceFailureReason = "slicer-not-installed" | "profile-missing" | "slicer-failed" | "timeout" | "no-output";

export type SliceResult =
  | {
      ok: true;
      slicer: SlicerInfo;
      gcodePath: string;
      gcode: string;
      estimates: GcodeEstimates;
      args: string[];
      durationMs: number;
      /** Always false: profiles are unverified guesses for the QD330. */
      profileVerified: false;
      log: string;
    }
  | { ok: false; reason: SliceFailureReason; message: string; slicer?: SlicerInfo; args?: string[]; log?: string };

/** Builds the PrusaSlicer CLI argument list (exported for tests / debugging). */
export function prusaArgs(o: { stlPath: string; outPath: string; ini: string; filamentIni?: string; speedIni?: string; zIni?: string; supports: SupportMode; layerHeightMm?: number; infillPercent?: number; brimWidthMm?: number; perimeters?: number; center: { x: number; y: number } }): string[] {
  // A second --load overrides the base profile's filament keys.
  const args = ["--export-gcode", "--load", o.ini, ...(o.filamentIni ? ["--load", o.filamentIni] : []), ...(o.speedIni ? ["--load", o.speedIni] : []), ...(o.zIni ? ["--load", o.zIni] : []), "--output", o.outPath, "--center", `${o.center.x},${o.center.y}`];
  if (o.supports === "auto") args.push("--support-material", "--support-material-auto");
  if (o.supports === "buildplate") args.push("--support-material", "--support-material-auto", "--support-material-buildplate-only");
  if (o.layerHeightMm) args.push("--layer-height", String(o.layerHeightMm), "--first-layer-height", String(o.layerHeightMm));
  if (o.infillPercent !== undefined) args.push("--fill-density", `${o.infillPercent}%`);
  if (o.brimWidthMm !== undefined) args.push("--brim-width", String(o.brimWidthMm));
  if (o.perimeters !== undefined) args.push("--perimeters", String(o.perimeters));
  args.push(o.stlPath);
  return args;
}

/** Slices an STL to G-code. Never throws for expected failures; returns { ok: false, reason }. */
export async function sliceStl(opts: SliceOptions): Promise<SliceResult> {
  const exec = opts.exec ?? defaultExec;
  const slicer = opts.slicer ?? (await detectSlicers({ exec, skipVersion: true, ...opts.detect }))[0];
  if (!slicer) {
    return {
      ok: false,
      reason: "slicer-not-installed",
      message: "No slicer installed. Install PrusaSlicer (Debian/Raspberry Pi OS: sudo apt install prusa-slicer) or set MORPHIX_PRUSA_SLICER.",
    };
  }
  const profiles = resolveProfilePaths(opts.profilesDir);
  if (!profiles) return { ok: false, reason: "profile-missing", message: "config/slicer-profiles not found (pass profilesDir or set MORPHIX_SLICER_PROFILES)", slicer };
  const outDir = opts.outDir ?? (await mkdtemp(join(tmpdir(), "morphix-slice-")));
  await mkdir(outDir, { recursive: true });
  const supports = opts.supports ?? "none";
  const filament = filamentProfile(opts.filament);
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000; // a Pi 4 is slow on big meshes
  const started = Date.now();
  let args: string[];
  let expected: string | null;
  if (slicer.kind === "prusaslicer") {
    expected = join(outDir, "morphix.gcode");
    args = prusaArgs({
      stlPath: opts.stlPath,
      outPath: expected,
      ini: profiles.prusaIni,
      filamentIni: await writePrusaFilamentIni(outDir, filament.id),
      speedIni: opts.speedMmS ? await writePrusaSpeedIni(outDir, opts.speedMmS) : undefined,
      zIni: opts.zOffsetMm !== undefined ? await writePrusaZOffsetIni(outDir, opts.zOffsetMm) : undefined,
      supports,
      layerHeightMm: opts.layerHeightMm,
      infillPercent: opts.infillPercent,
      brimWidthMm: opts.brimWidthMm,
      perimeters: opts.perimeters,
      center: opts.centerMm ?? { x: 0, y: 0 },
    });
  } else {
    const processJson = await orcaProcessFile(profiles, outDir, supports, opts.layerHeightMm, opts.infillPercent, opts);
    expected = null; // Orca names its output plate_1.gcode (version dependent)
    args = [
      "--slice", "0",
      "--load-settings", `${opts.zOffsetMm !== undefined ? await writeOrcaMachineWithZ(outDir, await readFile(profiles.orcaMachine, "utf8"), opts.zOffsetMm) : profiles.orcaMachine};${processJson}`,
      "--load-filaments", await writeOrcaFilament(outDir, filament),
      "--outputdir", outDir,
      opts.stlPath,
    ];
  }
  const r = await exec(slicer.path, args, { timeoutMs, cwd: outDir });
  const log = tail(r.stdout + "\n" + r.stderr, 4000);
  if (r.timedOut) return { ok: false, reason: "timeout", message: `${slicer.kind} timed out after ${timeoutMs} ms`, slicer, args, log };
  const gcodePath = expected && (await exists(expected)) ? expected : await findGcode(outDir);
  if (r.code !== 0 && !gcodePath) return { ok: false, reason: "slicer-failed", message: `${slicer.kind} exited with code ${r.code}`, slicer, args, log };
  if (!gcodePath) return { ok: false, reason: "no-output", message: `${slicer.kind} produced no G-code in ${outDir}`, slicer, args, log };
  const gcode = await readFile(gcodePath, "utf8");
  return {
    ok: true,
    slicer,
    gcodePath,
    gcode,
    estimates: analyzeGcode(gcode, { diameterMm: QD330_PLA_DEFAULTS.filamentDiameterMm, densityGcm3: filament.densityGcm3 }),
    args,
    durationMs: Date.now() - started,
    profileVerified: false,
    log,
  };
}

async function orcaProcessFile(
  p: SlicerProfilePaths,
  outDir: string,
  supports: SupportMode,
  layer?: number,
  infill?: number,
  extra: { brimWidthMm?: number; perimeters?: number; speedMmS?: number } = {},
): Promise<string> {
  const json = JSON.parse(await readFile(p.orcaProcess, "utf8"));
  json.enable_support = supports === "none" ? "0" : "1";
  json.support_type = "normal(auto)";
  json.support_on_build_plate_only = supports === "buildplate" ? "1" : "0";
  if (layer) {
    json.layer_height = String(layer);
    json.initial_layer_print_height = String(layer);
  }
  if (infill !== undefined) json.sparse_infill_density = `${infill}%`;
  if (extra.brimWidthMm !== undefined) {
    json.brim_type = extra.brimWidthMm > 0 ? "outer_only" : "no_brim";
    json.brim_width = String(extra.brimWidthMm);
  }
  if (extra.perimeters !== undefined) json.wall_loops = String(extra.perimeters);
  if (extra.speedMmS) Object.assign(json, orcaSpeedConfig(extra.speedMmS));
  const path = join(outDir, "morphix-process.json");
  await writeFile(path, JSON.stringify(json, null, 2));
  return path;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function findGcode(dir: string): Promise<string | null> {
  try {
    const names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".gcode")).sort();
    return names.length ? join(dir, names[0]) : null;
  } catch {
    return null;
  }
}

function tail(s: string, n: number): string {
  return s.length > n ? s.slice(s.length - n) : s;
}

async function writeOrcaFilament(dir: string, f: FilamentProfile): Promise<string> {
  const path = join(dir, `filament-${f.id}.json`);
  await writeFile(path, JSON.stringify(orcaFilamentJson(f), null, 2));
  return path;
}
