// Shared helpers for the "lan" driver family: config parsing, timeouts, error mapping, a
// log wrapper that strips secrets, HTTP with a deadline, and a small WebSocket session.
// Pure plumbing: nothing here sends a printer command on its own.
import { DriverError, type DriverCapabilities, type DriverConfig, type DriverDeps, type DriverErrorCode, type DriverId, type DriverStatus, type PrinterConnection, type PrintState, type TestResult } from "../types";

export type Log = NonNullable<DriverDeps["log"]>;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wraps deps.log so it can never throw and never prints a value from `secrets`. */
export function safeLog(deps: DriverDeps | undefined, secrets: () => (string | undefined)[]): Log {
  const log = deps?.log;
  return (level, message, data) => {
    if (!log) return;
    try {
      const values = secrets().filter((s): s is string => typeof s === "string" && s.length >= 3);
      const scrub = (s: string) => values.reduce((acc, v) => acc.split(v).join("***"), s);
      const clean = data ? (JSON.parse(scrub(JSON.stringify(data))) as Record<string, unknown>) : undefined;
      log(level, scrub(message), clean);
    } catch {
      // logging must never break printer control
    }
  };
}

/** Replaces every secret in a string (for error messages built from printer replies). */
export function redact(text: string, secrets: (string | undefined)[]): string {
  return secrets.filter((s): s is string => typeof s === "string" && s.length >= 3).reduce((acc, v) => acc.split(v).join("***"), text);
}

export function str(cfg: DriverConfig, key: string, fallback = ""): string {
  const v = cfg[key];
  return v === undefined || v === null ? fallback : String(v).trim();
}

export function num(cfg: DriverConfig, key: string, fallback: number): number {
  const v = cfg[key];
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function bool(cfg: DriverConfig, key: string, fallback: boolean): boolean {
  const v = cfg[key];
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return fallback;
}

/** Throws DriverError("rejected") for an empty or malformed host. Hostnames, IPv4 and IPv6 are allowed. */
export function requireHost(cfg: DriverConfig): string {
  const host = str(cfg, "host");
  if (!host) throw new DriverError("rejected", "printer address is missing", "Enter the printer's IP address (shown in its network settings).");
  if (!/^[A-Za-z0-9.:\-[\]%]+$/.test(host) || host.length > 253) {
    throw new DriverError("rejected", "printer address has characters that are not allowed", "Enter just the IP address or host name, without http:// or a path.");
  }
  return host.replace(/^\[(.*)\]$/, "$1");
}

export function requirePort(cfg: DriverConfig, key: string, fallback: number): number {
  const p = num(cfg, key, fallback);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new DriverError("rejected", `port ${String(cfg[key])} is not a valid port`, "Use a number from 1 to 65535, or leave it empty for the default.");
  return p;
}

/** For use in URLs: IPv6 literals need brackets. */
export function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

export function requireSecret(cfg: DriverConfig, key: string, label: string, hint: string): string {
  const v = str(cfg, key);
  if (!v) throw new DriverError("auth", `${label} is missing`, hint);
  return v;
}

/** Rejects after `ms` with DriverError("timeout"). The timer never keeps the process alive. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string, hint?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new DriverError("timeout", `${what} timed out after ${ms} ms`, hint ?? "Check that the printer is on and on the same network, then try again.")), ms);
    t.unref?.();
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

const UNREACHABLE = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|socket hang up|fetch failed|cannot reach|connection error|closed the connection|other side closed|Unexpected server response|ERR_SOCKET/i;
const TIMEOUT = /ETIMEDOUT|timed out|timeout|aborted|AbortError/i;

/** Maps any thrown value to a DriverError with a plain hint. DriverErrors pass through. */
export function toDriverError(e: unknown, what: string, secrets: (string | undefined)[] = []): DriverError {
  if (e instanceof DriverError) return e;
  const err = e as { message?: string; code?: string; cause?: { code?: string; message?: string }; name?: string };
  const raw = [err?.name, err?.code, err?.message, err?.cause?.code, err?.cause?.message].filter(Boolean).join(" ");
  const msg = redact(err?.message ?? String(e), secrets);
  if (TIMEOUT.test(raw)) return new DriverError("timeout", `${what}: no answer in time (${msg})`, "Check that the printer is on and on the same network, then try again.");
  if (UNREACHABLE.test(raw)) return new DriverError("unreachable", `${what}: cannot reach the printer (${msg})`, "Check the IP address, that the printer is on, and that this computer is on the same network.");
  return new DriverError("protocol", `${what}: ${msg}`, "The printer answered in an unexpected way. Check its firmware is up to date, then try again.");
}

export function failResult(e: unknown, what: string, secrets: (string | undefined)[] = []): TestResult {
  const d = toDriverError(e, what, secrets);
  return { ok: false, code: d.code, message: d.message, hint: d.hint };
}

export function offline(message: string, now: () => number): DriverStatus {
  return { state: "offline", message, checkedAt: new Date(now()).toISOString() };
}

export function busy(state: PrintState, action: string): DriverError {
  return new DriverError("busy", `printer is ${state}; ${action} needs it to be idle`, "Wait for the current job to finish (or cancel it on the printer), then try again.");
}

export function wrongState(action: string, state: PrintState): DriverError {
  return new DriverError("rejected", `nothing to ${action}: printer is ${state}`, "Refresh the printer status; the job may already have changed.");
}

/** Plain file name for storing on a printer: basename, safe ASCII, keeps the extension. */
export function safeFileName(name: string, allowedExt: string[]): string {
  const base = (name.split(/[\\/]/).pop() ?? "").trim();
  const lower = base.toLowerCase();
  const ext = allowedExt.find((e) => lower.endsWith(e));
  if (!ext) throw new DriverError("unsupported", `file ${JSON.stringify(base)} is not a ${allowedExt.join(" / ")} file`, "Slice for this printer so the file has the right type.");
  const stem = base
    .slice(0, base.length - ext.length)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^[._-]+/, "")
    .slice(0, 100);
  if (!stem) throw new DriverError("rejected", `file name ${JSON.stringify(base)} has no usable characters`, "Rename the file using letters and numbers.");
  return stem + ext;
}

