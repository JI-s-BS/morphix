// The local website: router + RPC/SSE + setup routes + the UI and model library as static files.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthProvider, RouteModule } from "@morphix/config";
import type { HandlerRegistry } from "./registry";
import { MorphixRouter, mountRoutes, type RouterOptions } from "./router";
import { mountRpc } from "./rpc";
import { cleanPath, libraryFile, notFound, sendFile, serveRenderer } from "./static";
import { proxyCamera } from "./camera";

export interface HttpAppOptions {
  registry: HandlerRegistry;
  auth: AuthProvider;
  /** Signs CSRF tokens. */
  secret: string;
  version: string;
  /** Built UI (apps/desktop/dist/renderer). */
  rendererDir: string;
  /** Data dir root (Storage.root): /library/* files come from here. */
  storageRoot: string;
  /** The printer camera's own addresses (server-side only). */
  camera?: () => { stream: string | null; snapshot: string | null };
  /** Setup / auth routes (packages/config). */
  modules?: RouteModule | RouteModule[];
  secureCookies?: boolean;
  rateLimit?: RouterOptions["rateLimit"];
  maxBodyBytes?: number;
  maxStreams?: number;
  heartbeatMs?: number;
  log?: RouterOptions["log"];
  now?: () => number;
}

export interface HttpApp {
  router: MorphixRouter;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Ends open event streams (graceful shutdown). */
  closeStreams(): void;
}

export function createHttpApp(o: HttpAppOptions): HttpApp {
  const started = (o.now ?? Date.now)();
  const router = new MorphixRouter({
    auth: o.auth, secret: o.secret, secureCookies: o.secureCookies, rateLimit: o.rateLimit,
    maxBodyBytes: o.maxBodyBytes, log: o.log, now: o.now,
  });

  // Public, for the installer's doctor / update checks. No secrets, no config.
  router.add("GET", "/api/health", "public", (ctx) => {
    ctx.send(200, { ok: true, name: "morphix", version: o.version, uptimeS: Math.round(((o.now ?? Date.now)() - started) / 1000) });
  });
  // The CSRF token (also in the morphix_csrf cookie) and who is signed in.
  router.add("GET", "/api/session", "public", async (ctx) => {
    const csrfToken = router.csrfToken(ctx.req, ctx.res);
    // `csrf` is the name the setup page reads; `csrfToken` the HTTP client's.
    ctx.send(200, { csrf: csrfToken, csrfToken, user: ctx.user, setupOpen: await o.auth.setupOpen() });
  });
  router.add("GET", "/api/camera/stream", "user", (ctx) => proxyCamera(o.camera?.().stream ?? null, ctx.res));
  router.add("GET", "/api/camera/snapshot", "user", (ctx) => proxyCamera(o.camera?.().snapshot ?? null, ctx.res));
  router.add("GET", "/library/*", "user", (ctx) => sendLibrary(ctx.req, ctx.res, o.storageRoot));
  const rpc = mountRpc(router, o.registry, { auth: o.auth, maxStreams: o.maxStreams, heartbeatMs: o.heartbeatMs });
  mountRoutes(router, o.modules);

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        if (await router.handle(req, res)) return;
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" }).end("method not allowed");
          return;
        }
        const path = cleanPath(req.url);
        if (!path) return notFound(res);
        // index.html hands out the CSRF cookie, so the first RPC already has it.
        if (!serveRenderer(req, res, o.rendererDir, path, () => router.csrfToken(req, res))) notFound(res);
      } catch (e) {
        o.log?.("error", "request failed", { error: (e as Error).message });
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("server error");
        else res.destroy();
      }
    })();
  };
  return { router, handler, closeStreams: rpc.closeStreams };
}

function sendLibrary(req: IncomingMessage, res: ServerResponse, storageRoot: string): void {
  const path = cleanPath(req.url);
  const file = path ? libraryFile(storageRoot, path) : null;
  if (!file) return notFound(res);
  sendFile(req, res, file, "private, max-age=3600");
}
