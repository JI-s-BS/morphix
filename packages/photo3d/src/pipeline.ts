// photoToModel: analyse -> (ask questions?) -> engine (scan | openscad -> meshy fallback)
// -> repair, place on bed, scale, check dimensions -> files + report.
import { QD330_BUILD_VOLUME_MM } from "@morphix/shared";
import {
  computeBounds,
  parseGlb,
  parseStl,
  repairMesh,
  validateMesh,
  writeBinaryStl,
  type Mesh,
  type RepairSummary,
  type Vec3,
} from "@morphix/slicing";
import { analyzePhotos, type Dimensions, type Engine, type PhotoAnalysis, type ReferenceObject } from "./analyze";
import { checkDimensions, chooseScaleAxis, fmt, placeOnBed, scaleToDimension, type DimensionCheck } from "./dimensions";
import { issue, Photo3dError, throwIfAborted, toIssue, type P3dIssue } from "./errors";
import type { GeminiJsonClient } from "./gemini";
import { checkPhotos, MESHY_IMAGE_MIMES, type Axis, type CheckedPhoto, type Measurement, type PhotoInput } from "./images";
import { meshyImageCost, type MeshyImageClient, type MeshyImageKind, type MeshyImageOptions } from "./meshy-image";
import { designWithOpenscad, type OpenscadAttempt, type OpenscadRunOptions } from "./openscad";
import { importScan, type ScanImport, type ScanImportOptions } from "./scan";

export type Photo3dStage = "validate" | "analyze" | "questions" | "design" | "compile" | "generate" | "download" | "import" | "verify" | "done" | "failed";

export interface Photo3dProgress {
  stage: Photo3dStage;
  /** Overall 0-100. */
  progress: number;
  detail: string;
}

export interface PhotoToModelRequest {
  images?: PhotoInput[];
  description: string;
  measurements?: Measurement[];
  referenceObject?: ReferenceObject;
  /** A 3D scan (OBJ/PLY/STL/GLB); when present the scan engine is used. */
  scan?: { name: string; bytes: Uint8Array } & ScanImportOptions;
  /** Force an engine; "auto" (default) follows the analysis. */
  engine?: "auto" | Engine;
  /** Answers to a previous `needsAnswers` result (re-runs the analysis with them). */
  answers?: { question: string; answer: string }[];
  /** Build with the best guesses instead of asking. */
  skipQuestions?: boolean;
  /** Reuse an earlier analysis (no Gemini analysis call). */
  analysis?: PhotoAnalysis;
  /** User-confirmed overall size in mm; overrides the estimate per axis. */
  dimensionsMm?: Partial<Record<Axis, number>>;
  /** Resume a Meshy task after a restart instead of creating (and paying for) a new one. */
  resumeMeshyTask?: { kind: MeshyImageKind; id: string };
  meshy?: MeshyImageOptions;
}

export interface PhotoToModelDeps {
  gemini?: GeminiJsonClient;
  meshy?: MeshyImageClient;
  openscad?: OpenscadRunOptions & { maxAttempts?: number };
  /** Defaults for Meshy tasks (ai_model etc.); `request.meshy` overrides them. */
  meshyDefaults?: MeshyImageOptions;
  /** Refuse Meshy engines that would cost more than this. Default: no limit. */
  maxCredits?: number;
  /** Fall back from openscad to Meshy when OpenSCAD fails. Default true. */
  allowFallback?: boolean;
  /** Persist this to resume a Meshy task later. */
  onMeshyTask?: (t: { kind: MeshyImageKind; id: string }) => void;
  signal?: AbortSignal;
}

export interface EngineAttempt {
  engine: Engine;
  ok: boolean;
  error?: P3dIssue;
}

