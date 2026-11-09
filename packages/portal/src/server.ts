// The Morphix web portal: Auth0 sign-in, JSON API, Server-Sent Events, uploads,
// a login-only camera proxy and the static child-friendly front-end.
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import type { AddressInfo } from "node:net";
import { isAdmin, isAllowed, type PortalAuthConfig, type PortalAuthSetup } from "./config";
import { OidcClient, OidcError } from "./oidc";
import { CookieSigner, LOGIN_COOKIE, SESSION_COOKIE, parseCookies, randomToken, safeEqual, serializeCookie, type LoginState, type SessionData } from "./session";
import { RateLimiter } from "./ratelimit";
import { MultipartError } from "./multipart";
import { UPLOAD_LIMITS, maxUploadBytes, parseUploadForm } from "./uploads";
import { parsePrinterCommand } from "./commands";
import { emailUnverifiedPage, loginProblemPage, notAllowedPage, setupPage } from "./pages";
import type { JobEvent, Log, PortalBackend, PortalFile, PortalUser } from "./types";

export interface PortalOptions {
  backend: PortalBackend;
  auth: PortalAuthSetup;
  host?: string;
  port?: number;
  tls?: { cert: string | Buffer; key: string | Buffer };
  /** Morphix storage root (~/Morphix). Files the portal streams must live inside it. */
  storageRoot: string;
  log?: Log;
  /** packages/portal/web. Default: found next to the repo checkout. */
  webRoot?: string;
  /** The `three` package directory (node_modules/three). */
  threeRoot?: string;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
  limits?: Partial<PortalLimits>;
}

export interface PortalLimits {
  loginPerMinute: number;
  uploadsPer10Min: number;
  apiPerMinute: number;
  commandsPerMinute: number;
  concurrentUploads: number;
  cameraViewers: number;
  sseConnections: number;
  sseHeartbeatMs: number;
}

const DEFAULT_LIMITS: PortalLimits = {
  loginPerMinute: 10,
  uploadsPer10Min: 10,
  apiPerMinute: 300,
  commandsPerMinute: 30,
  concurrentUploads: 2,
  cameraViewers: 3,
  sseConnections: 40,
  sseHeartbeatMs: 15_000,
};

export interface Portal {
  start(): Promise<{ url: string; port: number }>;
  stop(): Promise<void>;
  readonly server: Server;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
};

