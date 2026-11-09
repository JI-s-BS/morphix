// AI slicer advisor: picks slicer, layer height, infill, walls, supports, orientation
// and brim for a prepared model. A deterministic heuristic engine always answers;
// Gemini can optionally refine it, but its answer is validated, clamped to safe ranges
// and never allowed to remove supports the geometry clearly needs. Any Gemini problem
// falls back to the heuristic (with MX-SLICE-012 attached as `fallback`).
import { MorphixError, toMorphixError, type SerializedMorphixError } from "@morphix/errors";
import { computeBounds, faceCross, triangleCount, type Mesh, type Vec3 } from "./mesh";
import { DEFAULT_BUILD_VOLUME, type BuildVolume, type OrientationCandidate } from "./place";
import { QD330_PLA_DEFAULTS } from "./profiles";
import type { SlicerInfo, SlicerKind, SupportMode } from "./slicer";
import type { ValidationReport } from "./validate";

export type IntendedUse = "functional" | "decorative" | "unknown";

/** Safe ranges for a 0.4 mm nozzle on the QD330 (UNVERIFIED). Every advice is clamped to these. */
export const ADVICE_LIMITS = {
  layerHeightMm: { min: 0.1, max: 0.3 },
  infillPercent: { min: 5, max: 80 },
  walls: { min: 2, max: 5 },
  brimWidthMm: { min: 0, max: 10 },
} as const;

export const DEFAULT_GEMINI_TEXT_MODEL = "gemini-3.8-flash";
export const GEMINI_TEXT_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface MeshStats {
  triangles: number;
  volumeMm3: number;
  surfaceAreaMm2: number;
  shellCount?: number;
  watertight?: boolean;
}

/** Overhang analysis of the final (oriented, plate-placed) mesh. */
export interface OverhangStats {
  totalAreaMm2: number;
  /** Faces resting on the bed. */
  bedContactAreaMm2: number;
  /** Downward faces steeper than 45 deg from vertical (excluding the bed). */
  overhangAreaMm2: number;
  /** Steeper than 60 deg from vertical. */
  severeOverhangAreaMm2: number;
  overhangRatio: number;
  severeRatio: number;
  /** Steepest overhang that covers at least 0.1 % of the surface (0 = none; 90 = flat ceiling). */
  maxOverhangAngleDeg: number;
  /** Share of the overhang area with nothing but the build plate below it (0-1; 1 when no overhangs). */
  plateReachableRatio: number;
}

export interface AdviseSlicingInput {
  /** Final printed size in mm. */
  size: Vec3;
  validation?: ValidationReport;
  mesh?: MeshStats;
  overhang?: OverhangStats;
  /** preparePrint's orientation result (or anything with the chosen candidate). */
  orientation?: { chosen: OrientationCandidate; unchanged?: boolean; candidates?: OrientationCandidate[] };
  intendedUse?: IntendedUse;
  /** What the model is ("a phone stand", "a dragon figurine"). */
  description?: string;
  availableSlicers?: SlicerInfo[];
  buildVolume?: BuildVolume;
  /** Force the orientation answer (used after a re-run with a kept orientation). */
  lockOrientation?: "auto" | "keep";
}

export interface SlicingAdvice {
  slicer: SlicerKind | null;
  slicerPath: string | null;
  layerHeightMm: number;
  infillPercent: number;
  /** Perimeters / wall loops. */
  walls: number;
  supports: SupportMode;
  orientation: "auto" | "keep";
  brim: boolean;
  /** 0 when brim is false. */
  brimWidthMm: number;
  /** The use the advice was made for (inferred from the description when "unknown"). */
  intendedUse: IntendedUse;
  /** Kid-friendly, one line each: why each setting was chosen. */
  reasons: string[];
  /** Things the user should know (no slicer installed, too big…). */
  warnings: string[];
  confidence: number;
  source: "heuristic" | "gemini";
  /** Gemini model used (source "gemini"). */
  model?: string;
  /** Why Gemini was not used although configured (MX-SLICE-012). */
  fallback?: SerializedMorphixError;
}

// --------------------------------------------------------------- geometry

