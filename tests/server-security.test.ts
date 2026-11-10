// Router security: CSRF, same-origin, Access (public / setup / user / admin), body limits,
// rate limit, security headers, JSON errors, health, and mounting setup RouteModules.
import { afterEach, describe, expect, it } from "vitest";
import { CSRF_COOKIE, CSRF_HEADER, IPC } from "@morphix/shared";
import type { RouteModule } from "@morphix/config";
import { HandlerRegistry } from "../apps/server/src/registry";
import { MorphixRouter, mountRoutes } from "../apps/server/src/router";
import { startTestServer, type TestServer } from "./server-helpers";

let s: TestServer | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

const withJobs = () => {
  const r = new HandlerRegistry();
  r.handle(IPC.jobs, () => ["job"]);
  return r;
};

describe("CSRF", () => {
  it("hands out a signed token in a readable cookie and from /api/session", async () => {
    s = await startTestServer();
    const c = s.client();
    const r = await c.fetch("/api/session");
    const j = await r.json();
    const cookie = r.headers.getSetCookie().find((x) => x.startsWith(`${CSRF_COOKIE}=`))!;
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toMatch(/HttpOnly/); // the page must read it
    expect(j.csrfToken).toBe(c.cookies.get(CSRF_COOKIE));
    expect(j.csrf).toBe(j.csrfToken); // the setup page reads `csrf`
    expect(j).toMatchObject({ user: null, setupOpen: false });
    // The same browser keeps its token.
    expect((await (await c.fetch("/api/session")).json()).csrfToken).toBe(j.csrfToken);
  });

  it("rejects POSTs without the header, with a wrong one, or with a forged cookie", async () => {
    s = await startTestServer({ registry: withJobs() });
    const c = s.client("tok-user");
    const token = await c.csrf();
    expect((await c.fetch(`/api/rpc/${IPC.jobs}`, { method: "POST", body: "[]", csrf: false })).status).toBe(403);
    expect((await c.fetch(`/api/rpc/${IPC.jobs}`, { method: "POST", body: "[]", csrf: token.slice(0, -2) + "xx" })).status).toBe(403);
    // A cookie planted by someone else (not signed by this server) never works, even if header == cookie.
    c.cookies.set(CSRF_COOKIE, "forged.value");
    const forged = await c.fetch(`/api/rpc/${IPC.jobs}`, { method: "POST", body: "[]", csrf: "forged.value" });
    expect(forged.status).toBe(403);
    expect((await forged.json()).error.code).toBe("csrf");
    c.cookies.set(CSRF_COOKIE, token);
    expect((await c.fetch(`/api/rpc/${IPC.jobs}`, { method: "POST", body: "[]", csrf: token })).status).toBe(200);
  });

  it("does not accept a token signed with another server's secret", async () => {
    const other = new MorphixRouter({ auth: { userFor: async () => null, setupOpen: async () => false }, secret: "another-secret-another-secret-xx" });
    s = await startTestServer({ registry: withJobs() });
    const c = s.client("tok-user");
    const t = other.newCsrfToken();
    c.cookies.set(CSRF_COOKIE, t);
    expect((await c.fetch(`/api/rpc/${IPC.jobs}`, { method: "POST", body: "[]", csrf: t })).status).toBe(403);
  });
});

