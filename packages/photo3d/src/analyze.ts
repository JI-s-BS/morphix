// Step 1: Gemini looks at the photos + description and decides what the object is,
// how big it is (with per-dimension confidence and method), which engine to use,
// and writes the Meshy prompt and/or the OpenSCAD design spec.
import { Photo3dError } from "./errors";
import type { GeminiJsonClient, GeminiPart } from "./gemini";
import { checkPhotos, overallAxisOf, toBase64, toMm, type Axis, type Measurement, type PhotoInput } from "./images";

export type Engine = "openscad" | "meshy-image" | "meshy-multi-image" | "scan";
export const ENGINES: readonly Engine[] = ["openscad", "meshy-image", "meshy-multi-image", "scan"];

export type ReferenceObject = "credit-card" | "coin" | "ruler" | "phone" | "none";

/** How a dimension was obtained, best first. */
export type DimensionMethod = "user-measurement" | "reference-object" | "typical-size";
const METHODS: readonly DimensionMethod[] = ["user-measurement", "reference-object", "typical-size"];

export interface DimensionEstimate {
  valueMm: number;
  /** 0..1. User measurements are 1; reference-object estimates ~0.6-0.85; priors <= 0.5. */
  confidence: number;
  method: DimensionMethod;
  note?: string;
}

/** X = width (left-right), Y = depth (front-back), Z = height above the bed, in print orientation. */
export type Dimensions = Record<Axis, DimensionEstimate>;

export interface HoleSpec {
  description: string;
  diameterMm: number;
  /** null = through-hole. */
  depthMm: number | null;
}

export interface OpenscadSpec {
  summary: string;
  features: string[];
  wallThicknessMm: number | null;
  holes: HoleSpec[];
  /** Clearance for parts that must fit something (per side), e.g. 0.2-0.4 mm. */
  toleranceMm: number | null;
  /** How the part rests on the bed (which face is down, why, overhangs). */
  bedOrientation: string;
  notes: string;
}

/** What the photos look like as input for image-to-3D (filled for the phone flow; optional for older callers). */
export interface PhotoSubjectInfo {
  /** The one thing to model, in a few words ("the red Sprite can", "the person on the left"). */
  subject: string;
  /** True when a busy background, other objects, other people or a far-away subject would confuse image-to-3D. */
  needsCleanup: boolean;
  cleanupReason: string;
  /** 0-based index of the photo that shows the subject best. */
  bestPhotoIndex: number;
  /** All photos show the same object from different angles (good for multi-image). */
  sameObjectAllPhotos: boolean;
}

export interface PhotoAnalysis {
  object: {
    name: string;
    description: string;
    category: "functional" | "decorative";
    /** Exact dimensions matter (fits, mates, holds something). */
    mechanical: boolean;
  };
  recommendedEngine: Engine;
  engineReason: string;
  dimensions: Dimensions;
  referenceObject: { requested: ReferenceObject; detected: boolean; note: string };
  /** At most 3 short questions; asked only when confidence is low. */
  questions: string[];
  /** True when the pipeline should stop and ask `questions` before building. */
  needsAnswers: boolean;
  meshyPrompt: string;
  /** Present when the object can be modelled with simple CAD geometry. */
  openscadSpec: OpenscadSpec | null;
  overallConfidence: number;
  model: string;
  photo?: PhotoSubjectInfo;
}

export interface AnalyzeInput {
  images: PhotoInput[];
  description: string;
  measurements?: Measurement[];
  referenceObject?: ReferenceObject;
  /** A 3D scan file accompanies the photos (forces the "scan" engine). */
  hasScanFile?: boolean;
  /** Answers to questions from a previous analysis. */
  answers?: { question: string; answer: string }[];
}

export interface AnalyzeDeps {
  gemini: GeminiJsonClient;
  signal?: AbortSignal;
}

/** Below these the pipeline asks the user (when Gemini supplied questions). */
export const ASK_BELOW_CONFIDENCE = { functional: 0.75, decorative: 0.4 } as const;

/** Real sizes the prompt gives Gemini for scale. */
export const REFERENCE_SIZES: Record<Exclude<ReferenceObject, "none">, string> = {
  "credit-card": "ISO/IEC 7810 ID-1 card: 85.60 x 53.98 mm, 0.76 mm thick",
  coin: "coin: US quarter 24.26 mm, euro 1 coin 23.25 mm, euro 2 coin 25.75 mm, UK 1 pound 23.43 mm (diameter); if the coin type is unclear, say so and lower confidence",
  ruler: "ruler: read the printed scale (mm/cm or inch marks) directly",
  phone: "smartphone: typically 146-163 mm tall and 70-78 mm wide; model varies, so confidence is lower than a card",
};

