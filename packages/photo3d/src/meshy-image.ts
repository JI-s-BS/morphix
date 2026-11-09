// Meshy Image to 3D (POST /openapi/v1/image-to-3d) and Multi-Image to 3D
// (POST /openapi/v1/multi-image-to-3d, 1-4 views). Same request/poll/download
// shape as the text-to-3D client in @morphix/meshy. Images go as base64 data URIs.
// Checked against docs.meshy.ai on 2026-11-07.
import { Photo3dError, sleep, throwIfAborted, type P3dErrorCode } from "./errors";
import { MESHY_IMAGE_MIMES, toDataUri, type CheckedPhoto } from "./images";

export type MeshyImageKind = "image-to-3d" | "multi-image-to-3d";
export type MeshyImageModel = "meshy-7.1" | "latest" | "meshy-6" | "meshy-6-lite";

/** Credits per task (docs.meshy.ai/en/api/pricing, 2026-11-07). Same for single and multi image. */
export const MESHY_IMAGE_CREDITS: Record<MeshyImageModel, { mesh: number; textured: number }> = {
  "meshy-7.1": { mesh: 20, textured: 30 },
  latest: { mesh: 20, textured: 30 },
  "meshy-6": { mesh: 20, textured: 30 },
  "meshy-6-lite": { mesh: 5, textured: 15 },
};
/** geometry_resolution "2k"/"4k" surcharge. */
export const MESHY_ULTRA_SURCHARGE = 5;
export const MESHY_MAX_MULTI_IMAGES = 4;

export function meshyImageCost(o: { model?: MeshyImageModel; texture?: boolean; geometryResolution?: "standard" | "2k" | "4k" } = {}): number {
  const p = MESHY_IMAGE_CREDITS[o.model ?? DEFAULT_MESHY_IMAGE_MODEL];
  return (o.texture ? p.textured : p.mesh) + (o.geometryResolution && o.geometryResolution !== "standard" ? MESHY_ULTRA_SURCHARGE : 0);
}

export const DEFAULT_MESHY_IMAGE_MODEL: MeshyImageModel = "meshy-7.1";

export interface MeshyImageTask {
  id: string;
  type?: string;
  status: "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED";
  progress: number;
  model_urls?: Partial<Record<"glb" | "fbx" | "obj" | "usdz" | "stl" | "3mf" | "mtl", string>>;
  thumbnail_url?: string;
  task_error?: { message?: string } | null;
  consumed_credits?: number;
  preceding_tasks?: number;
}

export interface MeshyImageOptions {
  model?: MeshyImageModel;
  /** Printing is single-colour, so texture is off by default (20 instead of 30 credits). */
  texture?: boolean;
  texturePrompt?: string;
  geometryResolution?: "standard" | "2k" | "4k";
  targetPolycount?: number;
  imageEnhancement?: boolean;
  moderation?: boolean;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface MeshyImageClientOptions {
  apiKey?: string;
  base?: string;
  fetch?: FetchLike;
  pollMs?: number;
  timeoutMs?: number;
}

export interface MeshyImageProgress {
  status: MeshyImageTask["status"];
  progress: number;
  precedingTasks?: number;
}

export interface MeshyImageResult {
  taskId: string;
  kind: MeshyImageKind;
  glb?: Buffer;
  stl?: Buffer;
  thumbnail?: Buffer;
  credits: number;
}

export class MeshyImageClient {
  private readonly apiKey?: string;
  private readonly base: string;
  private readonly fetchFn: FetchLike;
  readonly pollMs: number;
  readonly timeoutMs: number;

  constructor(o: MeshyImageClientOptions = {}) {
    this.apiKey = o.apiKey?.trim() || undefined;
    this.base = (o.base ?? "https://api.meshy.ai").replace(/\/$/, "");
    this.fetchFn = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.pollMs = o.pollMs ?? 3000;
    this.timeoutMs = o.timeoutMs ?? 20 * 60 * 1000;
  }

  get available(): boolean {
    return !!this.apiKey;
  }

  private async req<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    if (!this.apiKey) throw new Photo3dError("MX-P3D-020");
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchFn(this.base + path, {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal,
      });
    } catch (e) {
      throwIfAborted(init.signal);
      throw new Photo3dError("MX-P3D-026", `Meshy could not be reached: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? msg;
      } catch {
        /* keep raw */
      }
      throw new Photo3dError(meshyStatusCode(res.status), `Meshy ${res.status}: ${msg}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Photo3dError("MX-P3D-026", "Meshy returned a non-JSON response.");
    }
  }

