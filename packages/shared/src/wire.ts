// JSON wire format for the HTTP bridge (apps/server <-> apps/desktop/src/bridge.ts).
// Binary values (PCM audio, model files) travel as { "$bytes": "<base64>" } and come back as
// ArrayBuffer; everything else is plain JSON. Used for RPC args, results and SSE events.

const BYTES = "$bytes";

function toBase64(u8: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(a: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(u8).toString("base64");
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): ArrayBuffer {
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (B) {
    const b = B.from(b64, "base64");
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

/** Turns binary values into { $bytes } so the value survives JSON.stringify. */
export function encodeWire(v: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("value nested too deeply");
  if (v instanceof ArrayBuffer) return { [BYTES]: toBase64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) return { [BYTES]: toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (Array.isArray(v)) return v.map((x) => encodeWire(x, depth + 1));
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = encodeWire(x, depth + 1);
    return out;
  }
  return v;
}

/** Reverse of encodeWire: { $bytes } becomes an ArrayBuffer. */
export function decodeWire(v: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("value nested too deeply");
  if (Array.isArray(v)) return v.map((x) => decodeWire(x, depth + 1));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === BYTES && typeof o[BYTES] === "string") return fromBase64(o[BYTES] as string);
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = decodeWire(o[k], depth + 1);
    }
    return out;
  }
  return v;
}

/** Push-event channels, as the HTTP bridge streams them over GET /api/events (SSE `event:` names). */
export const EVENT_CHANNELS = ["events:generation", "events:printer", "events:voice", "events:app"] as const;
export type EventChannel = (typeof EVENT_CHANNELS)[number];

export const CSRF_HEADER = "X-Morphix-CSRF";
export const CSRF_COOKIE = "morphix_csrf";
