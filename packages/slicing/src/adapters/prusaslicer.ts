// PrusaSlicer: plain G-code (and FlashForge .gx via Morphix). It can't write Bambu .gcode.3mf.
//   prusa-slicer --export-gcode --load <printer.ini> --load <filament.ini> [--load speed] [--load z]
//                --output <out.gcode> --center X,Y [flags] model.stl
// With a vendor profile (catalog vendorProfiles.prusaslicer, PrusaSlicer 2.6+) the printer
// comes from `--printer-profile "<name>"` (needs PrusaSlicer's bundled vendor profiles in its
// data dir) and Morphix only loads the print and filament settings; if that slice fails,
// Morphix slices again with the generated profile and says so.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PrinterModel } from "@morphix/catalog";
import { defaultExec, versionAtLeast, type ExecFileFn, type SupportMode } from "../slicer";
import { writePrusaSpeedIni, writePrusaZOffsetIni } from "../speed";
import { commandFor, detectInstall, SPECS, type DetectOptions } from "./detect";
import { hintFor } from "./hints";
import { finishSlice, findGcode, tail, type MorphixSliceJob, type MorphixSliceOutput } from "./output";
import { bedCenter, filamentFor, printerMaxSpeed, prusaFilamentIni, prusaProfileIni } from "./profile";
import type { SlicerAdapter, SlicerInstall } from "./types";

export interface PrusaArgs {
  stlPath: string;
  outPath: string;
  /** Base profile; omitted with printerProfile. */
  ini?: string;
  /** PrusaSlicer vendor printer profile name (2.6+). */
  printerProfile?: string;
  filamentIni?: string;
  speedIni?: string;
  zIni?: string;
  supports: SupportMode;
  layerHeightMm?: number;
  infillPercent?: number;
  brimWidthMm?: number;
  perimeters?: number;
  center: { x: number; y: number };
}

/** Builds the PrusaSlicer CLI argument list (exported for tests / debugging). Later --load wins. */
export function prusaArgs(o: PrusaArgs): string[] {
  const loads = [o.ini, o.filamentIni, o.speedIni, o.zIni].filter((x): x is string => !!x).flatMap((f) => ["--load", f]);
  const args = ["--export-gcode", ...(o.printerProfile ? ["--printer-profile", o.printerProfile] : []), ...loads, "--output", o.outPath, "--center", `${o.center.x},${o.center.y}`];
  if (o.supports === "auto") args.push("--support-material", "--support-material-auto");
  if (o.supports === "buildplate") args.push("--support-material", "--support-material-auto", "--support-material-buildplate-only");
  if (o.layerHeightMm) args.push("--layer-height", String(o.layerHeightMm), "--first-layer-height", String(o.layerHeightMm));
  if (o.infillPercent !== undefined) args.push("--fill-density", `${o.infillPercent}%`);
  if (o.brimWidthMm !== undefined) args.push("--brim-width", String(o.brimWidthMm));
  if (o.perimeters !== undefined) args.push("--perimeters", String(o.perimeters));
  args.push(o.stlPath);
  return args;
}

export function prusaUnsupportedReason(p: PrinterModel): string | null {
  if (p.fileFormat === "gcode.3mf" || p.gcodeFlavor === "bambu") return `PrusaSlicer can't make the Bambu .gcode.3mf the ${p.brand} ${p.model} needs: install OrcaSlicer or Bambu Studio`;
  if (p.fileFormat === "ufp") return ufpReason(p);
  return null;
}

export const ufpReason = (p: PrinterModel) =>
  `the ${p.brand} ${p.model} wants Ultimaker .ufp with Cura's Griffin G-code header, which PrusaSlicer, OrcaSlicer and Bambu Studio can't write: slice it in Ultimaker Cura`;

export const PRUSA_VENDOR_MIN_VERSION = "2.6";

