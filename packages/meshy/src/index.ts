// Text-to-3D generation through Meshy (https://docs.meshy.ai), behind the ModelGenerator
// interface. Without MESHY_API_KEY the app has no generator.

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
    onUpdate({ status: "running", progress: 99, stage: "Downloading the model…" });
    const glbUrl = task.model_urls?.glb;
    if (!glbUrl) throw new Error("Meshy returned no GLB model");
    const data = await this.client.download(glbUrl);
    const stl = task.model_urls?.stl ? await this.client.download(task.model_urls.stl).catch(() => undefined) : undefined;
    const thumbnail = task.thumbnail_url ? await this.client.download(task.thumbnail_url, 20e6).catch(() => undefined) : undefined;
    return { format: "glb", data, stl, thumbnail, remoteId: id, credits: task.consumed_credits };
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
