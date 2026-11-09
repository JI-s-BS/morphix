// Shared fakes for the photo3d tests. Nothing here touches the network or spends credits.
import { writeFile } from "node:fs/promises";
import { buildGlb, writeBinaryStl, type ExecFileFn, type ExecResult, type Mesh } from "@morphix/slicing";
import { GeminiJsonClient, MeshyImageClient, type FetchLike } from "@morphix/photo3d";
import { box } from "./phase3-fixtures";

export { box };

export const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
export const HEIC = Uint8Array.from([0, 0, 0, 24, ...Buffer.from("ftypheic"), 0, 0, 0, 0, ...Buffer.from("mif1heic")]);

export function boxStl(x: number, y: number, z: number): Buffer {
  return writeBinaryStl(box(x, y, z));
}

/** A Y-up GLB box (glTF metres) whose printed size is x by y (depth) by z (height). */
export function boxGlbYUp(x: number, depth: number, height: number): Buffer {
  const m = box(x, height, depth); // glTF Y is up; (x, y, z) -> (x, -z, y) gives x by depth by height
  return buildGlb([{ positions: m.positions, indices: m.indices }]);
}

export function geminiBody(answer: unknown, finishReason = "STOP"): string {
  return JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: typeof answer === "string" ? answer : JSON.stringify(answer) }] }, finishReason }] });
}

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

type Reply = { status?: number; body: string } | ((call: Call) => { status?: number; body: string } | Promise<{ status?: number; body: string }>);

/** Gemini fetch double: answers analysis requests and OpenSCAD requests from separate queues. */
export function fakeGemini(o: { analysis?: Reply[]; scad?: Reply[] } = {}) {
  const calls: Call[] = [];
  const queues = { analysis: [...(o.analysis ?? [])], scad: [...(o.scad ?? [])] };
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, method: init.method, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    const isScad = !!call.body.generationConfig?.responseJsonSchema?.properties?.scad;
    const q = isScad ? queues.scad : queues.analysis;
    const r = q.length > 1 ? q.shift()! : q[0];
    if (!r) throw new Error(`no fake ${isScad ? "scad" : "analysis"} reply left`);
    const res = typeof r === "function" ? await r(call) : r;
    return { ok: (res.status ?? 200) < 400, status: res.status ?? 200, text: async () => res.body };
  };
  const client = new GeminiJsonClient({ apiKey: "test-key", fetch, model: "gemini-test" });
  return { client, calls, scadCalls: () => calls.filter((c) => c.body.generationConfig.responseJsonSchema.properties?.scad) };
}

export function analysisAnswer(over: Record<string, unknown> = {}) {
  return {
    objectName: "phone stand",
    objectDescription: "A wedge-shaped desk stand that holds a phone at 60 degrees",
    category: "functional",
    mechanical: true,
    recommendedEngine: "openscad",
    engineReason: "Simple prismatic geometry",
    dimensions: {
      width: { valueMm: 80, confidence: 0.8, method: "reference-object" },
      depth: { valueMm: 60, confidence: 0.8, method: "reference-object" },
      height: { valueMm: 50, confidence: 0.8, method: "reference-object" },
    },
    referenceObjectDetected: true,
    referenceObjectNote: "credit card next to the stand",
    questions: [],
    meshyPrompt: "a simple wedge phone stand",
    openscadSpec: {
      applicable: true,
      summary: "Wedge stand with a lip",
      features: ["back support at 60 degrees", "front lip 8 mm high"],
      wallThicknessMm: 3,
      holes: [{ description: "cable hole", diameterMm: 12, through: true }],
      toleranceMm: 0.3,
      bedOrientation: "flat bottom down",
      notes: "",
    },
    overallConfidence: 0.8,
    ...over,
  };
}

/** Meshy HTTP double with a scripted task lifecycle. */
export function fakeMeshy(o: { createStatus?: number; createBody?: string; polls?: any[]; files?: Record<string, Buffer | number> } = {}) {
  const calls: Call[] = [];
  const polls = [...(o.polls ?? [{ status: "SUCCEEDED", progress: 100 }])];
  const fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const call: Call = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const text = (status: number, body: string) => ({ ok: status < 400, status, text: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
    if (url.startsWith("https://files.test/")) {
      const f = o.files?.[url.slice("https://files.test/".length)];
      if (typeof f === "number" || f === undefined) return text(typeof f === "number" ? f : 404, "");
      return { ok: true, status: 200, text: async () => "", arrayBuffer: async () => f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) as ArrayBuffer };
    }
    if (call.method === "POST") return text(o.createStatus ?? 200, o.createBody ?? JSON.stringify({ result: "task-123" }));
    const p = polls.length > 1 ? polls.shift() : polls[0];
    return text(200, JSON.stringify({ id: "task-123", progress: 0, ...p }));
  };
  const client = new MeshyImageClient({ apiKey: "meshy-test", fetch, pollMs: 0 });
  return { client, calls };
}

/** OpenSCAD CLI double: `behave(code)` decides what the fake binary does. */
export function fakeOpenscad(behave: (code: string) => { stl?: Buffer; code?: number | null; stderr?: string; timedOut?: boolean }) {
  const runs: string[] = [];
  const exec: ExecFileFn = async (_file, args): Promise<ExecResult> => {
    const out = args[args.indexOf("-o") + 1];
    const src = args[args.length - 1];
    const code = await import("node:fs/promises").then((fs) => fs.readFile(src, "utf8"));
    runs.push(code);
    const b = behave(code);
    if (b.stl) await writeFile(out, b.stl);
    return { code: b.code === undefined ? 0 : b.code, stdout: "", stderr: b.stderr ?? "", timedOut: !!b.timedOut };
  };
  return { exec, runs };
}

export const missingOpenscad: ExecFileFn = async () => ({ code: null, stdout: "", stderr: "\nENOENT: spawn openscad ENOENT", timedOut: false });

export function meshFromBox(x: number, y: number, z: number): Mesh {
  return box(x, y, z);
}
