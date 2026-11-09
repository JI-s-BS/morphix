import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPortal, FakeBackend, loadPortalAuthConfig, OidcClient, CookieSigner, parseEmailList, serializeCookie } from "@morphix/portal";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, freePort, loginFlow, signIn, startHarness, WEB_ROOT, THREE_ROOT, type Harness } from "./portal-helpers";

describe("portal config", () => {
  it("reports missing variables and weak secrets", () => {
    const r = loadPortalAuthConfig({ AUTH0_DOMAIN: "x.auth0.com", PORTAL_SESSION_SECRET: "short" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(["AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "PORTAL_BASE_URL"]);
    expect(r.problems.join(" ")).toMatch(/32 characters/);
  });

  it("parses a full config and normalises e-mail lists", () => {
    const r = loadPortalAuthConfig({
      AUTH0_DOMAIN: "https://dev-abc.us.auth0.com/",
      AUTH0_CLIENT_ID: "id",
      AUTH0_CLIENT_SECRET: "secret",
      PORTAL_BASE_URL: "http://192.168.86.38:8443/",
      PORTAL_SESSION_SECRET: "a".repeat(40),
      AUTH0_ALLOWED_EMAILS: "Kid@Example.com, mum@example.com,,",
      AUTH0_ADMIN_EMAILS: "mum@example.com",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.domain).toBe("dev-abc.us.auth0.com");
    expect(r.config.baseUrl).toBe("http://192.168.86.38:8443");
    expect(r.config.allowedEmails).toEqual(["kid@example.com", "mum@example.com"]);
    expect(parseEmailList("")).toEqual([]);
  });

  it("marks cookies Secure only when TLS is on", () => {
    expect(serializeCookie("a", "b", { maxAge: 60, secure: true })).toBe("a=b; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure");
    expect(serializeCookie("a", "b", { maxAge: 60, secure: false })).not.toContain("Secure");
  });

  it("rejects a base URL with a path", () => {
    const r = loadPortalAuthConfig({ AUTH0_DOMAIN: "a.auth0.com", AUTH0_CLIENT_ID: "i", AUTH0_CLIENT_SECRET: "s", PORTAL_BASE_URL: "http://x:1/portal", PORTAL_SESSION_SECRET: "b".repeat(32) });
    expect(r.ok).toBe(false);
  });
});

describe("portal without Auth0", () => {
  it("shows a setup page and refuses every API call", async () => {
    const port = await freePort();
    const storageRoot = mkdtempSync(join(tmpdir(), "portal-setup-"));
    const portal = createPortal({
      backend: new FakeBackend({ storageRoot, tickMs: 0 }),
      auth: loadPortalAuthConfig({}),
      host: "127.0.0.1",
      port,
      storageRoot,
      webRoot: WEB_ROOT,
      threeRoot: THREE_ROOT,
    });
    await portal.start();
    try {
      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(page.status).toBe(503);
      const html = await page.text();
      expect(html).toContain("AUTH0_DOMAIN");
      expect(html).toContain("morphix.env");
      for (const path of ["/api/me", "/api/projects", "/api/camera", "/api/printer"]) {
        const r = await fetch(`http://127.0.0.1:${port}${path}`);
        expect(r.status).toBe(503);
        expect((await r.json()).error).toBe("not_configured");
      }
      expect((await fetch(`http://127.0.0.1:${port}/login`)).status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${port}/static/style.css`)).status).toBe(200);
    } finally {
      await portal.stop();
    }
  });
});

describe("Auth0 login flow", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness({ allowed: ["kid@example.com"], admins: ["parent@example.com"] });
  });
  afterEach(async () => h.close());

  it("redirects to the authorize endpoint with PKCE, state and nonce", async () => {
    const client = new Client(h.base);
    const res = await client.req("/login");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(`${h.oidc.base}/authorize`);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.get("state")!.length).toBeGreaterThan(20);
    expect(loc.searchParams.get("nonce")!.length).toBeGreaterThan(20);
    expect(loc.searchParams.get("redirect_uri")).toBe(`${h.base}/callback`);
    expect(loc.searchParams.get("scope")).toBe("openid profile email");
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("mx_login="))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/Secure/); // plain http on the LAN
  });

  it("signs in a valid, allowed user and sets a signed session cookie", async () => {
    const client = new Client(h.base);
    const res = await loginFlow(h, client);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("mx_session="))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(client.cookies.has("mx_login")).toBe(false);
    const me = await (await client.req("/api/me")).json();
    expect(me.user).toMatchObject({ email: "kid@example.com", isAdmin: false });
    expect(me.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("rejects a callback with the wrong state", async () => {
    const client = new Client(h.base);
    const res = await loginFlow(h, client, (cb) => cb.searchParams.set("state", "attacker-state"));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("sign-in link is old");
    expect(client.cookies.has("mx_session")).toBe(false);
  });

  it("rejects a callback without the login cookie (login CSRF)", async () => {
    const client = new Client(h.base);
    const start = await client.req("/login");
    const authorize = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const cb = new URL(authorize.headers.get("location")!);
    const victim = new Client(h.base); // never started a login
    const res = await victim.req(cb.pathname + cb.search);
    expect(res.status).toBe(400);
    expect(victim.cookies.has("mx_session")).toBe(false);
  });

  it("rejects an ID token with a bad nonce", async () => {
    h.oidc.overrides = { nonce: "not-the-nonce" };
    const client = new Client(h.base);
    const res = await loginFlow(h, client);
    expect(res.status).toBe(400);
    expect(client.cookies.has("mx_session")).toBe(false);
    expect(h.logs.join("\n")).toMatch(/bad_nonce/);
  });

  it("rejects an expired ID token", async () => {
    h.oidc.overrides = { exp: Math.floor(Date.now() / 1000) - 3600 };
    const res = await loginFlow(h, new Client(h.base));
    expect(res.status).toBe(400);
    expect(h.logs.join("\n")).toMatch(/expired/);
  });

  it("rejects an ID token for another audience", async () => {
    h.oidc.overrides = { aud: "some-other-app" };
    const res = await loginFlow(h, new Client(h.base));
    expect(res.status).toBe(400);
    expect(h.logs.join("\n")).toMatch(/bad_audience/);
  });

  it("rejects an ID token from the wrong issuer", async () => {
    h.oidc.overrides = { iss: "https://evil.example.com/" };
    const res = await loginFlow(h, new Client(h.base));
    expect(res.status).toBe(400);
    expect(h.logs.join("\n")).toMatch(/bad_issuer/);
  });

  it("rejects an ID token signed with a key that is not in the JWKS", async () => {
    h.oidc.overrides = { foreignKey: true };
    const res = await loginFlow(h, new Client(h.base));
    expect(res.status).toBe(400);
    expect(h.logs.join("\n")).toMatch(/bad_signature/);
  });

  it("refuses e-mails that are not on the allow-list and explains how to add them", async () => {
    h.oidc.email = "stranger@example.com";
    const client = new Client(h.base);
    const res = await loginFlow(h, client);
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("not on the list");
    expect(html).toContain("AUTH0_ALLOWED_EMAILS");
    expect(html).toContain("stranger@example.com");
    expect(client.cookies.has("mx_session")).toBe(false);
  });

  it("refuses unverified e-mail addresses", async () => {
    h.oidc.overrides = { email_verified: false };
    const res = await loginFlow(h, new Client(h.base));
    expect(res.status).toBe(403);
  });

  it("lets admins in even when they are not in the allowed list", async () => {
    const { client } = await signIn(h, "parent@example.com");
    const me = await (await client.req("/api/me")).json();
    expect(me.user.isAdmin).toBe(true);
  });

  it("logs out: clears the cookie, revokes the session and points at Auth0 /v2/logout", async () => {
    const { client, csrf } = await signIn(h);
    const stolen = client.cookies.get("mx_session")!;
    expect((await client.req("/logout", { method: "POST" })).status).toBe(403); // CSRF token needed
    const res = await client.req("/logout", { method: "POST", headers: { "x-csrf-token": csrf } });
    expect(res.status).toBe(200);
    const { url } = await res.json();
    const u = new URL(url);
    expect(u.pathname).toBe("/v2/logout");
    expect(u.searchParams.get("client_id")).toBe("client-123");
    expect(u.searchParams.get("returnTo")).toBe(`${h.base}/`);
    expect(client.cookies.has("mx_session")).toBe(false);
    const replay = await fetch(`${h.base}/api/me`, { headers: { cookie: `mx_session=${stolen}` } });
    expect(replay.status).toBe(401);
  });

  it("rejects tampered or foreign session cookies", async () => {
    const { client } = await signIn(h);
    const value = client.cookies.get("mx_session")!;
    const [body, mac] = value.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    payload.email = "parent@example.com";
    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${mac}`;
    expect((await fetch(`${h.base}/api/me`, { headers: { cookie: `mx_session=${forged}` } })).status).toBe(401);
    // Signed with another secret
    const other = new CookieSigner("another-secret-another-secret-123", "session").sign(payload);
    expect((await fetch(`${h.base}/api/me`, { headers: { cookie: `mx_session=${other}` } })).status).toBe(401);
    // The login-state signer can't mint sessions
    const crossPurpose = new CookieSigner(h.cfg.sessionSecret, "login").sign({ ...payload });
    expect((await fetch(`${h.base}/api/me`, { headers: { cookie: `mx_session=${crossPurpose}` } })).status).toBe(401);
  });

  it("drops sessions of people removed from the allow-list", async () => {
    const { client } = await signIn(h);
    h.cfg.allowedEmails.length = 0; // simulates editing morphix.env and restarting
    expect((await client.req("/api/me")).status).toBe(401);
  });

  it("rate-limits sign-in attempts", async () => {
    await h.close();
    h = await startHarness({ limits: { loginPerMinute: 3 } });
    const client = new Client(h.base);
    for (let i = 0; i < 3; i++) expect((await client.req("/login")).status).toBe(302);
    const res = await client.req("/login");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

describe("ID token verification", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => h.close());

  const claims = (over: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return { iss: h.oidc.issuer, sub: "auth0|1", aud: "client-123", iat: now, exp: now + 600, nonce: "n1", email: "kid@example.com", email_verified: true, ...over };
  };

  it("accepts a good token and caches the JWKS", async () => {
    const client = new OidcClient(h.cfg);
    await client.verifyIdToken(h.oidc.makeIdToken(claims()), "n1");
    await client.verifyIdToken(h.oidc.makeIdToken(claims()), "n1");
    expect(h.oidc.hits.get("/.well-known/jwks.json")).toBe(1);
  });

  it("rejects alg=none and HS256 tokens", async () => {
    const client = new OidcClient(h.cfg);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${enc({ alg: "none", kid: h.oidc.kid })}.${enc(claims())}.`;
    await expect(client.verifyIdToken(none, "n1")).rejects.toMatchObject({ reason: "bad_alg" });
    await expect(client.verifyIdToken(h.oidc.makeIdToken(claims(), { alg: "HS256" }), "n1")).rejects.toMatchObject({ reason: "bad_alg" });
  });

  it("rejects an unknown key id without hammering the JWKS endpoint", async () => {
    const client = new OidcClient(h.cfg);
    await client.verifyIdToken(h.oidc.makeIdToken(claims()), "n1");
    await expect(client.verifyIdToken(h.oidc.makeIdToken(claims(), { kid: "nope" }), "n1")).rejects.toMatchObject({ reason: "unknown_key" });
    await expect(client.verifyIdToken(h.oidc.makeIdToken(claims(), { kid: "nope" }), "n1")).rejects.toMatchObject({ reason: "unknown_key" });
    expect(h.oidc.hits.get("/.well-known/jwks.json")).toBe(1);
  });

  it("requires azp when there are several audiences", async () => {
    const client = new OidcClient(h.cfg);
    await expect(client.verifyIdToken(h.oidc.makeIdToken(claims({ aud: ["client-123", "api"] })), "n1")).rejects.toMatchObject({ reason: "bad_audience" });
    await client.verifyIdToken(h.oidc.makeIdToken(claims({ aud: ["client-123", "api"], azp: "client-123" })), "n1");
  });

  it("rejects tokens issued in the future and malformed tokens", async () => {
    const client = new OidcClient(h.cfg);
    await expect(client.verifyIdToken(h.oidc.makeIdToken(claims({ iat: Math.floor(Date.now() / 1000) + 3600 })), "n1")).rejects.toMatchObject({ reason: "future" });
    await expect(client.verifyIdToken("abc.def", "n1")).rejects.toMatchObject({ reason: "malformed" });
  });

  it("refuses a discovery document for another issuer", async () => {
    const client = new OidcClient({ ...h.cfg, issuerBaseUrl: h.oidc.base + "/other" });
    await expect(client.getDiscovery()).rejects.toThrow();
  });
});