/**
 * Overhang statistics for an oriented mesh (Z up, any Z offset). Plate reachability is
 * estimated on a 64 x 64 XY grid: for each overhang sample, the highest upward-facing
 * surface below it in that cell decides. None -> supports stand on the plate; within
 * 0.5 mm -> the face rests on the model (no support needed, counted as reachable);
 * further below -> supports would have to stand on the model.
 */
export function overhangStats(mesh: Mesh, opts: { overhangAngleDeg?: number; severeAngleDeg?: number; grid?: number } = {}): OverhangStats {
  const n = triangleCount(mesh);
  const p = mesh.positions, idx = mesh.indices;
  const b = computeBounds(mesh);
  const diag = Math.hypot(b.size.x, b.size.y, b.size.z) || 1;
  const zTol = Math.max(5e-4 * diag, 1e-4);
  const cosFlat = Math.cos((5 * Math.PI) / 180);
  const overDeg = opts.overhangAngleDeg ?? 45;
  const severeDeg = opts.severeAngleDeg ?? 60;
  const G = opts.grid ?? 64;
  const cw = Math.max(b.size.x / G, 1e-6), ch = Math.max(b.size.y / G, 1e-6);
  const upZ: (number[] | undefined)[] = new Array(G * G);
  const c = [0, 0, 0];
  let total = 0, bed = 0, over = 0, severe = 0;
  const overhangs: { t: number; area: number; angle: number }[] = [];
  const angles: { angle: number; area: number }[] = [];

  // Visit the grid cells whose centres fall inside triangle t's XY projection, with the
  // triangle's Z at that centre. Tiny triangles fall back to their centroid's cell.
  const cells = (t: number, visit: (cell: number, z: number) => void) => {
    const ax = p[idx[t * 3] * 3], ay = p[idx[t * 3] * 3 + 1], az = p[idx[t * 3] * 3 + 2];
    const bx = p[idx[t * 3 + 1] * 3], by = p[idx[t * 3 + 1] * 3 + 1], bz = p[idx[t * 3 + 1] * 3 + 2];
    const cx = p[idx[t * 3 + 2] * 3], cy = p[idx[t * 3 + 2] * 3 + 1], cz = p[idx[t * 3 + 2] * 3 + 2];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    const cellOf = (x: number, y: number) => {
      const i = Math.min(G - 1, Math.max(0, Math.floor((x - b.min.x) / cw)));
      const j = Math.min(G - 1, Math.max(0, Math.floor((y - b.min.y) / ch)));
      return j * G + i;
    };
    let hits = 0;
    if (Math.abs(det) > 1e-12) {
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - b.min.x) / cw - 0.5));
      const i1 = Math.min(G - 1, Math.ceil((Math.max(ax, bx, cx) - b.min.x) / cw - 0.5));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - b.min.y) / ch - 0.5));
      const j1 = Math.min(G - 1, Math.ceil((Math.max(ay, by, cy) - b.min.y) / ch - 0.5));
      for (let j = j0; j <= j1; j++) {
        const y = b.min.y + (j + 0.5) * ch;
        for (let i = i0; i <= i1; i++) {
          const x = b.min.x + (i + 0.5) * cw;
          const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
          const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
          const l3 = 1 - l1 - l2;
          if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
          visit(j * G + i, l1 * az + l2 * bz + l3 * cz);
          hits++;
        }
      }
    }
    if (!hits) visit(cellOf((ax + bx + cx) / 3, (ay + by + cy) / 3), (az + bz + cz) / 3);
    return hits || 1;
  };

  for (let t = 0; t < n; t++) {
    faceCross(mesh, t, c);
    const l = Math.hypot(c[0], c[1], c[2]);
    if (!(l > 0)) continue;
    const area = l / 2;
    total += area;
    const nz = c[2] / l;
    if (nz > 0.05) {
      cells(t, (cell, z) => {
        (upZ[cell] ??= []).push(z);
      });
      continue;
    }
    if (nz >= 0) continue;
    const onBed = [0, 1, 2].every((k) => p[idx[t * 3 + k] * 3 + 2] - b.min.z < zTol);
    if (onBed && nz <= -cosFlat) {
      bed += area;
      continue;
    }
    const angle = (Math.asin(Math.min(1, -nz)) * 180) / Math.PI;
    angles.push({ angle, area });
    if (angle > overDeg) {
      over += area;
      overhangs.push({ t, area, angle });
      if (angle > severeDeg) severe += area;
    }
  }

  let plate = 0;
  for (const o of overhangs) {
    let reach = 0;
    const samples = cells(o.t, (cell, z) => {
      let below = -Infinity;
      for (const u of upZ[cell] ?? []) if (u <= z + 0.01 && u > below) below = u;
      if (below === -Infinity || below >= z - 0.5) reach++;
    });
    plate += (o.area * reach) / samples;
  }

  angles.sort((a, b2) => b2.angle - a.angle);
  let acc = 0, maxAngle = 0;
  for (const a of angles) {
    acc += a.area;
    if (acc >= 0.001 * total) {
      maxAngle = a.angle;
      break;
    }
  }
  return {
    totalAreaMm2: total,
    bedContactAreaMm2: bed,
    overhangAreaMm2: over,
    severeOverhangAreaMm2: severe,
    overhangRatio: total > 0 ? over / total : 0,
    severeRatio: total > 0 ? severe / total : 0,
    maxOverhangAngleDeg: round(maxAngle, 1),
    plateReachableRatio: over > 0 ? plate / over : 1,
  };
}

