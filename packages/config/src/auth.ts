// Accounts and sign-in (docs/GOAL.md items 5/10).
//   - First run: the first POST /api/auth/setup creates the admin; after that setup is closed.
//   - Passwords: node:crypto scrypt with a per-user random salt, compared with timingSafeEqual.
//   - Sessions: random 256-bit token in an HttpOnly SameSite=Strict cookie (Secure over HTTPS);
//     only its SHA-256 is kept, in memory. Absolute and idle expiry. A password change or reset
//     (also from the reset-admin CLI in another process) signs that user out everywhere.
//   - Failed logins are limited per user name and per client address.
// Accounts live in <dataDir>/secrets/users.json (mode 0600). Nothing here logs passwords or tokens.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, createQueue, ensureDir, moveAside, readIfExists } from "./fsutil";
import { SECRETS_DIR } from "./store";
import type { Access, AuthProvider, AuthUser, ConfigStore, RouteContext, RouteHandler, RouteModule, Router } from "./types";
import { InputError, checkPassword, checkUsername, isRecord } from "./validate";

export const SESSION_COOKIE = "morphix_session";
export const USERS_FILE = "users.json";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password.normalize("NFKC"), salt, keylen, opts, (e, key) => (e ? reject(e) : resolve(key))));
}

/** "scrypt$N$r$p$<salt b64>$<hash b64>" */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > 1 << 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4], "base64");
  const want = Buffer.from(parts[5], "base64");
  if (want.length < 16 || want.length > 128) return false;
  const got = await scrypt(password, salt, want.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return timingSafeEqual(got, want);
}

/** Used for unknown user names so a failed login takes as long as a wrong password. */
let dummyHash: Promise<string> | null = null;

// ------------------------------------------------------------------ users file ---
export interface StoredUser {
  name: string;
  role: AuthUser["role"];
  hash: string;
  /** Bumped on every password change; sessions from an older version are invalid. */
  pwVersion: number;
  createdAt: string;
  /** Set by reset-admin with a generated password: the UI asks for a new one. */
  mustChangePassword?: boolean;
}
interface UsersFile { version: 1; users: StoredUser[] }

export class CorruptUsersFile extends Error {
  constructor(readonly file: string) {
    super(`The accounts file ${file} could not be read. Run "server.cjs reset-admin" on the Morphix machine to start a new one with a fresh admin password.`);
    this.name = "CorruptUsersFile";
  }
}

function validUsers(raw: unknown): raw is UsersFile {
  return (
    isRecord(raw) && raw.version === 1 && Array.isArray(raw.users) &&
    raw.users.every((u) => isRecord(u) && typeof u.name === "string" && (u.role === "admin" || u.role === "user") && typeof u.hash === "string" && Number.isInteger(u.pwVersion))
  );
}

/** Reads and writes users.json; reloads when another process (reset-admin) replaced it. */
function usersDb(store: ConfigStore) {
  const dir = join(store.dataDir, SECRETS_DIR);
  const file = join(dir, USERS_FILE);
  const queue = createQueue();
  let cache: { users: StoredUser[]; sig: string } | null = null;

  const sigOf = async () => {
    try {
      const s = await stat(file);
      return `${s.ino}:${s.mtimeMs}:${s.size}`;
    } catch {
      return "none";
    }
  };

  async function read(): Promise<StoredUser[]> {
    const sig = await sigOf();
    if (cache && cache.sig === sig) return cache.users;
    const text = await readIfExists(file);
    let users: StoredUser[] = [];
    if (text !== undefined) {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = undefined;
      }
      if (validUsers(raw)) users = raw.users;
      else {
        // Leave it in place and refuse to work: treating it as "no accounts" would reopen setup to
        // anyone on the network. reset-admin (at the console) moves it aside and starts fresh.
        throw new CorruptUsersFile(file);
      }
    }
    cache = { users, sig: await sigOf() };
    return users;
  }

  return {
    file,
    read,
    /** Read-modify-write under a lock. */
    update<T>(fn: (users: StoredUser[]) => Promise<{ users: StoredUser[]; result: T }>): Promise<T> {
      return queue(async () => {
        cache = null;
        const { users, result } = await fn(structuredClone(await read()));
        await ensureDir(dir, 0o700);
        await atomicWrite(file, JSON.stringify({ version: 1, users } satisfies UsersFile, null, 2) + "\n", 0o600);
        cache = { users, sig: await sigOf() };
        return result;
      });
    },
  };
}

