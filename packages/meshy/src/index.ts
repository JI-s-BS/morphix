// 3D generation adapters. Phase 1 ships the demo adapter (procedural geometry,
// no network, no cost). The Meshy adapter is wired in Phase 2 behind the same interface.

export interface GenerationUpdate {
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  stage: string;
}

export interface GeneratedModel {
  /** Primary file shown in the viewer. */
  format: "stl" | "glb";
  data: Buffer;
  /** Printable STL (Meshy can return it directly). */
  stl?: Buffer;
  thumbnail?: Buffer;
  /** Remote id when the provider has one (Meshy task id). */
  remoteId?: string;
  credits?: number;
}

export interface GenerateOptions {
  kind?: "preview" | "refine";
  /** Required for refine: the SUCCEEDED preview task to texture. */
  previewRemoteId?: string;
  /** Resume polling an existing remote task (after a restart). */
  resumeRemoteId?: string;
  /** Called as soon as the remote task id is known, so it can be persisted. */
  onRemoteId?: (id: string) => void;
  signal?: AbortSignal;
}

export interface ModelGenerator {
  readonly name: "demo" | "meshy";
  generate(prompt: string, onUpdate: (u: GenerationUpdate) => void, opts?: GenerateOptions): Promise<GeneratedModel>;
}

export class MeshyNotConfigured extends Error {
  constructor() {
    super("Meshy is not configured. Add MESHY_API_KEY to ~/Morphix/config/morphix.env.");
  }
}

// ---------------------------------------------------------------------------
// Meshy (https://docs.meshy.ai) — Text to 3D v2

export const MESHY_PREVIEW_CREDITS: Record<string, number> = {
  "meshy-6-lite": 5,
  "meshy-6": 20,
  "meshy-7.1": 20,
  latest: 20,
};
export const MESHY_REFINE_CREDITS = 10;

export interface MeshyTask {
  id: string;
  status: "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED";
  progress: number;
  model_urls?: Partial<Record<"glb" | "fbx" | "obj" | "usdz" | "stl" | "3mf", string>>;
  thumbnail_url?: string;
  task_error?: { message?: string } | null;
  consumed_credits?: number;
  preceding_tasks?: number;
}

type FetchLike = typeof fetch;

export class MeshyClient {
  constructor(
    private apiKey: string,
    readonly model = "meshy-6",
    private base = "https://api.meshy.ai",
    private fetchImpl: FetchLike = fetch,
  ) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(this.base + path, {
      ...init,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? msg;
      } catch {
        /* keep raw */
      }
      throw new Error(`Meshy ${res.status}: ${msg}`);
    }
    return JSON.parse(text) as T;
  }

  balance(): Promise<{ balance: number; monthly_credits: number; permanent_credits: number }> {
    return this.req("/openapi/v1/balance");
  }

  async createPreview(prompt: string): Promise<string> {
    const r = await this.req<{ result: string }>("/openapi/v2/text-to-3d", {
      method: "POST",
      body: JSON.stringify({
        mode: "preview",
        prompt: prompt.slice(0, 800),
        ai_model: this.model,
        should_remesh: true,
        topology: "triangle",
        target_polycount: 30000,
        target_formats: ["glb", "stl"],
        origin_at: "bottom",
      }),
    });
    return r.result;
  }

  async createRefine(previewTaskId: string): Promise<string> {
    const r = await this.req<{ result: string }>("/openapi/v2/text-to-3d", {
      method: "POST",
      body: JSON.stringify({ mode: "refine", preview_task_id: previewTaskId, enable_pbr: false, target_formats: ["glb", "stl"] }),
    });
    return r.result;
  }

  get(id: string): Promise<MeshyTask> {
    return this.req(`/openapi/v2/text-to-3d/${encodeURIComponent(id)}`);
  }

  async waitFor(id: string, onUpdate: (t: MeshyTask) => void, signal?: AbortSignal, pollMs = 3000): Promise<MeshyTask> {
    const deadline = Date.now() + 20 * 60 * 1000;
    for (;;) {
      if (signal?.aborted) throw new Error("cancelled");
      const t = await this.get(id);
      onUpdate(t);
      if (t.status === "SUCCEEDED") return t;
      if (t.status === "FAILED" || t.status === "CANCELED") {
        throw new Error(`Meshy task ${t.status.toLowerCase()}: ${t.task_error?.message ?? "no details"}`);
      }
      if (Date.now() > deadline) throw new Error("Meshy task timed out after 20 minutes");
      await sleep(pollMs, signal);
    }
  }

  async download(url: string, maxBytes = 250 * 1024 * 1024): Promise<Buffer> {
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error("downloaded file is too large");
    return buf;
  }
}