  /** Creates a task and returns its id. One image -> image-to-3d; 2-4 -> multi-image-to-3d. */
  async create(images: CheckedPhoto[], o: MeshyImageOptions = {}, signal?: AbortSignal): Promise<{ id: string; kind: MeshyImageKind }> {
    const usable = images.filter((i) => MESHY_IMAGE_MIMES.includes(i.mime));
    if (usable.length === 0) throw new Photo3dError("MX-P3D-001", "Meshy needs at least one JPEG, PNG or WebP photo (HEIC is not accepted).");
    const kind: MeshyImageKind = usable.length > 1 ? "multi-image-to-3d" : "image-to-3d";
    const body: Record<string, unknown> = {
      ai_model: o.model ?? DEFAULT_MESHY_IMAGE_MODEL,
      should_texture: o.texture ?? false,
      should_remesh: true,
      topology: "triangle",
      target_polycount: o.targetPolycount ?? 30000,
      target_formats: ["glb", "stl"],
      image_enhancement: o.imageEnhancement ?? true,
      moderation: o.moderation ?? false,
    };
    if (o.geometryResolution && o.geometryResolution !== "standard") body.geometry_resolution = o.geometryResolution;
    if (o.texture && o.texturePrompt) body.texture_prompt = o.texturePrompt.slice(0, 800);
    if (kind === "multi-image-to-3d") body.image_urls = usable.slice(0, MESHY_MAX_MULTI_IMAGES).map(toDataUri);
    else body.image_url = toDataUri(usable[0]);
    const r = await this.req<{ result?: string }>(`/openapi/v1/${kind}`, { method: "POST", body, signal });
    if (!r.result) throw new Photo3dError("MX-P3D-026", "Meshy did not return a task id.");
    return { id: r.result, kind };
  }

  get(kind: MeshyImageKind, id: string, signal?: AbortSignal): Promise<MeshyImageTask> {
    return this.req(`/openapi/v1/${kind}/${encodeURIComponent(id)}`, { signal });
  }

  async waitFor(kind: MeshyImageKind, id: string, onUpdate: (p: MeshyImageProgress) => void, signal?: AbortSignal): Promise<MeshyImageTask> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      throwIfAborted(signal);
      const t = await this.get(kind, id, signal);
      onUpdate({ status: t.status, progress: t.progress ?? 0, precedingTasks: t.preceding_tasks });
      if (t.status === "SUCCEEDED") return t;
      if (t.status === "FAILED" || t.status === "CANCELED") {
        throw new Photo3dError("MX-P3D-027", `Meshy task ${t.status.toLowerCase()}: ${t.task_error?.message || "no details"}`);
      }
      if (Date.now() > deadline) throw new Photo3dError("MX-P3D-028", `Meshy task ${id} did not finish within ${Math.round(this.timeoutMs / 60000)} min; resume it by task id.`);
      await sleep(this.pollMs, signal);
    }
  }

  async download(url: string, maxBytes = 250 * 1024 * 1024, signal?: AbortSignal): Promise<Buffer> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchFn(url, { signal });
    } catch (e) {
      throwIfAborted(signal);
      throw new Photo3dError("MX-P3D-029", `Model download failed: ${(e as Error).message}`);
    }
    if (!res.ok) throw new Photo3dError("MX-P3D-029", `Model download failed (HTTP ${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Photo3dError("MX-P3D-029", "Downloaded model is too large.");
    return buf;
  }

  /**
   * Full run: create (or resume `resume.id`), poll, download GLB + STL.
   * `onTaskId` fires as soon as the id is known so it can be persisted for resuming.
   */
  async generate(
    images: CheckedPhoto[],
    o: MeshyImageOptions & {
      resume?: { kind: MeshyImageKind; id: string };
      onTaskId?: (t: { kind: MeshyImageKind; id: string }) => void;
      onProgress?: (p: MeshyImageProgress) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<MeshyImageResult> {
    const task = o.resume ?? (await this.create(images, o, o.signal));
    o.onTaskId?.(task);
    const done = await this.waitFor(task.kind, task.id, (p) => o.onProgress?.(p), o.signal);
    const urls = done.model_urls ?? {};
    if (!urls.glb && !urls.stl) throw new Photo3dError("MX-P3D-029", "Meshy finished but returned no GLB or STL.");
    const glb = urls.glb ? await this.download(urls.glb, undefined, o.signal) : undefined;
    // The STL is a convenience copy; the GLB is the authoritative geometry when both exist.
    const stl = urls.stl ? await this.download(urls.stl, undefined, o.signal).catch((e) => (glb ? undefined : Promise.reject(e))) : undefined;
    const thumbnail = done.thumbnail_url ? await this.download(done.thumbnail_url, 20e6, o.signal).catch(() => undefined) : undefined;
    return { taskId: task.id, kind: task.kind, glb, stl, thumbnail, credits: done.consumed_credits ?? meshyImageCost(o) };
  }
}

export function meshyStatusCode(status: number): P3dErrorCode {
  if (status === 400 || status === 404 || status === 422) return "MX-P3D-021";
  if (status === 401) return "MX-P3D-022";
  if (status === 402) return "MX-P3D-023";
  if (status === 403) return "MX-P3D-024";
  if (status === 429) return "MX-P3D-025";
  return "MX-P3D-026";
}

/** MESHY_API_KEY; MORPHIX_MESHY_IMAGE_MODEL picks the ai_model. */
export function meshyImageFromEnv(env: Record<string, string | undefined> = process.env, extra: Partial<MeshyImageClientOptions> = {}): MeshyImageClient {
  return new MeshyImageClient({ apiKey: env.MESHY_API_KEY, ...extra });
}

export function meshyImageModelFromEnv(env: Record<string, string | undefined> = process.env): MeshyImageModel {
  const m = env.MORPHIX_MESHY_IMAGE_MODEL?.trim() as MeshyImageModel | undefined;
  return m && m in MESHY_IMAGE_CREDITS ? m : DEFAULT_MESHY_IMAGE_MODEL;
}
