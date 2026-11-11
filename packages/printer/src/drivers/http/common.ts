// Shared plumbing for the "http" driver family (Moonraker, OctoPrint, PrusaLink, Duet):
// base URL from the user's fields, one HTTP request helper with a timeout on every call,
// mapping of network / HTTP failures to DriverError with a plain hint, and status helpers.
// Secrets: request URLs are logged without their query string and headers are never logged;
// error messages never contain URLs, headers or request bodies.
import {
  DriverError,
  type DriverConfig,
  type DriverDeps,
  type DriverErrorCode,
  type DriverStatus,
  type FileFormat,
  type PrintState,
  type Temp,
  type TestResult,
} from "../types";

export const DEFAULT_TIMEOUT_MS = 8000;

/** Resolved helpers from DriverDeps, with defaults. */
export interface Env {
  fetch: typeof fetch;
  log: NonNullable<DriverDeps["log"]>;
  now: () => number;
}

export function makeEnv(deps?: DriverDeps): Env {
  return {
    fetch: deps?.fetch ?? fetch,
    log: deps?.log ?? (() => undefined),
    now: deps?.now ?? Date.now,
  };
}

export function str(v: DriverConfig[string]): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

/** Per-call timeout; `timeoutMs` is an advanced config value (not shown on the setup form). */
export function timeoutFrom(config: DriverConfig): number {
  const t = Number(config.timeoutMs);
  return Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS;
}

/**
 * "192.168.1.5", "voron.local", "http://x:7125", "[fe80::1]" or "fe80::1" plus an optional port field
 * → "http://192.168.1.5:7125" (no trailing slash). Throws DriverError("rejected") for anything else.
 */
export function baseUrl(config: DriverConfig, defaultPort?: number): string {
  let host = str(config.host);
  if (!host) throw new DriverError("rejected", "No printer address was entered", "Enter the printer's IP address or host name.");
  // A bare IPv6 address needs brackets in a URL.
  if (!host.includes("://") && !host.startsWith("[") && (host.match(/:/g)?.length ?? 0) > 1) host = `[${host}]`;
  let url: URL;
  try {
    url = new URL(host.includes("://") ? host : `http://${host}`);
  } catch {
    throw new DriverError("rejected", "The printer address is not valid", "Use an IP address like 192.168.1.50 or a name like printer.local.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DriverError("rejected", "The printer address must start with http:// or https://", "Leave out the prefix to use http://.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DriverError("rejected", "The printer address must not contain a login, ? or #", "Enter only the address; put passwords and keys in their own fields.");
  }
  const port = Number(config.port);
  if (!url.port) {
    if (Number.isInteger(port) && port > 0 && port < 65536) url.port = String(port);
    else if (defaultPort) url.port = String(defaultPort);
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** Makes a camera URL from the printer absolute and replaces localhost (the printer's own view) with the printer host. */
export function absoluteUrl(raw: string, base: string, dropPort = false): string | undefined {
  if (!raw) return undefined;
  try {
    const b = new URL(base);
    const origin = dropPort ? `${b.protocol}//${b.hostname.includes(":") ? `[${b.hostname}]` : b.hostname}` : b.origin;
    const u = new URL(raw, origin + "/");
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]") u.hostname = b.hostname;
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "rtsp:") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
}

export interface RequestOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | FormData;
  timeoutMs?: number;
  /** Plain words for messages: "read the status", "upload the file". */
  what: string;
}

/** Driver-specific words for errors (printer kind, where to fix credentials). */
export interface Hints {
  /** "Moonraker", "OctoPrint", ... */
  name: string;
  /** Next step when the printer says 401 / 403. */
  auth: string;
  /** Next step when nothing answers. */
  unreachable: string;
}

/** Adds credentials to a request and handles 401 challenges (HTTP Digest). */
export interface Authorizer {
  headers(method: string, uri: string): Record<string, string>;
  /** Called on 401; return true to retry the request once with fresh credentials. */
  challenge?(reply: Reply): boolean;
}

export class Http {
  constructor(
    readonly base: string,
    private readonly env: Env,
    private readonly hints: Hints,
    private readonly timeoutMs: number,
    private readonly auth?: Authorizer,
  ) {}

  /** Sends one request and reads the whole body inside the timeout. Throws DriverError only for network failures. */
  async send(path: string, opts: RequestOpts): Promise<Reply> {
    const method = opts.method ?? "GET";
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const logPath = path.split("?")[0];
    for (let attempt = 0; ; attempt++) {
      const uri = new URL(this.base + path).pathname + (path.includes("?") ? path.slice(path.indexOf("?")) : "");
      const headers = { ...(opts.headers ?? {}), ...(this.auth?.headers(method, uri) ?? {}) };
      let reply: Reply;
      const started = this.env.now();
      try {
        const res = await this.env.fetch(this.base + path, {
          method,
          headers,
          body: opts.body as BodyInit | undefined,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "manual",
        });
        reply = { status: res.status, headers: res.headers, text: await res.text() };
      } catch (e) {
        this.env.log("debug", `${this.hints.name} ${method} ${logPath} failed`, { error: errorName(e) });
        throw networkError(e, opts.what, timeoutMs, this.hints);
      }
      this.env.log("debug", `${this.hints.name} ${method} ${logPath} → ${reply.status}`, { ms: this.env.now() - started });
      if (reply.status === 401 && attempt === 0 && this.auth?.challenge?.(reply)) continue;
      return reply;
    }
  }

  /** Like send, but any non-2xx reply becomes a DriverError. */
  async call(path: string, opts: RequestOpts): Promise<Reply> {
    const reply = await this.send(path, opts);
    if (reply.status >= 200 && reply.status < 300) return reply;
    throw httpError(reply, opts.what, this.hints);
  }

  async json<T>(path: string, opts: RequestOpts): Promise<T> {
    return parseJson<T>((await this.call(path, opts)).text, opts.what, this.hints.name);
  }
}

export function parseJson<T>(text: string, what: string, name: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DriverError("protocol", `${name} sent a reply that is not JSON when trying to ${what}`, "Check that the address and port point at the right service.");
  }
}

function errorName(e: unknown): string {
  const err = e as { name?: string; cause?: { code?: string } };
  return err?.cause?.code ?? err?.name ?? "error";
}

export function networkError(e: unknown, what: string, timeoutMs: number, hints: Hints): DriverError {
  if (e instanceof DriverError) return e;
  const err = e as { name?: string; cause?: { code?: string; name?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError" || err?.cause?.name === "TimeoutError") {
    return new DriverError("timeout", `${hints.name} did not answer within ${Math.round(timeoutMs / 100) / 10} s when trying to ${what}`, hints.unreachable);
  }
  const code = err?.cause?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new DriverError("unreachable", "The printer's name could not be found on the network", "Use its IP address instead (shown on the printer's screen or in your router).");
  }
  if (code === "ECONNREFUSED") {
    return new DriverError("unreachable", `The printer refused the connection: ${hints.name} is not answering on that port`, hints.unreachable);
  }
  if (code.startsWith("ERR_TLS") || code.includes("CERT") || code === "EPROTO") {
    return new DriverError("protocol", "The printer's HTTPS certificate was not accepted", "Use http:// in the address instead.");
  }
  if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
    return new DriverError("timeout", `${hints.name} did not answer in time when trying to ${what}`, hints.unreachable);
  }
  return new DriverError("unreachable", `Could not reach the printer to ${what}`, hints.unreachable);
}

