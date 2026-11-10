// Phone "Photo to 3D" flow (Morphix Remote): photos + description -> a plan with a
// recommended route (Meshy image-to-3D or Claude CAD) that the user must choose
// before anything is generated or any credits are spent. Meshy gets a cleaned
// photo (one subject, plain background) and the phone can preview exactly that.
import { randomUUID } from "node:crypto";
import { QD330_BUILD_VOLUME_MM } from "@morphix/shared";
import { computeBounds, parseStl, repairMesh, validateMesh, writeBinaryStl, type Vec3 } from "@morphix/slicing";
import { analyzePhotos, type Dimensions, type OpenscadSpec, type PhotoAnalysis } from "./analyze";
import { cleanupPhoto, type GeminiImageClient } from "./cleanup";
import { fmt, placeOnBed } from "./dimensions";
import { Photo3dError, throwIfAborted } from "./errors";
import type { GeminiJsonClient } from "./gemini";
import { checkPhotos, MESHY_IMAGE_MIMES, stripJpegMetadata, type CheckedPhoto, type Measurement, type PhotoInput } from "./images";
import type { PhotoToModelRequest } from "./pipeline";

export type PhotoRoute = "meshy" | "cad";

/** The phone sends at most this many photos (Meshy multi-image uses up to 4). */
export const PHONE_MAX_PHOTOS = 4;

// ------------------------------------------------------------------ CAD seam

/** What the Claude CAD engine gets (packages/cad adapts this to generateCadModel). */
export interface CadPhotoRequest {
  /** The user's own words ("a replacement for this broken clip"). */
  description: string;
  objectName: string;
  /** Gemini's description of the object in the photos. */
  summary: string;
  /** Best-guess overall size of the part to print, with confidence per axis. */
  dimensions: Dimensions;
  /** Gemini's CAD-style spec when it wrote one (features, holes, tolerances, bed orientation). */
  spec: OpenscadSpec | null;
  measurements: Measurement[];
  /** The photos (metadata stripped) for reference. */
  images: CheckedPhoto[];
  /** OpenSCAD of the design being changed ("add a cap to it"), if any. */
  baseScad?: string;
}

export interface CadPhotoResult {
  /** STL in millimetres, Z-up. */
  stl: Uint8Array;
  scad?: string;
  name?: string;
  thumbnail?: Uint8Array;
  warnings?: string[];
}

export interface CadProgress {
  progress: number;
  detail: string;
  /** Live view of Claude's work (optional): step, attempt, its OpenSCAD and rendered STL. */
  stage?: string;
  attempt?: number;
  maxAttempts?: number;
  scad?: string;
  previewStl?: Uint8Array;
}

/** Injected by the app once packages/cad is wired; absent means "not available yet". */
export type GenerateCadFn = (request: CadPhotoRequest, ctx: { signal?: AbortSignal; onProgress?: (p: CadProgress) => void }) => Promise<CadPhotoResult>;

// ------------------------------------------------------------------ plan

export interface RouteOption {
  route: PhotoRoute;
  title: string;
  tagline: string;
  recommended: boolean;
  available: boolean;
  unavailableReason?: string;
  /** Meshy credits this choice spends (0 for CAD). */
  credits: number;
}

export interface PhotoCleanupState {
  /** Gemini thinks the photo needs a cleaner background before Meshy. */
  needed: boolean;
  reason: string;
  /** The images Meshy would receive have been decided (cleaned or not). */
  ready: boolean;
  /** At least one image Meshy gets was edited by Gemini. */
  cleaned: boolean;
  note: string;
  model: string | null;
}

export interface PhotoPlan {
  id: string;
  createdAt: string;
  description: string;
  analysis: PhotoAnalysis;
  recommended: PhotoRoute;
  reason: string;
  options: RouteOption[];
  /** The phone's photos with EXIF/XMP removed. */
  photos: CheckedPhoto[];
  /** What Meshy receives (cleaned when needed); null until prepared. */
  meshyImages: CheckedPhoto[] | null;
  /** Indexes into `photos` that `meshyImages` were made from. */
  meshySources: number[];
  cleanup: PhotoCleanupState;
  /** Set once the user chose a route, so a double tap never pays twice. */
  started?: { route: PhotoRoute; jobId: string; useOriginal: boolean };
}