// ------------------------------------------------------------------ rate limit ---
interface Strike { fails: number; first: number; lockedUntil: number }

/** Counts failures in a window; after `max` the key is locked for `lockMs`. Bounded in size. */
function limiter(max: number, windowMs: number, lockMs: number, now: () => number) {
  const m = new Map<string, Strike>();
  const prune = () => {
    const t = now();
    for (const [k, s] of m) if (s.lockedUntil < t && s.first + windowMs < t) m.delete(k);
    while (m.size > 10_000) m.delete(m.keys().next().value as string);
  };
  return {
    /** ms until unlocked, or 0. */
    lockedFor(key: string): number {
      const s = m.get(key);
      return s ? Math.max(0, s.lockedUntil - now()) : 0;
    },
    fail(key: string): void {
      const t = now();
      let s = m.get(key);
      if (!s || s.first + windowMs < t) s = { fails: 0, first: t, lockedUntil: 0 };
      s.fails++;
      if (s.fails >= max) {
        s.lockedUntil = t + lockMs;
        s.fails = 0;
        s.first = t;
      }
      m.delete(key);
      m.set(key, s);
      if (m.size > 10_000) prune();
    },
    clear(key: string): void {
      m.delete(key);
    },
  };
}

// ------------------------------------------------------------------ cookies ---
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function clientAddress(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? "unknown";
}

function isHttps(req: IncomingMessage): boolean {
  return Boolean((req.socket as TLSSocket | undefined)?.encrypted);
}

// ------------------------------------------------------------------ provider ---
export interface AuthOptions {
  /** Absolute session lifetime. Default 7 days. */
  sessionTtlMs?: number;
  /** Signed out after this long without a request. Default 24 hours. */
  idleTimeoutMs?: number;
  /** Failed logins per user name before a lockout. Default 5 (in 15 minutes). */
  maxFailsPerUser?: number;
  /** Failed logins per client address before it is blocked. Default 20 (in 15 minutes). */
  maxFailsPerAddress?: number;
  lockoutMs?: number;
  /** Force the cookie's Secure flag (default: Secure when the request came over TLS). */
  secureCookies?: boolean;
  now?: () => number;
}

interface Session { name: string; pwVersion: number; created: number; lastSeen: number }

export type LoginResult =
  | { ok: true; user: AuthUser; token: string; mustChangePassword: boolean }
  | { ok: false; status: 401 | 429; message: string; retryAfterS?: number };

export interface Auth extends AuthProvider {
  /** /api/auth/* routes. Mount next to setupRoutes(). */
  routes: RouteModule;
  createAdmin(name: string, password: string): Promise<AuthUser>;
  login(name: string, password: string, address?: string): Promise<LoginResult>;
  logout(req: IncomingMessage): void;
  changePassword(name: string, current: string, next: string): Promise<void>;
  addUser(name: string, password: string, role: AuthUser["role"]): Promise<AuthUser>;
  removeUser(name: string): Promise<void>;
  listUsers(): Promise<{ name: string; role: AuthUser["role"]; createdAt: string }[]>;
  /** True when this request's user was given a generated password (reset-admin) and must pick a new one. */
  mustChangePassword(req: IncomingMessage): Promise<boolean>;
  sessionCookie(token: string, req: IncomingMessage): string;
  clearCookie(req: IncomingMessage): string;
}

