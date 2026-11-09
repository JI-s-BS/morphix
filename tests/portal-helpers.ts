// Shared setup for the portal tests: fake Auth0, FakeBackend, a portal on a free port,
// and a tiny cookie-jar HTTP client that does not follow redirects.
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPortal, FakeBackend, FakeOidcServer, type Portal, type PortalAuthConfig, type PortalLimits } from "@morphix/portal";

export const WEB_ROOT = resolve(__dirname, "../packages/portal/web");
export const THREE_ROOT = resolve(__dirname, "../node_modules/three");

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

export class Client {
  cookies = new Map<string, string>();
  constructor(readonly base: string) {}

  async req(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : this.base + path;
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (this.cookies.size && new URL(url).origin === new URL(this.base).origin) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    if (new URL(url).origin === new URL(this.base).origin) {
      for (const sc of res.headers.getSetCookie()) {
        const [pair] = sc.split(";");
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        if (/max-age=0/i.test(sc) || !value) this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
    }
    return res;
  }
}

export interface Harness {
  oidc: FakeOidcServer;
  backend: FakeBackend;
  portal: Portal;
  base: string;
  storageRoot: string;
  cfg: PortalAuthConfig;
  logs: string[];
  close(): Promise<void>;
}

export async function startHarness(
  opts: { allowed?: string[]; admins?: string[]; limits?: Partial<PortalLimits>; confirmCost?: boolean; printControlsEnabled?: boolean } = {},
): Promise<Harness> {
  const oidc = new FakeOidcServer({ clientId: "client-123", clientSecret: "secret-456", email: "kid@example.com" });
  const issuer = await oidc.start();
  const port = await freePort();
  const storageRoot = mkdtempSync(join(tmpdir(), "portal-test-"));
  const backend = new FakeBackend({ storageRoot, tickMs: 0, confirmCost: opts.confirmCost, printControlsEnabled: opts.printControlsEnabled ?? true, cameraFrameMs: 20 });
  const base = `http://127.0.0.1:${port}`;
  const cfg: PortalAuthConfig = {
    domain: "tenant.example.auth0.com",
    issuerBaseUrl: issuer,
    clientId: "client-123",
    clientSecret: "secret-456",
    baseUrl: base,
    sessionSecret: "test-session-secret-0123456789abcdef",
    allowedEmails: opts.allowed ?? ["kid@example.com"],
    adminEmails: opts.admins ?? ["parent@example.com"],
  };
  const logs: string[] = [];
  const portal = createPortal({
    backend,
    auth: { ok: true, config: cfg },
    host: "127.0.0.1",
    port,
    storageRoot,
    webRoot: WEB_ROOT,
    threeRoot: THREE_ROOT,
    log: (l) => logs.push(l),
    limits: { sseHeartbeatMs: 50, ...opts.limits },
  });
  await portal.start();
  return {
    oidc,
    backend,
    portal,
    base,
    storageRoot,
    cfg,
    logs,
    async close() {
      backend.close();
      await portal.stop();
      await oidc.stop();
      rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}

/** Run the browser side of the Authorization Code flow. Returns the callback response. */
export async function loginFlow(h: Harness, client: Client, tamper?: (callbackUrl: URL) => void): Promise<Response> {
  const start = await client.req("/login");
  if (start.status !== 302) throw new Error(`login returned ${start.status}`);
  const authorize = await fetch(start.headers.get("location")!, { redirect: "manual" });
  const cb = new URL(authorize.headers.get("location")!);
  tamper?.(cb);
  return client.req(cb.pathname + cb.search);
}

/** Sign in as `email` and return a client plus its CSRF token. */
export async function signIn(h: Harness, email = "kid@example.com"): Promise<{ client: Client; csrf: string }> {
  const client = new Client(h.base);
  h.oidc.email = email;
  const res = await loginFlow(h, client);
  if (res.status !== 302) throw new Error(`callback returned ${res.status}: ${await res.text()}`);
  const me = await client.req("/api/me");
  const body = await me.json();
  return { client, csrf: body.csrfToken };
}