export class MeshyGenerator implements ModelGenerator {
  readonly name = "meshy" as const;

  constructor(readonly client: MeshyClient) {}

  async generate(prompt: string, onUpdate: (u: GenerationUpdate) => void, opts: GenerateOptions = {}): Promise<GeneratedModel> {
    const kind = opts.kind ?? "preview";
    let id = opts.resumeRemoteId;
    if (!id) {
      onUpdate({ status: "queued", progress: 0, stage: kind === "refine" ? "Sending to Meshy (texturing)…" : "Sending to Meshy…" });
      if (kind === "refine") {
        if (!opts.previewRemoteId) throw new Error("refine needs a Meshy preview task");
        id = await this.client.createRefine(opts.previewRemoteId);
      } else {
        id = await this.client.createPreview(prompt);
      }
    }
    opts.onRemoteId?.(id);
    const label = kind === "refine" ? "Meshy: adding colour and texture" : "Meshy: building the 3D shape";
    const task = await this.client.waitFor(
      id,
      (t) =>
        onUpdate({
          status: t.status === "PENDING" ? "queued" : "running",
          progress: Math.min(99, t.progress ?? 0),
          stage: t.status === "PENDING" ? `Meshy: waiting in queue${t.preceding_tasks ? ` (${t.preceding_tasks} ahead)` : ""}` : label,
        }),
      opts.signal,
    );
    onUpdate({ status: "running", progress: 99, stage: "Downloading model to the Pi…" });
    const glbUrl = task.model_urls?.glb;
    if (!glbUrl) throw new Error("Meshy returned no GLB model");
    const data = await this.client.download(glbUrl);
    const stl = task.model_urls?.stl ? await this.client.download(task.model_urls.stl).catch(() => undefined) : undefined;
    const thumbnail = task.thumbnail_url ? await this.client.download(task.thumbnail_url, 20e6).catch(() => undefined) : undefined;
    return { format: "glb", data, stl, thumbnail, remoteId: id, credits: task.consumed_credits };
  }
}

// ---------------------------------------------------------------------------
// Demo adapter: honest about being a demo — stages are labelled as such.

type Shape = "vase" | "torus" | "star" | "gear";

export function pickShape(prompt: string): Shape {
  const p = prompt.toLowerCase();
  if (/\b(vase|cup|pot|bowl)\b/.test(p)) return "vase";
  if (/\b(ring|donut|torus|bracelet)\b/.test(p)) return "torus";
  if (/\b(star|trophy|badge)\b/.test(p)) return "star";
  if (/\b(gear|cog|wheel)\b/.test(p)) return "gear";
  const shapes: Shape[] = ["vase", "torus", "star", "gear"];
  let h = 0;
  for (const c of p) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return shapes[h % shapes.length];
}

export class DemoGenerator implements ModelGenerator {
  readonly name = "demo" as const;

  constructor(private stepMs = 700) {}

  async generate(prompt: string, onUpdate: (u: GenerationUpdate) => void, opts: GenerateOptions = {}): Promise<GeneratedModel> {
    const signal = opts.signal;
    const stages = ["Demo: queued", "Demo: shaping", "Demo: building mesh", "Demo: finishing"];
    onUpdate({ status: "queued", progress: 0, stage: stages[0] });
    for (let i = 1; i <= 8; i++) {
      await sleep(this.stepMs, signal);
      onUpdate({ status: "running", progress: i * 12, stage: stages[Math.min(3, Math.floor(i / 2.2))] });
    }
    const tris = buildShape(pickShape(prompt));
    onUpdate({ status: "succeeded", progress: 100, stage: "Demo: done" });
    return { format: "stl", data: toBinaryStl(tris, `Morphix demo: ${prompt}`) };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new Error("cancelled"));
    });
  });
}