// --------------------------------------------------------------- heuristic

const FUNCTIONAL_WORDS = /\b(bracket|mount|holder|hook|clip|hinge|gear|tool|wrench|stand|case|box|enclosure|adapter|spacer|knob|handle|shelf|organi[sz]er|replacement|part|peg|latch|cable|phone stand|doorstop|functional)\b/i;
const STRONG_WORDS = /\b(strong|sturdy|load|heavy|weight|tough|durable|bracket|hook|hinge|gear|wrench|handle|shelf)\b/i;
const DECORATIVE_WORDS = /\b(figurine|figure|statue|bust|toy|keychain|ornament|vase|sculpture|model|miniature|dragon|dinosaur|animal|character|decor(ation|ative)?|cute|bear|cat|dog|robot|trophy|art)\b/i;

export function inferIntendedUse(description: string | undefined): IntendedUse {
  if (!description) return "unknown";
  const f = FUNCTIONAL_WORDS.test(description), d = DECORATIVE_WORDS.test(description);
  if (f && !d) return "functional";
  if (d && !f) return "decorative";
  return "unknown";
}

/** Deterministic advice. Never throws, never touches the network. */
export function heuristicAdvice(input: AdviseSlicingInput): SlicingAdvice {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const size = input.size;
  const maxDim = Math.max(size.x, size.y, size.z);
  const footprint = Math.max(size.x * size.y, 1e-6);
  const volumeMm3 = input.mesh?.volumeMm3 ?? input.validation?.volumeMm3 ?? size.x * size.y * size.z * 0.4;
  const surface = input.mesh?.surfaceAreaMm2 ?? input.validation?.surfaceAreaMm2 ?? input.overhang?.totalAreaMm2;
  let confidence = 0.8;

  // Intended use.
  let use: IntendedUse = input.intendedUse ?? "unknown";
  if (use === "unknown") {
    use = inferIntendedUse(input.description);
    if (use !== "unknown") reasons.push(`It sounds ${use === "functional" ? "like something you'll use" : "like something to look at"}, so I planned for that.`);
    else confidence -= 0.05;
  }
  const strong = use === "functional" && STRONG_WORDS.test(input.description ?? "");

  // Slicer.
  const slicers = input.availableSlicers ?? [];
  const pick = slicers.find((s) => s.kind === "prusaslicer") ?? slicers.find((s) => s.kind === "orcaslicer") ?? null;
  if (pick?.kind === "prusaslicer") reasons.push("Using PrusaSlicer, the main slicer for Morphix.");
  else if (pick?.kind === "orcaslicer") reasons.push("PrusaSlicer isn't installed, so I'm using OrcaSlicer instead.");
  else {
    warnings.push("No slicer is installed. Install PrusaSlicer (sudo apt install prusa-slicer) so Morphix can make printer files.");
    confidence -= 0.1;
  }

  // Supports.
  let supports: SupportMode = "none";
  const ov = input.overhang;
  if (ov) {
    if (ov.overhangAreaMm2 === 0 || (ov.severeRatio < 0.005 && ov.overhangRatio < 0.05 && ov.maxOverhangAngleDeg < 65)) {
      reasons.push(ov.overhangAreaMm2 === 0 ? "Nothing hangs in the air, so no supports are needed." : `Only gentle overhangs (up to ${Math.round(ov.maxOverhangAngleDeg)}°), so no supports are needed.`);
    } else if (ov.plateReachableRatio >= 0.9) {
      supports = "buildplate";
      reasons.push(`Some parts hang in the air (${pct(ov.overhangRatio)} of the surface), so I'll add supports that stand on the plate.`);
    } else {
      supports = "auto";
      reasons.push(`Some overhangs sit above other parts of the model (${pct(ov.overhangRatio)} of the surface), so supports can grow from the model too.`);
    }
  } else if (input.orientation && surface) {
    const ratio = input.orientation.chosen.overhangAreaMm2 / surface;
    confidence -= 0.15;
    if (ratio < 0.02) reasons.push("Very few overhangs, so no supports are needed.");
    else {
      supports = "auto";
      reasons.push(`About ${pct(ratio)} of the surface hangs over, so I'll add supports.`);
    }
  } else {
    confidence -= 0.25;
    reasons.push("I couldn't measure overhangs, so I kept supports off (the printer profile default).");
  }

  // Orientation: keep a decorative model upright when the original pose is printable.
  let orientation: "auto" | "keep" = "auto";
  const cands = input.orientation?.candidates;
  if (input.lockOrientation) orientation = input.lockOrientation;
  else if (use === "decorative" && input.orientation && input.orientation.unchanged === false && cands?.length && surface) {
    const original = cands[0];
    if (original.overhangAreaMm2 / surface < 0.1 && original.baseAreaMm2 > 0) {
      orientation = "keep";
      reasons.push("Keeping it standing the way it was made, so its face looks its best.");
    }
  }

  // Layer height.
  let layer: number = QD330_PLA_DEFAULTS.layerHeightMm;
  if (maxDim < 25) {
    layer = 0.12;
    reasons.push("It's small, so thinner layers keep the little details.");
  } else if (size.z > 150 || volumeMm3 > 250_000) {
    layer = use === "functional" ? 0.25 : 0.28;
    reasons.push("It's big, so thicker layers will save hours of printing.");
  } else if (use === "decorative" && maxDim < 60) {
    layer = 0.15;
    reasons.push("Thinner layers make a small decoration look smoother.");
  }

  // Infill and walls.
  let infill: number = QD330_PLA_DEFAULTS.infillPercent;
  let walls: number = QD330_PLA_DEFAULTS.perimeters;
  if (use === "functional") {
    infill = strong ? 40 : 30;
    walls = strong ? 4 : 3;
    reasons.push(strong ? "It needs to be strong, so it gets extra walls and a solid inside." : "It's something you'll use, so it gets thicker walls and a stronger inside.");
  } else if (use === "decorative") {
    infill = 10;
    reasons.push("It's for looking at, so a light inside saves plastic and time.");
  }

  // Brim.
  const contact = ov?.bedContactAreaMm2 ?? input.orientation?.chosen.baseAreaMm2;
  const aspect = size.z / Math.max(Math.min(size.x, size.y), 1);
  let brimWidth = 0;
  if (aspect > 2.5 && size.z > 30) {
    brimWidth = aspect > 4 ? 8 : 5;
    reasons.push("It's tall and thin, so a brim helps it stay stuck to the plate.");
  } else if (contact !== undefined && contact < 0.15 * footprint && contact < 150 && size.z > 15) {
    brimWidth = 5;
    reasons.push("Only a small part touches the plate, so a brim helps it hold on.");
  } else if (Math.max(size.x, size.y) > 150) {
    brimWidth = 4;
    reasons.push("Big flat parts can curl at the corners, so a brim helps keep them down.");
  }

  // Warnings about the model itself.
  const vol = input.buildVolume ?? DEFAULT_BUILD_VOLUME;
  if (size.x > vol.x || size.y > vol.y || size.z > vol.z) warnings.push(`It's too big for the printer (${fmt(size)} mm, the limit is ${vol.x} x ${vol.y} x ${vol.z} mm).`);
  if (maxDim < 10) warnings.push("It's very tiny. Some parts may be too small to print well.");
  if (input.validation && !input.validation.watertight) warnings.push("The model has small holes. The slicer will try to fix them.");
  if (input.validation && !input.validation.printable) {
    warnings.push("This model can't be printed as it is.");
    confidence -= 0.3;
  }

  return finalize({
    slicer: pick?.kind ?? null,
    slicerPath: pick?.path ?? null,
    layerHeightMm: layer,
    infillPercent: infill,
    walls,
    supports,
    orientation,
    brim: brimWidth > 0,
    brimWidthMm: brimWidth,
    intendedUse: use,
    reasons,
    warnings,
    confidence,
    source: "heuristic",
  });
}

