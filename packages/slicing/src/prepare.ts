// preparePrint: the single entry point for the Electron main process.
// Load -> validate -> repair -> scale -> orient -> place -> fit check -> slice -> .gx.
// It never touches the network or the printer; the only process it may start is a
// locally installed slicer (execFile, no shell).
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { isGlb, parseGlb } from "./glb";
import { analyzeGcode, capFirstLayers, type GcodeEstimates } from "./gcode";
import type { FilamentId } from "./filaments";
import { applyLeveling, levelingPlan, type LevelingPlan, type LevelingReport } from "./leveling";
import { GX_LAYOUT_VERIFIED, validateGx, writeGx, type GxValidation } from "./gx";
import { computeBounds, type Mesh, type Vec3 } from "./mesh";
import { applyOrientation, autoOrient, checkFit, DEFAULT_BUILD_VOLUME, placeOnPlate, scaleToHeight, type BuildVolume, type BuildVolumeResult, type OrientationResult } from "./place";
import { QD330_PLA_DEFAULTS } from "./profiles";
import { repairMesh, type RepairOptions, type RepairSummary } from "./repair";
import { sliceStl, type DetectOptions, type ExecFileFn, type SlicerInfo, type SliceResult, type SupportMode } from "./slicer";
import { MeshFormatError, parseStl, writeBinaryStl } from "./stl";
import { gxThumbnailBmp } from "./thumbnail";
import { detectUpAxis, normalizeUpAxis, type UpAxisDetection } from "./upaxis";
import { validateMesh, type ValidationReport } from "./validate";

export type MeshFormat = "stl" | "glb";

export type PrepareStage = "load" | "validate" | "repair" | "place" | "slice" | "gx" | "done";

export interface PreparePrintOptions {
  /** Default true. */
  repair?: boolean | RepairOptions;
  /** "auto" (default) picks a stable lay-flat rotation; "keep" uses the model as given. */
  orientation?: "auto" | "keep";
  supports?: SupportMode;
  layerHeightMm?: number;
  infillPercent?: number;
  /** Brim width in mm (0 = none). Omitted: the slicer profile's value. */
  brimWidthMm?: number;
  /** Perimeters (walls). Omitted: the slicer profile's value. */
  perimeters?: number;
  buildVolume?: BuildVolume;
  /** For GLB: glTF unit -> mm factor before height scaling (default 1000). */
  glbUnitScaleMm?: number;
  /**
   * Source up axis. "auto" (default): GLB is treated as Y-up (glTF spec); STL is detected
   * with detectUpAxis, using `referenceGlb` (or a same-named .glb next to the STL) when
   * available. "z"/"y" force the interpretation for either format.
   */
  upAxis?: "auto" | "z" | "y";
  /** Z-up reference for STL up-axis detection: path or bytes of the same model's GLB. */
  referenceGlb?: string | Uint8Array;
  /** false = stop after the mesh stages (no slicer is run). Default true. */
  slice?: boolean;
  /** Use this slicer, or "none" to skip detection. Default: auto-detect. */
  slicer?: SlicerInfo | "none";
  profilesDir?: string;
  /** Where to write model.stl / model.gcode / model.gx / thumbnail.bmp. Default: temp dir. */
  outputDir?: string;
  /** Base file name for outputs (default "model"). */
  baseName?: string;
  sliceTimeoutMs?: number;
  /** Generic filament profile (default PLA). */
  filament?: FilamentId;
  /** One print speed for every move, first layer included (mm/s, max 600). Omitted: profile speeds. */
  speedMmS?: number;
  /** Nozzle height above the bed for this slice (mm). Omitted: the profile's z_offset. */
  zOffsetMm?: number;
  /**
   * How the bed is levelled before the print (see leveling.ts). Default "gcode": G29 (UNVERIFIED)
   * is written into the start G-code of every print; "printer" leaves it to the QD330's own routine.
   */
  leveling?: LevelingPlan;
  /** Injected process runner (tests). */
  exec?: ExecFileFn;
  /** Slicer auto-detection options (search path, env). */
  detect?: DetectOptions;
  onProgress?: (stage: PrepareStage) => void;
}

