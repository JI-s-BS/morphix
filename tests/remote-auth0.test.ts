// Phone "Sign in with Auth0" on the Pi's Remote API (packages/remote/src/auth0.ts, docs/REMOTE.md).
// A test RSA key signs ID tokens; discovery + JWKS come from an injected fetch. No network.
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@morphix/storage";
import { FakeBackend } from "@morphix/portal";
import { MorphixRemote, type RemoteAuth0Options } from "@morphix/remote";

const ORIGIN = "https://morphix.example";
const ISSUER = "https://tenant.example.auth0.com/";
const CLIENT_ID = "phone-spa-client";
const KID = "test-key-1";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

const fakeAuth0: typeof fetch = async (input) => {
  const url = String(input);
  if (url === `${ISSUER}.well-known/openid-configuration`) {
    return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}authorize`, token_endpoint: `${ISSUER}oauth/token`, jwks_uri: `${ISSUER}.well-known/jwks.json` });
  }
  if (url === `${ISSUER}.well-known/jwks.json`) {
    return Response.json({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" }] });
  }
  return new Response("not found", { status: 404 });
};

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function idToken(claims: Record<string, unknown>, opts: { key?: KeyObject; alg?: string; kid?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? KID });
  const body = b64({ iss: ISSUER, sub: "auth0|kid", aud: CLIENT_ID, iat: now, exp: now + 3600, email: "kid@example.com", email_verified: true, ...claims });
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), opts.key ?? keys.privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

const roots: string[] = [];
const remotes: MorphixRemote[] = [];
afterEach(async () => {
  await Promise.all(remotes.splice(0).map((r) => r.stop()));
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});

async function startRemote(auth0?: RemoteAuth0Options) {
  const root = mkdtempSync(join(tmpdir(), "morphix-remote-auth0-")); roots.push(root);
  const storage = new Storage(root); storage.init();
  const logs: string[] = [];
  const remote = new MorphixRemote({
    storage, backend: new FakeBackend({ storageRoot: root, tickMs: 0 }), conversation: () => [], jobs: () => [], assistantText: async () => {}, assistantVoice: async () => {},
    setHeight: () => ({}), proposeRefine: () => ({}), prepare: async () => ({ ok: false } as never), latestPrint: () => null,
    proposePrint: () => ({}), printStatus: () => ({ enabled: false, gxVerified: false, job: null, busy: null, lastMessage: null }),
    smartSearch: () => null, searchModels: async () => ({ id: "s", query: "q", status: "ready", results: [] }), selectModel: () => { throw new Error("none"); },
    importModels: async () => ({ projectId: "p", versionId: "v", parts: [], warnings: [] }),
    downloadModel: async () => ({ projectId: "p", versionId: "v", parts: [], warnings: [] }),
    pause: async () => ({ ok: false, message: "disabled" }), resume: async () => ({ ok: false, message: "disabled" }), cancel: async () => ({ ok: false, message: "disabled" }),
    guardian: () => ({ running: false } as never), guardianAnswer: async () => ({ ok: false, message: "disabled" }), log: (l) => logs.push(l),
  }, { host: "127.0.0.1", port: 0, allowedOrigins: [ORIGIN], auth0 });
  remotes.push(remote);
  const { url, codeFile } = await remote.start();
  const call = (path: string, body?: unknown, token?: string) => fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const nonce = async () => ((await (await call("/api/pair/auth0/start", {})).json()) as { nonce: string }).nonce;
  return { root, url, codeFile, logs, call, nonce };
}

const configured: RemoteAuth0Options = { domain: "tenant.example.auth0.com", clientId: CLIENT_ID, allowedEmails: "kid@example.com, Parent@Example.com", fetch: fakeAuth0 };

describe("Morphix Remote: Sign in with Auth0", () => {
  it("turns a valid ID token from an allowed, verified email into a normal device token", async () => {
    const r = await startRemote(configured);
    const token = idToken({ nonce: await r.nonce() });
    const res = await r.call("/api/pair/auth0", { idToken: token, name: "Kid's iPhone" });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; device: { name: string } };
    expect(body.device.name).toBe("Kid's iPhone");
    const state = await r.call("/api/state", undefined, body.token);
    expect(state.status).toBe(200);
    expect(((await state.json()) as { device: { name: string } }).device.name).toBe("Kid's iPhone");
    const devices = JSON.parse(readFileSync(join(r.root, "remote", "devices.json"), "utf8"));
    expect(devices.devices).toHaveLength(1);
    expect(devices.devices[0].account).toBe("kid@example.com");
    expect(JSON.stringify(devices)).not.toContain(body.token);
    // Same token again: the nonce was single-use.
    const replay = await r.call("/api/pair/auth0", { idToken: token, name: "Stranger" });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: string }).error).toBe("MX-AUTH-006");
    // Tokens never reach the log.
    expect(r.logs.join("\n")).not.toContain(token);
    expect(r.logs.join("\n")).not.toContain(body.token);
  });

  it("matches allowed emails case-insensitively", async () => {
    const r = await startRemote(configured);
    const res = await r.call("/api/pair/auth0", { idToken: idToken({ nonce: await r.nonce(), email: "PARENT@example.com" }) });
    expect(res.status).toBe(200);
  });

  const refusals: [string, (nonce: string) => string, number, string][] = [
    ["a wrong signature", (nonce) => idToken({ nonce }, { key: otherKey }), 401, "MX-AUTH-001"],
    ["an unknown key id", (nonce) => idToken({ nonce }, { kid: "other-kid" }), 401, "MX-AUTH-001"],
    ["alg none", (nonce) => idToken({ nonce }, { alg: "none" }).split(".").slice(0, 2).join(".") + ".", 401, "MX-AUTH-001"],
    ["HS256", (nonce) => idToken({ nonce }, { alg: "HS256" }), 401, "MX-AUTH-001"],
    ["a wrong issuer", (nonce) => idToken({ nonce, iss: "https://evil.example.auth0.com/" }), 401, "MX-AUTH-001"],
    ["a wrong audience", (nonce) => idToken({ nonce, aud: "portal-web-app" }), 401, "MX-AUTH-001"],
    ["an expired token", (nonce) => idToken({ nonce, exp: Math.floor(Date.now() / 1000) - 3600 }), 401, "MX-AUTH-002"],
    ["an unverified email", (nonce) => idToken({ nonce, email_verified: false }), 403, "MX-AUTH-007"],
    ["a missing email_verified", (nonce) => idToken({ nonce, email_verified: undefined }), 403, "MX-AUTH-007"],
    ["an email not on the allow list", (nonce) => idToken({ nonce, email: "stranger@example.com" }), 403, "MX-AUTH-003"],
    ["a nonce this Pi never issued", () => idToken({ nonce: "made-up-nonce" }), 401, "MX-AUTH-006"],
    ["no nonce", () => idToken({}), 401, "MX-AUTH-006"],
    ["garbage", () => "not-a-jwt", 401, "MX-AUTH-001"],
  ];
  for (const [what, make, status, code] of refusals) {
    it(`refuses ${what} (${code}) and issues no device`, async () => {
      const r = await startRemote(configured);
      const res = await r.call("/api/pair/auth0", { idToken: make(await r.nonce()) });
      expect(res.status).toBe(status);
      const body = await res.json() as { error: string; message: string; token?: string };
      expect(body.error).toBe(code);
      expect(body.token).toBeUndefined();
      expect(body.message).toContain(code);
      const devices = JSON.parse(readFileSync(join(r.root, "remote", "devices.json"), "utf8"));
      expect(devices.devices).toHaveLength(0);
    });
  }

  it("refuses everyone when the allow list is empty", async () => {
    const r = await startRemote({ ...configured, allowedEmails: "" });
    const res = await r.call("/api/pair/auth0", { idToken: idToken({ nonce: await r.nonce() }) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("MX-AUTH-003");
  });

  it("says sign-in isn't set up when the domain or phone client ID is missing", async () => {
    for (const auth0 of [undefined, { ...configured, clientId: "" }, { ...configured, domain: "" }]) {
      const r = await startRemote(auth0);
      const start = await r.call("/api/pair/auth0/start", {});
      expect(start.status).toBe(503);
      expect(((await start.json()) as { error: string }).error).toBe("MX-AUTH-004");
      const res = await r.call("/api/pair/auth0", { idToken: idToken({ nonce: "x" }) });
      expect(res.status).toBe(503);
    }
  });

  it("reports Auth0 being unreachable as MX-AUTH-005", async () => {
    const r = await startRemote({ ...configured, fetch: async () => { throw new TypeError("fetch failed"); } });
    const res = await r.call("/api/pair/auth0", { idToken: idToken({ nonce: await r.nonce() }) });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("MX-AUTH-005");
  });

  it("rate-limits repeated refusals", async () => {
    const r = await startRemote(configured);
    for (let i = 0; i < 8; i++) expect((await r.call("/api/pair/auth0", { idToken: "not-a-jwt" })).status).toBe(401);
    expect((await r.call("/api/pair/auth0", { idToken: idToken({ nonce: await r.nonce() }) })).status).toBe(429);
  });

  it("refuses other origins", async () => {
    const r = await startRemote(configured);
    const res = await fetch(`${r.url}/api/pair/auth0/start`, { method: "POST", headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("leaves QR pairing working exactly as before", async () => {
    const r = await startRemote(configured);
    const code = readFileSync(r.codeFile, "utf8").match(/\d{8}/)![0];
    // An Auth0 sign-in does not use up or rotate the QR code.
    expect((await r.call("/api/pair/auth0", { idToken: idToken({ nonce: await r.nonce() }) })).status).toBe(200);
    expect(readFileSync(r.codeFile, "utf8")).toContain(code);
    const paired = await r.call("/api/pair", { code, name: "QR phone" });
    expect(paired.status).toBe(200);
    const { token } = await paired.json() as { token: string };
    expect((await r.call("/api/state", undefined, token)).status).toBe(200);
    expect((await r.call("/api/pair", { code, name: "Stranger" })).status).toBe(401);
    expect(readFileSync(r.codeFile, "utf8")).not.toContain(code);
  });
});
