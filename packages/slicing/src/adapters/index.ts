// The slicer adapters and how the server picks one for a printer.
import type { PrinterModel } from "@morphix/catalog";
import { bambustudio } from "./bambustudio";
import { SPECS, type DetectedSlicer, type DetectOptions } from "./detect";
import type { MorphixSliceJob, MorphixSliceOutput } from "./output";
import { orcaUnsupportedReason } from "./orcafamily";
import { orcaslicer } from "./orcaslicer";
import { prusaslicer, prusaUnsupportedReason } from "./prusaslicer";
import type { SlicerAdapter, SlicerId, SlicerInstall } from "./types";
import type { ExecFileFn } from "../slicer";

export * from "./types";
export { commandFor, detectInstall, installLabel, realFs, SPECS, type DetectedSlicer, type DetectFs, type DetectOptions, type SlicerSpec } from "./detect";
export { distroFamily, hintFor } from "./hints";
export { catalogLevelingPlan, postProcessSafe, type MorphixSliceJob, type MorphixSliceOutput, type ProfileSource } from "./output";
export { orcaArgs } from "./orcafamily";
export { prusaArgs, type PrusaArgs } from "./prusaslicer";
export {
  bedCenter, bedShape, DEFAULT_MAX_SPEED_MMS, DEFAULT_PRINTER_ID, defaultEndGcode, defaultPrinter, defaultStartGcode, filamentFor,
  orcaMachineJson, orcaProcessJson, PRINT_DEFAULTS, printableVolume, printerGcode, printerMaxSpeed, PRINTER_TUNING, printerTuning,
  printerZOffsetMm, prusaFilamentIni, prusaProfileIni, toOrcaPlaceholders, type PrinterTuning, type ProcessChoices,
} from "./profile";
export { readZip, type ZipEntry } from "./zip";

/** An adapter as implemented here: the contract, with Morphix's wider detect options and job / output. */
export interface MorphixSlicerAdapter extends SlicerAdapter {
  detect(opts?: DetectOptions): Promise<DetectedSlicer | null>;
  slice(install: SlicerInstall, job: MorphixSliceJob, deps?: { exec?: ExecFileFn }): Promise<MorphixSliceOutput>;
}

export const SLICERS: Record<SlicerId, MorphixSlicerAdapter> = { prusaslicer, orcaslicer, bambustudio };
export const SLICER_IDS = Object.keys(SLICERS) as SlicerId[];

/** Why `id` can't slice for this printer, or null when it can. */
export function unsupportedReason(id: SlicerId, p: PrinterModel): string | null {
  return id === "prusaslicer" ? prusaUnsupportedReason(p) : orcaUnsupportedReason(id, p);
}

/** Every installed slicer. `paths` are the custom paths from MorphixConfig.slicer.paths. */
export async function detectAll(opts: DetectOptions & { paths?: Partial<Record<SlicerId, string>> } = {}): Promise<DetectedSlicer[]> {
  const { paths, ...rest } = opts;
  const found = await Promise.all(SLICER_IDS.map((id) => SLICERS[id].detect({ ...rest, customPath: paths?.[id] ?? rest.customPath })));
  return found.filter((s): s is DetectedSlicer => !!s);
}

/**
 * Order Morphix tries slicers in when the user has no preference: one the catalog names a
 * vendor profile for comes first, then PrusaSlicer, OrcaSlicer, Bambu Studio (Bambu printers:
 * Bambu Studio, OrcaSlicer).
 */
export function slicerOrder(p: PrinterModel): SlicerId[] {
  const base: SlicerId[] = p.gcodeFlavor === "bambu" || p.fileFormat === "gcode.3mf" ? ["bambustudio", "orcaslicer", "prusaslicer"] : ["prusaslicer", "orcaslicer", "bambustudio"];
  return [...base.filter((id) => p.vendorProfiles?.[id]), ...base.filter((id) => !p.vendorProfiles?.[id])];
}

export type PickResult =
  | { ok: true; adapter: MorphixSlicerAdapter; install: SlicerInstall; warnings: string[] }
  | { ok: false; reason: "slicer-not-installed" | "unsupported-printer"; message: string };

/**
 * Picks the slicer for a printer: `preferred` when it is installed and can make the printer's
 * file, else the first installed one in slicerOrder(). Clear reasons when none fits.
 */
export function pickSlicer(printer: PrinterModel, installs: readonly SlicerInstall[], preferred?: SlicerId, env: { distro?: string; arch?: string } = {}): PickResult {
  const warnings: string[] = [];
  const usable = (s: SlicerInstall) => SLICERS[s.id].supports(printer);
  if (preferred) {
    const mine = installs.find((s) => s.id === preferred);
    if (mine && usable(mine)) return { ok: true, adapter: SLICERS[preferred], install: mine, warnings };
    warnings.push(mine ? `${SPECS[preferred].name} can't slice for this printer: ${unsupportedReason(preferred, printer)}` : `${SPECS[preferred].name} (your preferred slicer) is not installed`);
  }
  for (const id of slicerOrder(printer)) {
    const s = installs.find((x) => x.id === id);
    if (s && usable(s)) return { ok: true, adapter: SLICERS[id], install: s, warnings };
  }
  const able = slicerOrder(printer).filter((id) => unsupportedReason(id, printer) === null);
  const who = `the ${printer.brand} ${printer.model}`;
  if (!able.length) return { ok: false, reason: "unsupported-printer", message: `No slicer Morphix supports can make files for ${who}: ${unsupportedReason(slicerOrder(printer)[0], printer)}` };
  const hint = able.map((id) => `${SPECS[id].name}: ${SLICERS[id].installHint(env)}`).join(" | ");
  const installed = installs.length ? ` (installed: ${installs.map((s) => SPECS[s.id].name).join(", ")}, which can't)` : "";
  return { ok: false, reason: "slicer-not-installed", message: `No slicer installed for ${who}${installed}. Install ${hint}` };
}