export interface PreparePrintInput {
  /** Path to an .stl or .glb file, or */
  inputPath?: string;
  /** raw bytes plus `format`. */
  buffer?: Uint8Array;
  /** Required with `buffer` unless the bytes are self-identifying (GLB magic). */
  format?: MeshFormat;
  /** Final model height in mm (Z, before auto-orientation). Strongly recommended for Meshy output. */
  targetHeightMm?: number | null;
  options?: PreparePrintOptions;
}

export type NotProduced = { ok: false; reason: string; message: string };

export interface PrintEstimates {
  printTimeS: number | null;
  filamentMm: number | null;
  filamentG: number | null;
  layerCount: number | null;
  /** "slicer": from the slicer's G-code; "mesh-heuristic": rough guess from volume (no slicer). */
  source: "slicer" | "mesh-heuristic";
}

export interface PreparePrintResult {
  /** True when a .gx was produced. It is still UNVERIFIED and must not be sent to the printer yet. */
  ok: boolean;
  format: MeshFormat;
  /** How the source up axis was decided (the mesh is always converted to Z-up). */
  upAxis: UpAxisDetection;
  report: { input: ValidationReport; final: ValidationReport };
  repair: RepairSummary | null;
  /** Uniform scale applied after unit conversion (1 when no target height). */
  scale: number;
  orientation: OrientationResult;
  /** Final printed size (mm) after scale + orientation. */
  size: Vec3;
  fits: BuildVolumeResult;
  /** Binary STL, repaired, oriented, centred on the plate with min Z = 0 (mm). */
  repairedStl: Buffer;
  thumbnailBmp: Buffer;
  slicer: SliceResult | NotProduced;
  /** Slicer G-code analysis (estimates), when sliced. */
  gcode: { path: string; estimates: GcodeEstimates } | null;
  /** How the bed gets levelled for this print (null when not sliced). */
  leveling: LevelingReport | null;
  gx: { ok: true; buffer: Buffer; validation: GxValidation; verified: typeof GX_LAYOUT_VERIFIED } | NotProduced;
  estimates: PrintEstimates;
  files: { dir: string; stl: string; thumbnail: string; gcode?: string; gx?: string };
  warnings: string[];
}

/**
 * Loads a mesh from path or buffer and normalises it to printer Z-up (mm for STL; glTF
 * units x glbUnitScaleMm for GLB). Throws MeshFormatError on unreadable input.
 */
export async function loadMesh(
  input: Pick<PreparePrintInput, "inputPath" | "buffer" | "format">,
  opts: Pick<PreparePrintOptions, "glbUnitScaleMm" | "upAxis" | "referenceGlb"> = {},
): Promise<{ mesh: Mesh; format: MeshFormat; upAxis: UpAxisDetection; warnings: string[] }> {
  let buf: Uint8Array;
  let format = input.format;
  if (input.buffer) buf = input.buffer;
  else if (input.inputPath) {
    buf = await readFile(input.inputPath);
    const ext = extname(input.inputPath).toLowerCase();
    if (!format && (ext === ".stl" || ext === ".glb")) format = ext.slice(1) as MeshFormat;
  } else throw new MeshFormatError("preparePrint needs inputPath or buffer");
  if (!format) format = isGlb(buf) ? "glb" : "stl";
  const warnings: string[] = [];
  const forced = opts.upAxis && opts.upAxis !== "auto" ? opts.upAxis : null;
  if (format === "glb") {
    const axis = forced ?? "y";
    const r = parseGlb(buf, { unitScaleMm: opts.glbUnitScaleMm, zUp: axis === "y" });
    for (const s of r.skippedPrimitives) warnings.push(`GLB mesh ${s.mesh} primitive ${s.primitive} skipped: ${s.reason}`);
    const upAxis: UpAxisDetection = forced
      ? { axis, method: "default", reason: `forced by options.upAxis = "${axis}"` }
      : { axis, method: "default", reason: "glTF is Y-up by specification" };
    return { mesh: r.mesh, format, upAxis, warnings };
  }
  const raw = parseStl(buf);
  if (forced) return { mesh: normalizeUpAxis(raw, forced), format, upAxis: { axis: forced, method: "default", reason: `forced by options.upAxis = "${forced}"` }, warnings };
  let reference: Mesh | undefined;
  let refSource = opts.referenceGlb;
  if (!refSource && input.inputPath) {
    const sibling = join(dirname(input.inputPath), `${basename(input.inputPath, extname(input.inputPath))}.glb`);
    if (existsSync(sibling)) refSource = sibling;
  }
  if (refSource) {
    try {
      reference = parseGlb(typeof refSource === "string" ? await readFile(refSource) : refSource).mesh;
    } catch (e) {
      warnings.push(`reference GLB ignored: ${(e as Error).message}`);
    }
  }
  const upAxis = detectUpAxis(raw, reference);
  if (upAxis.method === "default") warnings.push(`STL up axis unknown: ${upAxis.reason}`);
  return { mesh: normalizeUpAxis(raw, upAxis.axis), format, upAxis, warnings };
}