/** fetch with a deadline; network failures become DriverError. */
export async function fetchWithTimeout(
  f: typeof fetch,
  url: string,
  init: RequestInit,
  ms: number,
  what: string,
  secrets: (string | undefined)[] = [],
): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  t.unref?.();
  try {
    return await f(url, { ...init, signal: ctl.signal });
  } catch (e) {
    if (ctl.signal.aborted) throw new DriverError("timeout", `${what} timed out after ${ms} ms`, "Check that the printer is on and on the same network, then try again.");
    throw toDriverError(e, what, secrets);
  } finally {
    clearTimeout(t);
  }
}

export async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new DriverError("protocol", `${what}: the printer did not answer with JSON (HTTP ${res.status})`, "Check that the address is this printer and its firmware is up to date.");
}

export function toNum(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export function temp(actual: unknown, target?: unknown): { actual: number; target?: number } | undefined {
  const a = toNum(actual);
  if (a === undefined) return undefined;
  const t = toNum(target);
  return t === undefined ? { actual: a } : { actual: a, target: t };
}

export function clamp01(n: number | undefined): number | undefined {
  return n === undefined ? undefined : Math.min(1, Math.max(0, n));
}

/**
 * One WebSocket used for request/response plus pushed messages. Opening has a deadline;
 * `waitFor` resolves on the first message matching a predicate (or rejects on timeout/close).
 */
export class WsSession {
  private ws: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private waiters = new Set<{ match: (m: unknown) => boolean; resolve: (m: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(m: unknown) => void>();

  constructor(
    private url: string,
    private Ctor: typeof WebSocket,
    private opts: { protocols?: string[]; openTimeoutMs: number; onText?: (text: string, ws: WebSocket) => boolean; what: string },
  ) {}

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  open(): Promise<WebSocket> {
    if (this.isOpen) return Promise.resolve(this.ws!);
    if (this.opening) return this.opening;
    this.opening = new Promise<WebSocket>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = this.opts.protocols ? new this.Ctor(this.url, this.opts.protocols) : new this.Ctor(this.url);
      } catch (e) {
        reject(toDriverError(e, this.opts.what));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new DriverError("timeout", `${this.opts.what}: no WebSocket connection within ${this.opts.openTimeoutMs} ms`, "Check that the printer is on and on the same network, then try again."));
      }, this.opts.openTimeoutMs);
      timer.unref?.();
      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        resolve(ws);
      });
      ws.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new DriverError("unreachable", `${this.opts.what}: cannot open a WebSocket to the printer`, "Check the IP address, that the printer is on, and that this computer is on the same network."));
      });
      ws.addEventListener("close", () => {
        if (this.ws === ws) this.ws = null;
        for (const w of this.waiters) w.reject(new DriverError("unreachable", `${this.opts.what}: the printer closed the connection`, "Check the printer is still on the network, then try again."));
        this.waiters.clear();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new DriverError("unreachable", `${this.opts.what}: the printer closed the connection`, "Check the IP address and that the printer is on."));
        }
      });
      ws.addEventListener("message", (ev: MessageEvent) => {
        const text = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8");
        if (this.opts.onText?.(text, ws)) return;
        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        for (const l of this.listeners) l(msg);
        for (const w of [...this.waiters]) {
          if (w.match(msg)) {
            this.waiters.delete(w);
            w.resolve(msg);
          }
        }
      });
    }).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  onMessage(fn: (m: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Registers the waiter before `send` runs, so a fast reply is never missed. */
  async request<T>(send: (ws: WebSocket) => void, match: (m: unknown) => boolean, ms: number, what: string): Promise<T> {
    const ws = await this.open();
    return new Promise<T>((resolve, reject) => {
      const w = {
        match,
        resolve: (m: unknown) => (clearTimeout(t), resolve(m as T)),
        reject: (e: Error) => (clearTimeout(t), reject(e)),
      };
      const t = setTimeout(() => {
        this.waiters.delete(w);
        reject(new DriverError("timeout", `${what}: no answer within ${ms} ms`, "Check that the printer is on and on the same network, then try again."));
      }, ms);
      t.unref?.();
      this.waiters.add(w);
      try {
        send(ws);
      } catch (e) {
        this.waiters.delete(w);
        clearTimeout(t);
        reject(toDriverError(e, what));
      }
    });
  }

  async send(data: string): Promise<void> {
    const ws = await this.open();
    ws.send(data);
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }
}

export function errorCodeOf(e: unknown): DriverErrorCode {
  return e instanceof DriverError ? e.code : "protocol";
}

/**
 * Returned by connect() when the settings themselves are unusable (e.g. no IP address), so
 * test()/status() can still report the problem instead of connect() throwing.
 */
export function invalidConnection(driver: DriverId, error: DriverError, caps: DriverCapabilities, now: () => number): PrinterConnection {
  const fail = async (): Promise<never> => {
    throw error;
  };
  return {
    driver,
    capabilities: () => caps,
    test: async () => ({ ok: false, code: error.code, message: error.message, hint: error.hint }),
    status: async () => offline(`${error.message}. ${error.hint ?? ""}`.trim(), now),
    upload: fail,
    start: fail,
    pause: fail,
    resume: fail,
    cancel: fail,
    close: async () => undefined,
  };
}

/** Polls `read` until `ok` holds or `ms` passes. Returns the last value and whether it matched. */
export async function pollUntil<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms: number, everyMs: number): Promise<{ value: T; ok: boolean }> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return { value, ok: true };
    if (Date.now() >= deadline) return { value, ok: false };
    await sleep(everyMs);
  }
}

export function requireData(data: Buffer): void {
  if (!data || data.length === 0) throw new DriverError("rejected", "upload: the file is empty", "Slice the model again and retry.");
}