/** A short message from the printer's error body (JSON `error`/`message`/`title` or plain text), never a secret we sent. */
function printerMessage(text: string): string {
  let msg = "";
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const e = j.error as Record<string, unknown> | string | undefined;
    msg = String((typeof e === "object" ? e?.message : e) ?? j.message ?? j.title ?? j.text ?? "");
  } catch {
    if (!/^\s*</.test(text)) msg = text;
  }
  msg = msg.replace(/\s+/g, " ").trim();
  return msg.length > 160 ? msg.slice(0, 157) + "..." : msg;
}

export function httpError(reply: Reply, what: string, hints: Hints): DriverError {
  const s = reply.status;
  if (s === 401 || s === 403) return new DriverError("auth", `${hints.name} refused the login when trying to ${what}`, hints.auth);
  const detail = printerMessage(reply.text);
  const suffix = detail ? `: ${detail}` : "";
  if (s === 409) return new DriverError("busy", `The printer is busy and could not ${what}${suffix}`, "Wait until the current job is done, then try again.");
  if (s === 404 || s === 405 || s === 501) return new DriverError("unsupported", `${hints.name} does not support this (could not ${what})${suffix}`, "Update the printer's firmware, or check that the right printer type is chosen.");
  if (s === 413) return new DriverError("rejected", "The file is too large for the printer", "Free space on the printer's storage or use a smaller file.");
  if (s >= 300 && s < 400) return new DriverError("protocol", `${hints.name} redirected the request to ${what}`, "Check the address: try http:// vs https:// and the port.");
  if (s >= 400 && s < 500) return new DriverError("rejected", `The printer rejected the request to ${what}${suffix}`);
  return new DriverError("protocol", `${hints.name} failed to ${what} (HTTP ${s})${suffix}`, "Check the printer's screen or web page for an error, or restart it.");
}

