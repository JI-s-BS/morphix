// MorphixApi over HTTP for a plain browser: every call is POST /api/rpc/<channel> (JSON args,
// binary as { $bytes }), push events arrive from GET /api/events (Server-Sent Events).
import type { MorphixApi } from "./index";
import { IPC } from "./ipc";
import { CSRF_COOKIE, CSRF_HEADER, decodeWire, encodeWire } from "./wire";

/** Every MorphixApi call except the on* subscriptions has an IPC channel of the same name. */
type CallName = Exclude<keyof MorphixApi, `on${string}`>;
const _allCallsHaveChannels: CallName extends keyof typeof IPC ? true : never = true;
void _allCallsHaveChannels;

const EVENT_FOR = {
  onGenerationProgress: IPC.generationProgress,
  onPrinterStatus: IPC.printerStatusEvent,
  onVoiceEvent: IPC.voiceEvent,
  onAppEvent: IPC.appEvent,
} as const;
const EVENT_KEYS = new Set<string>(["generationProgress", "printerStatusEvent", "voiceEvent", "appEvent"]);

export class RpcError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly hint?: string) {
    super(message);
    this.name = "RpcError";
  }
}

interface EventSourceLike {
  readyState: number;
  addEventListener(type: string, cb: (e: { data: string }) => void): void;
  close(): void;
  onerror: ((e: unknown) => void) | null;
}

export interface HttpApiOptions {
  /** Origin + path prefix, "" for same origin. */
  base?: string;
  fetch?: typeof fetch;
  EventSource?: new (url: string, init?: { withCredentials?: boolean }) => EventSourceLike;
  /** Reads the CSRF cookie (browser: document.cookie). */
  cookie?: () => string;
  /** Called on 401 (signed out / setup needed), e.g. to show the sign-in page. */
  onUnauthorized?: (code: string | undefined) => void;
  reconnectMs?: number;
}

export function createHttpApi(o: HttpApiOptions = {}): MorphixApi {
  const base = o.base ?? "";
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const readCookie = o.cookie ?? (() => (typeof document !== "undefined" ? document.cookie : ""));
  let csrf: string | null = null;

  const cookieToken = () => {
    for (const part of readCookie().split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === CSRF_COOKIE) return decodeURIComponent(v.join("="));
    }
    return null;
  };
  const token = async (): Promise<string> => {
    const c = cookieToken();
    if (c) return (csrf = c);
    if (csrf) return csrf;
    const r = await doFetch(`${base}/api/session`, { credentials: "same-origin" });
    const j = (await r.json().catch(() => ({}))) as { csrfToken?: string };
    if (!j.csrfToken) throw new RpcError("Couldn't start a session with Morphix.", r.status);
    return (csrf = j.csrfToken);
  };

  const call = async (channel: string, args: unknown[]): Promise<unknown> => {
    while (args.length && args[args.length - 1] === undefined) args = args.slice(0, -1);
    const body = JSON.stringify(encodeWire(args));
    let attempt = 0;
    for (;;) {
      const r = await doFetch(`${base}/api/rpc/${channel}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", [CSRF_HEADER]: await token() },
        body,
      });
      const j = (await r.json().catch(() => null)) as { result?: unknown; error?: { code?: string; message?: string; hint?: string } } | null;
      if (r.ok) return decodeWire(j?.result ?? null) ?? undefined;
      const err = j?.error;
      // A stale token (server secret changed): fetch a fresh one once.
      if (r.status === 403 && err?.code === "csrf" && attempt++ === 0) {
        csrf = null;
        continue;
      }
      if (r.status === 401) o.onUnauthorized?.(err?.code);
      const msg = err?.message ?? `Morphix answered ${r.status}`;
      throw new RpcError(err?.code === "rpc" || !err?.hint ? msg : `${msg} ${err.hint}`, r.status, err?.code, err?.hint);
    }
  };

  // ---------------------------------------------------------------- events ---
  const subs = new Map<string, Set<(v: unknown) => void>>();
  let es: EventSourceLike | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const ES = o.EventSource ?? (typeof EventSource !== "undefined" ? (EventSource as unknown as HttpApiOptions["EventSource"]) : undefined);
  const open = () => {
    if (es || !ES) return;
    const s = new ES(`${base}/api/events`, { withCredentials: true });
    es = s;
    for (const ch of Object.values(EVENT_FOR)) {
      s.addEventListener(ch, (e) => {
        let v: unknown;
        try {
          v = decodeWire(JSON.parse(e.data));
        } catch {
          return;
        }
        for (const cb of subs.get(ch) ?? []) cb(v);
      });
    }
    s.onerror = () => {
      // The browser retries by itself unless the server refused (CLOSED): then try again later.
      if (s.readyState === 2) {
        s.close();
        if (es === s) es = null;
        if (!retry && [...subs.values()].some((x) => x.size)) retry = setTimeout(() => ((retry = null), open()), o.reconnectMs ?? 5000);
      }
    };
  };
  const subscribe = (channel: string, cb: (v: unknown) => void) => {
    let set = subs.get(channel);
    if (!set) subs.set(channel, (set = new Set()));
    set.add(cb);
    open();
    return () => {
      set!.delete(cb);
      if (![...subs.values()].some((x) => x.size) && es) {
        es.close();
        es = null;
      }
    };
  };

  const api: Record<string, unknown> = {};
  for (const [name, channel] of Object.entries(IPC)) {
    if (EVENT_KEYS.has(name)) continue;
    api[name] = (...args: unknown[]) => call(channel, args);
  }
  // Fire-and-forget, never throws (it reports errors itself).
  api.log = (level: string, message: string) => void call(IPC.log, [level, message]).catch(() => {});
  for (const [name, channel] of Object.entries(EVENT_FOR)) api[name] = (cb: (v: unknown) => void) => subscribe(channel, cb);
  return api as unknown as MorphixApi;
}
