// Optional cloud extras. Both are OFF unless their env var is set, and both
// have local fallbacks so the guardian works fully offline.
//  - Swarms multi-agent review (SWARMS_API_KEY): a second opinion on a
//    confirmed alert. The remote request shape is best-effort; any error falls
//    back to the deterministic local review below.
//  - Tiger Data telemetry (TIGER_DATABASE_URL): batches guardian events into a
//    Postgres/Timescale table through an injected sink (no driver is bundled).
//    Without a sink or URL, records stay in a bounded local buffer.
import type { FailureKind } from "./events";
import type { FetchLike, GeminiResult } from "./gemini";

// ---------------------------------------------------------------- review ---
export type ReviewRecommendation = "pause_recommended" | "keep_watching" | "likely_false_alarm";

export interface ReviewInput {
  kind: FailureKind;
  localConfirmed: boolean;
  localScore: number;
  gemini?: GeminiResult;
  printerState?: string | null;
}

export interface ReviewResult {
  source: "swarms" | "local";
  recommendation: ReviewRecommendation;
  confidence: number;
  rationale: string;
  fallbackReason?: string;
}

/** Deterministic rules used when Swarms is off or fails. Conservative: an
 * unverified confirmed failure still recommends pausing. */
export function localReview(i: ReviewInput): ReviewResult {
  const g = i.gemini?.status === "ok" ? i.gemini : undefined;
  if (g && g.problem === "no_problem" && g.confidence >= 0.7) {
    return { source: "local", recommendation: "likely_false_alarm", confidence: g.confidence, rationale: `Gemini sees no problem: ${g.explanation}` };
  }
  if (g && g.failureLikely && g.confidence >= 0.6) {
    return { source: "local", recommendation: "pause_recommended", confidence: Math.min(0.95, (g.confidence + 0.8) / 2), rationale: `Local detector and Gemini agree (${g.problem}): ${g.explanation}` };
  }
  if (i.localConfirmed) {
    return { source: "local", recommendation: "pause_recommended", confidence: 0.6, rationale: `Local detector confirmed ${i.kind} over several frames${g ? `; Gemini: ${g.problem} (${g.confidence.toFixed(2)})` : "; no AI check available"}.` };
  }
  return { source: "local", recommendation: "keep_watching", confidence: 0.5, rationale: `Possible ${i.kind}; waiting for more frames.` };
}

export interface SwarmsOptions {
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class SwarmsReviewClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly modelName: string;
  private readonly fetchFn?: FetchLike;
  private readonly timeoutMs: number;

  constructor(o: SwarmsOptions = {}) {
    this.apiKey = o.apiKey?.trim() || undefined;
    this.baseUrl = (o.baseUrl ?? "https://api.swarms.world").replace(/\/$/, "");
    this.modelName = o.modelName ?? "gpt-4o-mini";
    this.fetchFn = o.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }

  get enabled(): boolean {
    return !!this.apiKey && !!this.fetchFn;
  }