/** Status for when the printer can't be read: never throws. */
export function offlineStatus(e: unknown, now: () => number): DriverStatus {
  const err = asDriverError(e);
  return { state: "offline", message: err.hint ? `${err.message}. ${err.hint}` : err.message, checkedAt: new Date(now()).toISOString() };
}

export function asDriverError(e: unknown): DriverError {
  if (e instanceof DriverError) return e;
  return new DriverError("protocol", "The printer sent a reply Morphix did not understand", "Check that the right printer type is chosen.");
}

/** Runs a test() body and turns any failure into ok:false. */
export async function guardTest(fn: () => Promise<TestResult>): Promise<TestResult> {
  try {
    return await fn();
  } catch (e) {
    const err = asDriverError(e);
    return { ok: false, code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) };
  }
}

export function temp(actual: unknown, target?: unknown): Temp | undefined {
  const a = Number(actual);
  if (actual === null || actual === undefined || !Number.isFinite(a)) return undefined;
  const t = Number(target);
  return target === null || target === undefined || !Number.isFinite(t) ? { actual: a } : { actual: a, target: t };
}

/** A heater has a target and is still well below it (the print's start G-code is waiting for M109/M190). */
export function heatingNow(temps: DriverStatus["temps"]): boolean {
  const below = (t?: Temp) => !!t && (t.target ?? 0) > 0 && t.actual < (t.target ?? 0) - 3;
  return below(temps?.nozzle) || below(temps?.bed);
}

const START_OK: PrintState[] = ["idle"];

/** start() is only allowed from idle (contract). */
export function requireIdle(st: DriverStatus): void {
  if (st.state === "offline") throw new DriverError("unreachable", st.message ?? "The printer is offline", "Check that the printer is on and connected.");
  if (!START_OK.includes(st.state)) {
    throw new DriverError("busy", `The printer is ${describe(st)}, so a new print can't start`, "Wait until it is idle, then start again.");
  }
}

export function requireState(st: DriverStatus, allowed: PrintState[], action: string): void {
  if (st.state === "offline") throw new DriverError("unreachable", st.message ?? "The printer is offline", "Check that the printer is on and connected.");
  if (!allowed.includes(st.state)) {
    throw new DriverError("rejected", `Can't ${action}: the printer is ${describe(st)}`, allowed.includes("paused") && !allowed.includes("printing") ? "Resume only works on a paused print." : undefined);
  }
}

function describe(st: DriverStatus): string {
  return st.message ? `${st.state} (${st.message})` : st.state;
}

export function requireFormat(format: FileFormat, allowed: FileFormat[]): void {
  if (!allowed.includes(format)) {
    throw new DriverError("unsupported", `This printer can't print .${format} files`, `Slice for this printer to get a ${allowed.map((f) => "." + f).join(" or ")} file.`);
  }
}

/** Temperatures: the caller clamps to the catalog model; this only rejects nonsense. */
export function checkTemperature(heater: "nozzle" | "bed", celsius: number): number {
  const max = heater === "nozzle" ? 500 : 200;
  if (!Number.isFinite(celsius) || celsius < 0 || celsius > max) {
    throw new DriverError("rejected", `${celsius} °C is not a valid ${heater} temperature`, `Use 0 (off) up to the printer's maximum.`);
  }
  return Math.round(celsius);
}

/** Manual G-code is refused while a print runs (except an emergency stop) so a typo can't crash a print. */
export function checkConsole(st: DriverStatus, line: string): string {
  const cmd = line.trim();
  if (!cmd || /[\r\n]/.test(cmd)) throw new DriverError("rejected", "Send one G-code line at a time");
  if (/^M112\b/i.test(cmd)) return cmd;
  requireState(st, ["idle", "paused", "error"], "send G-code");
  return cmd;
}

/** A safe file name for the printer: no folders, only plain characters, the right extension. */
export function safeFileName(name: string, ext = ".gcode"): string {
  const baseName = name.split(/[\\/]/).pop() ?? "";
  let n = baseName.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^[.\s]+/, "").replace(/\s+/g, " ").trim();
  if (!n.toLowerCase().endsWith(ext)) n = (n.replace(/\.+$/, "") || "print") + ext;
  if (n.length > 96) n = n.slice(0, 96 - ext.length) + ext;
  return n;
}

/** Uploads get more time: 60 s plus 1 s per 100 kB (slow Wi-Fi printers manage ~200 kB/s). */
export function uploadTimeout(bytes: number, base: number): number {
  return Math.max(base, 60_000) + Math.ceil(bytes / 100_000) * 1000;
}

export function nowIso(env: Env): string {
  return new Date(env.now()).toISOString();
}

export function code(e: unknown): DriverErrorCode | undefined {
  return e instanceof DriverError ? e.code : undefined;
}