export async function preparePrint(input: PreparePrintInput): Promise<PreparePrintResult> {
  const o = input.options ?? {};
  const progress = (s: PrepareStage) => o.onProgress?.(s);
  const volume = o.buildVolume ?? DEFAULT_BUILD_VOLUME;

  progress("load");
  const loaded = await loadMesh(input, o);
  const warnings = [...loaded.warnings];
  let mesh = loaded.mesh;

  progress("validate");
  const inputReport = validateMesh(mesh);
  if (loaded.format === "glb" && !input.targetHeightMm) warnings.push("GLB without targetHeightMm: size assumes glTF metres, which Meshy output often is not");

  progress("repair");
  let repair: RepairSummary | null = null;
  if (o.repair !== false) {
    const r = repairMesh(mesh, typeof o.repair === "object" ? o.repair : {});
    mesh = r.mesh;
    repair = r.summary;
  }

  progress("place");
  let scale = 1;
  if (input.targetHeightMm) {
    const s = scaleToHeight(mesh, input.targetHeightMm);
    mesh = s.mesh;
    scale = s.scale;
  }
  const orientation = autoOrient(mesh, o.orientation === "keep" ? { keepBias: Infinity } : {});
  mesh = applyOrientation(mesh, orientation);
  mesh = placeOnPlate(mesh, volume).mesh;
  const size = computeBounds(mesh).size;
  const fits = checkFit(size, volume);
  const finalReport = validateMesh(mesh);
  if (!finalReport.watertight) warnings.push("mesh is not watertight after repair; the slicer will attempt its own repair");

  const dir = o.outputDir ?? (await mkdtemp(join(tmpdir(), "morphix-prepare-")));
  await mkdir(dir, { recursive: true });
  const base = o.baseName ?? "model";
  const repairedStl = writeBinaryStl(mesh, "Morphix repaired, plate-centred (mm)");
  const thumbnailBmp = gxThumbnailBmp(mesh);
  const files: PreparePrintResult["files"] = { dir, stl: join(dir, `${base}.stl`), thumbnail: join(dir, `${base}-thumb.bmp`) };
  await writeFile(files.stl, repairedStl);
  await writeFile(files.thumbnail, thumbnailBmp);

  const result: PreparePrintResult = {
    ok: false,
    format: loaded.format,
    upAxis: loaded.upAxis,
    report: { input: inputReport, final: finalReport },
    repair,
    scale,
    orientation,
    size,
    fits,
    repairedStl,
    thumbnailBmp,
    slicer: { ok: false, reason: "skipped", message: "slicing not attempted" },
    gcode: null,
    leveling: null,
    gx: { ok: false, reason: "not-sliced", message: "no G-code to wrap" },
    estimates: heuristicEstimates(finalReport),
    files,
    warnings,
  };

  if (!fits.fits) {
    result.slicer = { ok: false, reason: "too-large", message: fits.message };
    result.gx = { ok: false, reason: "too-large", message: fits.message };
    progress("done");
    return result;
  }
  if (o.slice === false || o.slicer === "none") {
    result.slicer = { ok: false, reason: "skipped", message: "slicing disabled by options" };
    progress("done");
    return result;
  }

  progress("slice");
  const sliced = await sliceStl({
    stlPath: files.stl,
    outDir: join(dir, "slice"),
    slicer: o.slicer,
    supports: o.supports,
    layerHeightMm: o.layerHeightMm,
    infillPercent: o.infillPercent,
    brimWidthMm: o.brimWidthMm,
    perimeters: o.perimeters,
    centerMm: { x: 0, y: 0 }, // QD330 bed is centre-origin (-110..110)
    filament: o.filament,
    speedMmS: o.speedMmS,
    zOffsetMm: o.zOffsetMm,
    profilesDir: o.profilesDir,
    timeoutMs: o.sliceTimeoutMs,
    exec: o.exec,
    detect: o.detect,
  });
  result.slicer = sliced;
  if (!sliced.ok) {
    result.gx = { ok: false, reason: sliced.reason, message: sliced.message };
    progress("done");
    return result;
  }
  files.gcode = join(dir, `${base}.gcode`);
  const levelled = applyLeveling(sliced.gcode, o.leveling ?? levelingPlan());
  result.leveling = levelled.report;
  warnings.push(...levelled.report.warnings);
  if (levelled.report.mode === "gcode") warnings.push(`bed leveling uses an UNVERIFIED command (${levelled.report.commands.join("; ")}): checklist L1 in docs/PHASE5.md`);
  // Layer 1 at most 20 mm/s, layer 2 at most 30, travel in both at most 100 mm/s, whatever speed was chosen.
  const gcodeText = capFirstLayers(levelled.gcode);
  await writeFile(files.gcode, gcodeText);
  const est = sliced.estimates;
  result.gcode = { path: files.gcode, estimates: est };
  result.estimates = { printTimeS: est.printTimeS, filamentMm: est.filamentMm, filamentG: est.filamentG, layerCount: est.layerCount, source: "slicer" };

  progress("gx");
  const gx = gxFromGcode(gcodeText, thumbnailBmp, est, o.layerHeightMm, o.perimeters);
  const validation = validateGx(gx);
  files.gx = join(dir, `${base}.gx`);
  await writeFile(files.gx, gx);
  result.gx = { ok: true, buffer: gx, validation, verified: GX_LAYOUT_VERIFIED };
  result.ok = validation.ok;
  if (!validation.ok) warnings.push(`.gx validation failed: ${validation.errors.join("; ")}`);
  warnings.push(".gx layout is UNVERIFIED against official Afinia output: do not send to the printer until compared (docs/PHASE3.md)");
  progress("done");
  return result;
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

/**
 * Very rough estimate when no slicer is available: shell (2 x 0.45 mm walls over the surface)
 * plus 15 % of the remaining volume, printed at ~5 mm^3/s. For UI hints only.
 */
export function heuristicEstimates(report: ValidationReport): PrintEstimates {
  const d = QD330_PLA_DEFAULTS;
  const shell = Math.min(report.volumeMm3, report.surfaceAreaMm2 * d.perimeters * 0.45);
  const material = shell + Math.max(0, report.volumeMm3 - shell) * (d.infillPercent / 100);
  const area = Math.PI * (d.filamentDiameterMm / 2) ** 2;
  return {
    printTimeS: material > 0 ? Math.round(material / 5 + 300) : null,
    filamentMm: material > 0 ? material / area : null,
    filamentG: material > 0 ? (material / 1000) * d.filamentDensityGcm3 : null,
    layerCount: report.bounds.size.z > 0 ? Math.ceil(report.bounds.size.z / d.layerHeightMm) : null,
    source: "mesh-heuristic",
  };
}