function finalize(a: SlicingAdvice): SlicingAdvice {
  const L = ADVICE_LIMITS;
  a.layerHeightMm = round(clamp(a.layerHeightMm, L.layerHeightMm.min, L.layerHeightMm.max), 2);
  a.infillPercent = Math.round(clamp(a.infillPercent, L.infillPercent.min, L.infillPercent.max));
  a.walls = Math.round(clamp(a.walls, L.walls.min, L.walls.max));
  a.brimWidthMm = a.brim ? round(clamp(a.brimWidthMm, 1, L.brimWidthMm.max), 1) : 0;
  a.confidence = round(clamp(a.confidence, 0.05, 0.95), 2);
  return a;
}

// --------------------------------------------------------------- Gemini

export type AdvisorFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface AdvisorGeminiOptions {
  apiKey?: string;
  /** Default MORPHIX_GEMINI_TEXT_MODEL or DEFAULT_GEMINI_TEXT_MODEL. */
  model?: string;
  baseUrl?: string;
  fetch?: AdvisorFetch;
  /** Default 20 s. */
  timeoutMs?: number;
}

export interface AdviseOptions {
  /** Gemini refinement; omitted or false = heuristic only. */
  gemini?: AdvisorGeminiOptions | false;
}

/** GEMINI_API_KEY and MORPHIX_GEMINI_TEXT_MODEL. Returns false when no key is set. */
export function advisorGeminiFromEnv(env: Record<string, string | undefined> = process.env, extra: Partial<AdvisorGeminiOptions> = {}): AdvisorGeminiOptions | false {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return false;
  return { apiKey, model: env.MORPHIX_GEMINI_TEXT_MODEL?.trim() || undefined, ...extra };
}

