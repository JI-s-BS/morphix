// OpenSCAD engine: Gemini writes OpenSCAD for an exact design spec, the code passes
// static safety checks, the `openscad` CLI renders it (execFile, no shell, timeout,
// private temp dir), and compile errors or size mismatches are fed back to Gemini
// for another attempt (max 3). Debian: `sudo apt install openscad`.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBounds, defaultExec, parseStl, type ExecFileFn, type Mesh } from "@morphix/slicing";
import type { Dimensions, OpenscadSpec } from "./analyze";
import { checkDimensions, DIMENSION_TOLERANCE, type DimensionCheck } from "./dimensions";
import { Photo3dError, throwIfAborted, type P3dErrorCode } from "./errors";
import type { GeminiJsonClient } from "./gemini";

export const MAX_SCAD_BYTES = 64 * 1024;
export const MAX_RANGE_STEPS = 2000;
export const MAX_TOTAL_RANGE_STEPS = 20000;
export const MAX_FN = 256;
export const DEFAULT_OPENSCAD_TIMEOUT_MS = 120_000;

// ------------------------------------------------------------------ safety

export interface SafetyResult {
  ok: boolean;
  problems: string[];
}

/** Removes comments and string literals so keyword checks see only code. */
export function stripScad(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/**
 * Static checks before anything runs. Rejects every way OpenSCAD can read other files
 * (import, include/use, surface, the deprecated dxf_* functions and file= parameters),
 * absurd resolution ($fn) and literal loop ranges that would take forever.
 */
export function checkScadSafety(code: string): SafetyResult {
  const problems: string[] = [];
  if (Buffer.byteLength(code, "utf8") > MAX_SCAD_BYTES) problems.push(`code is larger than ${MAX_SCAD_BYTES / 1024} KB`);
  const s = stripScad(code);
  const banned: [RegExp, string][] = [
    [/\bimport\b/, "import() reads external files"],
    [/\binclude\s*</, "include <...> reads external files"],
    [/\buse\s*</, "use <...> reads external files"],
    [/\bsurface\s*\(/, "surface() reads external files"],
    [/\bdxf_\w+\s*\(/, "dxf_* functions read external files"],
    [/\bfile\s*=/, "file= parameters read external files"],
    [/\b(?:include|use)\b/, "include/use are not allowed"],
  ];
  for (const [re, why] of banned) if (re.test(s) && !problems.includes(why)) problems.push(why);

  for (const m of s.matchAll(/\$fn\s*=\s*([0-9.eE+-]+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > MAX_FN) problems.push(`$fn = ${m[1]} is too high (max ${MAX_FN})`);
  }
  for (const m of s.matchAll(/\$fs\s*=\s*([0-9.eE+-]+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n < 0.05) problems.push(`$fs = ${m[1]} is too fine (min 0.05)`);
  }
  for (const m of s.matchAll(/\$fa\s*=\s*([0-9.eE+-]+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n < 0.5) problems.push(`$fa = ${m[1]} is too fine (min 0.5)`);
  }

  // Literal ranges [a : b] / [a : step : b].
  let total = 0;
  const numRe = "(-?[0-9]*\\.?[0-9]+(?:[eE][+-]?[0-9]+)?)";
  const rangeRe = new RegExp(`\\[\\s*${numRe}\\s*:\\s*${numRe}\\s*(?::\\s*${numRe}\\s*)?\\]`, "g");
  for (const m of s.matchAll(rangeRe)) {
    const a = Number(m[1]);
    const step = m[3] !== undefined ? Number(m[2]) : 1;
    const b = m[3] !== undefined ? Number(m[3]) : Number(m[2]);
    if (step === 0) {
      problems.push(`range ${m[0]} has a zero step`);
      continue;
    }
    const steps = Math.floor(Math.abs((b - a) / step)) + 1;
    total += steps;
    if (steps > MAX_RANGE_STEPS) problems.push(`range ${m[0]} has ${steps} steps (max ${MAX_RANGE_STEPS})`);
  }
  if (total > MAX_TOTAL_RANGE_STEPS) problems.push(`loop ranges total ${total} steps (max ${MAX_TOTAL_RANGE_STEPS})`);
  if (!/\b(cube|cylinder|sphere|polyhedron|linear_extrude|rotate_extrude|hull|minkowski)\b/.test(s)) problems.push("no 3D geometry (cube, cylinder, sphere, polyhedron or extrusion)");
  return { ok: problems.length === 0, problems };
}

// ------------------------------------------------------------------ runner

export type OpenscadRun =
  | { ok: true; stl: Buffer; log: string }
  | { ok: false; kind: "missing" | "timeout" | "compile" | "empty"; log: string };

export interface OpenscadRunOptions {
  bin?: string;
  exec?: ExecFileFn;
  timeoutMs?: number;
  /** Parent of the per-run temp directory (default os.tmpdir()). */
  tmpRoot?: string;
}

/** Renders SCAD source to STL in a private temp dir. Does NOT run the safety check. */
export async function runOpenscad(code: string, o: OpenscadRunOptions = {}): Promise<OpenscadRun> {
  const dir = await mkdtemp(join(o.tmpRoot ?? tmpdir(), "morphix-scad-"));
  try {
    const src = join(dir, "model.scad");
    const out = join(dir, "model.stl");
    await writeFile(src, code, "utf8");
    const exec = o.exec ?? defaultExec;
    const r = await exec(o.bin ?? "openscad", ["-o", out, src], { timeoutMs: o.timeoutMs ?? DEFAULT_OPENSCAD_TIMEOUT_MS, cwd: dir });
    const log = `${r.stderr}\n${r.stdout}`.trim();
    if (r.code === null && /ENOENT/.test(r.stderr)) return { ok: false, kind: "missing", log };
    if (r.timedOut) return { ok: false, kind: "timeout", log };
    const empty = /top level object is empty|no top[- ]level geometry/i.test(log);
    if (r.code !== 0) return { ok: false, kind: empty ? "empty" : "compile", log };
    const stl = await readFile(out).catch(() => null);
    // An empty model may still leave a header-only file; the design loop also rejects 0 triangles.
    if (!stl || stl.length < 84) return { ok: false, kind: "empty", log };
    return { ok: true, stl, log };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Version string, or null when the binary is missing. */
export async function openscadVersion(o: Pick<OpenscadRunOptions, "bin" | "exec"> = {}): Promise<string | null> {
  const r = await (o.exec ?? defaultExec)(o.bin ?? "openscad", ["--version"], { timeoutMs: 10_000 });
  if (r.code === null && /ENOENT/.test(r.stderr)) return null;
  const m = /OpenSCAD version\s+(\S+)/i.exec(`${r.stderr}\n${r.stdout}`);
  return m ? m[1] : r.code === 0 ? "unknown" : null;
}

/** Keeps the useful part of an OpenSCAD log for Gemini (errors first, bounded). */
export function summarizeLog(log: string, max = 1500): string {
  const lines = log.split(/\r?\n/).filter((l) => /ERROR|WARNING|error|Parser|syntax|undefined|empty/i.test(l));
  return (lines.length ? lines : log.split(/\r?\n/)).join("\n").slice(0, max);
}

// ------------------------------------------------------------------ design loop

export interface OpenscadDesignInput {
  objectName: string;
  description: string;
  spec: OpenscadSpec;
  dimensions: Dimensions;
  /** Feature measurements from the user (hole diameters etc.), already in the user's words. */
  measurements?: { label: string; value: number; unit: string }[];
}

export interface OpenscadAttempt {
  attempt: number;
  code: string;
  outcome: "ok" | "unsafe" | "compile" | "timeout" | "empty" | "dimension-mismatch" | "bad-stl";
  detail?: string;
}

export interface OpenscadDesignResult {
  scad: string;
  stl: Buffer;
  mesh: Mesh;
  dimensionCheck: DimensionCheck;
  attempts: OpenscadAttempt[];
}

export interface OpenscadDesignDeps extends OpenscadRunOptions {
  gemini: GeminiJsonClient;
  maxAttempts?: number;
  tolerance?: number;
  signal?: AbortSignal;
  onAttempt?: (a: { attempt: number; phase: "writing" | "compiling" }) => void;
}

const SCAD_SCHEMA = {
  type: "object",
  properties: { scad: { type: "string" }, explanation: { type: "string" } },
  required: ["scad"],
};

export function buildScadPrompt(input: OpenscadDesignInput, history: OpenscadAttempt[]): string {
  const d = input.dimensions;
  const s = input.spec;
  const lines = [
    `Write OpenSCAD code for: ${input.objectName}. ${input.description}`.trim(),
    `Overall bounding box MUST be exactly ${d.width.valueMm} mm (X, width) x ${d.depth.valueMm} mm (Y, depth) x ${d.height.valueMm} mm (Z, height).`,
    `Design spec: ${s.summary}`,
    ...s.features.map((f) => `- feature: ${f}`),
    s.wallThicknessMm ? `- wall thickness: ${s.wallThicknessMm} mm` : "- wall thickness: at least 1.6 mm",
    ...s.holes.map((h) => `- hole: ${h.description}, diameter ${h.diameterMm} mm, ${h.depthMm === null ? "through" : `${h.depthMm} mm deep`}`),
    s.toleranceMm ? `- clearance for fitting parts: ${s.toleranceMm} mm per side` : "",
    s.bedOrientation ? `- rests on the bed: ${s.bedOrientation}` : "",
    s.notes ? `- notes: ${s.notes}` : "",
    ...(input.measurements ?? []).map((m) => `- user measurement: ${m.label} = ${m.value} ${m.unit}`),
    "",
    "Rules:",
    "- Units are millimetres. Put every key dimension in a named variable at the top.",
    "- The part sits in print orientation on Z = 0 (nothing below Z = 0), X/Y roughly centred on the origin.",
    "- One solid top-level object (wrap everything in union() if needed). Watertight, no zero-thickness walls.",
    `- Curves: $fn between 32 and 96 (never more than ${MAX_FN}).`,
    "- Avoid unsupported overhangs steeper than 45 degrees; chamfer instead of overhanging fillets on the bottom edge.",
    "- Do NOT use import(), include, use, surface(), dxf functions or file= parameters; standard library only.",
    "- Keep loops small (well under 1000 iterations).",
    'Answer JSON: {"scad": "<the complete code>", "explanation": "<one sentence>"}.',
  ];
  if (history.length) {
    lines.push("", "Previous attempts failed. Fix the problem and return the complete corrected code.");
    for (const h of history.slice(-2)) {
      lines.push(`Attempt ${h.attempt} (${h.outcome}): ${h.detail ?? ""}`.trim(), "```openscad", h.code.slice(0, 6000), "```");
    }
  }
  return lines.filter((l) => l !== "").join("\n");
}

export async function designWithOpenscad(input: OpenscadDesignInput, deps: OpenscadDesignDeps): Promise<OpenscadDesignResult> {
  const maxAttempts = deps.maxAttempts ?? 3;
  const tolerance = deps.tolerance ?? DIMENSION_TOLERANCE;
  const attempts: OpenscadAttempt[] = [];
  let best: OpenscadDesignResult | null = null;
  let lastCode: P3dErrorCode = "MX-P3D-032";

  for (let n = 1; n <= maxAttempts; n++) {
    throwIfAborted(deps.signal);
    deps.onAttempt?.({ attempt: n, phase: "writing" });
    const answer = await deps.gemini.generateJson<{ scad?: unknown }>({
      parts: [{ text: buildScadPrompt(input, attempts) }],
      schema: SCAD_SCHEMA,
      system: "You are an expert OpenSCAD engineer designing functional parts for FDM printing. Exact dimensions matter.",
      temperature: 0.1,
      maxOutputTokens: 8192,
      signal: deps.signal,
    });
    const code = typeof answer?.scad === "string" ? answer.scad.trim() : "";
    const safety = checkScadSafety(code);
    if (!safety.ok) {
      attempts.push({ attempt: n, code, outcome: "unsafe", detail: `rejected by safety checks: ${safety.problems.join("; ")}` });
      lastCode = "MX-P3D-031";
      continue;
    }
    throwIfAborted(deps.signal);
    deps.onAttempt?.({ attempt: n, phase: "compiling" });
    const run = await runOpenscad(code, deps);
    if (!run.ok) {
      if (run.kind === "missing") throw new Photo3dError("MX-P3D-030", `The openscad program was not found (${deps.bin ?? "openscad"}). Install it with: sudo apt install openscad`);
      const detail =
        run.kind === "timeout"
          ? `rendering took longer than ${Math.round((deps.timeoutMs ?? DEFAULT_OPENSCAD_TIMEOUT_MS) / 1000)} s; simplify (lower $fn, avoid minkowski and large loops)`
          : run.kind === "empty"
            ? "the code produced no 3D geometry"
            : `OpenSCAD error:\n${summarizeLog(run.log)}`;
      attempts.push({ attempt: n, code, outcome: run.kind, detail });
      lastCode = run.kind === "timeout" ? "MX-P3D-033" : run.kind === "empty" ? "MX-P3D-034" : "MX-P3D-032";
      continue;
    }
    let mesh: Mesh;
    try {
      mesh = parseStl(run.stl);
    } catch (e) {
      attempts.push({ attempt: n, code, outcome: "bad-stl", detail: (e as Error).message });
      lastCode = "MX-P3D-034";
      continue;
    }
    if (mesh.indices.length === 0) {
      attempts.push({ attempt: n, code, outcome: "empty", detail: "the code produced no 3D geometry" });
      lastCode = "MX-P3D-034";
      continue;
    }
    const check = checkDimensions(computeBounds(mesh).size, input.dimensions, tolerance);
    const result: OpenscadDesignResult = { scad: code, stl: run.stl, mesh, dimensionCheck: check, attempts };
    if (check.ok) {
      attempts.push({ attempt: n, code, outcome: "ok" });
      return result;
    }
    attempts.push({ attempt: n, code, outcome: "dimension-mismatch", detail: check.summary });
    if (!best || worstError(check) < worstError(best.dimensionCheck)) best = result;
  }
  // A model that compiled but is slightly off is still returned (the caller warns).
  if (best) return { ...best, attempts };
  const last = attempts[attempts.length - 1];
  throw new Photo3dError(lastCode, `${messageFor(lastCode)} Last problem: ${last?.detail ?? "unknown"}`.slice(0, 800), last?.code);
}

function worstError(c: DimensionCheck): number {
  return Math.max(...c.axes.map((a) => a.errorPct));
}

function messageFor(code: P3dErrorCode): string {
  switch (code) {
    case "MX-P3D-031":
      return "The generated OpenSCAD code failed the safety checks.";
    case "MX-P3D-033":
      return "OpenSCAD took too long to render the design.";
    case "MX-P3D-034":
      return "The OpenSCAD design produced no geometry.";
    default:
      return "OpenSCAD could not compile the generated design.";
  }
}
