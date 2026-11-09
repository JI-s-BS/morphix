// Claude + headless OpenSCAD: Claude writes parametric OpenSCAD for a functional part,
// the code passes static safety checks, `openscad -o out.stl in.scad` renders it, and
// the STL is validated (manifold, non-empty, inside the QD330 build volume, roughly the
// size Claude intended). Any failure goes back to Claude for another attempt.
import { checkScadSafety, runOpenscad, summarizeLog } from "@morphix/photo3d";
import { QD330_BUILD_VOLUME_MM } from "@morphix/shared";
import { computeBounds, parseStl, translateMesh, validateMesh, writeBinaryStl, type ExecFileFn, type Mesh } from "@morphix/slicing";
import { ClaudeClient, partialJsonString, type ClaudeEffort, type FetchLike } from "./claude";
import { describeDevice, isFitCritical, lookupDevice, mentionsDevice, type DeviceDimensions } from "./devices";
import { CadError, throwIfAborted } from "./errors";
import { buildCadPrompt, CAD_ANSWER_SCHEMA, CAD_SYSTEM_PROMPT, type CadAnswer, type FailedAttempt } from "./prompt";

/** Claude tries at most twice: each attempt is a full design + render, and 4 took too long. */
export const DEFAULT_MAX_ATTEMPTS = 2;
/** OpenSCAD's CGAL renderer is slow on a Raspberry Pi 4. */
export const DEFAULT_CAD_OPENSCAD_TIMEOUT_MS = 300_000;
/** Rendered size may differ from Claude's stated size by max(2 mm, 10 %) per axis. */
export const SIZE_TOLERANCE_MM = 2;
export const SIZE_TOLERANCE_PCT = 0.1;

export type CadStage = "designing" | "rendering" | "checking" | "repairing" | "done";

/** What Claude is working on right now, for showing the design live on screen. */
export interface CadProgressInfo {
  attempt: number;
  maxAttempts: number;
  /** The OpenSCAD Claude wrote for this attempt (from "rendering" on). */
  scad?: string;
  /** The rendered model of this attempt, binary STL in mm (from "checking" on). */
  stl?: Buffer;
}

export interface CadRequest {
  /** What to make, in the user's words ("iPhone 17 case with a cool design"). */
  description: string;
  /** Measurements the user gave, by name ("inner diameter": 22). Units are mm. */
  dimensions?: Record<string, number>;
  /** Optional analysis of the user's photos (e.g. from @morphix/photo3d), passed to Claude as context. */
  photoAnalysis?: unknown;
  /** The current design's OpenSCAD when this request changes it. */
  baseScad?: string;
  maxAttempts?: number;
}

export interface CadDeps {
  anthropicApiKey: string;
  /** Default claude-opus-5-5 (MORPHIX_CLAUDE_MODEL). */
  model?: string;
  effort?: ClaudeEffort;
  exec?: ExecFileFn;
  openscadBin?: string;
  openscadTimeoutMs?: number;
  fetch?: FetchLike | typeof fetch;
  /** Send `fallbacks: "default"` to the Claude API where the model supports it (default true). */
  fallbacks?: boolean;
  signal?: AbortSignal;
  onProgress?: (stage: CadStage, detail: string, info?: CadProgressInfo) => void;
  /** Injectable for tests (Claude API retry back-off). */
  sleep?: (ms: number) => Promise<void>;
}

export type CadAttemptOutcome = "ok" | "no-answer" | "unsafe" | "compile" | "timeout" | "empty" | "bad-stl" | "non-manifold" | "too-large" | "too-small" | "size-mismatch";

export interface CadAttempt {
  attempt: number;
  outcome: CadAttemptOutcome;
  detail?: string;
}

