// Strip secrets from log text before it leaves this machine (AI diagnosis).

const KEY_NAMES = "api[_-]?key|x-api-key|apikey|token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|client[_-]?secret|password|passwd|authorization|cookie|session[_-]?secret|key";

const PATTERNS: [RegExp, string][] = [
  // Anthropic / OpenAI-style keys, Google API keys, Meshy keys, GitHub tokens.
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED_KEY]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_KEY]"],
  [/\bmsy_[A-Za-z0-9_-]{8,}/g, "[REDACTED_KEY]"],
  [/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_KEY]"],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[REDACTED_JWT]"],
  // Authorization headers.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  // JSON "apiKey": "value" (and friends).
  [new RegExp(`("(?:[A-Za-z_-]*?)(?:${KEY_NAMES})"\\s*:\\s*)"[^"]*"`, "gi"), '$1"[REDACTED]"'],
  // key=value in URLs, env files and command lines.
  [new RegExp(`\\b((?:[A-Za-z_]*?)(?:${KEY_NAMES}))=([^&\\s"']+)`, "gi"), "$1=[REDACTED]"],
  // Emails (portal users).
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  // Long opaque strings (hex or base64 >= 40 chars) are most likely credentials or hashes.
  [/\b[A-Fa-f0-9]{40,}\b/g, "[REDACTED_HEX]"],
  [/\b[A-Za-z0-9+/_-]{48,}={0,2}/g, "[REDACTED_BLOB]"],
];

/**
 * Remove keys, tokens, passwords, emails and long opaque strings. `extraSecrets` are exact
 * values to remove as well (e.g. the values of GEMINI_API_KEY / MESHY_API_KEY from the env).
 */
export function redactSecrets(text: string, extraSecrets: readonly string[] = []): string {
  let out = text;
  for (const s of extraSecrets) {
    if (s && s.length >= 6) out = out.split(s).join("[REDACTED]");
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Values of env vars that look secret (for redactSecrets' extraSecrets). */
export function secretEnvValues(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([k, v]) => v && /KEY|TOKEN|SECRET|PASSWORD|PASS\b|COOKIE/i.test(k))
    .map(([, v]) => String(v).trim())
    .filter((v) => v.length >= 6);
}
