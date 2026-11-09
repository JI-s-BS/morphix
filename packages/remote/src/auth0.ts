// "Sign in with Auth0" for the phone (docs/REMOTE.md). The phone runs Authorization Code + PKCE
// itself as a public SPA client (no secret) and sends the ID token here. Morphix accepts it only if:
// - it carries a one-time nonce this Pi handed out in the last 10 minutes (no replay, no tokens
//   minted for other logins such as the web portal),
// - the portal's OidcClient verifies it: RS256 signature against the tenant JWKS, issuer, audience
//   (the phone's SPA client ID), expiry,
// - email_verified is true and the email is on the allow list (empty list = nobody).
// Tokens are never logged or stored.
import { randomBytes } from "node:crypto";
import { getErrorEntry } from "@morphix/errors";
import { OidcClient, OidcError, parseEmailList, type IdClaims } from "@morphix/portal";

export interface RemoteAuth0Options {
  /** AUTH0_DOMAIN, e.g. "dev-abc123.us.auth0.com". */
  domain?: string;
  /** Client ID of the phone's Auth0 Single Page Application (MORPHIX_REMOTE_AUTH0_CLIENT_ID). */
  clientId?: string;
  /** Comma/space separated e-mails that may connect a phone. Empty = nobody. */
  allowedEmails?: string;
  /** Tests only. */
  fetch?: typeof fetch;
  /** Tests only: issuer base URL instead of https://<domain>. */
  issuerBaseUrl?: string;
}

export type Auth0Code = "MX-AUTH-001" | "MX-AUTH-002" | "MX-AUTH-003" | "MX-AUTH-004" | "MX-AUTH-005" | "MX-AUTH-006" | "MX-AUTH-007";

const STATUS: Record<Auth0Code, number> = {
  "MX-AUTH-001": 401,
  "MX-AUTH-002": 401,
  "MX-AUTH-003": 403,
  "MX-AUTH-004": 503,
  "MX-AUTH-005": 502,
  "MX-AUTH-006": 401,
  "MX-AUTH-007": 403,
};

export class Auth0Refusal extends Error {
  readonly status: number;
  constructor(readonly code: Auth0Code, readonly reason: string, readonly email?: string) {
    super(reason);
    this.status = STATUS[code];
  }
  /** JSON body for the phone: kid-friendly title and hint from the error registry. */
  body() {
    const e = getErrorEntry(this.code)!;
    return { error: this.code, title: e.title, hint: e.hint, message: `${e.title}. ${e.hint} (${this.code})` };
  }
}

const NONCE_TTL_MS = 10 * 60_000;
const MAX_NONCES = 100;
const MAX_TOKEN_CHARS = 16_000;

function codeFor(e: unknown): Auth0Code {
  if (!(e instanceof OidcError)) return "MX-AUTH-005"; // network error or timeout talking to Auth0
  if (e.reason === "expired") return "MX-AUTH-002";
  if (e.reason === "bad_nonce") return "MX-AUTH-006";
  if (e.reason === "bad_discovery") return "MX-AUTH-004";
  if (e.reason === "bad_response") return "MX-AUTH-005";
  if (e.reason.startsWith("http_")) return Number(e.reason.slice(5)) >= 500 ? "MX-AUTH-005" : "MX-AUTH-004";
  return "MX-AUTH-001";
}

export class RemoteAuth0 {
  private readonly client: OidcClient | null;
  private readonly allowed: string[];
  private readonly nonces = new Map<string, number>();

  constructor(opts: RemoteAuth0Options = {}) {
    const domain = (opts.domain ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const clientId = (opts.clientId ?? "").trim();
    this.allowed = parseEmailList(opts.allowedEmails);
    // Only verifyIdToken() is used: the secret, base URL and session secret belong to the portal.
    this.client = domain && /^[a-z0-9.-]+$/i.test(domain) && clientId
      ? new OidcClient({ domain, clientId, clientSecret: "", baseUrl: "", sessionSecret: "", allowedEmails: this.allowed, adminEmails: [], issuerBaseUrl: opts.issuerBaseUrl }, opts.fetch ?? fetch)
      : null;
  }

  get configured(): boolean {
    return this.client !== null;
  }

  /** A one-time nonce the phone passes to Auth0's /authorize; the ID token must carry it back. */
  start(now = Date.now()): { nonce: string; expiresAt: string } {
    if (!this.client) throw new Auth0Refusal("MX-AUTH-004", "Auth0 domain or phone client ID is not configured");
    for (const [n, exp] of this.nonces) if (exp <= now) this.nonces.delete(n);
    while (this.nonces.size >= MAX_NONCES) this.nonces.delete(this.nonces.keys().next().value!);
    const nonce = randomBytes(24).toString("base64url");
    this.nonces.set(nonce, now + NONCE_TTL_MS);
    return { nonce, expiresAt: new Date(now + NONCE_TTL_MS).toISOString() };
  }

  /** Verifies the phone's ID token. Resolves to the verified account or throws Auth0Refusal. */
  async verify(idToken: unknown, now = Date.now()): Promise<{ email: string; sub: string }> {
    if (!this.client) throw new Auth0Refusal("MX-AUTH-004", "Auth0 domain or phone client ID is not configured");
    if (typeof idToken !== "string" || idToken.length > MAX_TOKEN_CHARS || idToken.split(".").length !== 3) {
      throw new Auth0Refusal("MX-AUTH-001", "malformed ID token");
    }
    let nonce: unknown;
    try {
      nonce = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"))?.nonce;
    } catch {
      throw new Auth0Refusal("MX-AUTH-001", "malformed ID token");
    }
    const expires = typeof nonce === "string" ? this.nonces.get(nonce) : undefined;
    if (typeof nonce !== "string" || expires === undefined || expires <= now) {
      throw new Auth0Refusal("MX-AUTH-006", "ID token nonce was not issued by this Morphix, expired or was already used");
    }
    let claims: IdClaims;
    try {
      claims = await this.client.verifyIdToken(idToken, nonce, Math.floor(now / 1000));
    } catch (e) {
      throw new Auth0Refusal(codeFor(e), e instanceof OidcError ? e.reason : "auth0_unreachable");
    }
    // Single use: of two requests racing with the same valid token only one gets here first.
    if (!this.nonces.delete(nonce)) throw new Auth0Refusal("MX-AUTH-006", "ID token nonce was already used");
    if (claims.email_verified !== true) throw new Auth0Refusal("MX-AUTH-007", "email is not verified");
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    if (!email || !this.allowed.includes(email)) throw new Auth0Refusal("MX-AUTH-003", "email is not on AUTH0_ALLOWED_EMAILS", email);
    return { email, sub: claims.sub };
  }
}