export interface PlanDeps {
  gemini: GeminiJsonClient;
  images?: GeminiImageClient;
  meshy: { available: boolean; credits: number; maxCredits?: number };
  cad: { available: boolean };
  signal?: AbortSignal;
  id?: () => string;
  now?: () => Date;
}

export interface PlanInput {
  images: PhotoInput[];
  description: string;
  measurements?: Measurement[];
}

/** Looks at the photos (free Gemini calls), recommends a route and, for Meshy, prepares the cleaned photo. */
export async function planPhotoModel(input: PlanInput, deps: PlanDeps): Promise<PhotoPlan> {
  const description = (input.description ?? "").trim();
  if (!description) throw new Photo3dError("MX-P3D-001", "Say what to make from the photo (e.g. 'a keychain of my friend').");
  if ((input.images ?? []).length > PHONE_MAX_PHOTOS) throw new Photo3dError("MX-P3D-001", `Use up to ${PHONE_MAX_PHOTOS} photos.`);
  if (!deps.gemini.available) throw new Photo3dError("MX-P3D-010");
  const photos = checkPhotos(input.images).map((p) => ({ mime: p.mime, bytes: stripJpegMetadata(p.bytes) }));
  const analysis = await analyzePhotos({ images: photos, description, measurements: input.measurements, referenceObject: "none" }, { gemini: deps.gemini, signal: deps.signal });
  const { route, reason } = recommendRoute(analysis);
  const options = routeOptions(route, deps);
  const plan: PhotoPlan = {
    id: deps.id?.() ?? randomUUID().replace(/-/g, ""),
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    description,
    analysis,
    recommended: route,
    reason,
    options,
    photos,
    meshyImages: null,
    meshySources: [],
    cleanup: { needed: analysis.photo?.needsCleanup === true, reason: analysis.photo?.cleanupReason ?? "", ready: false, cleaned: false, note: "", model: null },
  };
  // Clean the photo up front when Meshy is the likely choice, so the phone can show it before the user decides.
  const meshy = options.find((o) => o.route === "meshy")!;
  const cad = options.find((o) => o.route === "cad")!;
  if (meshy.available && (route === "meshy" || !cad.available)) await prepareMeshyImages(plan, deps);
  return plan;
}

/** Meshy for things you look at or hold; Claude CAD for parts that must work or fit. */
export function recommendRoute(a: PhotoAnalysis): { route: PhotoRoute; reason: string } {
  const functional = a.recommendedEngine === "openscad" || a.object.mechanical || a.object.category === "functional";
  const why = a.engineReason.replace(/\s*\((no usable CAD spec|no scan file)[^)]*\)\s*$/i, "").trim();
  if (functional) return { route: "cad", reason: why || `“${a.object.name}” has to work or fit, so exact sizes matter.` };
  return { route: "meshy", reason: why || `“${a.object.name}” is something you look at or hold, so its shape matters more than exact sizes.` };
}

export function routeOptions(recommended: PhotoRoute, deps: Pick<PlanDeps, "meshy" | "cad">): RouteOption[] {
  const credits = deps.meshy.credits;
  const overBudget = deps.meshy.maxCredits !== undefined && credits > deps.meshy.maxCredits;
  const meshy: RouteOption = {
    route: "meshy",
    title: "Meshy",
    tagline: "Best for figures, people, toys and things you hold",
    recommended: recommended === "meshy",
    available: deps.meshy.available && !overBudget,
    credits,
    ...(!deps.meshy.available
      ? { unavailableReason: "Meshy is not set up on the Pi (MESHY_API_KEY)." }
      : overBudget
        ? { unavailableReason: `Uses ${credits} credits; the limit is ${deps.meshy.maxCredits}.` }
        : {}),
  };
  const cad: RouteOption = {
    route: "cad",
    title: "Claude CAD",
    tagline: "Exact sizes and working parts",
    recommended: recommended === "cad",
    available: deps.cad.available,
    credits: 0,
    ...(!deps.cad.available ? { unavailableReason: "Not available yet on this Morphix." } : {}),
  };
  return recommended === "meshy" ? [meshy, cad] : [cad, meshy];
}

