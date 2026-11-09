// Minimal OpenID Connect client for Auth0 (Authorization Code + PKCE, confidential client).
// fetch + node:crypto only. Verifies RS256 ID tokens against the tenant's JWKS.
import { createHash, createPublicKey, verify as verifySig, type JsonWebKey, type KeyObject } from "node:crypto";
import type { PortalAuthConfig } from "./config";
import { b64url, randomToken } from "./session";

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export interface IdClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  azp?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  nickname?: string;
  picture?: string;
}

export class OidcError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export interface LoginStart {
  url: string;
  state: string;
  nonce: string;
  verifier: string;
}

const CLOCK_SKEW_SEC = 60;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 30 * 1000;

export function pkceChallenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

export class OidcClient {
  private discovery: { doc: Discovery; at: number } | null = null;
  private keys = new Map<string, KeyObject>();
  private keysAt = 0;
  readonly issuerBase: string;

  constructor(
    private readonly cfg: PortalAuthConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.issuerBase = (cfg.issuerBaseUrl ?? `https://${cfg.domain}`).replace(/\/+$/, "");
  }

  get redirectUri(): string {
    return `${this.cfg.baseUrl}/callback`;
  }

  private async getJson(url: string, init?: RequestInit): Promise<any> {
    const res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: "error" });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OidcError("bad_response", `Auth0 returned non-JSON (${res.status})`);
    }
    if (!res.ok) throw new OidcError("http_" + res.status, `Auth0 said ${res.status}: ${body?.error_description ?? body?.error ?? "error"}`);
    return body;
  }

  async getDiscovery(): Promise<Discovery> {
    if (this.discovery && Date.now() - this.discovery.at < DISCOVERY_TTL_MS) return this.discovery.doc;
    const doc = (await this.getJson(`${this.issuerBase}/.well-known/openid-configuration`)) as Discovery;
    for (const k of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
      if (typeof doc[k] !== "string") throw new OidcError("bad_discovery", `Discovery document has no ${k}`);
    }
    // The issuer must belong to the configured tenant (Auth0 uses "https://<domain>/").
    if (doc.issuer.replace(/\/+$/, "") !== this.issuerBase) throw new OidcError("bad_discovery", "Discovery issuer does not match AUTH0_DOMAIN");
    this.discovery = { doc, at: Date.now() };
    return doc;
  }

  async startLogin(): Promise<LoginStart> {
    const d = await this.getDiscovery();
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken(48);
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.cfg.clientId,
      redirect_uri: this.redirectUri,
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString(), state, nonce, verifier };
  }

  /** Exchange the code and return verified ID-token claims. */
  async finishLogin(code: string, verifier: string, nonce: string): Promise<IdClaims> {
    const d = await this.getDiscovery();
    const tokens = await this.getJson(d.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        code,
        redirect_uri: this.redirectUri,
        code_verifier: verifier,
      }).toString(),
    });
    if (typeof tokens.id_token !== "string") throw new OidcError("no_id_token", "Auth0 did not return an ID token");
    return this.verifyIdToken(tokens.id_token, nonce);
  }

  private async loadKeys(force: boolean): Promise<void> {
    const age = Date.now() - this.keysAt;
    if (!force && this.keys.size && age < JWKS_TTL_MS) return;
    if (force && age < JWKS_MIN_REFRESH_MS) return;
    const d = await this.getDiscovery();
    const jwks = await this.getJson(d.jwks_uri);
    const next = new Map<string, KeyObject>();
    for (const jwk of Array.isArray(jwks?.keys) ? jwks.keys : []) {
      if (jwk.kty !== "RSA" || !jwk.kid || (jwk.use && jwk.use !== "sig")) continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e } as JsonWebKey, format: "jwk" }));
      } catch {
        /* skip malformed key */
      }
    }
    this.keys = next;
    this.keysAt = Date.now();
  }

  private async keyFor(kid: string): Promise<KeyObject> {
    await this.loadKeys(false);
    if (!this.keys.has(kid)) await this.loadKeys(true); // key rotation
    const key = this.keys.get(kid);
    if (!key) throw new OidcError("unknown_key", "ID token signed with an unknown key");
    return key;
  }

  async verifyIdToken(token: string, nonce: string, nowSec = Math.floor(Date.now() / 1000)): Promise<IdClaims> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new OidcError("malformed", "ID token is malformed");
    let header: { alg?: string; kid?: string; typ?: string };
    let claims: IdClaims;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      throw new OidcError("malformed", "ID token is malformed");
    }
    if (header.alg !== "RS256") throw new OidcError("bad_alg", "ID token must be RS256");
    if (typeof header.kid !== "string") throw new OidcError("unknown_key", "ID token has no key id");
    const key = await this.keyFor(header.kid);
    const ok = verifySig("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
    if (!ok) throw new OidcError("bad_signature", "ID token signature is invalid");

    const d = await this.getDiscovery();
    if (claims.iss !== d.issuer) throw new OidcError("bad_issuer", "ID token issuer is wrong");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.cfg.clientId)) throw new OidcError("bad_audience", "ID token is for a different application");
    if (aud.length > 1 && claims.azp !== this.cfg.clientId) throw new OidcError("bad_audience", "ID token azp is wrong");
    if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SEC < nowSec) throw new OidcError("expired", "ID token has expired");
    if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_SEC > nowSec) throw new OidcError("future", "ID token is from the future");
    if (typeof claims.nonce !== "string" || claims.nonce !== nonce) throw new OidcError("bad_nonce", "ID token nonce does not match");
    if (typeof claims.sub !== "string" || !claims.sub) throw new OidcError("malformed", "ID token has no subject");
    return claims;
  }

  async logoutUrl(): Promise<string> {
    const url = new URL(`${this.issuerBase}/v2/logout`);
    url.search = new URLSearchParams({ client_id: this.cfg.clientId, returnTo: `${this.cfg.baseUrl}/` }).toString();
    return url.toString();
  }
}
