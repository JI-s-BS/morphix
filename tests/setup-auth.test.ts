// Accounts and sign-in: hashing, first-run admin, lockout, session expiry, reset-admin, cookies.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuth, createAuthProvider, createConfigStore, createSetupRoutes, hashPassword, resetAdmin, resetAdminAccount, verifyPassword, type Auth } from "@morphix/config";
import { TestRouter, cookieFrom, fakeReq, tempDir } from "./setup-helpers";

let t: ReturnType<typeof tempDir>;
let clock: number;
const now = () => clock;
const store = () => createConfigStore(t.dir, { legacyEnvPaths: [], env: {} });
const reqWith = (token: string) => fakeReq({ cookie: `other=1; morphix_session=${token}` });

beforeEach(() => {
  t = tempDir();
  clock = Date.parse("2026-11-10T12:00:00Z");
});
afterEach(() => t.cleanup());

async function loginOk(auth: Auth, name: string, pw: string) {
  const r = await auth.login(name, pw, "10.0.0.5");
  if (!r.ok) throw new Error(r.message);
  return r;
}

describe("password hashing", () => {
  it("uses scrypt with a per-user salt and verifies", async () => {
    const a = await hashPassword("correct horse");
    const b = await hashPassword("correct horse");
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("correct horse");
    expect(await verifyPassword("correct horse", a)).toBe(true);
    expect(await verifyPassword("correct horsf", a)).toBe(false);
  });

  it("rejects malformed or hostile hashes without throwing", async () => {
    expect(await verifyPassword("x", "plain")).toBe(false);
    expect(await verifyPassword("x", "scrypt$99999999$8$1$AAAA$AAAA")).toBe(false);
    expect(await verifyPassword("x", "scrypt$16384$8$1$AAAA$AA")).toBe(false);
  });
});

describe("first run", () => {
  it("setup is open until the admin exists, then closed", async () => {
    const auth = createAuth(store(), { now });
    expect(await auth.setupOpen()).toBe(true);
    await auth.createAdmin("owner", "longpassword");
    expect(await auth.setupOpen()).toBe(false);
    await expect(auth.createAdmin("intruder", "longpassword")).rejects.toThrow(/already done/);
    // a second process (or restart) sees the same
    expect(await createAuth(store()).setupOpen()).toBe(false);
  });

  it("two racing first-run requests make exactly one admin", async () => {
    const auth = createAuth(store(), { now });
    const results = await Promise.allSettled([auth.createAdmin("a", "longpassword"), auth.createAdmin("b", "longpassword")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await auth.listUsers()).map((u) => u.role)).toEqual(["admin"]);
  });

  it("stores accounts in a 0600 file with no clear-text password", async () => {
    const auth = createAuth(store(), { now });
    await auth.createAdmin("owner", "my-secret-pass");
    const file = join(t.dir, "secrets", "users.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain("my-secret-pass");
  });

  it("validates names and passwords", async () => {
    const auth = createAuth(store(), { now });
    await expect(auth.createAdmin("bad name!", "longpassword")).rejects.toThrow(/User name/);
    await expect(auth.createAdmin("owner", "short")).rejects.toThrow(/at least 8/);
    await expect(auth.createAdmin("owner", "x".repeat(300))).rejects.toThrow(/at most/);
  });
});

describe("login", () => {
  it("signs in, recognises the session cookie and signs out", async () => {
    const auth = createAuth(store(), { now });
    await auth.createAdmin("Owner", "longpassword");
    const r = await loginOk(auth, "owner", "longpassword"); // names are case-insensitive
    expect(r.user).toEqual({ name: "Owner", role: "admin" });
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await auth.userFor(reqWith(r.token))).toEqual({ name: "Owner", role: "admin" });
    expect(await auth.userFor(reqWith("forged"))).toBeNull();
    expect(await auth.userFor(fakeReq())).toBeNull();
    auth.logout(reqWith(r.token));
    expect(await auth.userFor(reqWith(r.token))).toBeNull();
  });

  it("gives the same answer for an unknown user and a wrong password", async () => {
    const auth = createAuth(store(), { now });
    await auth.createAdmin("owner", "longpassword");
    const a = await auth.login("owner", "wrongpassword");
    const b = await auth.login("nobody", "wrongpassword");
    expect(a).toEqual(b);
    expect(a).toMatchObject({ ok: false, status: 401 });
  });

  it("locks a user name after 5 wrong passwords, even for the right one, then unlocks", async () => {
    const auth = createAuth(store(), { now, lockoutMs: 15 * 60_000 });
    await auth.createAdmin("owner", "longpassword");
    for (let i = 0; i < 5; i++) expect((await auth.login("owner", "nope-nope", `10.0.0.${i}`)).ok).toBe(false);
    const locked = await auth.login("owner", "longpassword", "10.0.0.99");
    expect(locked).toMatchObject({ ok: false, status: 429 });
    expect(locked.ok === false && locked.message).toMatch(/Wait 15 minutes/);
    clock += 15 * 60_000 + 1;
    expect((await auth.login("owner", "longpassword", "10.0.0.99")).ok).toBe(true);
  });

  it("blocks an address that guesses many user names", async () => {
    const auth = createAuth(store(), { now, maxFailsPerAddress: 4 });
    await auth.createAdmin("owner", "longpassword");
    for (let i = 0; i < 4; i++) await auth.login(`user${i}`, "guess-guess", "10.9.9.9");
    expect(await auth.login("owner", "longpassword", "10.9.9.9")).toMatchObject({ ok: false, status: 429 });
    expect((await auth.login("owner", "longpassword", "10.9.9.10")).ok).toBe(true);
  });
});

