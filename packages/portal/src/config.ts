// Auth0 / portal configuration read from the environment (~/Morphix/config/morphix.env).

export interface PortalAuthConfig {
  /** Auth0 tenant domain, e.g. "dev-abc123.us.auth0.com" (no scheme). */
  domain: string;
  clientId: string;
  clientSecret: string;
  /** Where people open the portal, e.g. "http://192.168.86.38:8443" (no trailing slash). */
  baseUrl: string;
  /** At least 32 characters; signs the session and login cookies. */
  sessionSecret: string;
  /** Lower-case e-mails that may sign in. Empty = nobody. */
  allowedEmails: string[];
  /** Lower-case e-mails that may use printer controls (they may also sign in). */
  adminEmails: string[];
  /** Hours a session lasts. Default 12. */
  sessionHours?: number;
  /** Tests only: OIDC issuer base URL instead of https://<domain>. Never read from env. */
  issuerBaseUrl?: string;
}

export type PortalAuthSetup =
  | { ok: true; config: PortalAuthConfig }
  | { ok: false; missing: string[]; problems: string[] };

const REQUIRED = ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "PORTAL_BASE_URL", "PORTAL_SESSION_SECRET"] as const;

export function parseEmailList(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(/[,\s;]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
}

export function loadPortalAuthConfig(env: Record<string, string | undefined> = process.env): PortalAuthSetup {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  const problems: string[] = [];
  const domain = (env.AUTH0_DOMAIN ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (domain && !/^[a-z0-9.-]+$/i.test(domain)) problems.push("AUTH0_DOMAIN should look like dev-abc123.us.auth0.com");
  const baseUrl = (env.PORTAL_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (baseUrl) {
    try {
      const u = new URL(baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") problems.push("PORTAL_BASE_URL must start with http:// or https://");
      if (u.pathname !== "/" || u.search || u.hash) problems.push("PORTAL_BASE_URL must not have a path, e.g. http://192.168.86.38:8443");
    } catch {
      problems.push("PORTAL_BASE_URL is not a valid URL");
    }
  }
  const secret = env.PORTAL_SESSION_SECRET ?? "";
  if (secret && secret.length < 32) problems.push("PORTAL_SESSION_SECRET must be at least 32 characters (try: openssl rand -hex 32)");
  if (missing.length || problems.length) return { ok: false, missing, problems };
  const hours = Number(env.PORTAL_SESSION_HOURS);
  return {
    ok: true,
    config: {
      domain,
      clientId: env.AUTH0_CLIENT_ID!.trim(),
      clientSecret: env.AUTH0_CLIENT_SECRET!.trim(),
      baseUrl,
      sessionSecret: secret,
      allowedEmails: parseEmailList(env.AUTH0_ALLOWED_EMAILS),
      adminEmails: parseEmailList(env.AUTH0_ADMIN_EMAILS),
      sessionHours: Number.isFinite(hours) && hours > 0 && hours <= 24 * 30 ? hours : 12,
    },
  };
}

export function isAllowed(cfg: PortalAuthConfig, email: string): boolean {
  const e = email.toLowerCase();
  return cfg.allowedEmails.includes(e) || cfg.adminEmails.includes(e);
}

export function isAdmin(cfg: PortalAuthConfig, email: string): boolean {
  return cfg.adminEmails.includes(email.toLowerCase());
}
