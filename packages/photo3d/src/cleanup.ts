// Photo cleanup before image-to-3D: Gemini's image model crops to the one subject
// and replaces the background with plain white, because Meshy works best with a
// single subject on a plain background. generateContent with an inline image and
// responseModalities ["TEXT", "IMAGE"]; the edited image comes back as inlineData.
// The key is sent only in the x-goog-api-key header and never logged.
import { Photo3dError, throwIfAborted } from "./errors";
import { GEMINI_API_BASE, type FetchLike } from "./gemini";
import { sniffImageMime, toBase64, type CheckedPhoto, type ImageMime } from "./images";

/**
 * Nano Banana 2, the stable image-capable Gemini model on the AI Studio models page
 * (2026-11-07). Override with MORPHIX_GEMINI_IMAGE_MODEL (e.g. gemini-nano-banana-2.1,
 * gemini-3-pro-image).
 */
export const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";

export interface GeminiImageOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface EditImageRequest {
  image: CheckedPhoto;
  instruction: string;
  signal?: AbortSignal;
}

export class GeminiImageClient {
  readonly model: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchFn?: FetchLike;
  private readonly timeoutMs: number;

  constructor(o: GeminiImageOptions = {}) {
    this.apiKey = o.apiKey?.trim() || undefined;
    this.model = o.model?.trim() || DEFAULT_GEMINI_IMAGE_MODEL;
    this.baseUrl = (o.baseUrl ?? GEMINI_API_BASE).replace(/\/$/, "");
    this.fetchFn = o.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    this.timeoutMs = o.timeoutMs ?? 120_000;
  }

  get available(): boolean {
    return !!this.apiKey && !!this.fetchFn;
  }

  /** Returns the edited image. Throws Photo3dError MX-P3D-061 / 011 / 012 / 014 / 015 / 060. */
  async edit(r: EditImageRequest): Promise<CheckedPhoto> {
    if (!this.apiKey || !this.fetchFn) throw new Photo3dError("MX-P3D-061");
    throwIfAborted(r.signal);
    const body = {
      contents: [{ role: "user", parts: [{ text: r.instruction }, { inlineData: { mimeType: r.image.mime, data: toBase64(r.image.bytes) } }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    };
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    r.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let text = "";
    try {
      const res = await this.fetchFn(`${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      text = await res.text();
      if (!res.ok) {
        const msg = errorMessage(text);
        if (res.status === 429) throw new Photo3dError("MX-P3D-015", `Gemini rate limit or quota reached: ${msg}`);
        throw new Photo3dError("MX-P3D-011", `Gemini image HTTP ${res.status}: ${msg}`);
      }
    } catch (e) {
      if (e instanceof Photo3dError) throw e;
      throwIfAborted(r.signal);
      throw new Photo3dError("MX-P3D-012", `Gemini could not be reached: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
      r.signal?.removeEventListener("abort", onAbort);
    }
    return parseGeminiImage(text);
  }
}

/** Extracts the last image part from a generateContent response body. */
export function parseGeminiImage(responseText: string): CheckedPhoto {
  let j: any;
  try {
    j = JSON.parse(responseText);
  } catch {
    throw new Photo3dError("MX-P3D-060", "Gemini's image answer is not JSON.");
  }
  if (j?.promptFeedback?.blockReason) throw new Photo3dError("MX-P3D-014", `Gemini blocked the photo (${j.promptFeedback.blockReason}).`);
  const cand = j?.candidates?.[0];
  if (cand?.finishReason && /SAFETY|PROHIBITED|BLOCKLIST|SPII|IMAGE_SAFETY|RECITATION/.test(cand.finishReason)) {
    throw new Photo3dError("MX-P3D-014", `Gemini stopped the photo edit (${cand.finishReason}).`);
  }
  const parts: any[] = cand?.content?.parts ?? [];
  const images = parts.map((p) => p?.inlineData ?? p?.inline_data).filter((d) => d && typeof d.data === "string" && !d.thought);
  const last = images[images.length - 1];
  if (!last) throw new Photo3dError("MX-P3D-060", `Gemini returned no image${cand?.finishReason ? ` (${cand.finishReason})` : ""}.`);
  const bytes = new Uint8Array(Buffer.from(last.data, "base64"));
  const mime = sniffImageMime(bytes);
  if (!mime || !["image/jpeg", "image/png", "image/webp"].includes(mime)) throw new Photo3dError("MX-P3D-060", "Gemini's edited photo is not a JPEG, PNG or WebP image.");
  return { mime: mime as ImageMime, bytes };
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

/** The edit instruction: keep the subject exactly as it is, remove everything else. */
export function cleanupInstruction(subject: string, userWants: string): string {
  return [
    `Edit this photo for a 3D model generator. Keep only ${subject.trim() || "the main subject"}.`,
    "Remove the background, other objects and other people, and replace them with a plain, evenly lit white background.",
    "Crop so the subject fills most of the frame with a small margin, fully visible and not cut off.",
    "Do not change the subject's shape, proportions, pose, colours, text or details. Do not add anything. No shadows, no props, no frame.",
    `For context, the user wants: ${userWants.trim().slice(0, 300)}`,
  ].join(" ");
}

export interface CleanupResult {
  image: CheckedPhoto;
  /** False when the original was kept (cleanup failed or not configured). */
  cleaned: boolean;
  model: string | null;
  note: string;
}

/** Never throws except on cancel: on failure the original photo is returned with a note. */
export async function cleanupPhoto(
  image: CheckedPhoto,
  o: { subject: string; description: string },
  deps: { images?: GeminiImageClient; signal?: AbortSignal },
): Promise<CleanupResult> {
  const client = deps.images;
  if (!client?.available) return { image, cleaned: false, model: null, note: new Photo3dError("MX-P3D-061").message };
  try {
    const out = await client.edit({ image, instruction: cleanupInstruction(o.subject, o.description), signal: deps.signal });
    return { image: out, cleaned: true, model: client.model, note: `Background removed and cropped to ${o.subject || "the subject"}.` };
  } catch (e) {
    if (e instanceof Photo3dError && e.code === "MX-P3D-090") throw e;
    throwIfAborted(deps.signal);
    return { image, cleaned: false, model: client.model, note: `${new Photo3dError("MX-P3D-060").message} (${(e as Error).message})` };
  }
}

/** GEMINI_API_KEY and MORPHIX_GEMINI_IMAGE_MODEL. */
export function geminiImageFromEnv(env: Record<string, string | undefined> = process.env, extra: Partial<GeminiImageOptions> = {}): GeminiImageClient {
  return new GeminiImageClient({ apiKey: env.GEMINI_API_KEY, model: env.MORPHIX_GEMINI_IMAGE_MODEL, ...extra });
}