describe("sessions", () => {
  it("expire after the idle timeout", async () => {
    const auth = createAuth(store(), { now, idleTimeoutMs: 60_000, sessionTtlMs: 3600_000 });
    await auth.createAdmin("owner", "longpassword");
    const { token } = await loginOk(auth, "owner", "longpassword");
    clock += 50_000;
    expect(await auth.userFor(reqWith(token))).not.toBeNull(); // activity extends it
    clock += 50_000;
    expect(await auth.userFor(reqWith(token))).not.toBeNull();
    clock += 60_001;
    expect(await auth.userFor(reqWith(token))).toBeNull();
  });

  it("expire after the absolute lifetime even when used", async () => {
    const auth = createAuth(store(), { now, idleTimeoutMs: 3600_000, sessionTtlMs: 7200_000 });
    await auth.createAdmin("owner", "longpassword");
    const { token } = await loginOk(auth, "owner", "longpassword");
    for (let i = 0; i < 7; i++) {
      clock += 1000_000;
      expect(await auth.userFor(reqWith(token))).not.toBeNull();
    }
    clock += 300_000;
    expect(await auth.userFor(reqWith(token))).toBeNull();
  });

  it("end everywhere when the password changes", async () => {
    const auth = createAuth(store(), { now });
    await auth.createAdmin("owner", "longpassword");
    const a = await loginOk(auth, "owner", "longpassword");
    await expect(auth.changePassword("owner", "wrong-current", "newpassword1")).rejects.toThrow(/current password is wrong/);
    await auth.changePassword("owner", "longpassword", "newpassword1");
    expect(await auth.userFor(reqWith(a.token))).toBeNull();
    expect((await auth.login("owner", "longpassword")).ok).toBe(false);
    expect((await auth.login("owner", "newpassword1")).ok).toBe(true);
  });
});

describe("user accounts", () => {
  it("a user account can sign in but isn't an admin; the last admin can't be removed", async () => {
    const auth = createAuth(store(), { now });
    await auth.createAdmin("owner", "longpassword");
    await auth.addUser("kid", "printstuff", "user");
    const r = await loginOk(auth, "kid", "printstuff");
    expect(r.user.role).toBe("user");
    await expect(auth.addUser("KID", "printstuff", "user")).rejects.toThrow(/taken/);
    await expect(auth.removeUser("owner")).rejects.toThrow(/only admin/);
    await auth.removeUser("kid");
    expect(await auth.userFor(reqWith(r.token))).toBeNull();
  });
});

describe("reset-admin (CLI recovery)", () => {
  it("sets a generated password, signs the admin out of the running server, and asks for a new password", async () => {
    const server = createAuth(store(), { now });
    await server.createAdmin("owner", "forgotten-pass");
    const old = await loginOk(server, "owner", "forgotten-pass");
    const r = await resetAdminAccount(store()); // as a separate process would
    expect(r).toMatchObject({ name: "owner", created: false, generated: true });
    expect(r.password.length).toBeGreaterThanOrEqual(16);
    expect(await server.userFor(reqWith(old.token))).toBeNull();
    const fresh = await loginOk(server, "owner", r.password);
    expect(fresh.mustChangePassword).toBe(true);
    expect(await server.mustChangePassword(reqWith(fresh.token))).toBe(true);
    await server.changePassword("owner", r.password, "brand-new-pass");
    expect((await loginOk(server, "owner", "brand-new-pass")).mustChangePassword).toBe(false);
  });

  it("creates an admin when there is none, and recovers from a corrupt accounts file", async () => {
    const s = store();
    await s.load(); // creates the dirs
    writeFileSync(join(t.dir, "secrets", "users.json"), "{garbage");
    const auth = createAuth(s, { now });
    expect(await auth.setupOpen()).toBe(false); // unreadable: stays closed instead of letting anyone claim admin
    expect(await auth.setupOpen()).toBe(false); // ...every time, not just the first
    await expect(auth.createAdmin("intruder", "longpassword")).rejects.toThrow();
    const r = await resetAdminAccount(s, { password: "chosen-password" });
    expect(r).toMatchObject({ name: "admin", created: true, generated: false });
    expect((await auth.login("admin", "chosen-password")).ok).toBe(true);
    expect(readdirSync(join(t.dir, "secrets")).some((f) => f.startsWith("users.json.corrupt-"))).toBe(true);
  });
});