export async function analyzePhotos(input: AnalyzeInput, deps: AnalyzeDeps): Promise<PhotoAnalysis> {
  const description = (input.description ?? "").trim();
  if (!description) throw new Photo3dError("MX-P3D-001", "Describe what to make (e.g. 'replacement for this snapped phone stand').");
  const photos = checkPhotos(input.images, { allowEmpty: !!input.hasScanFile });

  const parts: GeminiPart[] = [{ text: buildAnalysisPrompt(input, photos.length) }];
  photos.forEach((p, i) => {
    parts.push({ text: `Photo ${i + 1}:` });
    parts.push({ inlineData: { mimeType: p.mime, data: toBase64(p.bytes) } });
  });
  const raw = await deps.gemini.generateJson<RawAnalysis>({
    parts,
    schema: ANALYSIS_SCHEMA,
    system: SYSTEM,
    temperature: 0.2,
    maxOutputTokens: 4096,
    signal: deps.signal,
  });
  return normalizeAnalysis(raw, input, photos.length, deps.gemini.model);
}

const SYSTEM =
  "You are the design brain of Morphix, a 3D printing assistant (FDM printer, 220 x 220 x 220 mm build volume, PLA, 0.4 mm nozzle). " +
  "You turn photos and a description into a plan for a printable model. Be precise and honest about uncertainty: never invent precision you do not have.";

export function buildAnalysisPrompt(input: AnalyzeInput, photoCount: number): string {
  const lines: string[] = [];
  lines.push(`The user wants: ${input.description.trim()}`);
  lines.push(photoCount ? `${photoCount} photo(s) follow. They may show a drawing, a broken part, or an object to copy.` : "No photos were sent.");
  if (input.hasScanFile) lines.push("The user also uploaded a 3D scan file of the object; recommend engine \"scan\".");

  const ms = (input.measurements ?? []).filter((m) => m && Number.isFinite(m.value) && m.value > 0);
  if (ms.length) {
    lines.push("User measurements (exact; use them, method \"user-measurement\", confidence 1):");
    for (const m of ms) {
      const mm = toMm(m.value, String(m.unit));
      lines.push(`- ${m.label}: ${m.value} ${m.unit}${mm !== null && String(m.unit) !== "mm" ? ` (= ${round(mm)} mm)` : ""}`);
    }
  }
  const ref = input.referenceObject ?? "none";
  if (ref !== "none") lines.push(`The user placed a reference object in the photo for scale: ${REFERENCE_SIZES[ref]}. Use it (method "reference-object") if you can see it; say whether you found it.`);
  else lines.push("No reference object was declared; if you still see a card, coin, ruler or phone, you may use it for scale.");
  if (input.answers?.length) {
    lines.push("Answers to your earlier questions (treat as user facts):");
    for (const a of input.answers) lines.push(`- Q: ${a.question} A: ${a.answer}`);
  }
  lines.push(
    "",
    "Decide:",
    "1. What the object is and whether it is functional/mechanical (exact dimensions matter: brackets, stands, clips, spacers, hooks, knobs, replacement parts) or organic/decorative (figures, animals, sculptures, things from drawings).",
    "2. recommendedEngine: \"openscad\" for functional parts made of simple geometry (boxes, cylinders, slots, holes, fillets, extrusions); \"meshy-image\" (one useful photo) or \"meshy-multi-image\" (2-4 photos of the same object from different angles) for organic shapes and drawings; \"scan\" only when a scan file was uploaded.",
    "3. Overall dimensions of the object TO PRINT in millimetres, in its print orientation: width = X (left-right), depth = Y (front-back), height = Z (up from the bed). For a broken part, give the dimensions of the complete, repaired part. Give each a confidence 0..1 and a method: \"user-measurement\" (given above), \"reference-object\" (scaled from a known object in the photo) or \"typical-size\" (a prior for this kind of object; confidence at most 0.5).",
    "4. Up to 3 short follow-up questions that would most improve the result, only if some important dimension has low confidence (e.g. 'What is the thickness of your phone with its case?'). Otherwise an empty list.",
    "5. meshyPrompt: one short sentence describing the object's shape for an image-to-3D model (no colours, no background).",
    "6. openscadSpec (set applicable=false when the engine is not openscad): a precise design spec with exact numbers: features, wall thickness, holes (diameter, depth or through), tolerance/clearance for anything that must fit, and how it rests on the bed (largest flat face down, minimal overhangs > 45 degrees, no supports if possible).",
    "7. photo: the single subject to model (subject), which photo shows it best (bestPhotoIndex, 0-based), whether all photos show the same object from different angles (sameObjectAllPhotos), and needsCleanup=true when a busy background, other objects or people, heavy shadows or a small/far subject would confuse an image-to-3D model that works best with one subject on a plain background (cleanupReason says why).",
  );
  return lines.join("\n");
}