const FILE_MIME: Record<PortalFile["format"], string> = {
  stl: "model/stl",
  glb: "model/gltf-binary",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function firstExisting(paths: (string | undefined)[]): string | undefined {
  return paths.find((p): p is string => !!p && existsSync(p));
}

export function defaultWebRoot(): string {
  return (
    firstExisting([
      process.env.MORPHIX_PORTAL_WEB,
      typeof __dirname === "string" ? resolve(__dirname, "../web") : undefined,
      typeof __dirname === "string" ? resolve(__dirname, "../../../packages/portal/web") : undefined, // apps/desktop/dist bundle
      resolve(process.cwd(), "packages/portal/web"),
    ]) ?? resolve(process.cwd(), "packages/portal/web")
  );
}

export function defaultThreeRoot(): string {
  return (
    firstExisting([
      process.env.MORPHIX_PORTAL_THREE,
      typeof __dirname === "string" ? resolve(__dirname, "../../../node_modules/three") : undefined,
      resolve(process.cwd(), "node_modules/three"),
    ]) ?? resolve(process.cwd(), "node_modules/three")
  );
}

/** Resolve `rel` under `root`, refusing anything that escapes it (also through symlinks). */
export function safeResolve(root: string, rel: string): string | null {
  if (rel.includes("\0") || rel.includes("\\")) return null;
  const rootReal = (() => {
    try {
      return realpathSync(root);
    } catch {
      return null;
    }
  })();
  if (!rootReal) return null;
  const full = resolve(rootReal, "." + sep + rel);
  if (full !== rootReal && !full.startsWith(rootReal + sep)) return null;
  try {
    const real = realpathSync(full);
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Decode a URL path; null when it is malformed or tries to climb out ("..", NUL, backslash). */
export function cleanPath(rawUrl: string | undefined): { path: string; query: URLSearchParams } | null {
  const raw = rawUrl ?? "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  const q = raw.indexOf("?");
  const pathPart = q < 0 ? raw : raw.slice(0, q);
  let path: string;
  try {
    path = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  if (path.includes("\0") || path.includes("\\")) return null;
  if (path.split("/").some((seg) => seg === ".." || seg === ".")) return null;
  return { path, query: new URLSearchParams(q < 0 ? "" : raw.slice(q + 1)) };
}

export function createPortal(opts: PortalOptions): Portal {
  const log: Log = opts.log ?? (() => {});
  const backend = opts.backend;
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const webRoot = opts.webRoot ?? defaultWebRoot();
  const threeRoot = opts.threeRoot ?? defaultThreeRoot();
  const storageRoot = resolve(opts.storageRoot);
  const uploadDir = join(storageRoot, "portal", "uploads");
  const cfg: PortalAuthConfig | null = opts.auth.ok ? opts.auth.config : null;
  const secure = !!opts.tls || !!cfg?.baseUrl.startsWith("https://"); // Secure cookies whenever people use https
  const oidc = cfg ? new OidcClient(cfg, opts.fetch) : null;
  const sessionSigner = cfg ? new CookieSigner(cfg.sessionSecret, "session") : null;
  const loginSigner = cfg ? new CookieSigner(cfg.sessionSecret, "login") : null;
  const baseOrigin = cfg ? new URL(cfg.baseUrl).origin : null;
  const revoked = new Map<string, number>(); // sid -> exp

  const loginLimiter = new RateLimiter(limits.loginPerMinute, 60_000);
  const uploadLimiter = new RateLimiter(limits.uploadsPer10Min, 10 * 60_000);
  const apiLimiter = new RateLimiter(limits.apiPerMinute, 60_000);
  const commandLimiter = new RateLimiter(limits.commandsPerMinute, 60_000);
  let activeUploads = 0;
  let cameraViewers = 0;
  let sseCount = 0;
  const openStreams = new Set<() => void>();

  // The front-end's import map is the only inline script; allow exactly it by hash.
  let importMapHash = "";
  try {
    const html = readFileSync(join(webRoot, "index.html"), "utf8");
    const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
    if (m) importMapHash = `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`;
  } catch {
    log(`portal: no index.html in ${webRoot}`);
  }
  const csp = [
    "default-src 'self'",
    `script-src 'self'${importMapHash ? " " + importMapHash : ""}`,
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  function securityHeaders(res: ServerResponse): void {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=(), payment=(), usb=()");
    if (opts.tls) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }

  function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const data = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(data), ...headers });
    res.end(data);
  }

  function sendHtml(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(html), ...headers });
    res.end(html);
  }

  function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
    const headers: Record<string, string | string[]> = { Location: location, "Cache-Control": "no-store" };
    if (cookies.length) headers["Set-Cookie"] = cookies;
    res.writeHead(302, headers);
    res.end();
  }

  function sendFile(res: ServerResponse, path: string, type: string, cache: string): void {
    const size = statSync(path).size;
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Cache-Control": cache });
    pipeline(createReadStream(path), res, () => {});
  }

  function clientIp(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? "unknown";
  }

  function getSession(req: IncomingMessage): { session: SessionData; user: PortalUser } | null {
    if (!cfg || !sessionSigner) return null;
    const cookies = parseCookies(req.headers.cookie);
    const session = sessionSigner.verify<SessionData>(cookies[SESSION_COOKIE]);
    if (!session || revoked.has(session.sid)) return null;
    if (!isAllowed(cfg, session.email)) return null; // removed from the list since signing in
    return {
      session,
      user: { sub: session.sub, email: session.email, name: session.name, picture: session.picture, isAdmin: isAdmin(cfg, session.email) },
    };
  }

  function requireUser(req: IncomingMessage): { session: SessionData; user: PortalUser } {
    const s = getSession(req);
    if (!s) throw new HttpError(401, "login_required", "Please sign in");
    return s;
  }

  /** CSRF: double-submit token from /api/me in X-CSRF-Token, plus Origin / Sec-Fetch-Site checks. */
  function checkCsrf(req: IncomingMessage, session: SessionData): void {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== baseOrigin) throw new HttpError(403, "csrf", "Request from another site was blocked");
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") throw new HttpError(403, "csrf", "Request from another site was blocked");
    const token = req.headers["x-csrf-token"];
    if (typeof token !== "string" || !safeEqual(token, session.csrf)) throw new HttpError(403, "csrf", "Security check failed, please reload the page");
  }

  async function readJson(req: IncomingMessage, max = 16 * 1024): Promise<any> {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "json_required", "Expected JSON");
    if (Number(req.headers["content-length"] ?? 0) > max) throw new HttpError(413, "too_large", "Request is too big");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > max) throw new HttpError(413, "too_large", "Request is too big");
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "bad_json", "Request could not be read");
    }
  }

  function limit(limiter: RateLimiter, key: string, what: string): void {
    if (!limiter.hit(key)) throw new HttpError(429, "rate_limited", `Too many ${what}, please wait a little`, { "Retry-After": String(limiter.retryAfterSec(key)) });
  }

  function inStorage(file: PortalFile | null): string | null {
    if (!file || !(file.format in FILE_MIME)) return null;
    let real: string;
    let root: string;
    try {
      real = realpathSync(file.path);
      root = realpathSync(storageRoot);
    } catch {
      return null;
    }
    if (!real.startsWith(root + sep)) {
      log(`portal: refused file outside storage root`);
      return null;
    }
    const ext = extname(real).slice(1).toLowerCase().replace("jpeg", "jpg");
    if (ext !== file.format) return null;
    try {
      return statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  }

  // ---------- Auth routes ----------

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    limit(loginLimiter, clientIp(req), "sign-in attempts");
    let start;
    try {
      start = await oidc!.startLogin();
    } catch (err) {
      log(`portal: Auth0 discovery failed: ${(err as Error).message}`);
      return sendHtml(res, 502, loginProblemPage("Morphix couldn't reach the sign-in service. Is the internet working?"));
    }
    const state: LoginState = { state: start.state, nonce: start.nonce, verifier: start.verifier, exp: Math.floor(Date.now() / 1000) + 600 };
    redirect(res, start.url, [serializeCookie(LOGIN_COOKIE, loginSigner!.sign(state), { maxAge: 600, secure })]);
  }

  async function callback(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    limit(loginLimiter, clientIp(req), "sign-in attempts");
    const clearLogin = serializeCookie(LOGIN_COOKIE, "", { maxAge: 0, secure });
    const fail = (status: number, html: string) => sendHtml(res, status, html, { "Set-Cookie": clearLogin });
    if (query.get("error")) {
      log(`portal: Auth0 returned error ${query.get("error")?.slice(0, 60)}`);
      return fail(400, loginProblemPage("Sign-in was cancelled or refused."));
    }
    const ls = loginSigner!.verify<LoginState>(parseCookies(req.headers.cookie)[LOGIN_COOKIE]);
    const code = query.get("code");
    const state = query.get("state");
    if (!ls || !code || !state || !safeEqual(state, ls.state)) {
      log("portal: login rejected (missing or wrong state)");
      return fail(400, loginProblemPage("That sign-in link is old or was opened in another browser."));
    }
    let claims;
    try {
      claims = await oidc!.finishLogin(code, ls.verifier, ls.nonce);
    } catch (err) {
      log(`portal: login rejected (${err instanceof OidcError ? err.reason : "error"}: ${(err as Error).message})`);
      return fail(400, loginProblemPage("Morphix couldn't check who you are."));
    }
    const email = (claims.email ?? "").toLowerCase();
    if (!email || claims.email_verified !== true) return fail(403, emailUnverifiedPage());
    if (!isAllowed(cfg!, email)) {
      log(`portal: sign-in by an e-mail that is not on the allow-list`);
      return fail(403, notAllowedPage(email));
    }
    const now = Math.floor(Date.now() / 1000);
    const session: SessionData = {
      sid: randomToken(16),
      sub: claims.sub,
      email,
      name: (claims.name || claims.nickname || email.split("@")[0]).slice(0, 80),
      picture: typeof claims.picture === "string" && claims.picture.startsWith("https://") ? claims.picture.slice(0, 500) : undefined,
      csrf: randomToken(),
      iat: now,
      exp: now + Math.round((cfg!.sessionHours ?? 12) * 3600),
    };
    log(`portal: signed in ${isAdmin(cfg!, email) ? "(admin)" : ""}`.trim());
    redirect(res, "/", [clearLogin, serializeCookie(SESSION_COOKIE, sessionSigner!.sign(session), { maxAge: session.exp - now, secure })]);
  }

  async function logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const s = getSession(req);
    if (s) {
      checkCsrf(req, s.session);
      revoked.set(s.session.sid, s.session.exp);
      const now = Date.now() / 1000;
      for (const [sid, exp] of revoked) if (exp < now) revoked.delete(sid);
    }
    sendJson(res, 200, { url: await oidc!.logoutUrl() }, { "Set-Cookie": serializeCookie(SESSION_COOKIE, "", { maxAge: 0, secure }) });
  }

  // ---------- API ----------

  async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? "GET";
    const { session, user } = requireUser(req);
    limit(apiLimiter, user.sub, "requests");
    const mutating = method !== "GET" && method !== "HEAD";
    if (mutating) checkCsrf(req, session);
    let m: RegExpExecArray | null;
    const only = (allowed: string) => {
      if (method !== allowed && !(allowed === "GET" && method === "HEAD")) throw new HttpError(405, "method_not_allowed", "Method not allowed", { Allow: allowed });
    };
    const id = (raw: string) => {
      if (!ID_RE.test(raw)) throw new HttpError(404, "not_found", "Not found");
      return raw;
    };

    if (path === "/api/me") {
      only("GET");
      const extra = await backend.me(user);
      return sendJson(res, 200, { user: { email: user.email, name: user.name, picture: user.picture ?? null, isAdmin: user.isAdmin }, csrfToken: session.csrf, ...extra });
    }
    if (path === "/api/projects") {
      only("GET");
      return sendJson(res, 200, { projects: await backend.listProjects(user) });
    }
    if ((m = /^\/api\/projects\/([^/]+)$/.exec(path))) {
      only("GET");
      const p = await backend.getProject(id(m[1]), user);
      if (!p) throw new HttpError(404, "not_found", "That thing wasn't found");
      return sendJson(res, 200, { project: p });
    }
    if ((m = /^\/api\/(models|thumbnails)\/([^/]+)$/.exec(path))) {
      only("GET");
      const vid = id(m[2]);
      const file = m[1] === "models" ? await backend.modelFile(vid, user) : ((await backend.thumbnailFile?.(vid, user)) ?? null);
      const real = inStorage(file);
      if (!real || !file) throw new HttpError(404, "not_found", "File not found");
      if (m[1] === "models") res.setHeader("Content-Disposition", `inline; filename="morphix-${vid}.${file.format}"`);
      return sendFile(res, real, FILE_MIME[file.format], "private, max-age=300");
    }
    if (path === "/api/requests") {
      only("POST");
      return photoRequest(req, res, user);
    }
    if (path === "/api/text-requests") {
      only("POST");
      limit(uploadLimiter, user.sub, "requests");
      const body = await readJson(req);
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) throw new HttpError(400, "empty_prompt", "Tell Morphix what to make");
      if ([...prompt].length > UPLOAD_LIMITS.maxDescriptionChars) throw new HttpError(400, "prompt_too_long", "That's a bit long, please make it shorter");
      return sendJson(res, 202, await backend.createTextRequest(prompt, user));
    }
    if (path === "/api/actions") {
      only("GET");
      return sendJson(res, 200, { actions: await backend.pendingActions(user) });
    }
    if ((m = /^\/api\/actions\/([^/]+)\/(confirm|cancel)$/.exec(path))) {
      only("POST");
      const aid = id(m[1]);
      const action = (await backend.pendingActions(user)).find((a) => a.id === aid);
      if (!action) throw new HttpError(404, "not_found", "That question has already been answered");
      if (m[2] === "confirm") {
        if (action.kind === "print" && !user.isAdmin) throw new HttpError(403, "admins_only", "Only a grown-up can start a print");
        log(`portal: action ${action.kind} confirmed from the web`);
        return sendJson(res, 200, await backend.confirmAction(aid, user));
      }
      return sendJson(res, 200, await backend.cancelAction(aid, user));
    }
    if ((m = /^\/api\/jobs\/([^/]+)\/events$/.exec(path))) {
      only("GET");
      return jobEvents(req, res, id(m[1]), user);
    }
    if (path === "/api/printer") {
      only("GET");
      return sendJson(res, 200, { printer: await backend.printerStatus(user) });
    }
    if (path === "/api/printer/command") {
      only("POST");
      if (!user.isAdmin) throw new HttpError(403, "admins_only", "Only a grown-up can use the printer buttons");
      limit(commandLimiter, user.sub, "printer commands");
      const command = parsePrinterCommand(await readJson(req));
      if (!command) throw new HttpError(400, "bad_command", "Unknown printer command");
      log(`portal: printer command ${command.cmd}`);
      return sendJson(res, 200, await backend.printerCommand(command, user));
    }
    if (path === "/api/camera") {
      only("GET");
      return camera(req, res, user);
    }
    throw new HttpError(404, "not_found", "Not found");
  }

  async function photoRequest(req: IncomingMessage, res: ServerResponse, user: PortalUser): Promise<void> {
    limit(uploadLimiter, user.sub, "uploads");
    limit(uploadLimiter, "ip:" + clientIp(req), "uploads");
    if (Number(req.headers["content-length"] ?? 0) > maxUploadBytes()) {
      res.setHeader("Connection", "close");
      throw new HttpError(413, "too_large", "That's too much at once. Try fewer or smaller photos.");
    }
    if (activeUploads >= limits.concurrentUploads) throw new HttpError(503, "busy", "Morphix is busy with another upload, try again in a moment", { "Retry-After": "10" });
    activeUploads++;
    let scanPath: string | undefined;
    try {
      let form;
      try {
        form = await parseUploadForm(req as AsyncIterable<Buffer>, req.headers["content-type"], uploadDir);
      } catch (err) {
        if (err instanceof MultipartError) {
          req.resume(); // discard the rest of the body
          if (err.status === 413) res.setHeader("Connection", "close");
          throw new HttpError(err.status, err.code, err.message);
        }
        throw err;
      }
      scanPath = form.scan?.path;
      log(`portal: photo request (${form.images.length} photo(s)${form.scan ? ", 1 scan" : ""})`);
      const accepted = await backend.createPhotoRequest({ ...form, user });
      sendJson(res, 202, accepted);
    } finally {
      activeUploads--;
      if (scanPath) rmSync(scanPath, { force: true });
    }
  }

  function jobEvents(req: IncomingMessage, res: ServerResponse, jobId: string, user: PortalUser): void {
    if (sseCount >= limits.sseConnections) throw new HttpError(503, "busy", "Too many open progress screens");
    const early: JobEvent[] = [];
    let live = false;
    const write = (e: JobEvent) => {
      if (!live) return void early.push(e);
      res.write(`event: job\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const unsubscribe = backend.jobEvents(jobId, write, user);
    if (!unsubscribe) throw new HttpError(404, "not_found", "That job wasn't found");
    sseCount++;
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    live = true;
    for (const e of early) write(e);
    const beat = setInterval(() => res.write(": ping\n\n"), limits.sseHeartbeatMs);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      sseCount--;
      openStreams.delete(close);
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      res.end();
    };
    openStreams.add(close);
    req.on("close", close);
    res.on("error", close);
  }

  async function camera(req: IncomingMessage, res: ServerResponse, user: PortalUser): Promise<void> {
    if (cameraViewers >= limits.cameraViewers) throw new HttpError(503, "busy", "Too many people are watching the camera");
    cameraViewers++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        cameraViewers--;
      }
    };
    let cam;
    try {
      cam = await backend.cameraStream(user);
    } catch (err) {
      release();
      throw err;
    }
    if (!cam) {
      release();
      throw new HttpError(503, "camera_unavailable", "The camera isn't available right now");
    }
    const type = /^(multipart\/x-mixed-replace|image\/jpeg)/i.test(cam.contentType) ? cam.contentType : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", Connection: "close" });
    const stream = cam.stream;
    const stop = () => {
      release();
      openStreams.delete(stop);
      stream.destroy();
      if (!res.writableEnded) res.end();
    };
    openStreams.add(stop);
    req.on("close", stop);
    pipeline(stream, res, stop);
  }

  // ---------- Static ----------

  function staticRoute(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let file: string | null = null;
    let cache = "no-cache";
    if (path === "/" || path === "/index.html") {
      if (!cfg) return false; // setup page instead
      file = safeResolve(webRoot, "index.html");
    } else if (path.startsWith("/static/")) {
      file = safeResolve(webRoot, path.slice("/static/".length));
    } else if (path === "/vendor/three/three.module.js" || path === "/vendor/three/three.module.min.js") {
      file = safeResolve(join(threeRoot, "build"), path.slice("/vendor/three/".length));
      cache = "public, max-age=86400";
    } else if (path.startsWith("/vendor/three-addons/") && path.endsWith(".js")) {
      file = safeResolve(join(threeRoot, "examples", "jsm"), path.slice("/vendor/three-addons/".length));
      cache = "public, max-age=86400";
    } else if (path === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return true;
    } else return false;
    const type = file ? MIME[extname(file).toLowerCase()] : undefined;
    if (!file || !type) {
      sendJson(res, 404, { error: "not_found", message: "Not found" });
      return true;
    }
    sendFile(res, file, type, cache);
    return true;
  }

  // ---------- Dispatcher ----------

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    securityHeaders(res);
    const parsed = cleanPath(req.url);
    if (!parsed) return sendJson(res, 400, { error: "bad_path", message: "Bad address" });
    const { path, query } = parsed;
    try {
      if (path === "/healthz") return sendJson(res, 200, { ok: true });
      if (staticRoute(req, res, path)) return;
      if (!cfg) {
        if (path.startsWith("/api/")) return sendJson(res, 503, { error: "not_configured", message: "Sign-in is not set up yet" });
        const setup = opts.auth.ok ? { missing: [], problems: [] } : opts.auth;
        return sendHtml(res, 503, setupPage(setup.missing, setup.problems));
      }
      if (path === "/login" && req.method === "GET") return await login(req, res);
      if (path === "/callback" && req.method === "GET") return await callback(req, res, query);
      if (path === "/logout" && req.method === "POST") return await logout(req, res);
      if (path.startsWith("/api/")) return await api(req, res, path);
      // Front-end routes are hash-based; anything else is unknown.
      return sendJson(res, 404, { error: "not_found", message: "Not found" });
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.code, message: err.message }, err.headers);
      log(`portal: ${req.method} ${path} failed: ${(err as Error)?.message ?? err}`);
      return sendJson(res, 500, { error: "internal", message: "Something went wrong" });
    }
  }

  const listener = (req: IncomingMessage, res: ServerResponse) => void handle(req, res);
  const server: Server = opts.tls ? createHttpsServer({ cert: opts.tls.cert, key: opts.tls.key }, listener) : createHttpServer(listener);
  server.headersTimeout = 15_000;
  server.requestTimeout = 15 * 60_000; // slow phone uploads
  server.keepAliveTimeout = 10_000;

  return {
    server,
    start() {
      return new Promise((resolveStart, reject) => {
        server.once("error", reject);
        server.listen(opts.port ?? 8443, opts.host ?? "0.0.0.0", () => {
          server.off("error", reject);
          const port = (server.address() as AddressInfo).port;
          log(`portal: listening on ${opts.tls ? "https" : "http"}://${opts.host ?? "0.0.0.0"}:${port}${cfg ? "" : " (setup needed: Auth0 not configured)"}`);
          resolveStart({ url: cfg?.baseUrl ?? `${opts.tls ? "https" : "http"}://localhost:${port}`, port });
        });
      });
    },
    stop() {
      for (const close of [...openStreams]) close();
      return new Promise((resolveStop) => {
        server.close(() => resolveStop());
        server.closeAllConnections();
      });
    },
  };
}
