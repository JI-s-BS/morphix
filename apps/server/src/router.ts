// The server's Router (contract: packages/config/src/types.ts). Every request goes through
// handle(): security headers, per-IP rate limit, route match, Access check (AuthProvider),
// same-origin + CSRF check for anything that isn't GET, size-limited body, JSON errors.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Access, AuthProvider, AuthUser, RouteContext, RouteHandler, RouteModule, Router } from "@morphix/config";
import { CSRF_COOKIE, CSRF_HEADER } from "@morphix/shared";
import { RateLimiter } from "./ratelimit";

type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface RouteOptions {
  /** Body limit for this route (default RouterOptions.maxBodyBytes). */
  maxBodyBytes?: number;
}

interface Route {
  method: Method;
  parts: string[];
  access: Access;
  handler: RouteHandler;
  maxBodyBytes: number;
}

export interface RouterOptions {
  auth: AuthProvider;
  /** Signs CSRF tokens (keep it stable across restarts so open tabs keep working). */
  secret: string;
  /** Default body limit (bytes). */
  maxBodyBytes?: number;
  /** Requests per IP per window (all /api routes). */
  rateLimit?: { limit: number; windowMs: number };
  /** Cookies get the Secure flag (HTTPS). */
  secureCookies?: boolean;
  log?: (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly hint?: string) {
    super(message);
  }
}

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    // React sets style attributes; no inline <style> or script is needed otherwise.
    "style-src 'self' 'unsafe-inline'",
    // https: for model-library preview pictures (og:image) shown in search results.
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "connect-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(self)",
};

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        /* skip malformed */
      }
    }
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function clientIp(req: IncomingMessage): string {
  // No proxy headers are trusted: Morphix is reached directly on the LAN.
  return req.socket.remoteAddress ?? "unknown";
}

export class MorphixRouter implements Router {
  private routes: Route[] = [];
  private limiter: RateLimiter;
  private maxBody: number;
  private log: NonNullable<RouterOptions["log"]>;

  constructor(private o: RouterOptions) {
    this.maxBody = o.maxBodyBytes ?? 1_000_000;
    const rl = o.rateLimit ?? { limit: 600, windowMs: 60_000 };
    this.limiter = new RateLimiter(rl.limit, rl.windowMs, o.now);
    this.log = o.log ?? (() => {});
  }

  add(method: Method, pattern: string, access: Access, handler: RouteHandler, opts: RouteOptions = {}): void {
    if (!pattern.startsWith("/")) throw new Error(`route pattern must start with /: ${pattern}`);
    this.routes.push({ method, parts: pattern.split("/").slice(1), access, handler, maxBodyBytes: opts.maxBodyBytes ?? this.maxBody });
  }

  // ---------------------------------------------------------------- CSRF ---
  /** A random value plus its HMAC, so a planted cookie from elsewhere is never accepted. */
  newCsrfToken(): string {
    const r = randomBytes(24).toString("base64url");
    return `${r}.${createHmac("sha256", this.o.secret).update(`csrf:${r}`).digest("base64url")}`;
  }

  validCsrfToken(t: string | undefined): t is string {
    if (!t || t.length > 200) return false;
    const [r, mac] = t.split(".");
    if (!r || !mac) return false;
    return safeEqual(mac, createHmac("sha256", this.o.secret).update(`csrf:${r}`).digest("base64url"));
  }