export const ADVISOR_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    layer_height_mm: { type: "number", minimum: ADVICE_LIMITS.layerHeightMm.min, maximum: ADVICE_LIMITS.layerHeightMm.max },
    infill_percent: { type: "integer", minimum: ADVICE_LIMITS.infillPercent.min, maximum: ADVICE_LIMITS.infillPercent.max },
    walls: { type: "integer", minimum: ADVICE_LIMITS.walls.min, maximum: ADVICE_LIMITS.walls.max },
    supports: { type: "string", enum: ["none", "buildplate", "auto"] },
    orientation: { type: "string", enum: ["auto", "keep"] },
    brim: { type: "boolean" },
    brim_width_mm: { type: "number", minimum: 0, maximum: ADVICE_LIMITS.brimWidthMm.max },
    reasons: { type: "array", items: { type: "string" }, maxItems: 6 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["layer_height_mm", "infill_percent", "walls", "supports", "orientation", "brim", "brim_width_mm", "reasons", "confidence"],
} as const;

/**
 * Heuristic advice, refined by Gemini when `opts.gemini` has an API key. Never throws:
 * any Gemini failure returns the heuristic advice with `fallback` set (MX-SLICE-012).
 */
export async function adviseSlicing(input: AdviseSlicingInput, opts: AdviseOptions = {}): Promise<SlicingAdvice> {
  const base = heuristicAdvice(input);
  const g = opts.gemini;
  if (!g || !g.apiKey?.trim()) return base;
  const model = g.model?.trim() || DEFAULT_GEMINI_TEXT_MODEL;
  try {
    const answer = await askGemini(input, base, g, model);
    return mergeGemini(base, answer, input, model);
  } catch (e) {
    const err = e instanceof MorphixError && e.code === "MX-SLICE-012" ? e : new MorphixError("MX-SLICE-012", { message: (e as Error)?.message ?? String(e), cause: e, context: { model } });
    return { ...base, reasons: [...base.reasons, "I used my built-in rules this time."], fallback: err.toJSON() };
  }
}

