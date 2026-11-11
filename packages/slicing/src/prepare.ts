// preparePrint: the single entry point for the server / Electron main process.
// Load -> validate -> repair -> scale -> orient -> place -> fit check -> slice -> printable file
// (.gcode, .gx or .gcode.3mf, whatever the printer takes). It never touches the network or
// the printer; the only process it may start is a locally installed slicer (execFile, no shell).
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { PrinterModel } from "@morphix/catalog";
import { detectAll, pickSlicer, SLICERS, unsupportedReason, type PickResult } from "./adapters";
import type { DetectOptions } from "./adapters/detect";
import type { SlicerId, SlicerInstall } from "./adapters/types";
import { defaultPrinter, printableVolume } from "./adapters/profile";
import { isGlb, parseGlb } from "./glb";
import type { GcodeEstimates } from "./gcode";
import type { FilamentId } from "./filaments";
import type { LevelingPlan, LevelingReport } from "./leveling";
import type { GX_LAYOUT_VERIFIED, GxValidation } from "./gx";
import { computeBounds, type Mesh, type Vec3 } from "./mesh";
import { applyOrientation, autoOrient, checkFit, placeOnPlate, scaleToHeight, type BuildVolume, type BuildVolumeResult, type OrientationResult } from "./place";
import { QD330_PLA_DEFAULTS } from "./profiles";
import { repairMesh, type RepairOptions, type RepairSummary } from "./repair";
import { toSlicerInfo, toSlicerInstall, type ExecFileFn, type SlicerInfo, type SliceResult, type SupportMode } from "./slicer";
import { MeshFormatError, parseStl, writeBinaryStl } from "./stl";
import { gxThumbnailBmp } from "./thumbnail";
import { detectUpAxis, normalizeUpAxis, type UpAxisDetection } from "./upaxis";
import { validateMesh, type ValidationReport } from "./validate";

export type MeshFormat = "stl" | "glb";

export type PrepareStage = "load" | "validate" | "repair" | "place" | "slice" | "gx" | "done";

export { gxFromGcode } from "./adapters/output";