export function createAuth(store: ConfigStore, opts: AuthOptions = {}): Auth {
  const now = opts.now ?? Date.now;
  const ttl = opts.sessionTtlMs ?? 7 * 24 * 3600_000;
  const idle = opts.idleTimeoutMs ?? 24 * 3600_000;
  const lockMs = opts.lockoutMs ?? 15 * 60_000;
  const byUser = limiter(opts.maxFailsPerUser ?? 5, 15 * 60_000, lockMs, now);
  const byAddr = limiter(opts.maxFailsPerAddress ?? 20, 15 * 60_000, lockMs, now);
  const db = usersDb(store);
  const sessions = new Map<string, Session>();
  let adminCreation: Promise<AuthUser> | null = null;

  const digest = (token: string) => createHash("sha256").update(token).digest("hex");
  const key = (name: string) => name.toLowerCase();
  const find = (users: StoredUser[], name: string) => users.find((u) => key(u.name) === key(name));

  function startSession(u: StoredUser): string {
    const token = randomBytes(32).toString("base64url");
    const t = now();
    sessions.set(digest(token), { name: u.name, pwVersion: u.pwVersion, created: t, lastSeen: t });
    // Cap sessions per user (oldest first) and drop expired ones.
    const mine = [...sessions.entries()].filter(([, s]) => s.name === u.name);
    for (const [k] of mine.slice(0, Math.max(0, mine.length - 20))) sessions.delete(k);
    for (const [k, s] of sessions) if (s.created + ttl < t || s.lastSeen + idle < t) sessions.delete(k);
    return token;
  }

  function dropSessionsOf(name: string, except?: string) {
    for (const [k, s] of sessions) if (key(s.name) === key(name) && k !== except) sessions.delete(k);
  }

  async function sessionFor(req: IncomingMessage): Promise<{ id: string; s: Session; u: StoredUser } | null> {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token || token.length > 100) return null;
    const id = digest(token);
    const s = sessions.get(id);
    if (!s) return null;
    const t = now();
    if (s.created + ttl < t || s.lastSeen + idle < t) {
      sessions.delete(id);
      return null;
    }
    let users: StoredUser[];
    try {
      users = await db.read();
    } catch {
      return null;
    }
    const u = find(users, s.name);
    if (!u || u.pwVersion !== s.pwVersion) {
      sessions.delete(id);
      return null;
    }
    s.lastSeen = t;
    return { id, s, u };
  }

  async function setupOpen(): Promise<boolean> {
    try {
      return !(await db.read()).some((u) => u.role === "admin");
    } catch {
      return false; // unreadable accounts file: stay closed, reset-admin recovers
    }
  }

  const cookieFlags = (req: IncomingMessage) => `Path=/; HttpOnly; SameSite=Strict${opts.secureCookies ?? isHttps(req) ? "; Secure" : ""}`;

  const auth: Auth = {
    userFor: async (req) => {
      const hit = await sessionFor(req);
      return hit ? { name: hit.u.name, role: hit.u.role } : null;
    },
    setupOpen,

    async mustChangePassword(req) {
      return Boolean((await sessionFor(req))?.u.mustChangePassword);
    },

    sessionCookie: (token, req) => `${SESSION_COOKIE}=${token}; ${cookieFlags(req)}; Max-Age=${Math.floor(ttl / 1000)}`,
    clearCookie: (req) => `${SESSION_COOKIE}=; ${cookieFlags(req)}; Max-Age=0`,

    createAdmin(name, password) {
      // One at a time: two people racing on first run can't both become admin.
      const run = (adminCreation ?? Promise.resolve(null as unknown as AuthUser)).catch(() => null).then(async () => {
        if (!(await setupOpen())) throw new InputError("Setup is already done: an admin account exists. Sign in instead.");
        return auth.addUser(name, password, "admin");
      });
      adminCreation = run;
      return run;
    },

    async login(name, password, address = "unknown") {
      const wait = Math.max(byAddr.lockedFor(address), typeof name === "string" ? byUser.lockedFor(key(name)) : 0);
      if (wait > 0) {
        const mins = Math.ceil(wait / 60_000);
        return { ok: false, status: 429, retryAfterS: Math.ceil(wait / 1000), message: `Too many wrong passwords. Wait ${mins} minute${mins === 1 ? "" : "s"} and try again.` };
      }
      const bad = { ok: false as const, status: 401 as const, message: "Wrong user name or password." };
      if (typeof name !== "string" || typeof password !== "string" || checkUsername(name) || password.length > 1024) {
        byAddr.fail(address);
        return bad;
      }
      const u = find(await db.read(), name);
      const ok = u ? await verifyPassword(password, u.hash) : (await verifyPassword(password, await (dummyHash ??= hashPassword(randomBytes(16).toString("hex")))), false);
      if (!u || !ok) {
        byUser.fail(key(name));
        byAddr.fail(address);
        return bad;
      }
      byUser.clear(key(name));
      return { ok: true, user: { name: u.name, role: u.role }, token: startSession(u), mustChangePassword: Boolean(u.mustChangePassword) };
    },

    logout(req) {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token) sessions.delete(digest(token));
    },

    async changePassword(name, current, next) {
      const problem = checkPassword(next);
      if (problem) throw new InputError(problem, "next");
      if (current === next) throw new InputError("Pick a new password that's different from the current one.", "next");
      await db.update(async (users) => {
        const u = find(users, name);
        if (!u || typeof current !== "string" || !(await verifyPassword(current, u.hash))) throw new InputError("The current password is wrong.", "current");
        u.hash = await hashPassword(next);
        u.pwVersion++;
        delete u.mustChangePassword;
        return { users, result: undefined };
      });
      dropSessionsOf(name);
    },

    async addUser(name, password, role) {
      const p = checkUsername(name) ?? null;
      if (p) throw new InputError(p, "name");
      const q = checkPassword(password);
      if (q) throw new InputError(q, "password");
      if (role !== "admin" && role !== "user") throw new InputError("Role must be admin or user.", "role");
      const hash = await hashPassword(password);
      return db.update(async (users) => {
        if (find(users, name)) throw new InputError("That user name is taken.", "name");
        if (users.length >= 50) throw new InputError("Too many accounts (50 max).");
        users.push({ name, role, hash, pwVersion: 1, createdAt: new Date(now()).toISOString() });
        return { users, result: { name, role } };
      });
    },

    async removeUser(name) {
      await db.update(async (users) => {
        const u = find(users, name);
        if (!u) throw new InputError("No such user.", "name");
        if (u.role === "admin" && users.filter((x) => x.role === "admin").length === 1) throw new InputError("You can't remove the only admin.", "name");
        return { users: users.filter((x) => x !== u), result: undefined };
      });
      dropSessionsOf(name);
    },

    async listUsers() {
      return (await db.read()).map((u) => ({ name: u.name, role: u.role, createdAt: u.createdAt }));
    },

    routes: (router) => authRoutes(router, auth),
  };
  return auth;
}

