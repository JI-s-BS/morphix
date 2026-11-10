// Test harness for apps/server: the real router / RPC / SSE / static stack on 127.0.0.1:0,
// with a fake AuthProvider (token in an "mx_test" cookie) and a fake handler registry.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthProvider, AuthUser, RouteModule } from "@morphix/config";
import { CSRF_COOKIE, CSRF_HEADER } from "@morphix/shared";
import { createHttpApp, type HttpApp, type HttpAppOptions } from "../apps/server/src/http";
import { HandlerRegistry } from "../apps/server/src/registry";
import { parseCookies } from "../apps/server/src/router";

export const USERS: Record<string, AuthUser> = {
  "tok-user": { name: "sam", role: "user" },
  "tok-admin": { name: "alex", role: "admin" },
};

export class FakeAuth implements AuthProvider {
  open = false;
  async userFor(req: IncomingMessage): Promise<AuthUser | null> {
    return USERS[parseCookies(req.headers.cookie).mx_test ?? ""] ?? null;
  }
  async setupOpen(): Promise<boolean> {
    return this.open;
  }
}

export interface TestServer {
  url: string;
  host: string;
  app: HttpApp;
  auth: FakeAuth;
  registry: HandlerRegistry;
  close(): Promise<void>;
  /** A browser-like client: keeps cookies, sends Origin and the CSRF header. */
  client(token?: string): TestClient;
}

export interface TestClient {
  cookies: Map<string, string>;
  csrf(): Promise<string>;
  fetch(path: string, init?: RequestInit & { csrf?: boolean | string; origin?: string | null }): Promise<Response>;
  rpc(channel: string, args?: unknown[]): Promise<Response>;
}

export async function startTestServer(opts: Partial<HttpAppOptions> & { modules?: RouteModule | RouteModule[] } = {}): Promise<TestServer> {
  const auth = new FakeAuth();
  const registry = opts.registry ?? new HandlerRegistry();
  const app = createHttpApp({
    registry,
    auth: opts.auth ?? auth,
    secret: "test-secret-0123456789abcdef0123456789",
    version: "9.9.9-test",
    rendererDir: opts.rendererDir ?? "/nonexistent",
    storageRoot: opts.storageRoot ?? "/nonexistent",
    rateLimit: opts.rateLimit ?? { limit: 10_000, windowMs: 60_000 },
    heartbeatMs: opts.heartbeatMs ?? 60_000,
    ...opts,
  });
  const server: Server = createServer(app.handler);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  const host = `127.0.0.1:${port}`;
  const url = `http://${host}`;

  const client = (token?: string): TestClient => {
    const cookies = new Map<string, string>();
    if (token) cookies.set("mx_test", token);
    const header = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const remember = (r: Response) => {
      for (const c of r.headers.getSetCookie()) {
        const [kv] = c.split(";");
        const i = kv.indexOf("=");
        cookies.set(kv.slice(0, i), kv.slice(i + 1));
      }
    };
    const raw = async (path: string, init: RequestInit & { csrf?: boolean | string; origin?: string | null } = {}) => {
      const h = new Headers(init.headers);
      if (typeof init.csrf === "string") h.set(CSRF_HEADER, init.csrf);
      else if (init.csrf !== false && init.method && init.method !== "GET") h.set(CSRF_HEADER, await c.csrf());
      if (cookies.size) h.set("Cookie", header());
      if (init.origin !== null) h.set("Origin", init.origin ?? url);
      const r = await fetch(url + path, { ...init, headers: h, redirect: "manual" });
      remember(r);
      return r;
    };
    const c: TestClient = {
      cookies,
      async csrf() {
        if (!cookies.has(CSRF_COOKIE)) await raw("/api/session");
        return cookies.get(CSRF_COOKIE)!;
      },
      fetch: raw,
      rpc: (channel, args = []) => raw(`/api/rpc/${channel}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) }),
    };
    return c;
  };

  return {
    url, host, app, auth, registry, client,
    close: () =>
      new Promise((ok) => {
        app.closeStreams();
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

/** Reads Server-Sent Events from a fetch Response until `count` events arrived. */
export async function readEvents(r: Response, count: number, timeoutMs = 3000): Promise<{ event: string; data: unknown }[]> {
  const out: { event: string; data: unknown }[] = [];
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => void reader.cancel(), timeoutMs);
  try {
    while (out.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev && data) out.push({ event: ev, data: JSON.parse(data) });
      }
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  return out;
}