interface GeminiAdvice {
  layer_height_mm: number;
  infill_percent: number;
  walls: number;
  supports: SupportMode;
  orientation: "auto" | "keep";
  brim: boolean;
  brim_width_mm: number;
  reasons: string[];
  confidence: number;
}

async function askGemini(input: AdviseSlicingInput, base: SlicingAdvice, g: AdvisorGeminiOptions, model: string): Promise<GeminiAdvice> {
  const fetchFn = g.fetch ?? (globalThis.fetch as unknown as AdvisorFetch | undefined);
  if (!fetchFn) throw new Error("fetch is not available");
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: buildPrompt(input, base) }] }],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: ADVISOR_RESPONSE_SCHEMA, temperature: 0.2, maxOutputTokens: 1024 },
  };
  const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), g.timeoutMs ?? 20_000) : undefined;
  try {
    const url = `${(g.baseUrl ?? GEMINI_TEXT_API_BASE).replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
    let res;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": g.apiKey!.trim() },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });
    } catch (e) {
      // Keep the specific network classification (NET-xxx) as context for logs.
      const net = toMorphixError(e, "MX-GEN-010", { service: "gemini" });
      throw new MorphixError("MX-SLICE-012", { message: `Gemini request failed: ${net.message}`, cause: e, context: { model, underlying: net.code } });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new MorphixError("MX-SLICE-012", { message: `Gemini HTTP ${res.status} ${text.slice(0, 200)}`.trim(), context: { model, httpStatus: res.status } });
    }
    return parseGeminiAdvice(await res.json());
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Extracts and type-checks the JSON answer. Throws on anything unexpected. */
export function parseGeminiAdvice(response: unknown): GeminiAdvice {
  const r = response as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
  if (r?.promptFeedback?.blockReason) throw new Error(`Gemini blocked the prompt: ${r.promptFeedback.blockReason}`);
  const text = r?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) throw new Error("Gemini returned no text");
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new Error("Gemini answer is not valid JSON");
  }
  const num = (k: string) => {
    const v = j[k];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Gemini answer: ${k} must be a number`);
    return v;
  };
  const oneOf = <T extends string>(k: string, allowed: readonly T[]): T => {
    const v = j[k];
    if (typeof v !== "string" || !allowed.includes(v as T)) throw new Error(`Gemini answer: ${k} must be one of ${allowed.join(", ")}`);
    return v as T;
  };
  if (typeof j.brim !== "boolean") throw new Error("Gemini answer: brim must be a boolean");
  const reasons = Array.isArray(j.reasons) ? j.reasons.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : [];
  return {
    layer_height_mm: num("layer_height_mm"),
    infill_percent: num("infill_percent"),
    walls: num("walls"),
    supports: oneOf("supports", ["none", "buildplate", "auto"] as const),
    orientation: oneOf("orientation", ["auto", "keep"] as const),
    brim: j.brim,
    brim_width_mm: num("brim_width_mm"),
    reasons,
    confidence: num("confidence"),
  };
}

function mergeGemini(base: SlicingAdvice, g: GeminiAdvice, input: AdviseSlicingInput, model: string): SlicingAdvice {
  const reasons = g.reasons.slice(0, 6).map((s) => s.trim().replace(/\s+/g, " ").slice(0, 200));
  const ov = input.overhang;
  let supports = g.supports;
  // Safety: Gemini may add supports but not remove ones the geometry clearly needs.
  const needed = base.supports !== "none" && (!ov || ov.severeRatio >= 0.01 || ov.overhangRatio >= 0.08);
  if (supports === "none" && needed) {
    supports = base.supports;
    reasons.push("I kept the supports because parts of the model hang in the air.");
  }
  // "buildplate" on a model whose overhangs sit over itself would leave them unsupported.
  if (supports === "buildplate" && ov && ov.overhangAreaMm2 > 0 && ov.plateReachableRatio < 0.9 && base.supports === "auto") {
    supports = "auto";
    reasons.push("Some overhangs sit above the model itself, so supports may grow from the model.");
  }
  // Brim: Gemini may add one; it may only drop the heuristic's brim for wide, short models.
  let brim = g.brim;
  if (!brim && base.brim && input.size.z / Math.max(Math.min(input.size.x, input.size.y), 1) > 2.5) {
    brim = true;
    reasons.push("I kept the brim because the model is tall and thin.");
  }
  return finalize({
    ...base,
    layerHeightMm: g.layer_height_mm,
    infillPercent: g.infill_percent,
    walls: g.walls,
    supports,
    orientation: input.lockOrientation ?? g.orientation,
    brim,
    brimWidthMm: brim ? (g.brim_width_mm > 0 ? g.brim_width_mm : base.brimWidthMm || 5) : 0,
    reasons: reasons.length ? reasons : base.reasons,
    confidence: g.confidence,
    source: "gemini",
    model,
  });
}