  /** The request's CSRF token, issuing a new cookie when it has none (or a bad one). */
  csrfToken(req: IncomingMessage, res?: ServerResponse): string {
    const have = parseCookies(req.headers.cookie)[CSRF_COOKIE];
    if (this.validCsrfToken(have)) return have;
    const t = (req as { __morphixCsrf?: string }).__morphixCsrf ?? this.newCsrfToken();
    (req as { __morphixCsrf?: string }).__morphixCsrf = t;
    if (res && !res.headersSent) {
      const cookie = `${CSRF_COOKIE}=${t}; Path=/; SameSite=Strict${this.o.secureCookies ? "; Secure" : ""}`;
      const prev = res.getHeader("Set-Cookie");
      res.setHeader("Set-Cookie", [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), cookie]);
    }
    return t;
  }

  private checkCsrf(req: IncomingMessage): void {
    const cookie = parseCookies(req.headers.cookie)[CSRF_COOKIE];
    const header = req.headers[CSRF_HEADER.toLowerCase()];
    const h = Array.isArray(header) ? header[0] : header;
    if (!this.validCsrfToken(cookie) || !h || !safeEqual(h, cookie)) {
      throw new HttpError(403, "csrf", "This request is missing its security token.", "Reload the page and try again.");
    }
  }

  private checkOrigin(req: IncomingMessage): void {
    const site = req.headers["sec-fetch-site"];
    if (site === "cross-site" || site === "same-site") throw new HttpError(403, "origin", "Requests from other websites are not allowed.");
    const origin = req.headers.origin;
    if (!origin) return; // non-browser client; the CSRF token is still required
    const host = req.headers.host;
    let ok = false;
    try {
      ok = !!host && new URL(origin).host === host;
    } catch {
      ok = false;
    }
    if (!ok) throw new HttpError(403, "origin", "Requests from other websites are not allowed.");
  }

  // -------------------------------------------------------------- access ---
  private async checkAccess(access: Access, user: AuthUser | null): Promise<void> {
    if (access === "public") return;
    if (access === "setup") {
      if (await this.o.auth.setupOpen()) return;
      if (user?.role === "admin") return;
      throw new HttpError(user ? 403 : 401, user ? "forbidden" : "unauthenticated", "Setup is finished. Sign in as the admin to change it.");
    }
    if (!user) {
      const open = await this.o.auth.setupOpen();
      throw new HttpError(401, open ? "setup_required" : "unauthenticated", open ? "Morphix isn't set up yet." : "Please sign in.", open ? "Open the setup page to create the admin account." : undefined);
    }
    if (access === "admin" && user.role !== "admin") throw new HttpError(403, "forbidden", "Only the admin can do that.");
  }

  // -------------------------------------------------------------- handle ---
  private match(method: string, pathname: string): { route: Route; params: Record<string, string> } | "method" | null {
    const segs = pathname.split("/").slice(1);
    let methodMismatch = false;
    for (const route of this.routes) {
      const wild = route.parts[route.parts.length - 1] === "*";
      if (wild ? segs.length < route.parts.length : route.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const p = route.parts[i];
        if (p === "*" && i === route.parts.length - 1) {
          // The rest of the path, still URL-encoded (the handler decodes and checks it).
          params["*"] = segs.slice(i).join("/");
          break;
        }
        if (p.startsWith(":")) {
          let v: string;
          try {
            v = decodeURIComponent(segs[i]);
          } catch {
            ok = false;
            break;
          }
          if (!v || v.includes("/") || v.includes("\0")) {
            ok = false;
            break;
          }
          params[p.slice(1)] = v;
        } else if (p !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method !== method && !(method === "HEAD" && route.method === "GET")) {
        methodMismatch = true;
        continue;
      }
      return { route, params };
    }
    return methodMismatch ? "method" : null;
  }

  /** Handles the request if a route matches; false lets the caller serve static files. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://morphix.local");
    } catch {
      sendJson(res, 400, { error: { code: "bad_url", message: "Bad address." } });
      return true;
    }
    const method = (req.method ?? "GET").toUpperCase();
    const found = this.match(method, url.pathname);
    if (!found) {
      if (url.pathname.startsWith("/api/")) {
        if (!this.limiter.hit(clientIp(req))) return this.tooMany(req, res);
        sendJson(res, 404, { error: { code: "not_found", message: "No such API route." } });
        return true;
      }
      return false;
    }
    if (!this.limiter.hit(clientIp(req))) return this.tooMany(req, res);
    if (found === "method") {
      sendJson(res, 405, { error: { code: "method", message: "Method not allowed." } });
      return true;
    }
    const { route, params } = found;
    let user: AuthUser | null = null;
    try {
      user = await this.o.auth.userFor(req);
      if (!SAFE_METHODS.has(method)) {
        this.checkOrigin(req);
        this.checkCsrf(req);
      }
      await this.checkAccess(route.access, user);
      let bodyP: Promise<Buffer> | null = null;
      const body = () => (bodyP ??= readBody(req, route.maxBodyBytes));
      const ctx: RouteContext = {
        req, res, url, params, user,
        body,
        json: async <T>() => {
          const b = await body();
          if (!b.length) return undefined as T;
          try {
            return JSON.parse(b.toString("utf8")) as T;
          } catch {
            throw new HttpError(400, "bad_json", "The request body isn't valid JSON.");
          }
        },
        send: (status, payload, headers) => send(res, status, payload, headers),
      };
      await route.handler(ctx);
      if (!res.headersSent && !res.writableEnded) send(res, 204);
    } catch (e) {
      this.fail(res, e, url.pathname);
    }
    return true;
  }

  private tooMany(req: IncomingMessage, res: ServerResponse): true {
    res.setHeader("Retry-After", String(this.limiter.retryAfterSec(clientIp(req))));
    sendJson(res, 429, { error: { code: "rate_limited", message: "Too many requests.", hint: "Wait a minute and try again." } });
    return true;
  }

  private fail(res: ServerResponse, e: unknown, path: string): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (e instanceof HttpError) {
      sendJson(res, e.status, { error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) } });
      return;
    }
    this.log("error", "route failed", { path, error: (e as Error)?.message });
    sendJson(res, 500, { error: { code: "internal", message: "Something went wrong on the Morphix server.", hint: "Check the server log (journalctl -u morphix)." } });
  }
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, "too_large", `The request is too large (limit ${limit} bytes).`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        req.resume();
        reject(new HttpError(413, "too_large", `The request is too large (limit ${limit} bytes).`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, body);
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  let data: Buffer | string | undefined;
  const h: Record<string, string> = { "Cache-Control": "no-store", ...headers };
  if (body === undefined || status === 204) data = undefined;
  else if (Buffer.isBuffer(body) || typeof body === "string") data = body;
  else {
    data = JSON.stringify(body);
    h["Content-Type"] ??= "application/json; charset=utf-8";
  }
  if (data !== undefined) h["Content-Length"] = String(Buffer.byteLength(data));
  res.writeHead(status, h);
  res.end(data);
}

/** Plugs RouteModules (setup / auth, packages/config) into the router. */
export function mountRoutes(router: Router, modules: RouteModule | RouteModule[] | undefined | null): void {
  for (const m of Array.isArray(modules) ? modules : modules ? [modules] : []) m(router);
}