const dimSchema = {
  type: "object",
  properties: {
    valueMm: { type: "number" },
    confidence: { type: "number" },
    method: { type: "string", enum: [...METHODS] },
    note: { type: "string" },
  },
  required: ["valueMm", "confidence", "method"],
};

export const ANALYSIS_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    objectName: { type: "string" },
    objectDescription: { type: "string" },
    category: { type: "string", enum: ["functional", "decorative"] },
    mechanical: { type: "boolean" },
    recommendedEngine: { type: "string", enum: [...ENGINES] },
    engineReason: { type: "string" },
    dimensions: {
      type: "object",
      properties: { width: dimSchema, depth: dimSchema, height: dimSchema },
      required: ["width", "depth", "height"],
    },
    referenceObjectDetected: { type: "boolean" },
    referenceObjectNote: { type: "string" },
    questions: { type: "array", items: { type: "string" }, maxItems: 3 },
    meshyPrompt: { type: "string" },
    openscadSpec: {
      type: "object",
      properties: {
        applicable: { type: "boolean" },
        summary: { type: "string" },
        features: { type: "array", items: { type: "string" } },
        wallThicknessMm: { type: "number" },
        holes: {
          type: "array",
          items: {
            type: "object",
            properties: { description: { type: "string" }, diameterMm: { type: "number" }, depthMm: { type: "number" }, through: { type: "boolean" } },
            required: ["description", "diameterMm"],
          },
        },
        toleranceMm: { type: "number" },
        bedOrientation: { type: "string" },
        notes: { type: "string" },
      },
      required: ["applicable"],
    },
    overallConfidence: { type: "number" },
    photo: {
      type: "object",
      properties: {
        subject: { type: "string" },
        needsCleanup: { type: "boolean" },
        cleanupReason: { type: "string" },
        bestPhotoIndex: { type: "integer" },
        sameObjectAllPhotos: { type: "boolean" },
      },
      required: ["subject", "needsCleanup"],
    },
  },
  required: ["objectName", "category", "mechanical", "recommendedEngine", "dimensions", "questions", "meshyPrompt", "openscadSpec", "overallConfidence"],
};

interface RawDim {
  valueMm?: unknown;
  confidence?: unknown;
  method?: unknown;
  note?: unknown;
}

export interface RawAnalysis {
  objectName?: unknown;
  objectDescription?: unknown;
  category?: unknown;
  mechanical?: unknown;
  recommendedEngine?: unknown;
  engineReason?: unknown;
  dimensions?: { width?: RawDim; depth?: RawDim; height?: RawDim };
  referenceObjectDetected?: unknown;
  referenceObjectNote?: unknown;
  questions?: unknown;
  meshyPrompt?: unknown;
  openscadSpec?: {
    applicable?: unknown;
    summary?: unknown;
    features?: unknown;
    wallThicknessMm?: unknown;
    holes?: { description?: unknown; diameterMm?: unknown; depthMm?: unknown; through?: unknown }[];
    toleranceMm?: unknown;
    bedOrientation?: unknown;
    notes?: unknown;
  };
  overallConfidence?: unknown;
  photo?: { subject?: unknown; needsCleanup?: unknown; cleanupReason?: unknown; bestPhotoIndex?: unknown; sameObjectAllPhotos?: unknown };
}