/** Decides which photos Meshy gets and cleans them when Gemini said so. Idempotent. */
export async function prepareMeshyImages(plan: PhotoPlan, deps: Pick<PlanDeps, "images" | "signal">): Promise<PhotoPlan> {
  if (plan.cleanup.ready && plan.meshyImages) return plan;
  const usable = plan.photos.map((p, i) => ({ p, i })).filter((x) => MESHY_IMAGE_MIMES.includes(x.p.mime));
  if (!usable.length) throw new Photo3dError("MX-P3D-001", "Meshy needs a JPEG, PNG or WebP photo.");
  const info = plan.analysis.photo;
  const multi = usable.length >= 2 && info?.sameObjectAllPhotos === true;
  const best = usable.find((x) => x.i === (info?.bestPhotoIndex ?? 0)) ?? usable[0];
  const chosen = multi ? usable.slice(0, 4) : [best];
  let cleaned = false;
  let note = plan.cleanup.needed ? "" : "The photo already shows one clear subject, so it is sent as it is.";
  let model: string | null = null;
  let images = chosen.map((x) => x.p);
  if (plan.cleanup.needed) {
    const subject = info?.subject || plan.analysis.object.name;
    const results = await Promise.all(chosen.map((x) => cleanupPhoto(x.p, { subject, description: plan.description }, deps)));
    throwIfAborted(deps.signal);
    images = results.map((r) => r.image);
    cleaned = results.some((r) => r.cleaned);
    model = results.find((r) => r.model)?.model ?? null;
    note = results.find((r) => !r.cleaned)?.note ?? results[0].note;
  }
  plan.meshyImages = images;
  plan.meshySources = chosen.map((x) => x.i);
  plan.cleanup = { ...plan.cleanup, ready: true, cleaned, note, model };
  return plan;
}

/** The photoToModel request for the Meshy route (no new analysis; the plan's is reused). */
export function meshyRequestFromPlan(plan: PhotoPlan, o: { useOriginal?: boolean } = {}): PhotoToModelRequest {
  const sources = plan.meshySources.length ? plan.meshySources : [plan.analysis.photo?.bestPhotoIndex ?? 0];
  const images = o.useOriginal || !plan.meshyImages ? sources.map((i) => plan.photos[i] ?? plan.photos[0]) : plan.meshyImages;
  return {
    images,
    description: plan.description,
    analysis: plan.analysis,
    engine: images.length >= 2 ? "meshy-multi-image" : "meshy-image",
    skipQuestions: true,
  };
}

export function cadRequestFromPlan(plan: PhotoPlan, measurements: Measurement[] = []): CadPhotoRequest {
  const a = plan.analysis;
  return {
    description: plan.description,
    objectName: a.object.name,
    summary: a.object.description,
    dimensions: a.dimensions,
    spec: a.openscadSpec,
    measurements,
    images: plan.photos,
  };
}