// ------------------------------------------------------------------ CLI recovery ---
/**
 * `server.cjs reset-admin`: gives the admin a new password (generated unless one is passed) and
 * signs that admin out everywhere. With no admin account it creates "admin". The caller prints the
 * password once on the console; it is never logged or stored in clear text.
 */
export async function resetAdminAccount(store: ConfigStore, opts: { name?: string; password?: string } = {}): Promise<{ name: string; password: string; created: boolean; generated: boolean }> {
  if (opts.name !== undefined) {
    const p = checkUsername(opts.name);
    if (p) throw new InputError(p, "name");
  }
  if (opts.password !== undefined) {
    const p = checkPassword(opts.password);
    if (p) throw new InputError(p, "password");
  }
  const generated = opts.password === undefined;
  const password = opts.password ?? randomBytes(12).toString("base64url");
  const hash = await hashPassword(password);
  const db = usersDb(store);
  try {
    await db.read();
  } catch (e) {
    if (!(e instanceof CorruptUsersFile)) throw e;
    await moveAside(db.file, "corrupt"); // kept for inspection; start a fresh one
  }
  return db.update<{ name: string; password: string; created: boolean; generated: boolean }>(async (list) => {
    const target = opts.name ? list.find((u) => u.name.toLowerCase() === opts.name!.toLowerCase()) : list.find((u) => u.role === "admin");
    if (target) {
      target.hash = hash;
      target.role = "admin";
      target.pwVersion++;
      if (generated) target.mustChangePassword = true;
      else delete target.mustChangePassword;
      return { users: list, result: { name: target.name, password, created: false, generated } };
    }
    const name = opts.name ?? "admin";
    list.push({ name, role: "admin", hash, pwVersion: 1, createdAt: new Date().toISOString(), ...(generated ? { mustChangePassword: true } : {}) });
    return { users: list, result: { name, password, created: true, generated } };
  });
}

/** `server.cjs reset-admin`: the text the CLI prints (once, to the terminal; never logged). */
export async function resetAdmin(store: ConfigStore, opts: { name?: string; password?: string } = {}): Promise<string> {
  const r = await resetAdminAccount(store, opts);
  return [
    `${r.created ? "Created the admin account" : "Reset the password of"} "${r.name}".`,
    r.generated ? `New password: ${r.password}` : "The password you chose is set.",
    r.generated ? "Sign in with it; Morphix will ask you to pick your own. Everyone signed in as this admin was signed out." : "Everyone signed in as this admin was signed out.",
  ].join("\n");
}

// ------------------------------------------------------------------ routes ---
/** Re-checks access inside the handler too, so a server bug can't expose an admin route. */
export function guarded(access: Access, setupOpen: () => Promise<boolean>, handler: RouteHandler): RouteHandler {
  return async (ctx) => {
    if (!(await allowed(access, ctx.user, setupOpen))) {
      ctx.send(ctx.user ? 403 : 401, { error: ctx.user ? "Only an admin can do that." : "Sign in first." });
      return;
    }
    try {
      await handler(ctx);
    } catch (e) {
      // The server's own HTTP errors (body too large, bad JSON …) carry their status: let the server answer them.
      if (typeof (e as { status?: unknown })?.status === "number") throw e;
      if (e instanceof InputError) ctx.send(400, { error: e.message, ...(e.field ? { field: e.field } : {}) });
      else if (e instanceof CorruptUsersFile) ctx.send(503, { error: e.message });
      else if (e instanceof SyntaxError || (e as Error)?.name === "SyntaxError") ctx.send(400, { error: "The request wasn't valid JSON." });
      else ctx.send(500, { error: "Something went wrong on the Morphix server. Check its log (journalctl -u morphix) and try again." });
    }
  };
}

