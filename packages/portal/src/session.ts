// Signed cookies (HMAC-SHA256) for the session and the short-lived login state.
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "mx_session";
export const LOGIN_COOKIE = "mx_login";

export function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Signs and verifies small JSON payloads. Separate keys per purpose so cookies can't be swapped. */
export class CookieSigner {
  private readonly key: Buffer;

  constructor(secret: string, purpose: string) {
    this.key = Buffer.from(hkdfSync("sha256", secret, "morphix-portal", purpose, 32));
  }

  sign(payload: object): string {
    const body = b64url(Buffer.from(JSON.stringify(payload)));
    return `${body}.${b64url(createHmac("sha256", this.key).update(body).digest())}`;
  }

  /** Returns the payload when the signature is valid and `exp` (seconds) is in the future. */
  verify<T extends { exp: number }>(value: string | undefined, nowSec = Date.now() / 1000): T | null {
    if (!value || value.length > 4096) return null;
    const dot = value.indexOf(".");
    if (dot <= 0) return null;
    const body = value.slice(0, dot);
    const mac = b64url(createHmac("sha256", this.key).update(body).digest());
    if (!safeEqual(mac, value.slice(dot + 1))) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
      if (typeof payload.exp !== "number" || payload.exp <= nowSec) return null;
      return payload;
    } catch {
      return null;
    }
  }
}

export interface SessionData {
  sid: string;
  sub: string;
  email: string;
  name: string;
  picture?: string;
  csrf: string;
  iat: number;
  exp: number;
}

export interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
  exp: number;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!(name in out)) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

export function serializeCookie(name: string, value: string, opts: { maxAge: number; secure: boolean; path?: string }): string {
  const parts = [`${name}=${value}`, `Path=${opts.path ?? "/"}`, `Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`, "HttpOnly", "SameSite=Lax"];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}