export interface PhotoToModelReport {
  objectName: string;
  category: "functional" | "decorative" | null;
  engineReason: string;
  attempts: EngineAttempt[];
  geminiModel: string | null;
  openscad?: { attempts: Omit<OpenscadAttempt, "code">[] };
  meshy?: { taskId: string; kind: MeshyImageKind; scaledBy: Axis; scaleFactor: number };
  scan?: Omit<ScanImport, "mesh">;
  repair: Pick<RepairSummary, "verticesMerged" | "degenerateFacesRemoved" | "facesFlipped" | "shellsRemoved" | "notes">;
  validation: { triangles: number; watertight: boolean; manifold: boolean; printable: boolean; volumeMm3: number; issues: string[] };
  fitsBuildVolume: boolean;
}

export interface PhotoToModelDone {
  status: "done";
  files: { stl: Buffer; glb?: Buffer; scad?: string; thumbnail?: Buffer };
  engine: Engine;
  dimensions: { intended: Dimensions | null; actualMm: Vec3; check: DimensionCheck | null };
  analysis: PhotoAnalysis | null;
  report: PhotoToModelReport;
  warnings: P3dIssue[];
  costCredits: number;
}

export interface PhotoToModelNeedsAnswers {
  status: "needsAnswers";
  analysis: PhotoAnalysis;
  questions: string[];
  warnings: P3dIssue[];
  costCredits: 0;
}

export interface PhotoToModelFailed {
  status: "failed";
  error: P3dIssue;
  attempts: EngineAttempt[];
  analysis: PhotoAnalysis | null;
  warnings: P3dIssue[];
  costCredits: number;
}

export type PhotoToModelResult = PhotoToModelDone | PhotoToModelNeedsAnswers | PhotoToModelFailed;

interface EngineOutput {
  mesh: Mesh;
  /** True when the mesh already has real-world size (scan, OpenSCAD). */
  sized: boolean;
  glb?: Buffer;
  scad?: string;
  thumbnail?: Buffer;
  credits: number;
  check?: DimensionCheck;
  report: Partial<PhotoToModelReport>;
  warnings?: P3dIssue[];
}