/** Defensive normalisation: clamps numbers, applies user measurements, fixes impossible engine choices. */
export function normalizeAnalysis(raw: RawAnalysis, input: AnalyzeInput, photoCount: number, model: string): PhotoAnalysis {
  if (!raw || typeof raw !== "object" || !raw.dimensions) throw new Photo3dError("MX-P3D-013", "Gemini's analysis is missing the dimensions.");
  const category = raw.category === "decorative" ? "decorative" : "functional";
  const mechanical = raw.mechanical === true || (raw.mechanical === undefined && category === "functional");

  const dimensions = {} as Dimensions;
  for (const axis of ["width", "depth", "height"] as Axis[]) {
    const d = raw.dimensions[axis] ?? {};
    const v = num(d.valueMm);
    if (v === null || v <= 0) throw new Photo3dError("MX-P3D-013", `Gemini gave no usable ${axis}.`);
    const method = METHODS.includes(d.method as DimensionMethod) ? (d.method as DimensionMethod) : "typical-size";
    let confidence = clamp01(num(d.confidence) ?? 0.3);
    if (method === "typical-size") confidence = Math.min(confidence, 0.5);
    dimensions[axis] = { valueMm: round(Math.min(v, 5000)), confidence, method, ...(str(d.note) ? { note: str(d.note) } : {}) };
  }
  // User measurements of the overall size are facts, whatever Gemini made of them.
  for (const m of input.measurements ?? []) {
    const axis = overallAxisOf(m?.label ?? "");
    const mm = axis ? toMm(m.value, String(m.unit)) : null;
    if (axis && mm !== null && mm > 0) dimensions[axis] = { valueMm: round(mm), confidence: 1, method: "user-measurement", note: `${m.label}: ${m.value} ${m.unit}` };
  }

  let engine: Engine = ENGINES.includes(raw.recommendedEngine as Engine) ? (raw.recommendedEngine as Engine) : category === "functional" ? "openscad" : "meshy-image";
  let engineReason = str(raw.engineReason);
  if (input.hasScanFile) {
    engine = "scan";
    engineReason = "A 3D scan file was provided.";
  } else if (engine === "scan") {
    engine = category === "functional" ? "openscad" : "meshy-image";
    engineReason = `${engineReason} (no scan file was uploaded, so ${engine} is used instead)`.trim();
  }
  if (engine === "meshy-multi-image" && photoCount < 2) engine = "meshy-image";

  const s = raw.openscadSpec;
  let openscadSpec: OpenscadSpec | null = null;
  if (s && (s.applicable === true || engine === "openscad") && (str(s.summary) || arr(s.features).length)) {
    openscadSpec = {
      summary: str(s.summary),
      features: arr(s.features).map(String).filter(Boolean),
      wallThicknessMm: pos(s.wallThicknessMm),
      holes: (Array.isArray(s.holes) ? s.holes : [])
        .map((h) => ({
          description: str(h?.description),
          diameterMm: pos(h?.diameterMm) ?? 0,
          depthMm: h?.through === true ? null : pos(h?.depthMm),
        }))
        .filter((h) => h.diameterMm > 0),
      toleranceMm: pos(s.toleranceMm),
      bedOrientation: str(s.bedOrientation),
      notes: str(s.notes),
    };
  }
  if (engine === "openscad" && !openscadSpec) {
    engine = photoCount >= 2 ? "meshy-multi-image" : "meshy-image";
    engineReason = `${engineReason} (no usable CAD spec, so Meshy is used)`.trim();
  }

  const questions = arr(raw.questions).map((q) => String(q).trim()).filter(Boolean).slice(0, 3);
  const minConf = Math.min(dimensions.width.confidence, dimensions.depth.confidence, dimensions.height.confidence);
  const threshold = mechanical ? ASK_BELOW_CONFIDENCE.functional : ASK_BELOW_CONFIDENCE.decorative;
  const needsAnswers = questions.length > 0 && engine !== "scan" && minConf < threshold && !(input.answers && input.answers.length);

  const name = str(raw.objectName) || "object";
  const rp = raw.photo && typeof raw.photo === "object" ? raw.photo : null;
  const best = num(rp?.bestPhotoIndex);
  const photo: PhotoSubjectInfo | undefined = rp
    ? {
        subject: (str(rp.subject) || name).slice(0, 200),
        needsCleanup: rp.needsCleanup === true,
        cleanupReason: str(rp.cleanupReason).slice(0, 300),
        bestPhotoIndex: best !== null && best >= 0 && best < photoCount ? Math.floor(best) : 0,
        sameObjectAllPhotos: rp.sameObjectAllPhotos === true,
      }
    : undefined;
  return {
    object: { name, description: str(raw.objectDescription), category, mechanical },
    recommendedEngine: engine,
    engineReason,
    dimensions,
    referenceObject: { requested: input.referenceObject ?? "none", detected: raw.referenceObjectDetected === true, note: str(raw.referenceObjectNote) },
    questions,
    needsAnswers,
    meshyPrompt: (str(raw.meshyPrompt) || name).slice(0, 600),
    openscadSpec,
    overallConfidence: clamp01(num(raw.overallConfidence) ?? minConf),
    model,
    ...(photo ? { photo } : {}),
  };
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function pos(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