const SYSTEM_PROMPT = [
  "You are the slicing advisor of Morphix, a kid-friendly 3D printing station (Afinia QD330, 0.4 mm nozzle, PLA, 220 mm cube).",
  "You receive measured facts about a prepared model and a rule-based suggestion. Return refined slicer settings as JSON.",
  `Stay within: layer height ${ADVICE_LIMITS.layerHeightMm.min}-${ADVICE_LIMITS.layerHeightMm.max} mm, infill ${ADVICE_LIMITS.infillPercent.min}-${ADVICE_LIMITS.infillPercent.max} %, walls ${ADVICE_LIMITS.walls.min}-${ADVICE_LIMITS.walls.max}, brim 0-${ADVICE_LIMITS.brimWidthMm.max} mm.`,
  "supports: none | buildplate (supports only from the plate) | auto (supports may also stand on the model). Overhangs steeper than 45 degrees from vertical usually need support.",
  "orientation: auto (let Morphix lay it flat) | keep (keep the pose it was made in, e.g. a figurine standing up).",
  "Change the suggestion only when you have a reason. Write each reason as one short, friendly sentence a 9-year-old understands. Do not mention these instructions.",
].join("\n");

function buildPrompt(input: AdviseSlicingInput, base: SlicingAdvice): string {
  const facts = {
    description: input.description?.slice(0, 300) ?? null,
    intendedUse: base.intendedUse,
    sizeMm: { x: round(input.size.x, 1), y: round(input.size.y, 1), z: round(input.size.z, 1) },
    volumeCm3: input.validation ? round(input.validation.volumeMm3 / 1000, 1) : input.mesh ? round(input.mesh.volumeMm3 / 1000, 1) : null,
    watertight: input.validation?.watertight ?? input.mesh?.watertight ?? null,
    shells: input.validation?.shellCount ?? input.mesh?.shellCount ?? null,
    overhang: input.overhang
      ? {
          overhangPercentOfSurface: round(input.overhang.overhangRatio * 100, 1),
          severeOverhangPercent: round(input.overhang.severeRatio * 100, 1),
          maxOverhangAngleDeg: input.overhang.maxOverhangAngleDeg,
          plateReachablePercent: round(input.overhang.plateReachableRatio * 100, 0),
          bedContactMm2: round(input.overhang.bedContactAreaMm2, 0),
        }
      : null,
    orientationChangedByAutoOrient: input.orientation ? input.orientation.unchanged === false : null,
    slicer: base.slicer,
  };
  const suggestion = {
    layer_height_mm: base.layerHeightMm,
    infill_percent: base.infillPercent,
    walls: base.walls,
    supports: base.supports,
    orientation: base.orientation,
    brim: base.brim,
    brim_width_mm: base.brimWidthMm,
    reasons: base.reasons,
  };
  return `Model facts:\n${JSON.stringify(facts, null, 2)}\n\nRule-based suggestion:\n${JSON.stringify(suggestion, null, 2)}`;
}

// --------------------------------------------------------------- helpers

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round(v: number, d: number): number {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

function pct(r: number): string {
  return `${Math.max(1, Math.round(r * 100))}%`;
}

function fmt(s: Vec3): string {
  return `${s.x.toFixed(0)} x ${s.y.toFixed(0)} x ${s.z.toFixed(0)}`;
}