// ---------------------------------------------------------------------------
// Procedural meshes (millimetres, Z up, sitting on Z=0). All closed/watertight.

type V = [number, number, number];
export type Tri = [V, V, V];

/** Surface of revolution from a profile of (radius, z) points, capped top and bottom. */
function lathe(profile: [number, number][], segments: number): Tri[] {
  const tris: Tri[] = [];
  const ring = (r: number, z: number, k: number): V => {
    const a = (2 * Math.PI * k) / segments;
    return [r * Math.cos(a), r * Math.sin(a), z];
  };
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, z0] = profile[i];
    const [r1, z1] = profile[i + 1];
    for (let k = 0; k < segments; k++) {
      const a = ring(r0, z0, k), b = ring(r0, z0, k + 1), c = ring(r1, z1, k + 1), d = ring(r1, z1, k);
      tris.push([a, b, c], [a, c, d]);
    }
  }
  const [rb, zb] = profile[0];
  const [rt, zt] = profile[profile.length - 1];
  for (let k = 0; k < segments; k++) {
    tris.push([[0, 0, zb], ring(rb, zb, k + 1), ring(rb, zb, k)]);
    tris.push([[0, 0, zt], ring(rt, zt, k), ring(rt, zt, k + 1)]);
  }
  return tris;
}

function vase(): Tri[] {
  const profile: [number, number][] = [];
  for (let i = 0; i <= 24; i++) {
    const z = (i / 24) * 80;
    const r = 18 + 10 * Math.sin((i / 24) * Math.PI * 1.3) - (i > 20 ? (i - 20) * 1.5 : 0);
    profile.push([r, z]);
  }
  return lathe(profile, 48);
}

function torus(): Tri[] {
  const R = 30, r = 10, nu = 48, nv = 24;
  const p = (u: number, v: number): V => {
    const a = (2 * Math.PI * u) / nu, b = (2 * Math.PI * v) / nv;
    return [(R + r * Math.cos(b)) * Math.cos(a), (R + r * Math.cos(b)) * Math.sin(a), r + r * Math.sin(b)];
  };
  const tris: Tri[] = [];
  for (let u = 0; u < nu; u++)
    for (let v = 0; v < nv; v++) {
      const a = p(u, v), b = p(u + 1, v), c = p(u + 1, v + 1), d = p(u, v + 1);
      tris.push([a, b, c], [a, c, d]);
    }
  return tris;
}

/** Extrude a closed 2D outline (counter-clockwise, star-shaped around origin) to height h. */
function extrude(outline: [number, number][], h: number): Tri[] {
  const tris: Tri[] = [];
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % n];
    tris.push([[x0, y0, 0], [x1, y1, 0], [x1, y1, h]], [[x0, y0, 0], [x1, y1, h], [x0, y0, h]]);
    tris.push([[0, 0, 0], [x1, y1, 0], [x0, y0, 0]]);
    tris.push([[0, 0, h], [x0, y0, h], [x1, y1, h]]);
  }
  return tris;
}

function star(): Tri[] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI * 2 * i) / 10 + Math.PI / 2;
    const r = i % 2 === 0 ? 45 : 19;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return extrude(pts, 12);
}

function gear(): Tri[] {
  const pts: [number, number][] = [];
  const teeth = 16;
  for (let i = 0; i < teeth * 4; i++) {
    const a = (Math.PI * 2 * i) / (teeth * 4);
    const r = i % 4 < 2 ? 40 : 33;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return extrude(pts, 10);
}

export function buildShape(shape: Shape): Tri[] {
  return { vase, torus, star, gear }[shape]();
}

export function toBinaryStl(tris: Tri[], header = "Morphix"): Buffer {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write(header.slice(0, 79), 0, "ascii");
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const [a, b, c] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    for (const x of [n[0] / len, n[1] / len, n[2] / len, ...a, ...b, ...c]) {
      buf.writeFloatLE(x, o);
      o += 4;
    }
    buf.writeUInt16LE(0, o);
    o += 2;
  }
  return buf;
}
