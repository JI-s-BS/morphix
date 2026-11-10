// The API keys the setup page manages, what each unlocks, and a short live "test key" call.
// The key goes only in a request header to its own service; replies are reduced to plain text
// and never include the key.
import { SECRET_KEYS } from "./types";

export type ApiKeyName = (typeof SECRET_KEYS)[number];

export interface ApiKeyInfo {
  key: ApiKeyName;
  label: string;
  /** One sentence: what setting this key switches on. */
  unlocks: string;
  /** Where to get one. */
  getUrl: string;
}

export const API_KEYS: readonly ApiKeyInfo[] = [
  { key: "GEMINI_API_KEY", label: "Google Gemini", unlocks: "Talk to Morphix by voice, get print advice, and let the Print Guardian watch the camera for failed prints.", getUrl: "https://aistudio.google.com/apikey" },
  { key: "MESHY_API_KEY", label: "Meshy", unlocks: "Turn a spoken or typed idea (or a photo) into a 3D model.", getUrl: "https://www.meshy.ai/settings/api" },
  { key: "ANTHROPIC_API_KEY", label: "Anthropic Claude", unlocks: "Design exact, measured parts (brackets, boxes, holders) as OpenSCAD models.", getUrl: "https://console.anthropic.com/settings/keys" },
  { key: "THINGIVERSE_TOKEN", label: "Thingiverse", unlocks: "Search Thingiverse for ready-made models to print.", getUrl: "https://www.thingiverse.com/developers" },
];

export type KeyTestResult = { ok: true; message: string } | { ok: false; message: string; hint?: string };

const TEST_TIMEOUT_MS = 8000;

const REQUESTS: Record<ApiKeyName, (key: string) => { url: string; headers: Record<string, string> }> = {
  GEMINI_API_KEY: (k) => ({ url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: { "x-goog-api-key": k } }),
  MESHY_API_KEY: (k) => ({ url: "https://api.meshy.ai/openapi/v1/balance", headers: { Authorization: `Bearer ${k}` } }),
  ANTHROPIC_API_KEY: (k) => ({ url: "https://api.anthropic.com/v1/models?limit=1", headers: { "x-api-key": k, "anthropic-version": "2023-06-01" } }),
  THINGIVERSE_TOKEN: (k) => ({ url: "https://api.thingiverse.com/users/me", headers: { Authorization: `Bearer ${k}` } }),
};

/** One read-only request that only succeeds with a working key. Never throws. */
export async function testApiKey(name: ApiKeyName, key: string, deps: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<KeyTestResult> {
  const info = API_KEYS.find((k) => k.key === name);
  if (!info) return { ok: false, message: "Unknown key." };
  const { url, headers } = REQUESTS[name](key);
  const f = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, { headers, signal: AbortSignal.timeout(deps.timeoutMs ?? TEST_TIMEOUT_MS), redirect: "error" });
  } catch (e) {
    const timeout = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
    return {
      ok: false,
      message: timeout ? `${info.label} didn't answer within ${Math.round((deps.timeoutMs ?? TEST_TIMEOUT_MS) / 1000)} seconds.` : `Couldn't reach ${info.label}.`,
      hint: "Check that this machine is online (try opening a website from it), then test again.",
    };
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.ok) return { ok: true, message: `${info.label} accepted the key.` };
  if (res.status === 401 || res.status === 403) return { ok: false, message: `${info.label} rejected the key.`, hint: `Copy the key again from ${info.getUrl} and make sure nothing is missing.` };
  if (res.status === 402) return { ok: false, message: `${info.label} accepted the key but the account has no credit or plan.`, hint: `Check billing at ${info.getUrl}.` };
  if (res.status === 429) return { ok: false, message: `${info.label} says too many requests right now.`, hint: "Wait a minute and test again. The key may still be fine." };
  return { ok: false, message: `${info.label} answered with an error (HTTP ${res.status}).`, hint: "The service may be down; try again later." };
}