/** Never throws: failures come back as `{ status: "failed", error: { code: "MX-P3D-nnn" } }`. */
export async function photoToModel(
  request: PhotoToModelRequest,
  deps: PhotoToModelDeps,
  onProgress: (p: Photo3dProgress) => void = () => undefined,
): Promise<PhotoToModelResult> {
  const warnings: P3dIssue[] = [];
  const attempts: EngineAttempt[] = [];
  let analysis: PhotoAnalysis | null = request.analysis ?? null;
  let last = 0;
  const emit = (stage: Photo3dStage, progress: number, detail: string) => {
    last = Math.max(last, Math.min(100, Math.round(progress)));
    onProgress({ stage, progress: last, detail });
  };
  const fail = (e: unknown, credits = 0): PhotoToModelFailed => {
    const error = toIssue(e);
    emit("failed", last, `${error.code}: ${error.message}`);
    return { status: "failed", error, attempts, analysis, warnings, costCredits: credits };
  };

  try {
    emit("validate", 1, "Checking the photos");
    if (!(request.description ?? "").trim()) throw new Photo3dError("MX-P3D-001", "Describe what to make.");
    const photos = checkPhotos(request.images, { allowEmpty: !!request.scan });

    // 1. Analysis.
    if (!analysis) {
      const canAnalyze = !!deps.gemini?.available;
      if (photos.length && !canAnalyze && !request.scan) throw new Photo3dError("MX-P3D-010");
      if (photos.length && canAnalyze) {
        emit("analyze", 5, "Gemini is looking at the photos");
        try {
          analysis = await analyzePhotos(
            { images: request.images ?? [], description: request.description, measurements: request.measurements, referenceObject: request.referenceObject, hasScanFile: !!request.scan, answers: request.answers },
            { gemini: deps.gemini!, signal: deps.signal },
          );
        } catch (e) {
          // A scan can still be imported without the analysis.
          if (!request.scan || isCancel(e)) throw e;
          warnings.push(toIssue(e));
        }
      }
    }
    if (analysis && request.dimensionsMm) analysis = withDimensions(analysis, request.dimensionsMm);
    if (analysis) emit("analyze", 20, `Looks like: ${analysis.object.name} (~${dimsText(analysis.dimensions)} mm)`);

    // 2. Questions.
    if (analysis?.needsAnswers && !request.skipQuestions && !request.answers?.length && !request.dimensionsMm && !request.scan) {
      emit("questions", 20, "A few questions would make the size more accurate");
      return { status: "needsAnswers", analysis, questions: analysis.questions, warnings, costCredits: 0 };
    }
    if (analysis) {
      const low = (Object.keys(analysis.dimensions) as Axis[]).filter((a) => analysis!.dimensions[a].confidence < 0.5);
      if (low.length) warnings.push(issue("MX-P3D-053", `Low-confidence estimate for ${low.join(", ")}; check the size before printing.`));
    }

    // 3. Engines.
    const order = engineOrder(request, analysis, photos, deps.allowFallback !== false);
    let out: EngineOutput | null = null;
    let engine: Engine = order[0];
    for (const e of order) {
      throwIfAborted(deps.signal);
      engine = e;
      try {
        out = await runEngine(e, request, deps, analysis, photos, emit);
        attempts.push({ engine: e, ok: true });
        break;
      } catch (err) {
        if (isCancel(err)) throw err;
        attempts.push({ engine: e, ok: false, error: toIssue(err) });
        const next = order[order.indexOf(e) + 1];
        if (next) emit(e === "openscad" ? "compile" : "generate", last, `${e} failed (${toIssue(err).code}); trying ${next}`);
      }
    }
    if (!out) {
      const errs = attempts.map((a) => a.error!).filter(Boolean);
      if (errs.length === 1) return fail(new Photo3dError(errs[0].code, errs[0].message, errs[0].detail));
      return fail(new Photo3dError("MX-P3D-091", `No engine produced a model: ${errs.map((x) => `${x.code} ${x.message}`).join(" | ")}`));
    }

    warnings.push(...(out.warnings ?? []));

    // 4. Verify: repair, scale (Meshy), place, check.
    emit("verify", 92, "Checking the model for printing");
    const repaired = repairMesh(out.mesh);
    let mesh = repaired.mesh;
    let check = out.check ?? null;
    let meshyScale: { axis: Axis; factor: number } | undefined;
    if (!out.sized && analysis) {
      const axis = chooseScaleAxis(analysis.dimensions);
      const s = scaleToDimension(mesh, axis, analysis.dimensions[axis].valueMm);
      mesh = s.mesh;
      meshyScale = { axis, factor: s.factor };
    }
    mesh = placeOnBed(mesh);
    const size = computeBounds(mesh).size;
    if (!out.sized || engine === "scan") {
      // Proportions from Meshy or a scan are informative only: wider tolerance.
      check = analysis ? checkDimensions(size, analysis.dimensions, 0.1) : null;
    }
    // Meshy proportions are only a warning when the part is mechanical (they are guesses otherwise).
    if (check && !check.ok && (out.sized || analysis?.object.mechanical)) warnings.push(issue("MX-P3D-050", check.summary));
    const v = validateMesh(mesh);
    if (!v.printable) warnings.push(issue("MX-P3D-052", `Mesh problems: ${v.issues.slice(0, 3).join("; ")}`));
    const vol = QD330_BUILD_VOLUME_MM;
    const fits = size.x <= vol.x && size.y <= vol.y && size.z <= vol.z;
    if (!fits) warnings.push(issue("MX-P3D-051", `Model is ${fmt(size)} mm; the printer fits ${vol.x} x ${vol.y} x ${vol.z} mm. Scale it down or split it.`));

    const report: PhotoToModelReport = {
      objectName: analysis?.object.name ?? request.scan?.name ?? "model",
      category: analysis?.object.category ?? null,
      engineReason: analysis?.engineReason ?? (request.scan ? "A 3D scan file was provided." : ""),
      attempts,
      geminiModel: analysis?.model ?? null,
      ...out.report,
      ...(meshyScale && out.report.meshy ? { meshy: { ...out.report.meshy, scaledBy: meshyScale.axis, scaleFactor: round(meshyScale.factor) } } : {}),
      repair: {
        verticesMerged: repaired.summary.verticesMerged,
        degenerateFacesRemoved: repaired.summary.degenerateFacesRemoved,
        facesFlipped: repaired.summary.facesFlipped,
        shellsRemoved: repaired.summary.shellsRemoved,
        notes: repaired.summary.notes,
      },
      validation: { triangles: v.triangles, watertight: v.watertight, manifold: v.manifold, printable: v.printable, volumeMm3: round(v.volumeMm3), issues: v.issues },
      fitsBuildVolume: fits,
    };
    const stl = writeBinaryStl(mesh, `Morphix photo3d ${engine} (mm)`);
    emit("done", 100, `Model ready: ${fmt(size)} mm via ${engine}`);
    return {
      status: "done",
      files: { stl, ...(out.glb ? { glb: out.glb } : {}), ...(out.scad ? { scad: out.scad } : {}), ...(out.thumbnail ? { thumbnail: out.thumbnail } : {}) },
      engine,
      dimensions: { intended: analysis?.dimensions ?? null, actualMm: { x: round(size.x), y: round(size.y), z: round(size.z) }, check },
      analysis,
      report,
      warnings,
      costCredits: out.credits,
    };
  } catch (e) {
    return fail(e);
  }
}