/** Repairs and places a CAD STL on the bed; returns a clean binary STL in mm plus warnings. */
export function finishCadModel(result: CadPhotoResult): { stl: Buffer; sizeMm: Vec3; warnings: string[] } {
  if (!(result?.stl instanceof Uint8Array) || result.stl.length < 84) throw new Photo3dError("MX-P3D-071", "Claude CAD returned no model.");
  let mesh;
  try {
    mesh = parseStl(result.stl);
  } catch (e) {
    throw new Photo3dError("MX-P3D-071", `Claude CAD's model could not be read: ${(e as Error).message}`);
  }
  if (mesh.indices.length === 0) throw new Photo3dError("MX-P3D-071", "Claude CAD's model has no triangles.");
  mesh = placeOnBed(repairMesh(mesh).mesh);
  const size = computeBounds(mesh).size;
  const warnings = [...(result.warnings ?? [])].map(String).slice(0, 10);
  const v = validateMesh(mesh);
  if (!v.printable) warnings.push(`Mesh problems: ${v.issues.slice(0, 3).join("; ")}`);
  const vol = QD330_BUILD_VOLUME_MM;
  if (size.x > vol.x || size.y > vol.y || size.z > vol.z) warnings.push(`Model is ${fmt(size)} mm; the printer fits ${vol.x} x ${vol.y} x ${vol.z} mm.`);
  const r = (n: number) => Math.round(n * 100) / 100;
  return { stl: writeBinaryStl(mesh, "Morphix photo CAD (mm)"), sizeMm: { x: r(size.x), y: r(size.y), z: r(size.z) }, warnings };
}

// ------------------------------------------------------------------ phone view

/** JSON-safe view of a plan for the phone (no image bytes). */
export interface PhotoPlanView {
  id: string;
  description: string;
  object: { name: string; description: string; category: "functional" | "decorative" };
  sizeMm: { width: number; depth: number; height: number };
  sizeConfidence: number;
  recommended: PhotoRoute;
  reason: string;
  options: RouteOption[];
  photoCount: number;
  cleanup: Omit<PhotoCleanupState, "model"> & { previews: number };
  hints: string[];
  started: { route: PhotoRoute; jobId: string } | null;
}

export function planView(plan: PhotoPlan): PhotoPlanView {
  const d = plan.analysis.dimensions;
  const { model: _model, ...cleanup } = plan.cleanup;
  return {
    id: plan.id,
    description: plan.description,
    object: { name: plan.analysis.object.name, description: plan.analysis.object.description, category: plan.analysis.object.category },
    sizeMm: { width: Math.round(d.width.valueMm), depth: Math.round(d.depth.valueMm), height: Math.round(d.height.valueMm) },
    sizeConfidence: Math.round(Math.min(d.width.confidence, d.depth.confidence, d.height.confidence) * 100) / 100,
    recommended: plan.recommended,
    reason: plan.reason,
    options: plan.options,
    photoCount: plan.photos.length,
    cleanup: { ...cleanup, previews: plan.meshyImages?.length ?? 0 },
    hints: plan.analysis.questions.slice(0, 3),
    started: plan.started ? { route: plan.started.route, jobId: plan.started.jobId } : null,
  };
}

// ------------------------------------------------------------------ store

/** Plans live in memory on the Pi for a short while (photos are not written to disk). */
export class PhotoPlanStore {
  private plans = new Map<string, PhotoPlan>();
  constructor(private o: { ttlMs?: number; max?: number; now?: () => number } = {}) {}

  private get ttl() { return this.o.ttlMs ?? 30 * 60_000; }
  private now() { return this.o.now?.() ?? Date.now(); }

  put(plan: PhotoPlan): PhotoPlan {
    this.prune();
    this.plans.set(plan.id, plan);
    const max = this.o.max ?? 8;
    while (this.plans.size > max) this.plans.delete(this.plans.keys().next().value as string);
    return plan;
  }

  /** Throws MX-P3D-080 when the plan is unknown or expired. */
  get(id: string): PhotoPlan {
    this.prune();
    const p = this.plans.get(id);
    if (!p) throw new Photo3dError("MX-P3D-080");
    return p;
  }

  delete(id: string) { this.plans.delete(id); }

  get size() { this.prune(); return this.plans.size; }

  private prune() {
    const cutoff = this.now() - this.ttl;
    for (const [id, p] of this.plans) if (Date.parse(p.createdAt) < cutoff && !p.started) this.plans.delete(id);
    // Started plans are kept a little longer (double-tap protection), then dropped.
    for (const [id, p] of this.plans) if (Date.parse(p.createdAt) < cutoff - this.ttl) this.plans.delete(id);
  }
}
