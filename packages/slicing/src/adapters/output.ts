// After the slicer ran: Morphix's post-processing (bed leveling, slow first layers) for plain
// G-code printers, then packaging in the printer's file format (.gcode, FlashForge .gx, Bambu
// .gcode.3mf straight from the slicer). Shared by every adapter.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PrinterModel } from "@morphix/catalog";
import type { FilamentProfile } from "../filaments";
import { analyzeGcode, capFirstLayers, type GcodeEstimates } from "../gcode";
import { GX_LAYOUT_VERIFIED, validateGx, writeGx, type GxValidation } from "../gx";
import { applyLeveling, LEVEL_MARKER, validateLevelCommands, type LevelingPlan, type LevelingReport } from "../leveling";
import { QD330_PLA_DEFAULTS } from "../profiles";
import { parseStl } from "../stl";
import { gxThumbnailBmp } from "../thumbnail";
import type { SlicerInstall, SliceJob, SliceOutput } from "./types";
import { readZip } from "./zip";

/** SliceJob plus the extras preparePrint passes (all optional). */
export interface MorphixSliceJob extends SliceJob {
  /** Where the printable file goes (default outDir). The slicer's own output stays in outDir. */
  printableDir?: string;
  /** Base name of the printable files (default "model"). */
  baseName?: string;
  /** Bed leveling plan (default: the catalog's autoLevel command, or none). */
  leveling?: LevelingPlan;
  /** .gx thumbnail (default: rendered from modelPath when it is an STL). */
  thumbnailBmp?: Uint8Array;
  /** false = ignore printer.vendorProfiles and use the generated profile. Default true. */
  useVendorProfile?: boolean;
}

export type ProfileSource = "generated" | "catalog" | "vendor";

/** The adapter's result with what preparePrint reports on top of the contract. */
export type MorphixSliceOutput =
  | (Extract<SliceOutput, { ok: true }> & {
      install: SlicerInstall;
      args: string[];
      log: string;
      durationMs: number;
      profile: ProfileSource;
      /** The slicer's own G-code (before post-processing), when there is one. */
      rawGcodePath?: string;
      rawGcode?: string;
      estimates: GcodeEstimates | null;
      leveling: LevelingReport | null;
      gx?: { buffer: Buffer; validation: GxValidation; verified: typeof GX_LAYOUT_VERIFIED };
    })
  | (Extract<SliceOutput, { ok: false }> & { install?: SlicerInstall; args?: string[]; log?: string });

/** Morphix may rewrite the G-code (leveling, first-layer caps) only for plain G-code printers. */
export function postProcessSafe(p: PrinterModel): boolean {
  return (p.fileFormat === "gcode" || p.fileFormat === "gx") && p.gcodeFlavor !== "bambu";
}

export function tail(s: string, n = 4000): string {
  return s.length > n ? s.slice(s.length - n) : s;
}

/** The slicer's G-code in `dir`: `preferred`, else plate_*.gcode, else the first other .gcode. */
export async function findGcode(dir: string, preferred?: string, exclude: string[] = []): Promise<string | null> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".gcode") && !exclude.includes(n)).sort();
  } catch {
    return null;
  }
  const pick = (preferred && names.includes(preferred) ? preferred : null) ?? names.find((n) => /^plate_\d+\.gcode$/i.test(n)) ?? names[0];
  return pick ? join(dir, pick) : null;
}

/** The leveling plan for a printer: the catalog's command, or none. */
export function catalogLevelingPlan(p: PrinterModel): LevelingPlan {
  return p.autoLevel ? { mode: "gcode", commands: [p.autoLevel.gcode], verified: false } : { mode: "printer" };
}

function level(p: PrinterModel, gcode: string, job: MorphixSliceJob, profile: ProfileSource): { gcode: string; report: LevelingReport } {
  const plan = job.leveling ?? catalogLevelingPlan(p);
  // A catalog or vendor start G-code without the marker levels the bed itself (or not at all).
  if (profile !== "generated" && !gcode.split("\n").some((l) => l.trim() === LEVEL_MARKER)) {
    const who = profile === "vendor" ? "the slicer's vendor profile" : "the catalog";
    return { gcode, report: { mode: "printer", commands: [], markerFound: false, warnings: [`start G-code from ${who} handles bed leveling; Morphix added none`] } };
  }
  try {
    if (plan.mode === "gcode") validateLevelCommands(plan.commands);
  } catch (e) {
    return { gcode, report: { mode: "printer", commands: [], markerFound: false, warnings: [`bed leveling skipped: ${(e as Error).message}`] } };
  }
  return applyLeveling(gcode, plan);
}

/** Wraps slicer G-code in a .gx using values read from the G-code (or the QD330 defaults). */
export function gxFromGcode(gcode: string, thumbnailBmp: Uint8Array, est: GcodeEstimates = analyzeGcode(gcode), layerHeightMm?: number, shells?: number): Buffer {
  return writeGx({
    gcode,
    thumbnailBmp,
    printTimeS: est.printTimeS ?? 0,
    filamentMm: est.filamentMm ?? 0,
    layerHeightMm: layerHeightMm ?? est.layerHeightMm ?? QD330_PLA_DEFAULTS.layerHeightMm,
    shells: shells ?? QD330_PLA_DEFAULTS.perimeters,
    printSpeedMmS: QD330_PLA_DEFAULTS.printSpeedMmS,
    bedTempC: est.bedTempC ?? QD330_PLA_DEFAULTS.bedTempC,
    extruderTempC: est.nozzleTempC ?? QD330_PLA_DEFAULTS.nozzleTempC,
  });
}