export interface PreparePrintOptions {
  /** Catalog printer to prepare for. Default: the Afinia QD330 (Morphix's original printer). */
  printer?: PrinterModel;
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
  /** Default: the printer's bed (a round bed's inscribed square). */
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
  /** Use this slicer, or "none" to skip detection. Default: detect, then pickSlicer(). */
  slicer?: SlicerInfo | SlicerInstall | "none";
  /** Preferred slicer when several are installed (MorphixConfig.slicer.preferred). */
  preferredSlicer?: SlicerId;
  /** Custom executable per slicer (MorphixConfig.slicer.paths). */
  slicerPaths?: Partial<Record<SlicerId, string>>;
  /** false = ignore the catalog's vendorProfiles and use Morphix's generated profile. Default true. */
  useVendorProfile?: boolean;
  /** @deprecated ignored: profiles are generated from the printer catalog (adapters/profile.ts). */
  profilesDir?: string;
  /** Where to write model.stl / model.gcode / model.gx|.gcode.3mf / thumbnail.bmp. Default: temp dir. */
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
   * How the bed is levelled before the print (see leveling.ts). Default: the catalog's
   * autoLevel command (G29 for the QD330, UNVERIFIED) written into the start G-code of every
   * print; "printer" leaves it to the printer's own routine. Plain G-code printers only.
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
  /** True when the printable file was produced (a .gx also validated). Still UNVERIFIED until printed. */
  ok: boolean;
  /** Catalog id of the printer this was prepared for. */
  printerId: string;
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
  /** How the bed gets levelled for this print (null when not sliced or not post-processed). */
  leveling: LevelingReport | null;
  /** FlashForge .gx (only for printers whose fileFormat is "gx"). */
  gx: { ok: true; buffer: Buffer; validation: GxValidation; verified: typeof GX_LAYOUT_VERIFIED } | NotProduced;
  /** The file to send to the printer, in printer.fileFormat. */
  printable: { ok: true; path: string; format: PrinterModel["fileFormat"] } | NotProduced;
  estimates: PrintEstimates;
  /** gcode: plain G-code for the preview (post-processed for plain printers, extracted from a .gcode.3mf). */
  files: { dir: string; stl: string; thumbnail: string; gcode?: string; gx?: string; printable?: string };
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
  const printer = o.printer ?? defaultPrinter();
  const volume = o.buildVolume ?? printableVolume(printer);

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
    printerId: printer.id,
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
    printable: { ok: false, reason: "not-sliced", message: "slicing not attempted" },
    estimates: heuristicEstimates(finalReport),
    files,
    warnings,
  };

  if (!fits.fits) {
    result.slicer = { ok: false, reason: "too-large", message: fits.message };
    result.gx = { ok: false, reason: "too-large", message: fits.message };
    result.printable = { ok: false, reason: "too-large", message: fits.message };
    progress("done");
    return result;
  }
  if (o.slice === false || o.slicer === "none") {
    result.slicer = { ok: false, reason: "skipped", message: "slicing disabled by options" };
    result.printable = { ok: false, reason: "skipped", message: "slicing disabled by options" };
    progress("done");
    return result;
  }

  progress("slice");
  const fail = (reason: string, message: string) => {
    result.gx = { ok: false, reason, message };
    result.printable = { ok: false, reason, message };
    progress("done");
    return result;
  };
  const chosen = await chooseSlicer(printer, o);
  if (!chosen.ok) {
    result.slicer = { ok: false, reason: chosen.reason, message: chosen.message };
    return fail(chosen.reason, chosen.message);
  }
  warnings.push(...chosen.warnings);
  const sliced = await chosen.adapter.slice(
    chosen.install,
    {
      modelPath: files.stl,
      outDir: join(dir, "slice"),
      printableDir: dir,
      baseName: base,
      printer,
      filament: o.filament ?? "pla",
      layerHeightMm: o.layerHeightMm,
      infillPercent: o.infillPercent,
      supports: o.supports,
      brimWidthMm: o.brimWidthMm,
      perimeters: o.perimeters,
      speedMmS: o.speedMmS,
      zOffsetMm: o.zOffsetMm,
      timeoutMs: o.sliceTimeoutMs,
      leveling: o.leveling,
      thumbnailBmp,
      useVendorProfile: o.useVendorProfile,
    },
    { exec: o.exec },
  );
  const info = toSlicerInfo(chosen.install);
  if (!sliced.ok) {
    result.slicer = { ok: false, reason: sliced.reason, message: sliced.message, slicer: info, args: sliced.args, log: sliced.log };
    return fail(sliced.reason, sliced.message);
  }
  const est = sliced.estimates;
  result.slicer = {
    ok: true, slicer: info, gcodePath: sliced.rawGcodePath ?? "", gcode: sliced.rawGcode ?? "", estimates: est ?? emptyEstimates(),
    args: sliced.args, durationMs: sliced.durationMs, profileVerified: false, log: sliced.log,
  };
  result.leveling = sliced.leveling;
  warnings.push(...sliced.warnings);
  if (sliced.gcodePath) {
    files.gcode = sliced.gcodePath;
    if (est) result.gcode = { path: sliced.gcodePath, estimates: est };
  }
  if (est) result.estimates = { printTimeS: est.printTimeS, filamentMm: est.filamentMm, filamentG: est.filamentG, layerCount: est.layerCount, source: "slicer" };
  files.printable = sliced.printablePath;
  result.printable = { ok: true, path: sliced.printablePath, format: sliced.format };
  if (sliced.gx) {
    progress("gx");
    files.gx = sliced.printablePath;
    result.gx = { ok: true, buffer: sliced.gx.buffer, validation: sliced.gx.validation, verified: sliced.gx.verified };
    result.ok = sliced.gx.validation.ok;
  } else {
    result.gx = { ok: false, reason: "not-gx", message: `the ${printer.brand} ${printer.model} takes .${sliced.format} files, not .gx` };
    result.ok = true;
  }
  progress("done");
  return result;
}

/** The slicer to use: the one passed in (if it can make this printer's file), else detect + pickSlicer(). */
async function chooseSlicer(printer: PrinterModel, o: PreparePrintOptions): Promise<PickResult> {
  if (o.slicer && o.slicer !== "none") {
    const install = toSlicerInstall(o.slicer);
    const why = unsupportedReason(install.id, printer);
    if (why) return { ok: false, reason: "unsupported-printer", message: why };
    return { ok: true, adapter: SLICERS[install.id], install, warnings: [] };
  }
  const installs = await detectAll({ exec: o.exec, skipVersion: true, ...o.detect, paths: o.slicerPaths });
  return pickSlicer(printer, installs, o.preferredSlicer);
}

function emptyEstimates(): GcodeEstimates {
  return { printTimeS: null, filamentMm: null, filamentG: null, filamentCm3: null, layerCount: 0, layerHeightMm: null, maxZMm: 0, nozzleTempC: null, bedTempC: null, generator: null, source: { time: null, filament: null } };
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