describe("routes and cookies", () => {
  it("sets an HttpOnly SameSite=Strict cookie, Secure only over HTTPS", async () => {
    const auth = createAuth(store(), { now });
    const router = new TestRouter(auth);
    auth.routes(router);
    const setup = await router.request("POST", "/api/auth/setup", { body: { name: "owner", password: "longpassword" } });
    expect(setup.status).toBe(201);
    expect(setup.headers["Set-Cookie"]).toMatch(/^morphix_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800$/);
    const https = await router.request("POST", "/api/auth/login", { body: { name: "owner", password: "longpassword" }, https: true });
    expect(https.headers["Set-Cookie"]).toMatch(/; Secure;/);

    const me = await router.request("GET", "/api/auth/me", { cookie: cookieFrom(setup) });
    expect(me.body).toEqual({ user: { name: "owner", role: "admin" }, setupOpen: false, mustChangePassword: false });
    const again = await router.request("POST", "/api/auth/setup", { body: { name: "x", password: "longpassword" } });
    expect(again.status).toBe(401); // setup closed: needs an admin now

    const out = await router.request("POST", "/api/auth/logout", { cookie: cookieFrom(setup) });
    expect(out.headers["Set-Cookie"]).toMatch(/Max-Age=0/);
    expect((await router.request("GET", "/api/auth/me", { cookie: cookieFrom(setup) })).body.user).toBeNull();
    expect(router.transcript.join("\n")).not.toContain("longpassword");
  });

  it("returns 429 with Retry-After when locked, and 400 for junk input", async () => {
    const auth = createAuth(store(), { now, maxFailsPerUser: 2 });
    const router = new TestRouter(auth);
    auth.routes(router);
    await router.request("POST", "/api/auth/setup", { body: { name: "owner", password: "longpassword" } });
    for (let i = 0; i < 2; i++) expect((await router.request("POST", "/api/auth/login", { body: { name: "owner", password: "wrong-wrong" } })).status).toBe(401);
    const r = await router.request("POST", "/api/auth/login", { body: { name: "owner", password: "longpassword" } });
    expect(r.status).toBe(429);
    expect(Number(r.headers["Retry-After"])).toBeGreaterThan(0);
    expect((await router.request("POST", "/api/auth/login", { rawBody: "{nope" })).status).toBe(400);
    expect((await router.request("POST", "/api/auth/login", { body: [1] })).status).toBe(400);
  });

  it("only admins manage accounts; users can change their own password", async () => {
    const auth = createAuth(store(), { now });
    const router = new TestRouter(auth);
    auth.routes(router);
    const admin = cookieFrom(await router.request("POST", "/api/auth/setup", { body: { name: "owner", password: "longpassword" } }));
    expect((await router.request("POST", "/api/auth/users", { cookie: admin, body: { name: "kid", password: "printstuff" } })).status).toBe(201);
    const kid = cookieFrom(await router.request("POST", "/api/auth/login", { body: { name: "kid", password: "printstuff" } }));
    expect((await router.request("GET", "/api/auth/users", { cookie: kid })).status).toBe(403);
    expect((await router.request("DELETE", "/api/auth/users/owner", { cookie: admin })).status).toBe(400);
    const pw = await router.request("POST", "/api/auth/password", { cookie: kid, body: { current: "printstuff", next: "printmore1" } });
    expect(pw.status).toBe(200);
    expect((await router.request("GET", "/api/auth/me", { cookie: kid })).body.user).toBeNull(); // old cookie ended
    expect((await router.request("GET", "/api/auth/me", { cookie: cookieFrom(pw) })).body.user).toEqual({ name: "kid", role: "user" });
    const users = await router.request("GET", "/api/auth/users", { cookie: admin });
    expect(JSON.stringify(users.body)).not.toMatch(/hash|scrypt/);
  });
});

describe("server-facing exports", () => {
  it("resetAdmin returns the text the CLI prints", async () => {
    const text = await resetAdmin(store());
    expect(text).toMatch(/^Created the admin account "admin"\.\nNew password: [A-Za-z0-9_-]{16}\n/);
    const pw = /New password: (\S+)/.exec(text)![1];
    expect((await createAuth(store()).login("admin", pw)).ok).toBe(true);
  });

  it("createAuthProvider + createSetupRoutes mount the auth and setup routes", async () => {
    const s = store();
    const auth = createAuthProvider(s);
    const router = new TestRouter(auth);
    const mods = createSetupRoutes({ store: s, auth, csrfToken: () => "x" });
    expect(mods).toHaveLength(2);
    mods.forEach((m) => m(router));
    const c = cookieFrom(await router.request("POST", "/api/auth/setup", { body: { name: "owner", password: "longpassword" } }));
    expect((await router.request("GET", "/api/setup/keys", { cookie: c })).status).toBe(200);
  });
});