async function thumbnailFor(job: MorphixSliceJob): Promise<Uint8Array> {
  if (job.thumbnailBmp) return job.thumbnailBmp;
  try {
    return gxThumbnailBmp(parseStl(await readFile(job.modelPath)));
  } catch {
    return gxThumbnailBmp(null);
  }
}

export interface FinishInput {
  printer: PrinterModel;
  job: MorphixSliceJob;
  install: SlicerInstall;
  filament: FilamentProfile;
  args: string[];
  log: string;
  started: number;
  profile: ProfileSource;
  warnings: string[];
  /** The slicer's G-code file (plain-G-code printers). */
  gcodePath?: string | null;
  /** The sliced .gcode.3mf (Bambu printers). */
  threeMfPath?: string | null;
}

/** Post-processes and packages the slicer output in printer.fileFormat. */
export async function finishSlice(i: FinishInput): Promise<MorphixSliceOutput> {
  const { printer: p, job, install } = i;
  const dir = job.printableDir ?? job.outDir;
  const base = job.baseName ?? "model";
  const warnings = [...i.warnings];
  const common = { install, args: i.args, log: i.log, durationMs: Date.now() - i.started, profile: i.profile };
  const spec = { diameterMm: p.filamentMm, densityGcm3: i.filament.densityGcm3 };

  if (p.fileFormat === "gcode.3mf") {
    if (!i.threeMfPath) return { ok: false, reason: "no-output", message: `the slicer wrote no .gcode.3mf in ${job.outDir}`, install, args: i.args, log: i.log };
    const printablePath = join(dir, `${base}.gcode.3mf`);
    const bytes = await readFile(i.threeMfPath);
    if (printablePath !== i.threeMfPath) await writeFile(printablePath, bytes);
    let gcodePath: string | undefined;
    let estimates: GcodeEstimates | null = null;
    let rawGcode: string | undefined;
    try {
      const entry = readZip(bytes).find((e) => /^Metadata\/plate_\d+\.gcode$/i.test(e.name));
      if (entry) {
        rawGcode = entry.data().toString("utf8");
        gcodePath = join(dir, `${base}.gcode`);
        await writeFile(gcodePath, rawGcode);
        estimates = analyzeGcode(rawGcode, spec);
      } else warnings.push("no plate G-code inside the .gcode.3mf: no preview or estimates");
    } catch (e) {
      warnings.push(`could not read the .gcode.3mf for a preview: ${(e as Error).message}`);
    }
    warnings.push(".gcode.3mf is sent as the slicer wrote it (Morphix does not change Bambu G-code)");
    return {
      ok: true, printablePath, format: p.fileFormat, gcodePath, rawGcodePath: gcodePath, rawGcode,
      estimatedTimeS: estimates?.printTimeS ?? undefined, filamentMm: estimates?.filamentMm ?? undefined,
      estimates, leveling: null, warnings, ...common,
    };
  }

  if (!i.gcodePath) return { ok: false, reason: "no-output", message: `the slicer produced no G-code in ${job.outDir}`, install, args: i.args, log: i.log };
  const raw = await readFile(i.gcodePath, "utf8");
  const estimates = analyzeGcode(raw, spec);
  let gcode = raw;
  let leveling: LevelingReport | null = null;
  if (postProcessSafe(p)) {
    const l = level(p, raw, job, i.profile);
    leveling = l.report;
    warnings.push(...l.report.warnings);
    if (l.report.mode === "gcode") warnings.push(`bed leveling uses an UNVERIFIED command (${l.report.commands.join("; ")})${p.id === "afinia-qd330" ? ": checklist L1 in docs/SAFETY.md" : ", from the printer catalog"}`);
    // Layer 1 at most 20 mm/s, layer 2 at most 30, travel in both at most 100 mm/s, whatever speed was chosen.
    gcode = capFirstLayers(l.gcode);
  }
  const gcodePath = join(dir, `${base}.gcode`);
  await writeFile(gcodePath, gcode);
  const out = {
    ok: true as const, gcodePath, rawGcodePath: i.gcodePath, rawGcode: raw,
    estimatedTimeS: estimates.printTimeS ?? undefined, filamentMm: estimates.filamentMm ?? undefined,
    estimates, leveling, warnings, ...common,
  };
  if (p.fileFormat === "gcode") return { ...out, printablePath: gcodePath, format: "gcode" };

  const buffer = gxFromGcode(gcode, await thumbnailFor(job), estimates, job.layerHeightMm, job.perimeters);
  const validation = validateGx(buffer);
  const printablePath = join(dir, `${base}.gx`);
  await writeFile(printablePath, buffer);
  if (!validation.ok) warnings.push(`.gx validation failed: ${validation.errors.join("; ")}`);
  warnings.push(".gx layout is UNVERIFIED against official Afinia output: do not send to the printer until compared (docs/QD330.md)");
  return { ...out, printablePath, format: "gx", gx: { buffer, validation, verified: GX_LAYOUT_VERIFIED } };
}