  async review(i: ReviewInput): Promise<ReviewResult> {
    const fallback = localReview(i);
    if (!this.enabled) return fallback;
    const agent = (name: string, role: string) => ({ agent_name: name, system_prompt: role, model_name: this.modelName, max_loops: 1 });
    const body = {
      name: "morphix-print-guardian-review",
      swarm_type: "ConcurrentWorkflow",
      agents: [
        agent("failure-analyst", "You judge whether a 3D print has failed from detector and vision-model evidence."),
        agent("safety-reviewer", "You weigh the cost of pausing a healthy print against letting a failed print continue."),
      ],
      task: `Evidence: ${JSON.stringify(i)}. Reply with JSON {"recommendation":"pause_recommended|keep_watching|likely_false_alarm","confidence":0-1,"rationale":"..."}`,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn!(`${this.baseUrl}/v1/swarm/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": this.apiKey! },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return { ...fallback, fallbackReason: `swarms HTTP ${res.status}` };
      const parsed = extractReview(JSON.stringify(await res.json()));
      return parsed ? { source: "swarms", ...parsed } : { ...fallback, fallbackReason: "swarms answer not understood" };
    } catch (e) {
      return { ...fallback, fallbackReason: `swarms error: ${(e as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

function extractReview(text: string): Omit<ReviewResult, "source"> | null {
  // the answer may be nested anywhere in the response as an escaped JSON string
  const unescaped = text.replace(/\\"/g, '"');
  const m = /\{[^{}]*"recommendation"\s*:\s*"(pause_recommended|keep_watching|likely_false_alarm)"[^{}]*\}/.exec(unescaped);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { recommendation: ReviewRecommendation; confidence?: number; rationale?: string };
    return { recommendation: o.recommendation, confidence: Math.min(1, Math.max(0, Number(o.confidence) || 0.5)), rationale: String(o.rationale ?? "") };
  } catch {
    return { recommendation: m[1] as ReviewRecommendation, confidence: 0.5, rationale: "" };
  }
}

// ------------------------------------------------------------- telemetry ---
export interface TelemetryRecord {
  at: string;
  sessionId: string | null;
  type: string;
  kind?: string;
  state?: string;
  value?: number;
  data?: Record<string, unknown>;
}

/** Integrator-provided writer, e.g. backed by `pg` with TIGER_DATABASE_URL. */
export interface TelemetrySink {
  insert(records: TelemetryRecord[]): Promise<void>;
}

/** Table for Tiger Data (TimescaleDB). Run once on the cloud database. */
export const TIGER_TELEMETRY_SQL = `
CREATE TABLE IF NOT EXISTS guardian_telemetry (
  at TIMESTAMPTZ NOT NULL,
  device TEXT NOT NULL,
  session_id TEXT,
  type TEXT NOT NULL,
  kind TEXT,
  state TEXT,
  value DOUBLE PRECISION,
  data JSONB
);
SELECT create_hypertable('guardian_telemetry', 'at', if_not_exists => TRUE);
`;

export interface TelemetryOptions {
  databaseUrl?: string;
  sink?: TelemetrySink;
  maxBuffer?: number;
  batchSize?: number;
}

export class TelemetrySync {
  private buffer: TelemetryRecord[] = [];
  private flushing = false;
  lastError: string | null = null;
  sent = 0;
  dropped = 0;
  private readonly maxBuffer: number;
  private readonly batchSize: number;

  constructor(private readonly o: TelemetryOptions = {}) {
    this.maxBuffer = o.maxBuffer ?? 1000;
    this.batchSize = o.batchSize ?? 100;
  }

  /** Remote sync only with both TIGER_DATABASE_URL and a sink. */
  get enabled(): boolean {
    return !!this.o.databaseUrl && !!this.o.sink;
  }

  get pending(): readonly TelemetryRecord[] {
    return this.buffer;
  }

  record(r: TelemetryRecord): void {
    this.buffer.push(r);
    if (this.buffer.length > this.maxBuffer) {
      this.dropped += this.buffer.length - this.maxBuffer;
      this.buffer = this.buffer.slice(-this.maxBuffer);
    }
  }

  /** Sends buffered records; on failure they stay buffered for the next try. */
  async flush(): Promise<{ sent: number; pending: number; error?: string }> {
    if (!this.enabled || this.flushing || this.buffer.length === 0) return { sent: 0, pending: this.buffer.length };
    this.flushing = true;
    let sent = 0;
    try {
      while (this.buffer.length) {
        const batch = this.buffer.slice(0, this.batchSize);
        await this.o.sink!.insert(batch);
        this.buffer.splice(0, batch.length);
        sent += batch.length;
      }
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.flushing = false;
      this.sent += sent;
    }
    return { sent, pending: this.buffer.length, ...(this.lastError ? { error: this.lastError } : {}) };
  }
}

export function swarmsFromEnv(env: Record<string, string | undefined> = process.env, extra: Partial<SwarmsOptions> = {}): SwarmsReviewClient {
  return new SwarmsReviewClient({ apiKey: env.SWARMS_API_KEY, baseUrl: env.MORPHIX_SWARMS_BASE_URL, ...extra });
}

export function telemetryFromEnv(env: Record<string, string | undefined> = process.env, sink?: TelemetrySink): TelemetrySync {
  return new TelemetrySync({ databaseUrl: env.TIGER_DATABASE_URL?.trim() || undefined, sink: env.TIGER_DATABASE_URL?.trim() ? sink : undefined });
}
