// A tiny local OpenID provider that behaves like Auth0 for tests and the offline demo.
// Generates its own RSA key. /authorize approves immediately as `email` (no password).
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOidcOptions {
  clientId: string;
  clientSecret: string;
  email?: string;
  host?: string;
  port?: number;
}

/** Claim tweaks for negative tests. */
export interface FakeOidcOverrides {
  nonce?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  email?: string;
  email_verified?: boolean;
  /** Sign with a key that is not in the JWKS. */
  foreignKey?: boolean;
  alg?: string;
}

interface CodeGrant {
  clientId: string;
  redirectUri: string;
  nonce: string;
  challenge: string;
  email: string;
}

export class FakeOidcServer {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  private readonly otherKey: KeyObject;
  readonly kid = "fake-key-1";
  private server: Server;
  private codes = new Map<string, CodeGrant>();
  base = "";
  overrides: FakeOidcOverrides = {};
  email: string;
  /** Counts requests per path (tests check JWKS caching). */
  readonly hits = new Map<string, number>();

  constructor(private readonly opts: FakeOidcOptions) {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    this.otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    this.email = opts.email ?? "kid@example.com";
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ({ status, headers, body }) => {
          res.writeHead(status, headers);
          res.end(body);
        },
        () => {
          res.writeHead(500);
          res.end();
        },
      );
    });
  }

  get issuer(): string {
    return `${this.base}/`;
  }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(this.opts.port ?? 0, this.opts.host ?? "127.0.0.1", r));
    this.base = `http://${this.opts.host ?? "127.0.0.1"}:${(this.server.address() as AddressInfo).port}`;
    return this.base;
  }

  stop(): Promise<void> {
    return new Promise((r) => {
      this.server.close(() => r());
      this.server.closeAllConnections();
    });
  }

  /** Build a signed ID token directly (for unit tests of the verifier). */
  makeIdToken(claims: Record<string, unknown>, opts: { alg?: string; kid?: string; key?: KeyObject } = {}): string {
    const header = { alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? this.kid };
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const input = `${enc(header)}.${enc(claims)}`;
    const sig = sign("RSA-SHA256", Buffer.from(input), opts.key ?? this.privateKey).toString("base64url");
    return `${input}.${sig}`;
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const url = new URL(req.url ?? "/", this.base);
    this.hits.set(url.pathname, (this.hits.get(url.pathname) ?? 0) + 1);
    const json = (status: number, body: unknown) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.base}/authorize`,
        token_endpoint: `${this.base}/oauth/token`,
        jwks_uri: `${this.base}/.well-known/jwks.json`,
        end_session_endpoint: `${this.base}/oidc/logout`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/.well-known/jwks.json") {
      const jwk = this.publicKey.export({ format: "jwk" });
      return json(200, { keys: [{ ...jwk, kid: this.kid, use: "sig", alg: "RS256" }] });
    }
    if (url.pathname === "/authorize") {
      const p = url.searchParams;
      if (p.get("response_type") !== "code" || p.get("client_id") !== this.opts.clientId || p.get("code_challenge_method") !== "S256") {
        return json(400, { error: "invalid_request" });
      }
      const code = Math.random().toString(36).slice(2) + Date.now().toString(36);
      this.codes.set(code, {
        clientId: p.get("client_id")!,
        redirectUri: p.get("redirect_uri")!,
        nonce: p.get("nonce") ?? "",
        challenge: p.get("code_challenge") ?? "",
        email: this.email,
      });
      const back = new URL(p.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", p.get("state") ?? "");
      return { status: 302, headers: { location: back.toString() }, body: "" };
    }
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const p = new URLSearchParams(Buffer.concat(chunks).toString());
      const grant = this.codes.get(p.get("code") ?? "");
      if (!grant) return json(403, { error: "invalid_grant", error_description: "Invalid authorization code" });
      this.codes.delete(p.get("code")!);
      if (p.get("client_id") !== grant.clientId || p.get("client_secret") !== this.opts.clientSecret) return json(401, { error: "access_denied", error_description: "Unauthorized" });
      if (p.get("redirect_uri") !== grant.redirectUri) return json(403, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
      const challenge = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url");
      if (challenge !== grant.challenge) return json(403, { error: "invalid_grant", error_description: "Failed to verify code verifier" });
      const now = Math.floor(Date.now() / 1000);
      const o = this.overrides;
      const claims = {
        iss: o.iss ?? this.issuer,
        sub: `auth0|${createHash("sha256").update(o.email ?? grant.email).digest("hex").slice(0, 16)}`,
        aud: o.aud ?? grant.clientId,
        iat: now,
        exp: o.exp ?? now + 3600,
        nonce: o.nonce ?? grant.nonce,
        email: o.email ?? grant.email,
        email_verified: o.email_verified ?? true,
        name: (o.email ?? grant.email).split("@")[0],
      };
      const id_token = this.makeIdToken(claims, { alg: o.alg, key: o.foreignKey ? this.otherKey : undefined });
      return json(200, { access_token: "fake-access", id_token, token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname === "/v2/logout") {
      const to = url.searchParams.get("returnTo");
      return to ? { status: 302, headers: { location: to }, body: "" } : json(200, { ok: true });
    }
    return json(404, { error: "not_found" });
  }
}