export function engineOrder(request: PhotoToModelRequest, analysis: PhotoAnalysis | null, photos: CheckedPhoto[], allowFallback: boolean): Engine[] {
  if (request.scan) return ["scan"];
  if (request.resumeMeshyTask) return [request.resumeMeshyTask.kind === "multi-image-to-3d" ? "meshy-multi-image" : "meshy-image"];
  const meshyUsable = photos.filter((p) => MESHY_IMAGE_MIMES.includes(p.mime)).length;
  const meshyDefault: Engine = meshyUsable >= 2 ? "meshy-multi-image" : "meshy-image";
  const forced = request.engine && request.engine !== "auto" ? request.engine : null;
  let first: Engine = forced ?? analysis?.recommendedEngine ?? meshyDefault;
  if (first === "scan") first = meshyDefault; // no scan file
  if (first === "meshy-multi-image" && meshyUsable < 2) first = "meshy-image";
  if (first === "openscad") return allowFallback ? ["openscad", meshyDefault] : ["openscad"];
  return [first];
}

async function runEngine(
  engine: Engine,
  request: PhotoToModelRequest,
  deps: PhotoToModelDeps,
  analysis: PhotoAnalysis | null,
  photos: CheckedPhoto[],
  emit: (stage: Photo3dStage, progress: number, detail: string) => void,
): Promise<EngineOutput> {
  if (engine === "scan") {
    const s = request.scan!;
    emit("import", 30, `Reading ${s.name}`);
    const d = analysis?.dimensions;
    const expected = d ? Math.max(d.width.valueMm, d.depth.valueMm, d.height.valueMm) : undefined;
    const r = importScan(s.name, s.bytes, { units: s.units, upAxis: s.upAxis, expectedSizeMm: s.units && s.units !== "auto" ? undefined : expected });
    emit("import", 70, `Scan is ${fmt(r.sizeMm)} mm (${r.units}, ${r.upAxis.toUpperCase()}-up)`);
    const { mesh, ...scanReport } = r;
    const out: EngineOutput = { mesh, sized: true, credits: 0, report: { scan: scanReport }, warnings: [] };
    if (r.format === "glb") out.glb = Buffer.from(s.bytes);
    if (!r.unitsConfident) out.warnings!.push(issue("MX-P3D-043", `Scan units are uncertain; assumed ${r.units}. Check the size (${fmt(r.sizeMm)} mm) or pass the units.`));
    return out;
  }

  if (engine === "openscad") {
    if (!analysis?.openscadSpec) throw new Photo3dError("MX-P3D-035");
    if (!deps.gemini?.available) throw new Photo3dError("MX-P3D-010");
    const o = deps.openscad ?? {};
    const r = await designWithOpenscad(
      {
        objectName: analysis.object.name,
        description: analysis.object.description || request.description,
        spec: analysis.openscadSpec,
        dimensions: analysis.dimensions,
        measurements: request.measurements?.map((m) => ({ label: m.label, value: m.value, unit: String(m.unit) })),
      },
      {
        ...o,
        gemini: deps.gemini,
        signal: deps.signal,
        onAttempt: ({ attempt, phase }) =>
          emit(phase === "writing" ? "design" : "compile", 25 + (attempt - 1) * 20 + (phase === "compiling" ? 10 : 0), phase === "writing" ? `Designing the part (attempt ${attempt})` : `Rendering with OpenSCAD (attempt ${attempt})`),
      },
    );
    return {
      mesh: r.mesh,
      sized: true,
      scad: r.scad,
      credits: 0,
      check: r.dimensionCheck,
      report: { openscad: { attempts: r.attempts.map(({ code: _code, ...a }) => a) } },
    };
  }

  // Meshy image / multi-image.
  const client = deps.meshy;
  if (!client?.available) throw new Photo3dError("MX-P3D-020");
  const opts: MeshyImageOptions = { ...deps.meshyDefaults, ...request.meshy };
  const cost = meshyImageCost(opts);
  if (!request.resumeMeshyTask && deps.maxCredits !== undefined && cost > deps.maxCredits) {
    throw new Photo3dError("MX-P3D-092", `Meshy would cost ${cost} credits; the limit is ${deps.maxCredits}.`);
  }
  const usable = photos.filter((p) => MESHY_IMAGE_MIMES.includes(p.mime));
  const imgs = engine === "meshy-multi-image" ? usable.slice(0, 4) : usable.slice(0, 1);
  if (!request.resumeMeshyTask && imgs.length === 0) throw new Photo3dError("MX-P3D-001", "Meshy needs a JPEG, PNG or WebP photo.");
  emit("generate", 25, `Sending ${imgs.length} photo(s) to Meshy (~${cost} credits)`);
  const r = await client.generate(imgs, {
    ...opts,
    resume: request.resumeMeshyTask,
    signal: deps.signal,
    onTaskId: (t) => deps.onMeshyTask?.(t),
    onProgress: (p) =>
      emit(
        "generate",
        25 + 0.6 * Math.min(100, p.progress),
        p.status === "PENDING" ? `Meshy: waiting in queue${p.precedingTasks ? ` (${p.precedingTasks} ahead)` : ""}` : `Meshy: building the 3D shape (${p.progress}%)`,
      ),
  });
  emit("download", 88, "Model downloaded");
  let mesh: Mesh;
  try {
    // GLB is Y-up by spec (converted to Z-up); Meshy's STL is Z-up.
    mesh = r.glb ? parseGlb(r.glb, { unitScaleMm: 1000 }).mesh : parseStl(r.stl!);
  } catch (e) {
    throw new Photo3dError("MX-P3D-029", `Meshy's model could not be read: ${(e as Error).message}`);
  }
  if (mesh.indices.length === 0) throw new Photo3dError("MX-P3D-029", "Meshy's model has no triangles.");
  return {
    mesh,
    sized: false,
    glb: r.glb,
    thumbnail: r.thumbnail,
    credits: r.credits,
    report: { meshy: { taskId: r.taskId, kind: r.kind, scaledBy: "height", scaleFactor: 1 } },
  };
}

function withDimensions(a: PhotoAnalysis, mm: Partial<Record<Axis, number>>): PhotoAnalysis {
  const dimensions = { ...a.dimensions };
  for (const axis of ["width", "depth", "height"] as Axis[]) {
    const v = mm[axis];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) dimensions[axis] = { valueMm: v, confidence: 1, method: "user-measurement", note: "confirmed by the user" };
  }
  return { ...a, dimensions, needsAnswers: false };
}

function dimsText(d: Dimensions): string {
  return `${d.width.valueMm} x ${d.depth.valueMm} x ${d.height.valueMm}`;
}

function isCancel(e: unknown): boolean {
  return e instanceof Photo3dError && e.code === "MX-P3D-090";
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