/** The Access rule from types.ts, for the server and for guarded(). */
export async function allowed(access: Access, user: AuthUser | null, setupOpen: () => Promise<boolean>): Promise<boolean> {
  switch (access) {
    case "public":
      return true;
    case "setup":
      return user?.role === "admin" || (await setupOpen());
    case "user":
      return user !== null;
    case "admin":
      return user?.role === "admin";
  }
}

export async function jsonBody(ctx: RouteContext): Promise<Record<string, unknown>> {
  const body = await ctx.json<unknown>();
  if (!isRecord(body)) throw new InputError("Send a JSON object.");
  return body;
}

function authRoutes(router: Router, auth: Auth) {
  const add = (method: "GET" | "POST" | "PUT" | "DELETE", pattern: string, access: Access, h: RouteHandler) =>
    router.add(method, pattern, access, guarded(access, auth.setupOpen, h));
  const noStore = { "Cache-Control": "no-store" };

  add("GET", "/api/auth/me", "public", async (ctx) => {
    ctx.send(200, { user: ctx.user, setupOpen: await auth.setupOpen(), mustChangePassword: ctx.user ? await auth.mustChangePassword(ctx.req) : false }, noStore);
  });

  /** First run: create the admin and sign in. Closed once an admin exists. */
  add("POST", "/api/auth/setup", "setup", async (ctx) => {
    if (!(await auth.setupOpen())) return ctx.send(409, { error: "Setup is already done: an admin account exists. Sign in instead." });
    const b = await jsonBody(ctx);
    await auth.createAdmin(b.name as string, b.password as string);
    const r = await auth.login(b.name as string, b.password as string, clientAddress(ctx.req));
    if (!r.ok) return ctx.send(r.status, { error: r.message });
    ctx.send(201, { user: r.user }, { ...noStore, "Set-Cookie": auth.sessionCookie(r.token, ctx.req) });
  });

  add("POST", "/api/auth/login", "public", async (ctx) => {
    const b = await jsonBody(ctx);
    const r = await auth.login(b.name as string, b.password as string, clientAddress(ctx.req));
    if (!r.ok) return ctx.send(r.status, { error: r.message }, r.retryAfterS ? { "Retry-After": String(r.retryAfterS) } : undefined);
    ctx.send(200, { user: r.user, mustChangePassword: r.mustChangePassword }, { ...noStore, "Set-Cookie": auth.sessionCookie(r.token, ctx.req) });
  });

  add("POST", "/api/auth/logout", "public", (ctx) => {
    auth.logout(ctx.req);
    ctx.send(200, { ok: true }, { "Set-Cookie": auth.clearCookie(ctx.req) });
  });

  add("POST", "/api/auth/password", "user", async (ctx) => {
    const b = await jsonBody(ctx);
    await auth.changePassword(ctx.user!.name, b.current as string, b.next as string);
    // Every session of this user ended; sign this browser back in with the new password.
    const r = await auth.login(ctx.user!.name, b.next as string, clientAddress(ctx.req));
    if (!r.ok) return ctx.send(200, { ok: true }, { "Set-Cookie": auth.clearCookie(ctx.req) });
    ctx.send(200, { ok: true }, { "Set-Cookie": auth.sessionCookie(r.token, ctx.req) });
  });

  add("GET", "/api/auth/users", "admin", async (ctx) => ctx.send(200, { users: await auth.listUsers() }, noStore));

  add("POST", "/api/auth/users", "admin", async (ctx) => {
    const b = await jsonBody(ctx);
    const role = b.role === undefined ? "user" : b.role;
    ctx.send(201, { user: await auth.addUser(b.name as string, b.password as string, role as AuthUser["role"]) });
  });

  add("DELETE", "/api/auth/users/:name", "admin", async (ctx) => {
    if (ctx.params.name.toLowerCase() === ctx.user!.name.toLowerCase()) return ctx.send(400, { error: "You can't remove your own account while signed in with it." });
    await auth.removeUser(ctx.params.name);
    ctx.send(200, { ok: true });
  });
}
