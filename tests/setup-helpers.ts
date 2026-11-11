// Test helpers for packages/config: a temp data dir and a tiny Router that behaves like the
// server's (pattern params, Access check, JSON bodies, cookies). CSRF is the server's job and
// isn't modelled here.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { allowed, type Auth } from "@morphix/config";
import type { Access, RouteHandler, Router } from "@morphix/config";

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "morphix-setup-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function fakeReq(opts: { method?: string; cookie?: string; ip?: string; https?: boolean } = {}): IncomingMessage {
  return {
    method: opts.method ?? "GET",
    headers: opts.cookie ? { cookie: opts.cookie } : {},
    socket: { remoteAddress: opts.ip ?? "192.168.1.20", encrypted: opts.https ?? false },
  } as unknown as IncomingMessage;
}

export interface Reply { status: number; body: any; headers: Record<string, string> }

interface Route { method: string; re: RegExp; keys: string[]; access: Access; handler: RouteHandler }

export class TestRouter implements Router {
  routes: Route[] = [];
  /** Everything every response contained, to check no secret ever left the server. */
  transcript: string[] = [];

  constructor(private auth: Auth) {}

  add(method: "GET" | "POST" | "PUT" | "DELETE", pattern: string, access: Access, handler: RouteHandler): void {
    const keys: string[] = [];
    const re = new RegExp("^" + pattern.replace(/:([A-Za-z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    this.routes.push({ method, re, keys, access, handler });
  }

  async request(method: string, path: string, opts: { body?: unknown; rawBody?: string; cookie?: string; ip?: string; https?: boolean } = {}): Promise<Reply> {
    const url = new URL(path, "http://morphix.test");
    const req = fakeReq({ method, cookie: opts.cookie, ip: opts.ip, https: opts.https });
    const user = await this.auth.userFor(req);
    for (const r of this.routes) {
      const m = r.method === method ? r.re.exec(url.pathname) : null;
      if (!m) continue;
      // The server's access check; handlers re-check it themselves too.
      if (!(await allowed(r.access, user, this.auth.setupOpen))) return this.record({ status: user ? 403 : 401, body: { error: "denied by server" }, headers: {} });
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const raw = Buffer.from(opts.rawBody ?? (opts.body === undefined ? "" : JSON.stringify(opts.body)));
      let reply: Reply | null = null;
      await r.handler({
        req, res: {} as never, url, params, user,
        body: async () => raw,
        json: async <T,>() => JSON.parse(raw.toString("utf8") || "null") as T,
        send: (status, body, headers) => {
          reply = { status, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)), headers: headers ?? {} };
        },
      });
      if (!reply) throw new Error(`${method} ${path} sent no reply`);
      return this.record(reply);
    }
    return this.record({ status: 404, body: { error: "no route" }, headers: {} });
  }

  private record(r: Reply): Reply {
    this.transcript.push(JSON.stringify(r));
    return r;
  }
}

/** "morphix_session=abc; Path=/; HttpOnly" → "morphix_session=abc" */
export function cookieFrom(r: Reply): string {
  const c = r.headers["Set-Cookie"];
  if (!c) throw new Error("no Set-Cookie");
  return c.split(";")[0];
}
