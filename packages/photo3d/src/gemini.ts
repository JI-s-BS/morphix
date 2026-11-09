// Minimal Gemini REST client: generateContent with inline image parts and a
// JSON-schema answer (responseMimeType application/json + responseJsonSchema).
// The key is sent only in the x-goog-api-key header and never logged.
import { Photo3dError, throwIfAborted } from "./errors";

export const DEFAULT_GEMINI_VISION_MODEL = "gemini-3.8-flash";
export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface GeminiJsonOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface GenerateJsonRequest {
  parts: GeminiPart[];
  schema: Record<string, unknown>;
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export class GeminiJsonClient {
  readonly model: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchFn?: FetchLike;
  private readonly timeoutMs: number;

  constructor(o: GeminiJsonOptions = {}) {
    this.apiKey = o.apiKey?.trim() || undefined;
    this.model = o.model?.trim() || DEFAULT_GEMINI_VISION_MODEL;
    this.baseUrl = (o.baseUrl ?? GEMINI_API_BASE).replace(/\/$/, "");
    this.fetchFn = o.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    this.timeoutMs = o.timeoutMs ?? 90_000;
  }

  get available(): boolean {
    return !!this.apiKey && !!this.fetchFn;
  }

  /** Returns the parsed JSON answer. Throws Photo3dError MX-P3D-010..015. */
  async generateJson<T = unknown>(r: GenerateJsonRequest): Promise<T> {
    if (!this.apiKey || !this.fetchFn) throw new Photo3dError("MX-P3D-010");
    throwIfAborted(r.signal);
    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: r.parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: r.schema,
        maxOutputTokens: r.maxOutputTokens ?? 8192,
        ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
      },
    };
    if (r.system) body.systemInstruction = { parts: [{ text: r.system }] };

    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    r.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let status = 0;
    let text = "";
    try {
      const res = await this.fetchFn(`${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      status = res.status;
      text = await res.text();
      if (!res.ok) {
        const msg = errorMessage(text);
        if (status === 429) throw new Photo3dError("MX-P3D-015", `Gemini rate limit or quota reached: ${msg}`);
        throw new Photo3dError("MX-P3D-011", `Gemini HTTP ${status}: ${msg}`);
      }
    } catch (e) {
      if (e instanceof Photo3dError) throw e;
      throwIfAborted(r.signal);
      throw new Photo3dError("MX-P3D-012", `Gemini could not be reached: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
      r.signal?.removeEventListener("abort", onAbort);
    }
    return parseGeminiJson<T>(text);
  }
}

function errorMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } };
    if (j.error?.message) return j.error.message.slice(0, 300);
  } catch {
    /* raw */
  }
  return text.slice(0, 300);
}

/** Extracts and parses the JSON text from a generateContent response body. */
export function parseGeminiJson<T>(responseText: string): T {
  let j: any;
  try {
    j = JSON.parse(responseText);
  } catch {
    throw new Photo3dError("MX-P3D-013", "Gemini response is not JSON.");
  }
  if (j?.promptFeedback?.blockReason) throw new Photo3dError("MX-P3D-014", `Gemini blocked the request (${j.promptFeedback.blockReason}).`);
  const cand = j?.candidates?.[0];
  if (!cand) throw new Photo3dError("MX-P3D-014", "Gemini returned no answer.");
  if (cand.finishReason && /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(cand.finishReason)) {
    throw new Photo3dError("MX-P3D-014", `Gemini stopped the answer (${cand.finishReason}).`);
  }
  const parts: any[] = cand.content?.parts ?? [];
  const out = parts.filter((p) => typeof p?.text === "string" && !p.thought).map((p) => p.text).join("");
  if (!out.trim()) throw new Photo3dError("MX-P3D-014", `Gemini returned an empty answer${cand.finishReason ? ` (${cand.finishReason})` : ""}.`);
  try {
    return JSON.parse(stripFence(out)) as T;
  } catch {
    const hint = cand.finishReason === "MAX_TOKENS" ? " (answer was cut off: MAX_TOKENS)" : "";
    throw new Photo3dError("MX-P3D-013", `Gemini answer is not valid JSON${hint}.`, out.slice(0, 200));
  }
}

function stripFence(s: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(s);
  return m ? m[1] : s;
}

/** GEMINI_API_KEY and MORPHIX_GEMINI_VISION_MODEL. */
export function geminiJsonFromEnv(env: Record<string, string | undefined> = process.env, extra: Partial<GeminiJsonOptions> = {}): GeminiJsonClient {
  return new GeminiJsonClient({ apiKey: env.GEMINI_API_KEY, model: env.MORPHIX_GEMINI_VISION_MODEL, ...extra });
}
