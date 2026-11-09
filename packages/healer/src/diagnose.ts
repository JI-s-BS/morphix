// Optional AI diagnosis for unknown errors: Claude explains what went wrong in plain words and
// may suggest ONE remediation from the whitelist. It never runs anything itself: the engine
// decides, and only whitelisted, AI-triggerable remediations can follow a suggestion.
import { isRemediationId, REMEDIATION_IDS } from "./remediations";
import { redactSecrets, secretEnvValues } from "./redact";
import type { Diagnoser, DiagnoseInput, Diagnosis } from "./types";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
const API_URL = "https://api.anthropic.com/v1/messages";

export interface ClaudeDiagnoserOptions {
  apiKey: string;
  model?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Server-side refusal fallback ("default" routing). Default true. */
  fallbacks?: boolean;
  /** Exact secret values to strip in addition to the built-in patterns. */
  secrets?: string[];
  maxLogLines?: number;
}

const SYSTEM = [
  "You diagnose errors in Morphix, a children's voice-controlled 3D printing appliance on a Raspberry Pi 4",
  "(Electron app, Afinia QD330 printer over TCP, Gemini Live voice, Meshy model generation, PrusaSlicer, a Python camera watcher).",
  "You get one error and recent JSON log lines (secrets removed). Explain what most likely happened.",
  "summary: one sentence a parent understands. likely_cause: one or two technical sentences.",
  "user_hint: one simple thing a grown-up can do. suggested_remediation: one id from the allowed list that would safely help, or \"none\".",
  "Never suggest anything that moves, heats, starts or cancels the printer or spends money; those ids do not exist.",
].join(" ");

function schema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "likely_cause", "user_hint", "suggested_remediation", "confidence"],
    properties: {
      summary: { type: "string" },
      likely_cause: { type: "string" },
      user_hint: { type: "string" },
      suggested_remediation: { type: "string", enum: [...REMEDIATION_IDS, "none"] },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
    },
  };
}

/** Builds the redacted user message (exported for tests). */
export function buildDiagnosisPrompt(input: DiagnoseInput, secrets: string[] = [], maxLogLines = 60): string {
  const lines = input.logLines.slice(-maxLogLines).map((l) => redactSecrets(l.slice(0, 600), secrets));
  const incident = redactSecrets(JSON.stringify({ kind: input.incident.kind, what: input.incident.what, code: input.incident.code, context: input.incident.context }), secrets);
  return [
    `Error: ${incident}`,
    `Allowed remediations: ${input.remediations.map((r) => `${r.id} (${r.label})`).join("; ")}`,
    "Recent log lines:",
    ...lines,
  ].join("\n");
}

export function parseDiagnosis(text: string, model?: string): Diagnosis | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const s = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const summary = s(j.summary, 300);
  if (!summary) return null;
  const sug = j.suggested_remediation;
  const conf = j.confidence;
  return {
    summary,
    likelyCause: s(j.likely_cause, 500),
    userHint: s(j.user_hint, 300),
    suggestedRemediation: isRemediationId(sug) ? sug : "none",
    confidence: conf === "high" || conf === "medium" ? conf : "low",
    model,
  };
}