export const prusaslicer = {
  id: "prusaslicer",
  name: "PrusaSlicer",
  detect: (opts: DetectOptions = {}) => detectInstall(SPECS.prusaslicer, opts),
  supports: (p: PrinterModel) => prusaUnsupportedReason(p) === null,
  installHint: (env: { distro?: string; arch?: string }) => hintFor("prusaslicer", env),

  async slice(install: SlicerInstall, job: MorphixSliceJob, deps: { exec?: ExecFileFn } = {}): Promise<MorphixSliceOutput> {
    const p = job.printer;
    const reason = prusaUnsupportedReason(p);
    if (reason) return { ok: false, reason: "unsupported-printer", message: reason };
    const exec = deps.exec ?? defaultExec;
    await mkdir(job.outDir, { recursive: true });
    if (job.printableDir) await mkdir(job.printableDir, { recursive: true });
    const started = Date.now();
    const { filament, warnings } = filamentFor(p, job.filament);
    const filamentIni = join(job.outDir, `filament-${filament.id}.ini`);
    await writeFile(filamentIni, prusaFilamentIni(p, filament));
    const speedIni = job.speedMmS ? await writePrusaSpeedIni(job.outDir, job.speedMmS, printerMaxSpeed(p)) : undefined;
    const zIni = job.zOffsetMm !== undefined ? await writePrusaZOffsetIni(job.outDir, job.zOffsetMm) : undefined;
    const outPath = join(job.outDir, "morphix.gcode");
    const timeoutMs = job.timeoutMs ?? 15 * 60 * 1000; // a Pi 4 is slow on big meshes
    const vendorName = job.useVendorProfile === false ? undefined : p.vendorProfiles?.prusaslicer;
    const vendor = vendorName && versionAtLeast(install.version, PRUSA_VENDOR_MIN_VERSION) ? vendorName : undefined;
    if (vendorName && !vendor) warnings.push(`PrusaSlicer ${install.version} is older than ${PRUSA_VENDOR_MIN_VERSION}: using Morphix's generated profile instead of "${vendorName}"`);

    const run = async (useVendor: boolean) => {
      const ini = join(job.outDir, useVendor ? `print-${p.id}.ini` : `printer-${p.id}.ini`);
      await writeFile(ini, prusaProfileIni(p, useVendor ? { vendor, slicerVersion: install.version } : {}));
      const args = prusaArgs({
        stlPath: job.modelPath, outPath, ini, printerProfile: useVendor ? vendor : undefined, filamentIni, speedIni, zIni,
        supports: job.supports ?? "none", layerHeightMm: job.layerHeightMm, infillPercent: job.infillPercent,
        brimWidthMm: job.brimWidthMm, perimeters: job.perimeters, center: bedCenter(p),
      });
      const cmd = commandFor(install, args, [job.outDir, dirname(job.modelPath)]);
      const r = await exec(cmd.file, cmd.args, { timeoutMs, cwd: job.outDir });
      return { args, r, gcodePath: await findGcode(job.outDir, "morphix.gcode", [`${job.baseName ?? "model"}.gcode`]) };
    };

    let profile: "generated" | "catalog" | "vendor" = vendor ? "vendor" : p.startGcode ? "catalog" : "generated";
    let { args, r, gcodePath } = await run(!!vendor);
    if (vendor && !r.timedOut && (r.code !== 0 || !gcodePath)) {
      warnings.push(`PrusaSlicer could not use its vendor profile "${vendor}" (${tail(r.stderr || r.stdout, 200).trim() || `exit ${r.code}`}): sliced with Morphix's generated profile instead`);
      profile = p.startGcode ? "catalog" : "generated";
      ({ args, r, gcodePath } = await run(false));
    }
    const log = tail(r.stdout + "\n" + r.stderr);
    if (r.timedOut) return { ok: false, reason: "timeout", message: `PrusaSlicer timed out after ${timeoutMs} ms`, install, args, log };
    if (r.code !== 0 && !gcodePath) return { ok: false, reason: "slicer-failed", message: `PrusaSlicer exited with code ${r.code}`, install, args, log };
    return finishSlice({ printer: p, job, install, filament, args, log, started, profile, warnings, gcodePath });
  },
} satisfies SlicerAdapter;
