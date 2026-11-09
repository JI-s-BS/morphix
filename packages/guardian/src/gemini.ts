// Gemini visual verification for CONFIRMED suspicious snapshots only.
// REST generateContent with an inline JPEG part and a JSON-schema answer.
// Rate-limited (minimum interval + daily cap) and fully optional: without an
// API key every call returns { status: "unavailable", reason: "no_api_key" }.
// The key is sent only in the x-goog-api-key header and never logged.
import type { FailureKind } from "./events";

export const DEFAULT_GEMINI_VISION_MODEL = "gemini-3.8-flash";
export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export type GeminiProblem =
  | "spaghetti"
  | "detachment"
  | "stalled"
  | "camera_issue"
  | "other_failure"
  | "no_problem"
  | "uncertain";

export const GEMINI_PROBLEMS: readonly GeminiProblem[] = [
  "spaghetti", "detachment", "stalled", "camera_issue", "other_failure", "no_problem", "uncertain",
];

export interface GeminiVerdict {
  status: "ok";
  problem: GeminiProblem;
  confidence: number; // 0..1
  explanation: string;
  model: string;
  /** problem is a print failure (not no_problem/uncertain/camera_issue). */
  failureLikely: boolean;
}

export interface GeminiUnavailable {
  status: "unavailable";
  reason: "no_api_key" | "rate_limited" | "daily_cap" | "image_too_large" | "http_error" | "network_error" | "bad_response";
  detail?: string;
  retryAfterMs?: number;
}

export type GeminiResult = GeminiVerdict | GeminiUnavailable;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface GeminiVisionOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Minimum time between requests. Default 2 min. */
  minIntervalMs?: number;
  /** Maximum requests per UTC day. Default 40. */
  dailyCap?: number;
  timeoutMs?: number;
  maxImageBytes?: number;
  now?: () => number;
}

export interface VerifyRequest {
  jpeg: Uint8Array;
  /** What the local detector thinks it saw. */
  suspectedKind?: FailureKind;
  printerState?: string | null;
  progress?: number;
  metrics?: Record<string, number | undefined>;
}

export const GEMINI_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    problem_type: { type: "string", enum: [...GEMINI_PROBLEMS] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    explanation: { type: "string" },
  },
  required: ["problem_type", "confidence", "explanation"],
} as const;