export interface CadResult {
  /** Binary STL in mm, Z up, resting on Z = 0. */
  stl: Buffer;
  /** The OpenSCAD source that produced it (parametric; variables at the top). */
  scad: string;
  /** Rendered bounding box, mm. */
  sizeMm: { x: number; y: number; z: number };
  /** Printing / assembly notes (Claude's, plus anything the checks noticed). */
  notes: string[];
  /** Number of Claude + OpenSCAD rounds used. */
  attempts: number;
  /**
   * Measurements that were assumed, not given or looked up. Non-empty means: show
   * "based on these measurements, check before printing".
   */
  assumptions: string[];
  /** The reference-table device the design used, or null. */
  device: Pick<DeviceDimensions, "name" | "heightMm" | "widthMm" | "depthMm" | "source"> | null;
  /** True for cases, mounts, replacement parts... anything that must fit something. */
  fitCritical: boolean;
  model: string;
  attemptLog: CadAttempt[];
  triangles: number;
  volumeMm3: number;
}

interface Rendered {
  answer: CadAnswer;
  stl: Buffer;
  mesh: Mesh;
  size: { x: number; y: number; z: number };
  notes: string[];
  triangles: number;
  volumeMm3: number;
}

export async function generateCadModel(request: CadRequest, deps: CadDeps): Promise<CadResult> {
  const description = request.description?.trim() ?? "";
  if (!description) throw new CadError("MX-CAD-001");
  const maxAttempts = Math.max(1, Math.floor(request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const claude = new ClaudeClient({ apiKey: deps.anthropicApiKey, model: deps.model, effort: deps.effort, fetch: deps.fetch, fallbacks: deps.fallbacks, sleep: deps.sleep });
  const progress = deps.onProgress ?? (() => undefined);
  const device = lookupDevice(description);
  const fitCritical = isFitCritical(description);

  const history: FailedAttempt[] = [];
  const log: CadAttempt[] = [];
  let sizeMismatch: Rendered | null = null;
  let lastScad = "";

  for (let n = 1; n <= maxAttempts; n++) {
    throwIfAborted(deps.signal);
    const at = { attempt: n, maxAttempts };
    progress("designing", n === 1 ? `Claude is designing: ${description}` : `Claude is fixing the design (attempt ${n} of ${maxAttempts})`, at);
    const reply = await claude.generateJson<Partial<CadAnswer>>({
      system: CAD_SYSTEM_PROMPT,
      prompt: buildCadPrompt({ description, dimensions: request.dimensions, photoAnalysis: request.photoAnalysis, device, baseScad: request.baseScad }, history),
      schema: CAD_ANSWER_SCHEMA as unknown as Record<string, unknown>,
      signal: deps.signal,
      // Live view: show the OpenSCAD as Claude writes it.
      onText: deps.onProgress
        ? (t) => {
            const code = partialJsonString(t, "scad");
            if (code) progress("designing", `Claude is writing the CAD code (attempt ${n})`, { ...at, scad: code });
          }
        : undefined,
    });
    const answer = normalizeAnswer(reply.value);
    const fail = (outcome: CadAttemptOutcome, problem: string, scad = answer?.scad ?? "") => {
      log.push({ attempt: n, outcome, detail: problem });
      history.push({ attempt: n, scad, problem });
      if (n < maxAttempts) progress("repairing", problem, { ...at, scad: scad || undefined });
    };
    if (!answer) {
      fail("no-answer", reply.stopReason === "max_tokens" ? "the answer was cut off (too long); write more compact code" : "the answer was not the requested JSON object with a non-empty `scad` string");
      continue;
    }
    lastScad = answer.scad;
    const safety = checkScadSafety(answer.scad);
    if (!safety.ok) {
      fail("unsafe", `rejected by the safety checks: ${safety.problems.join("; ")}`);
      continue;
    }

    throwIfAborted(deps.signal);
    progress("rendering", `OpenSCAD is rendering attempt ${n}`, { ...at, scad: answer.scad });
    const timeoutMs = deps.openscadTimeoutMs ?? DEFAULT_CAD_OPENSCAD_TIMEOUT_MS;
    const run = await runOpenscad(answer.scad, { bin: deps.openscadBin, exec: deps.exec, timeoutMs });
    if (!run.ok) {
      if (run.kind === "missing") throw new CadError("MX-CAD-020", `The openscad program was not found (${deps.openscadBin ?? "openscad"}). Install it with: sudo apt install openscad`, answer.scad);
      if (run.kind === "timeout") fail("timeout", `rendering took longer than ${Math.round(timeoutMs / 1000)} s; simplify (lower $fn, no minkowski, fewer boolean operations)`);
      else if (run.kind === "empty") fail("empty", "the code produced no 3D geometry (top-level object is empty)");
      else fail("compile", `OpenSCAD error:\n${summarizeLog(run.log)}`);
      continue;
    }

    progress("checking", `Checking the model from attempt ${n}`, { ...at, scad: answer.scad, stl: run.stl });
    const checked = checkRendered(answer, run.stl);
    if (!checked.ok) {
      fail(checked.outcome, checked.problem);
      continue;
    }
    const r = checked.rendered;
    const mismatch = sizeMismatchProblem(answer.sizeMm, r.size);
    if (mismatch) {
      // Usable, but not what Claude meant: ask again, keep it as a fallback.
      fail("size-mismatch", mismatch);
      if (!sizeMismatch) sizeMismatch = r;
      continue;
    }
    log.push({ attempt: n, outcome: "ok" });
    return finish(r, n);
  }

  if (sizeMismatch) {
    sizeMismatch.notes.push("The rendered size differs from what Claude intended; check the dimensions in the preview before printing.");
    return finish(sizeMismatch, maxAttempts);
  }
  const last = log[log.length - 1];
  throw new CadError("MX-CAD-021", `No printable design after ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}. Last problem: ${last?.detail ?? "unknown"}`.slice(0, 1000), lastScad || undefined);

  function finish(r: Rendered, attempts: number): CadResult {
    progress("done", `Model ready: ${fmtSize(r.size)}`, { attempt: attempts, maxAttempts, scad: r.answer.scad, stl: r.stl });
    return {
      stl: r.stl,
      scad: r.answer.scad,
      sizeMm: r.size,
      notes: [...r.answer.notes, ...r.notes],
      attempts,
      assumptions: buildAssumptions(r.answer.assumptions, device, description),
      device: device ? { name: device.name, heightMm: device.heightMm, widthMm: device.widthMm, depthMm: device.depthMm, source: device.source } : null,
      fitCritical,
      model: claude.model,
      attemptLog: log,
      triangles: r.triangles,
      volumeMm3: r.volumeMm3,
    };
  }
}

function normalizeAnswer(v: Partial<CadAnswer> | null): CadAnswer | null {
  if (!v || typeof v.scad !== "string" || !v.scad.trim()) return null;
  const strs = (a: unknown) => (Array.isArray(a) ? a.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim()) : []);
  const s = v.sizeMm;
  const sizeMm = s && [s.x, s.y, s.z].every((k) => typeof k === "number" && Number.isFinite(k) && k > 0) ? { x: s.x, y: s.y, z: s.z } : { x: 0, y: 0, z: 0 };
  return { scad: stripFence(v.scad), sizeMm, assumptions: strs(v.assumptions), notes: strs(v.notes) };
}

function stripFence(code: string): string {
  const m = /^\s*```(?:openscad|scad)?\s*\n([\s\S]*?)```\s*$/.exec(code);
  return (m ? m[1] : code).trim();
}

type Checked = { ok: true; rendered: Rendered } | { ok: false; outcome: CadAttemptOutcome; problem: string };

/** Mesh checks with the slicing helpers; fixes only a Z offset (drops the part onto the bed). */
export function checkRendered(answer: CadAnswer, stl: Buffer): Checked {
  let mesh: Mesh;
  try {
    mesh = parseStl(stl);
  } catch (e) {
    return { ok: false, outcome: "bad-stl", problem: `the STL could not be read: ${(e as Error).message}` };
  }
  if (mesh.indices.length === 0) return { ok: false, outcome: "empty", problem: "the code produced no 3D geometry" };
  const v = validateMesh(mesh);
  const tris = v.triangles;
  if (v.invalidCoordinates) return { ok: false, outcome: "bad-stl", problem: `${v.invalidCoordinates} non-finite coordinates in the output` };
  if (v.edges.boundaryEdges || v.edges.nonManifoldEdges) {
    return {
      ok: false,
      outcome: "non-manifold",
      problem: `the mesh is not a clean solid (${v.edges.boundaryEdges} open edges, ${v.edges.nonManifoldEdges} non-manifold edges). Usually caused by parts that only touch along an edge or at a point, or coincident faces: overlap unioned parts by at least 0.01 mm and extend cutting shapes 0.01 mm past the faces they cut`,
    };
  }
  if (v.inverted) return { ok: false, outcome: "non-manifold", problem: "the mesh is inside-out (negative volume); check polyhedron face winding" };
  if (v.degenerateFaces > Math.max(10, tris * 0.02)) return { ok: false, outcome: "non-manifold", problem: `${v.degenerateFaces} of ${tris} faces are degenerate (zero area); avoid coincident faces and extremely thin slivers` };

  const size = v.bounds.size;
  const vol = QD330_BUILD_VOLUME_MM;
  if (size.x > vol.x || size.y > vol.y || size.z > vol.z) {
    return {
      ok: false,
      outcome: "too-large",
      problem: `the part is ${fmtSize(size)}, larger than the ${vol.x} x ${vol.y} x ${vol.z} mm build volume. Make it smaller, or rotate it so it fits (keep it flat on Z = 0)`,
    };
  }
  if (Math.max(size.x, size.y, size.z) < 2 || Math.min(size.x, size.y, size.z) < 0.4) {
    return { ok: false, outcome: "too-small", problem: `the part is only ${fmtSize(size)}; check the units (millimetres) and the variables` };
  }

  const notes: string[] = [];
  let outStl = stl;
  const minZ = v.bounds.min.z;
  if (Math.abs(minZ) > 0.01) {
    mesh = translateMesh(mesh, { x: 0, y: 0, z: -minZ });
    outStl = writeBinaryStl(mesh, "Morphix CAD (Claude + OpenSCAD), mm");
    notes.push(`Moved the part ${minZ > 0 ? "down" : "up"} ${Math.abs(minZ).toFixed(2)} mm so it rests on the bed.`);
  }
  if (v.shellCount > 1) notes.push(`The model has ${v.shellCount} separate pieces; they print together on one plate.`);
  return { ok: true, rendered: { answer, stl: outStl, mesh, size: computeBounds(mesh).size, notes, triangles: tris, volumeMm3: v.volumeMm3 } };
}

/** Null when the rendered size matches Claude's stated size (or none was stated). */
export function sizeMismatchProblem(expected: { x: number; y: number; z: number }, actual: { x: number; y: number; z: number }): string | null {
  if (!(expected.x > 0 && expected.y > 0 && expected.z > 0)) return null;
  const off = (["x", "y", "z"] as const).filter((k) => Math.abs(actual[k] - expected[k]) > Math.max(SIZE_TOLERANCE_MM, expected[k] * SIZE_TOLERANCE_PCT));
  if (!off.length) return null;
  return `the rendered part is ${fmtSize(actual)} but you said it would be ${fmtSize(expected)} (axis ${off.join(", ")} off). Fix the geometry (or the stated size if the geometry is right)`;
}

function buildAssumptions(fromClaude: string[], device: DeviceDimensions | null, description: string): string[] {
  const out: string[] = [];
  if (device) out.push(`Used ${describeDevice(device)}. Not re-measured by Morphix.`);
  out.push(...fromClaude);
  if (!device && mentionsDevice(description) && fromClaude.length === 0) {
    out.push("The device's measurements were estimated (it is not in Morphix's reference table). Measure your device before printing.");
  }
  return [...new Set(out)];
}

function fmtSize(s: { x: number; y: number; z: number }): string {
  return `${s.x.toFixed(1)} x ${s.y.toFixed(1)} x ${s.z.toFixed(1)} mm`;
}
