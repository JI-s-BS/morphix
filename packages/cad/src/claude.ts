// Minimal Claude Messages API client over plain fetch (no SDK dependency).
// POST https://api.anthropic.com/v1/messages with x-api-key + anthropic-version.
// Requests stream (SSE) so long thinking never hits an HTTP header timeout; a plain
// JSON body is accepted too (test doubles and proxies that do not stream).
import { CadError, throwIfAborted } from "./errors";

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
export const DEFAULT_CLAUDE_EFFORT: ClaudeEffort = "high";
export const DEFAULT_MAX_TOKENS = 32_000;
/** Server-side refusal fallback ("default" routing by refusal category). */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Models that accept `fallbacks: "default"` on the Claude API. */
export const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;

export interface ClaudeJsonRequest {
  system: string;
  prompt: string;
  /** JSON Schema for structured output (output_config.format). */
  schema: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called with the answer text so far while it streams in (at most every ~300 ms). */
  onText?: (textSoFar: string) => void;
}

export interface ClaudeJsonAnswer<T> {
  /** Parsed JSON, or null when the answer was cut off or not JSON. */
  value: T | null;
  text: string;
  stopReason: string | null;
  model: string | null;
}

export interface ClaudeClientOptions {
  apiKey: string;
  model?: string;
  effort?: ClaudeEffort;
  fetch?: FetchLike | typeof fetch;
  /** Send `fallbacks: "default"` when the model supports it (default true). */
  fallbacks?: boolean;
  /** Retries for 429 / 5xx / 529 / network errors (default 2). */
  maxRetries?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  url?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ClaudeClient {
  readonly model: string;
  readonly effort: ClaudeEffort;
  private readonly o: ClaudeClientOptions;
  private useFallbacks: boolean;

  constructor(o: ClaudeClientOptions) {
    if (!o.apiKey?.trim()) throw new CadError("MX-CAD-002");
    this.o = o;
    this.model = o.model?.trim() || DEFAULT_CLAUDE_MODEL;
    this.effort = o.effort ?? DEFAULT_CLAUDE_EFFORT;
    this.useFallbacks = (o.fallbacks ?? true) && FALLBACK_MODELS.has(this.model);
  }

  buildBody(req: ClaudeJsonRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: this.effort, format: { type: "json_schema", schema: req.schema } },
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
    };
    if (this.useFallbacks) body.fallbacks = "default";
    return body;
  }

  headers(): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.o.apiKey.trim(),
      "anthropic-version": ANTHROPIC_VERSION,
    };
    if (this.useFallbacks) h["anthropic-beta"] = FALLBACK_BETA;
    return h;
  }

  async generateJson<T>(req: ClaudeJsonRequest): Promise<ClaudeJsonAnswer<T>> {
    const fetchFn = (this.o.fetch ?? fetch) as FetchLike;
    const sleep = this.o.sleep ?? defaultSleep;
    const maxRetries = this.o.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(req.signal);
      let res: Response;
      try {
        res = await fetchFn(this.o.url ?? ANTHROPIC_API_URL, { method: "POST", headers: this.headers(), body: JSON.stringify(this.buildBody(req)), signal: req.signal });
      } catch (e) {
        throwIfAborted(req.signal);
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt, null));
          continue;
        }
        throw new CadError("MX-CAD-013", `Claude API unreachable: ${(e as Error).message}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const msg = apiErrorMessage(text) ?? `HTTP ${res.status}`;
        // The fallback beta is optional: if this account rejects it, retry without it once.
        if (res.status === 400 && this.useFallbacks && /fallback|beta/i.test(msg)) {
          this.useFallbacks = false;
          attempt--;
          continue;
        }
        const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
        if (retryable && attempt < maxRetries) {
          await sleep(backoffMs(attempt, res.headers.get("retry-after")));
          continue;
        }
        if (res.status === 401 || res.status === 403) throw new CadError("MX-CAD-011", `Claude API: ${msg}`);
        if (res.status === 429 || res.status === 529) throw new CadError("MX-CAD-012", `Claude API: ${msg}`);
        if (res.status === 400 || res.status === 404) throw new CadError("MX-CAD-015", `Claude API (${this.model}): ${msg}`);
        throw new CadError("MX-CAD-010", `Claude API HTTP ${res.status}: ${msg}`);
      }
      const raw = req.onText && res.body ? await readStreaming(res.body, req.onText) : await res.text();
      const isSse = (res.headers.get("content-type") ?? "").includes("text/event-stream") || /^\s*(event|data):/.test(raw);
      const msg = isSse ? parseSseMessage(raw) : parseJsonMessage(raw);
      if (msg.error) {
        const overloaded = /overloaded|rate_limit/i.test(msg.error);
        if (overloaded && attempt < maxRetries) {
          await sleep(backoffMs(attempt, null));
          continue;
        }
        throw new CadError(overloaded ? "MX-CAD-012" : "MX-CAD-010", `Claude API stream error: ${msg.error}`);
      }
      if (msg.stopReason === "refusal") {
        throw new CadError("MX-CAD-014", `Claude declined this design${msg.refusalCategory ? ` (${msg.refusalCategory})` : ""}.`);
      }
      return { value: msg.stopReason === "max_tokens" ? null : parseJsonText<T>(msg.text), text: msg.text, stopReason: msg.stopReason, model: msg.model };
    }
  }
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  const s = retryAfter !== null ? Number(retryAfter) : NaN;
  if (Number.isFinite(s) && s >= 0) return Math.min(s, 60) * 1000;
  return 2000 * 2 ** attempt;
}

function apiErrorMessage(text: string): string | null {
  try {
    const j = JSON.parse(text) as { error?: { type?: string; message?: string } };
    if (j.error) return `${j.error.type ?? "error"}: ${j.error.message ?? ""}`.trim();
  } catch {
    /* not JSON */
  }
  return text.trim() ? text.trim().slice(0, 300) : null;
}

export interface ParsedMessage {
  text: string;
  stopReason: string | null;
  refusalCategory: string | null;
  model: string | null;
  error: string | null;
}

interface ApiMessage {
  model?: string;
  content?: { type: string; text?: string }[];
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
}

function joinText(content: ApiMessage["content"]): string {
  return (content ?? []).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}

/** A non-streaming Messages API response body. */
export function parseJsonMessage(raw: string): ParsedMessage {
  let m: ApiMessage & { type?: string; error?: { type?: string; message?: string } };
  try {
    m = JSON.parse(raw);
  } catch {
    return { text: "", stopReason: null, refusalCategory: null, model: null, error: "response was not JSON" };
  }
  if (m.type === "error" || m.error) return { text: "", stopReason: null, refusalCategory: null, model: null, error: `${m.error?.type ?? "error"}: ${m.error?.message ?? ""}` };
  return { text: joinText(m.content), stopReason: m.stop_reason ?? null, refusalCategory: m.stop_details?.category ?? null, model: m.model ?? null, error: null };
}

/** Reads an SSE body as it arrives, reporting the answer text so far; returns the whole body. */
async function readStreaming(body: ReadableStream<Uint8Array>, onText: (text: string) => void, everyMs = 300): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let last = 0;
  let shown = "";
  const report = () => {
    const text = parseSseMessage(raw).text;
    if (text && text !== shown) {
      shown = text;
      try {
        onText(text);
      } catch {
        /* the live view must never break generation */
      }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    if (Date.now() - last >= everyMs) {
      last = Date.now();
      report();
    }
  }
  raw += decoder.decode();
  report();
  return raw;
}

/**
 * The value of a string field from JSON that is still streaming in, e.g. the `scad` code
 * while Claude writes it. Null until the field has started.
 */
export function partialJsonString(text: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
  if (!m) return null;
  let out = "";
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return out;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = text[++i];
    if (n === undefined) break;
    if (n === "u") {
      const hex = text.slice(i + 1, i + 5);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[n] ?? n;
  }
  return out;
}

/**
 * A streamed (SSE) response, read to the end. Only text deltas are kept; thinking,
 * signature and fallback blocks are skipped. A fallback hop restarts the text, so the
 * answer is the text produced after the last `fallback` block.
 */
export function parseSseMessage(raw: string): ParsedMessage {
  let text = "";
  let stopReason: string | null = null;
  let refusalCategory: string | null = null;
  let model: string | null = null;
  let error: string | null = null;
  for (const chunk of raw.split(/\r?\n\r?\n/)) {
    const data = chunk
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    let ev: any;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    switch (ev?.type) {
      case "message_start":
        model = ev.message?.model ?? model;
        text += joinText(ev.message?.content);
        break;
      case "content_block_start":
        if (ev.content_block?.type === "fallback") {
          text = "";
          model = ev.content_block?.to?.model ?? model;
        } else if (ev.content_block?.type === "text" && typeof ev.content_block.text === "string") text += ev.content_block.text;
        break;
      case "content_block_delta":
        if (ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") text += ev.delta.text;
        break;
      case "message_delta":
        if (ev.delta?.stop_reason !== undefined) stopReason = ev.delta.stop_reason;
        if (ev.delta?.stop_details?.category !== undefined) refusalCategory = ev.delta.stop_details.category;
        break;
      case "error":
        error = `${ev.error?.type ?? "error"}: ${ev.error?.message ?? ""}`;
        break;
    }
  }
  return { text, stopReason, refusalCategory, model, error };
}

/** JSON from the answer text; tolerates a ```json fence or prose around one object. */
export function parseJsonText<T>(text: string): T | null {
  const t = text.trim();
  const candidates = [t, /```(?:json)?\s*([\s\S]*?)```/.exec(t)?.[1], t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object") return v as T;
    } catch {
      /* try the next form */
    }
  }
  return null;
}