export function createClaudeDiagnoser(o: ClaudeDiagnoserOptions): Diagnoser {
  const model = o.model || DEFAULT_CLAUDE_MODEL;
  const doFetch = o.fetch ?? fetch;
  const secrets = [o.apiKey, ...(o.secrets ?? [])];
  return async (input) => {
    const body: Record<string, unknown> = {
      model,
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { effort: "low", format: { type: "json_schema", schema: schema() } },
      messages: [{ role: "user", content: buildDiagnosisPrompt(input, secrets, o.maxLogLines) }],
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": o.apiKey,
      "anthropic-version": "2023-06-01",
    };
    if (o.fallbacks !== false) {
      body.fallbacks = "default";
      headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    }
    const res = await doFetch(API_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs ?? 60_000) });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Claude HTTP ${res.status}: ${redactSecrets(t.slice(0, 300), secrets)}`);
    }
    const j = (await res.json()) as { stop_reason?: string; model?: string; content?: { type: string; text?: string }[] };
    if (j.stop_reason === "refusal") return null;
    const text = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    return parseDiagnosis(text, j.model ?? model);
  };
}

/** ANTHROPIC_API_KEY + MORPHIX_CLAUDE_MODEL; null when no key (diagnosis switched off). */
export function claudeDiagnoserFromEnv(env: Record<string, string | undefined>, extra: Partial<ClaudeDiagnoserOptions> = {}): Diagnoser | null {
  const apiKey = (env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey || env.MORPHIX_SELF_HEAL_AI === "0") return null;
  return createClaudeDiagnoser({
    apiKey,
    model: (env.MORPHIX_CLAUDE_MODEL ?? "").trim() || DEFAULT_CLAUDE_MODEL,
    fallbacks: env.MORPHIX_CLAUDE_FALLBACKS !== "0",
    secrets: secretEnvValues(env),
    ...extra,
  });
}

// ------------------------------------------------------------- Vultr ---
/** Vultr Serverless Inference (OpenAI-compatible chat API). */
export const VULTR_INFERENCE_URL = "https://api.vultrinference.com/v1";

export interface VultrDiagnoserOptions {
  apiKey: string;
  /** A chat model id from GET /v1/models; picked automatically when unset. */
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxLogLines?: number;
  secrets?: string[];
}

/** Prefers an instruction-tuned Llama/Qwen/Mistral chat model from the list. */
export function pickVultrModel(ids: string[]): string | null {
  const chat = ids.filter((id) => !/embed|whisper|tts|image|vision|guard|rerank/i.test(id));
  return chat.find((id) => /instruct/i.test(id)) ?? chat[0] ?? null;
}

/** Vultr-hosted open model that explains an error the same way Claude does (used when Claude can't). */
export function createVultrDiagnoser(o: VultrDiagnoserOptions): Diagnoser {
  const base = (o.baseUrl ?? VULTR_INFERENCE_URL).replace(/\/$/, "");
  const doFetch = o.fetch ?? fetch;
  const secrets = [o.apiKey, ...(o.secrets ?? [])];
  const headers = { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` };
  let model: string | null = o.model ?? null;
  return async (input) => {
    if (!model) {
      const res = await doFetch(`${base}/models`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Vultr models HTTP ${res.status}`);
      const j = (await res.json()) as { data?: { id?: string }[] };
      model = pickVultrModel((j.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean));
      if (!model) throw new Error("Vultr has no chat model available");
    }
    const keys = schema().required.join(", ");
    const res = await doFetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 800,
        messages: [
          { role: "system", content: `${SYSTEM} Answer with only a JSON object with the keys ${keys}. suggested_remediation must be one of: ${[...REMEDIATION_IDS, "none"].join(", ")}. confidence is low, medium or high.` },
          { role: "user", content: buildDiagnosisPrompt(input, secrets, o.maxLogLines) },
        ],
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Vultr HTTP ${res.status}: ${redactSecrets(t.slice(0, 300), secrets)}`);
    }
    const j = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[] };
    return parseDiagnosis(j.choices?.[0]?.message?.content ?? "", `vultr:${j.model ?? model}`);
  };
}

/** VULTR_INFERENCE_API_KEY (the Serverless Inference key, not the account API key) + optional MORPHIX_VULTR_MODEL. */
export function vultrDiagnoserFromEnv(env: Record<string, string | undefined>, extra: Partial<VultrDiagnoserOptions> = {}): Diagnoser | null {
  const apiKey = (env.VULTR_INFERENCE_API_KEY ?? "").trim();
  if (!apiKey || env.MORPHIX_SELF_HEAL_AI === "0") return null;
  return createVultrDiagnoser({ apiKey, model: (env.MORPHIX_VULTR_MODEL ?? "").trim() || undefined, secrets: secretEnvValues(env), ...extra });
}

/** Tries each diagnoser in order (Claude first, then Vultr) until one answers. */
export function firstDiagnoser(list: (Diagnoser | null | undefined)[]): Diagnoser | null {
  const ds = list.filter((d): d is Diagnoser => Boolean(d));
  if (!ds.length) return null;
  if (ds.length === 1) return ds[0];
  return async (input) => {
    let lastError: unknown = null;
    for (const d of ds) {
      try {
        const r = await d(input);
        if (r) return r;
      } catch (e) {
        lastError = e;
      }
    }
    if (lastError) throw lastError;
    return null;
  };
}