describe("same-origin", () => {
  it("rejects requests from another website", async () => {
    s = await startTestServer({ registry: withJobs() });
    const c = s.client("tok-user");
    const evil = await c.fetch(`/api/rpc/${IPC.jobs}`, { method: "POST", body: "[]", origin: "http://evil.example" });
    expect(evil.status).toBe(403);
    expect((await evil.json()).error.code).toBe("origin");
    const site = await c.fetch(`/api/rpc/${IPC.jobs}`, { method: "POST", body: "[]", headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(site.status).toBe(403);
    expect((await c.fetch(`/api/rpc/${IPC.jobs}`, { method: "POST", body: "[]" })).status).toBe(200);
  });
});

describe("access control", () => {
  const module: RouteModule = (router) => {
    router.add("GET", "/api/test/public", "public", (ctx) => ctx.send(200, { ok: true }));
    router.add("GET", "/api/test/user", "user", (ctx) => ctx.send(200, { user: ctx.user }));
    router.add("POST", "/api/test/admin/:id", "admin", async (ctx) => ctx.send(200, { id: ctx.params.id, body: await ctx.json() }));
    router.add("POST", "/api/test/setup", "setup", (ctx) => ctx.send(200, { ok: true }));
  };

  it("enforces public / user / admin with the injected AuthProvider", async () => {
    s = await startTestServer({ modules: module });
    const anon = s.client();
    const user = s.client("tok-user");
    const admin = s.client("tok-admin");
    expect((await anon.fetch("/api/test/public")).status).toBe(200);
    const denied = await anon.fetch("/api/test/user");
    expect(denied.status).toBe(401);
    expect((await denied.json()).error.code).toBe("unauthenticated");
    expect(await (await user.fetch("/api/test/user")).json()).toEqual({ user: { name: "sam", role: "user" } });
    expect((await user.fetch("/api/test/admin/p1", { method: "POST", body: "{}" })).status).toBe(403);
    const ok = await admin.fetch("/api/test/admin/p%201", { method: "POST", body: '{"x":1}' });
    expect(await ok.json()).toEqual({ id: "p 1", body: { x: 1 } });
  });

  it("RPC needs a signed-in user; before setup the error says so", async () => {
    s = await startTestServer({ registry: withJobs() });
    const anon = s.client();
    expect((await anon.rpc(IPC.jobs)).status).toBe(401);
    s.auth.open = true;
    const r = await anon.rpc(IPC.jobs);
    expect(r.status).toBe(401);
    expect((await r.json()).error).toMatchObject({ code: "setup_required" });
  });

  it("setup routes are open on first run, admin-only afterwards", async () => {
    s = await startTestServer({ modules: [module] });
    s.auth.open = true;
    expect((await s.client().fetch("/api/test/setup", { method: "POST" })).status).toBe(200);
    s.auth.open = false;
    expect((await s.client().fetch("/api/test/setup", { method: "POST" })).status).toBe(401);
    expect((await s.client("tok-user").fetch("/api/test/setup", { method: "POST" })).status).toBe(403);
    expect((await s.client("tok-admin").fetch("/api/test/setup", { method: "POST" })).status).toBe(200);
  });

  it("mountRoutes accepts one module, a list, or nothing", () => {
    const added: string[] = [];
    const router = { add: (_m: string, p: string) => void added.push(p) };
    mountRoutes(router, module);
    mountRoutes(router, [module, module]);
    mountRoutes(router, undefined);
    expect(added).toHaveLength(12);
  });

  it("answers JSON 404 / 405 for API paths", async () => {
    s = await startTestServer({ modules: module });
    const c = s.client("tok-admin");
    const nf = await c.fetch("/api/nothing-here");
    expect(nf.status).toBe(404);
    expect((await nf.json()).error.code).toBe("not_found");
    expect((await c.fetch("/api/test/public", { method: "DELETE" })).status).toBe(405);
  });
});

describe("limits", () => {
  it("refuses bodies over the limit with 413", async () => {
    s = await startTestServer({ registry: withJobs() });
    const c = s.client("tok-user");
    const big = await c.fetch(`/api/rpc/${IPC.jobs}`, { method: "POST", body: JSON.stringify(["x".repeat(300_000)]) });
    expect(big.status).toBe(413);
    expect((await big.json()).error.code).toBe("too_large");
  });

  it("rate-limits each IP and says when to come back", async () => {
    s = await startTestServer({ rateLimit: { limit: 3, windowMs: 60_000 } });
    const c = s.client();
    for (let i = 0; i < 3; i++) expect((await c.fetch("/api/health")).status).toBe(200);
    const r = await c.fetch("/api/health");
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await r.json()).error.code).toBe("rate_limited");
  });
});

describe("headers and health", () => {
  it("sends the security headers on every response", async () => {
    s = await startTestServer();
    for (const path of ["/api/health", "/api/nope", "/"]) {
      const r = await s.client().fetch(path);
      expect(r.headers.get("content-security-policy")).toMatch(/default-src 'self'.*frame-ancestors 'none'/);
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("GET /api/health is public and shows only version, uptime and ok", async () => {
    s = await startTestServer();
    const r = await s.client().fetch("/api/health");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Object.keys(j).sort()).toEqual(["name", "ok", "uptimeS", "version"]);
    expect(j).toMatchObject({ ok: true, name: "morphix", version: "9.9.9-test" });
  });

  it("the CSRF header name is the one the client sends", () => {
    expect(CSRF_HEADER).toBe("X-Morphix-CSRF");
  });
});