export function buildPrompt(r: Omit<VerifyRequest, "jpeg">): string {
  const lines = [
    "You are checking a snapshot from the built-in camera of an Afinia QD330 FDM 3D printer.",
    "The image shows the print chamber: a blue build plate, rails, and the print head.",
    "Decide whether the print has failed. Problem types:",
    "- spaghetti: loose tangled filament strands instead of a solid part",
    "- detachment: the part has come loose, moved, toppled or is being dragged",
    "- stalled: nothing is being printed although a job is running (only if clearly visible)",
    "- camera_issue: the image is too dark, blurry, blocked or broken to judge",
    "- other_failure: another clear print defect (e.g. blob on nozzle, layer shift)",
    "- no_problem: the print looks normal",
    "- uncertain: you cannot tell",
    "Be conservative: only report a failure you can see. Explanation: one or two short sentences for the operator.",
  ];
  if (r.suspectedKind) lines.push(`A local detector flagged possible "${r.suspectedKind}" over several frames.`);
  if (r.printerState) lines.push(`Printer status: ${r.printerState}${r.progress !== undefined ? `, ${r.progress}% done` : ""}.`);
  if (r.metrics) {
    const m = Object.entries(r.metrics).filter(([, v]) => typeof v === "number").map(([k, v]) => `${k}=${v}`);
    if (m.length) lines.push(`Detector metrics: ${m.join(", ")}.`);
  }
  lines.push("Answer only with JSON matching the schema.");
  return lines.join("\n");
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** Extract and validate the model's JSON answer (tolerates ``` fences). */
export function parseGeminiAnswer(body: unknown, model: string): GeminiResult {
  const b = body as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
  if (b?.promptFeedback?.blockReason) return { status: "unavailable", reason: "bad_response", detail: `blocked: ${b.promptFeedback.blockReason}` };
  const text = (b?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  if (!text) return { status: "unavailable", reason: "bad_response", detail: `empty answer (${b?.candidates?.[0]?.finishReason ?? "no candidates"})` };
  const json = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let a: { problem_type?: unknown; confidence?: unknown; explanation?: unknown };
  try {
    a = JSON.parse(json);
  } catch {
    return { status: "unavailable", reason: "bad_response", detail: "answer is not JSON" };
  }
  const problem = GEMINI_PROBLEMS.includes(a.problem_type as GeminiProblem) ? (a.problem_type as GeminiProblem) : null;
  const confidence = typeof a.confidence === "number" && Number.isFinite(a.confidence) ? Math.min(1, Math.max(0, a.confidence)) : null;
  if (!problem || confidence === null) return { status: "unavailable", reason: "bad_response", detail: "answer is missing problem_type/confidence" };
  return {
    status: "ok",
    problem,
    confidence,
    explanation: typeof a.explanation === "string" ? a.explanation.slice(0, 500) : "",
    model,
    failureLikely: !["no_problem", "uncertain", "camera_issue"].includes(problem),
  };
}

export class GeminiVisionClient {
  readonly model: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchFn?: FetchLike;
  private readonly minIntervalMs: number;
  private readonly dailyCap: number;
  private readonly timeoutMs: number;
  private readonly maxImageBytes: number;
  private readonly now: () => number;
  private lastCallAt = -Infinity;
  private day = "";
  private callsToday = 0;

  constructor(o: GeminiVisionOptions = {}) {
    this.apiKey = o.apiKey?.trim() || undefined;
    this.model = o.model?.trim() || DEFAULT_GEMINI_VISION_MODEL;
    this.baseUrl = (o.baseUrl ?? GEMINI_API_BASE).replace(/\/$/, "");
    this.fetchFn = o.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    this.minIntervalMs = o.minIntervalMs ?? 120_000;
    this.dailyCap = o.dailyCap ?? 40;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.maxImageBytes = o.maxImageBytes ?? 4 * 1024 * 1024;
    this.now = o.now ?? Date.now;
  }

  get available(): boolean {
    return !!this.apiKey && !!this.fetchFn;
  }

  usage(): { day: string; callsToday: number; dailyCap: number } {
    this.rollDay();
    return { day: this.day, callsToday: this.callsToday, dailyCap: this.dailyCap };
  }

  async verify(r: VerifyRequest): Promise<GeminiResult> {
    if (!this.apiKey || !this.fetchFn) return { status: "unavailable", reason: "no_api_key" };
    if (r.jpeg.byteLength === 0 || r.jpeg.byteLength > this.maxImageBytes) {
      return { status: "unavailable", reason: "image_too_large", detail: `${r.jpeg.byteLength} bytes` };
    }
    const now = this.now();
    this.rollDay();
    if (this.callsToday >= this.dailyCap) return { status: "unavailable", reason: "daily_cap", detail: `${this.dailyCap} calls/day` };
    const wait = this.lastCallAt + this.minIntervalMs - now;
    if (wait > 0) return { status: "unavailable", reason: "rate_limited", retryAfterMs: wait };
    this.lastCallAt = now;
    this.callsToday += 1;

    const body = {
      contents: [{
        role: "user",
        parts: [
          { text: buildPrompt(r) },
          { inlineData: { mimeType: "image/jpeg", data: toBase64(r.jpeg) } },
        ],
      }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: GEMINI_RESPONSE_SCHEMA, maxOutputTokens: 512 },
    };
    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
    try {
      const res = await this.fetchFn(`${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { status: "unavailable", reason: "http_error", detail: `HTTP ${res.status} ${text.slice(0, 200)}`.trim() };
      }
      return parseGeminiAnswer(await res.json(), this.model);
    } catch (e) {
      return { status: "unavailable", reason: "network_error", detail: (e as Error).message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private rollDay(): void {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.callsToday = 0;
    }
  }
}

/** GEMINI_API_KEY, MORPHIX_GEMINI_VISION_MODEL, MORPHIX_GEMINI_VISION_MIN_INTERVAL_S, MORPHIX_GEMINI_VISION_DAILY_CAP. */
export function geminiVisionFromEnv(env: Record<string, string | undefined> = process.env, extra: Partial<GeminiVisionOptions> = {}): GeminiVisionClient {
  const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const interval = num(env.MORPHIX_GEMINI_VISION_MIN_INTERVAL_S);
  return new GeminiVisionClient({
    apiKey: env.GEMINI_API_KEY,
    model: env.MORPHIX_GEMINI_VISION_MODEL,
    minIntervalMs: interval !== undefined ? interval * 1000 : undefined,
    dailyCap: num(env.MORPHIX_GEMINI_VISION_DAILY_CAP),
    ...extra,
  });
}
