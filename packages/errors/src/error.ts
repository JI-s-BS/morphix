// MorphixError: a normal Error carrying a registry code, its cause and a small
// JSON-safe context. toJSON()/fromJSON() give the wire form used over IPC and HTTP.
import type { ErrorArea, ErrorCodeEntry, ErrorSeverity } from "./codes";
import { ERROR_CODE_PATTERN, getErrorEntry, type ErrorCode } from "./registry";

export type ErrorContext = Record<string, unknown>;

/** The wire form. Plain JSON: safe for IPC, HTTP bodies, SQLite and job snapshots. */
export interface SerializedMorphixError {
  name: "MorphixError";
  code: string;
  area: string;
  title: string;
  hint: string;
  /** Technical message (developer-facing). Show `title` and `hint` to users. */
  message: string;
  severity: ErrorSeverity;
  retryable: boolean;
  /** ISO time the error was created. */
  at: string;
  context?: ErrorContext;
  cause?: { name: string; message: string; code?: string | number };
}

export interface MorphixErrorOptions {
  /** Technical message; defaults to the registry description. */
  message?: string;
  cause?: unknown;
  context?: ErrorContext;
  /** Override the registry's retryable flag for this occurrence. */
  retryable?: boolean;
  at?: Date | string;
}

const SECRET_KEY = /(api[-_]?key|token|secret|password|passwd|authorization|cookie|session[-_]?id|client[-_]?secret)/i;

/** Entry used for codes nobody registered (keeps the code; falls back to generic text). */
function unknownEntry(code: string): ErrorCodeEntry {
  const sys = getErrorEntry("MX-SYS-001")!;
  const area = ERROR_CODE_PATTERN.exec(code)?.[1] ?? "SYS";
  return { ...sys, code, area: area as ErrorArea, description: `Unregistered error code ${code}.` };
}

export class MorphixError extends Error {
  readonly code: ErrorCode;
  readonly entry: ErrorCodeEntry;
  readonly context: ErrorContext;
  readonly retryable: boolean;
  readonly at: string;
  override readonly cause?: unknown;

  constructor(code: ErrorCode | string, opts: MorphixErrorOptions = {}) {
    const entry = getErrorEntry(code) ?? unknownEntry(code);
    super(opts.message ?? entry.description);
    this.name = "MorphixError";
    this.code = code as ErrorCode;
    this.entry = entry;
    this.context = sanitizeContext(opts.context ?? {});
    this.retryable = opts.retryable ?? entry.retryable;
    this.at = opts.at ? new Date(opts.at).toISOString() : new Date().toISOString();
    if (opts.cause !== undefined) this.cause = opts.cause;
  }

  get title(): string {
    return this.entry.title;
  }
  get hint(): string {
    return this.entry.hint;
  }
  get severity(): ErrorSeverity {
    return this.entry.severity;
  }
  get area(): string {
    return this.entry.area;
  }

  /** Copy with extra context merged in (the original is not changed). */
  withContext(extra: ErrorContext): MorphixError {
    return new MorphixError(this.code, { message: this.message, cause: this.cause, context: { ...this.context, ...extra }, retryable: this.retryable, at: this.at });
  }

  toJSON(): SerializedMorphixError {
    const out: SerializedMorphixError = {
      name: "MorphixError",
      code: this.code,
      area: this.entry.area,
      title: this.entry.title,
      hint: this.entry.hint,
      message: this.message,
      severity: this.entry.severity,
      retryable: this.retryable,
      at: this.at,
    };
    if (Object.keys(this.context).length) out.context = this.context;
    const cause = describeCause(this.cause);
    if (cause) out.cause = cause;
    return out;
  }

  static fromJSON(s: SerializedMorphixError): MorphixError {
    const e = new MorphixError(s.code, { message: s.message, context: s.context, retryable: s.retryable, at: s.at });
    if (s.cause) {
      const c = new Error(s.cause.message) as Error & { code?: string | number };
      c.name = s.cause.name;
      if (s.cause.code !== undefined) c.code = s.cause.code;
      (e as { cause?: unknown }).cause = c;
    }
    return e;
  }
}

export function isMorphixError(e: unknown): e is MorphixError {
  return e instanceof MorphixError;
}

export function isSerializedMorphixError(v: unknown): v is SerializedMorphixError {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.name === "MorphixError" && typeof o.code === "string" && ERROR_CODE_PATTERN.test(o.code) && typeof o.title === "string" && typeof o.message === "string";
}

/** Short user-facing text: "The printer isn't answering. Check the printer is switched on…". */
export function userMessage(e: MorphixError | SerializedMorphixError): string {
  return `${e.title}. ${e.hint}`;
}

function describeCause(c: unknown): SerializedMorphixError["cause"] | undefined {
  if (c === undefined || c === null) return undefined;
  if (c instanceof Error) {
    const code = (c as { code?: unknown }).code;
    return { name: c.name, message: truncate(redact(c.message), 500), ...(typeof code === "string" || typeof code === "number" ? { code } : {}) };
  }
  return { name: typeof c, message: truncate(redact(String(typeof c === "object" ? safeStringify(c) : c)), 500) };
}

/**
 * Makes context JSON-safe and small: drops functions/symbols, turns buffers into
 * "<n bytes>", truncates long strings, redacts secret-looking keys, limits depth.
 */
export function sanitizeContext(ctx: ErrorContext): ErrorContext {
  const out = clean(ctx, 0);
  return out && typeof out === "object" && !Array.isArray(out) ? (out as ErrorContext) : {};
}

function clean(v: unknown, depth: number, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return "[redacted]";
  if (v === null) return null;
  switch (typeof v) {
    case "string":
      return truncate(redact(v), 1000);
    case "number":
      return Number.isFinite(v) ? v : String(v);
    case "boolean":
      return v;
    case "bigint":
      return v.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Error) return { name: v.name, message: truncate(redact(v.message), 500) };
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return `<${(v as ArrayBufferLike).byteLength} bytes>`;
  if (depth >= 4) return "[…]";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, depth + 1) ?? null);
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (n++ >= 50) break;
    const c = clean(x, depth + 1, k);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/** Removes things that look like keys/tokens from free text (query strings, bearer tokens). */
function redact(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&\s]+/gi, "$1[redacted]");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function safeStringify(o: unknown): string {
  try {
    return JSON.stringify(o) ?? String(o);
  } catch {
    return String(o);
  }
}
