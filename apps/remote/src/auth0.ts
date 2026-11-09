// "Sign in with Auth0" on the Connect page (docs/REMOTE.md). Authorization Code + PKCE as a public
// SPA client: no client secret in the browser. The Pi hands out the nonce and verifies the ID token;
// this file only runs the redirect and the code exchange. Tokens are never stored after use.
const KEY = "morphix.remote.auth0";

export interface Auth0Config { domain: string; clientId: string; audience: string }

export function auth0Config(): Auth0Config | null {
  const env = import.meta.env;
  const domain = String(env.VITE_AUTH0_DOMAIN ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const clientId = String(env.VITE_AUTH0_CLIENT_ID ?? "").trim();
  const audience = String(env.VITE_AUTH0_AUDIENCE ?? "").trim();
  return /^[a-z0-9.-]+$/i.test(domain) && clientId ? { domain, clientId, audience } : null;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const redirectUri = () => `${location.origin}/`;

/** Builds the Universal Login URL and remembers state + PKCE verifier for the way back. */
export async function auth0LoginUrl(cfg: Auth0Config, nonce: string): Promise<string> {
  const state = random(), verifier = random(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  sessionStorage.setItem(KEY, JSON.stringify({ state, verifier }));
  const url = new URL(`https://${cfg.domain}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(cfg.audience ? { audience: cfg.audience } : {}),
  }).toString();
  return url.toString();
}

export type Auth0Callback = { code: string; state: string } | { error: string };

let callback: Auth0Callback | null | undefined;

/** Auth0 sent us back here (?code&state or ?error). Clears the query string; same answer on every call. */
export function readAuth0Callback(): Auth0Callback | null {
  if (callback !== undefined) return callback;
  const q = new URLSearchParams(location.search);
  if (!q.has("state") || !(q.has("code") || q.has("error"))) return (callback = null);
  history.replaceState(null, "", location.pathname + location.hash);
  const error = q.get("error");
  if (error) return (callback = { error: error === "access_denied" ? "You're not allowed to do that. Ask the owner of this Morphix to give you access." : "Signing in didn't work. Try signing in again." });
  return (callback = { code: q.get("code") ?? "", state: q.get("state") ?? "" });
}

/** Exchanges the code for an ID token (state and PKCE checked). */
export async function auth0IdToken(cfg: Auth0Config, cb: { code: string; state: string }): Promise<string> {
  const saved = (() => { try { return JSON.parse(sessionStorage.getItem(KEY) ?? "null"); } catch { return null; } })();
  sessionStorage.removeItem(KEY);
  if (!saved?.state || saved.state !== cb.state) throw new Error("Sign-in got mixed up. Close this page and sign in again.");
  let res: Response;
  try {
    res = await fetch(`https://${cfg.domain}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: cfg.clientId, code: cb.code, code_verifier: saved.verifier, redirect_uri: redirectUri() }).toString(),
    });
  } catch {
    throw new Error("The sign-in service isn't answering. Check the internet and try again.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.id_token !== "string") throw new Error("Signing in didn't work. Try signing in again.");
  return body.id_token;
}
