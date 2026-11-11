// prepareWithAdvice: preparePrint with the AI slicer advisor in the middle.
//   1. mesh stages (load, validate, repair, scale, orient, place) with slicing off
//   2. overhang analysis of the prepared mesh + adviseSlicing()
//   3. (only if the advisor wants the original pose back) mesh stages again with "keep"
//   4. slicing + .gx from the prepared STL with the advised settings
// Settings the caller passes explicitly in `options` always win over the advice.
import { adviseSlicing, overhangStats, type AdvisorGeminiOptions, type IntendedUse, type OverhangStats, type SlicingAdvice } from "./advisor";
import { detectAll, SLICERS } from "./adapters";
import { defaultPrinter, printableVolume } from "./adapters/profile";
import { preparePrint, type PreparePrintInput, type PreparePrintResult, type PrepareStage } from "./prepare";
import { toSlicerInfo, type SlicerInfo, type SupportMode } from "./slicer";
import { parseStl } from "./stl";

export type AdvisedPrepareStage = PrepareStage | "advise";

export interface PrepareWithAdviceInput extends PreparePrintInput {
  intendedUse?: IntendedUse;
  description?: string;
  /** Gemini refinement (see advisorGeminiFromEnv). Omitted/false = heuristic only. */
  gemini?: AdvisorGeminiOptions | false;
  /** Installed slicers, if already known (skips detection). */
  availableSlicers?: SlicerInfo[];
  /** Progress including the extra "advise" stage. Falls back to options.onProgress. */
  onProgress?: (stage: AdvisedPrepareStage) => void;
}

/** What was actually passed to the slicer, and where each value came from. */
export interface AppliedSettings {
  slicer: SlicerInfo | null;
  supports: SupportMode;
  layerHeightMm: number;
  infillPercent: number;
  perimeters: number;
  brimWidthMm: number;
  orientation: "auto" | "keep";
  /** Settings taken from the caller's options instead of the advice. */
  overriddenByCaller: string[];
}

export interface PrepareWithAdviceResult extends PreparePrintResult {
  advice: SlicingAdvice;
  overhang: OverhangStats;
  applied: AppliedSettings;
}

export async function prepareWithAdvice(input: PrepareWithAdviceInput): Promise<PrepareWithAdviceResult> {
  const o = input.options ?? {};
  const progress = (s: AdvisedPrepareStage) => (input.onProgress ?? (o.onProgress as ((s: AdvisedPrepareStage) => void) | undefined))?.(s);
  const meshStages = (s: PrepareStage) => {
    if (s !== "done") progress(s);
  };

  // 1. Mesh stages only.
  let first = await preparePrint({ ...input, options: { ...o, slice: false, onProgress: meshStages } });

  // 2. Advice.
  const printer = o.printer ?? defaultPrinter();
  const given = o.slicer && o.slicer !== "none" ? ("id" in o.slicer ? toSlicerInfo(o.slicer) : o.slicer) : null;
  const slicers: SlicerInfo[] = given
    ? [given]
    : input.availableSlicers ??
      (o.slicer === "none"
        ? []
        : (await detectAll({ exec: o.exec, skipVersion: true, ...o.detect, paths: o.slicerPaths })).filter((s) => SLICERS[s.id].supports(printer)).map(toSlicerInfo));
  progress("advise");
  const advise = (r: PreparePrintResult, overhang: OverhangStats, lock?: "keep") =>
    adviseSlicing(
      {
        size: r.size,
        validation: r.report.final,
        overhang,
        orientation: r.orientation,
        intendedUse: input.intendedUse,
        description: input.description,
        availableSlicers: slicers,
        buildVolume: o.buildVolume ?? printableVolume(printer),
        lockOrientation: lock ?? (o.orientation === "keep" ? "keep" : undefined),
      },
      { gemini: input.gemini },
    );
  let overhang = overhangStats(parseStl(first.repairedStl));
  let advice = await advise(first, overhang);

  // 3. The advisor prefers the original pose and the caller left orientation to us.
  if (advice.orientation === "keep" && !first.orientation.unchanged && o.orientation === undefined) {
    first = await preparePrint({ ...input, options: { ...o, orientation: "keep", slice: false } });
    overhang = overhangStats(parseStl(first.repairedStl));
    advice = await advise(first, overhang, "keep");
  }

  const overridden: string[] = [];
  const pick = <T>(name: string, mine: T | undefined, advised: T): T => {
    if (mine === undefined) return advised;
    overridden.push(name);
    return mine;
  };
  const slicer = given ?? slicers.find((s) => s.kind === advice.slicer) ?? null;
  if (o.slicer && o.slicer !== "none") overridden.push("slicer");
  const applied: AppliedSettings = {
    slicer,
    supports: pick("supports", o.supports, advice.supports),
    layerHeightMm: pick("layerHeightMm", o.layerHeightMm, advice.layerHeightMm),
    infillPercent: pick("infillPercent", o.infillPercent, advice.infillPercent),
    perimeters: pick("perimeters", o.perimeters, advice.walls),
    brimWidthMm: pick("brimWidthMm", o.brimWidthMm, advice.brim ? advice.brimWidthMm : 0),
    orientation: pick("orientation", o.orientation, advice.orientation),
    overriddenByCaller: overridden,
  };

  const done = (r: PreparePrintResult): PrepareWithAdviceResult => {
    progress("done");
    return { ...r, advice, overhang, applied };
  };
  if (!first.fits.fits || o.slice === false || o.slicer === "none") {
    return done({
      ...first,
      slicer: first.fits.fits ? first.slicer : { ok: false, reason: "too-large", message: first.fits.message },
      gx: first.fits.fits ? first.gx : { ok: false, reason: "too-large", message: first.fits.message },
    });
  }

  // 4. Slice the prepared STL (already repaired, oriented and on the plate).
  const second = await preparePrint({
    buffer: first.repairedStl,
    format: "stl",
    targetHeightMm: null,
    options: {
      ...o,
      repair: false,
      orientation: "keep",
      upAxis: "z",
      referenceGlb: undefined,
      slicer: slicer ?? undefined,
      supports: applied.supports,
      layerHeightMm: applied.layerHeightMm,
      infillPercent: applied.infillPercent,
      perimeters: applied.perimeters,
      // Only pass a brim when one is wanted, so the profile stays authoritative otherwise.
      brimWidthMm: applied.brimWidthMm > 0 || o.brimWidthMm !== undefined ? applied.brimWidthMm : undefined,
      outputDir: first.files.dir,
      onProgress: (s) => {
        if (s === "slice" || s === "gx") progress(s);
      },
    },
  });
  return done({
    ...second,
    format: first.format,
    upAxis: first.upAxis,
    report: { input: first.report.input, final: second.report.final },
    repair: first.repair,
    scale: first.scale,
    orientation: first.orientation,
    warnings: [...new Set([...first.warnings, ...second.warnings])],
  });
}
