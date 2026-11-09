import { describe, expect, it, vi } from "vitest";
import { localReview, SwarmsReviewClient, swarmsFromEnv, TelemetrySync, telemetryFromEnv } from "@morphix/guardian";
import type { FetchLike, TelemetryRecord } from "@morphix/guardian";

const gemini = (problem: string, confidence: number) =>
  ({ status: "ok", problem, confidence, explanation: "x", model: "m", failureLikely: !["no_problem", "uncertain", "camera_issue"].includes(problem) }) as never;

describe("local review fallback", () => {
  it("is conservative", () => {
    expect(localReview({ kind: "spaghetti", localConfirmed: true, localScore: 3 }).recommendation).toBe("pause_recommended");
    expect(localReview({ kind: "spaghetti", localConfirmed: true, localScore: 3, gemini: gemini("spaghetti", 0.9) }).recommendation).toBe("pause_recommended");
    expect(localReview({ kind: "spaghetti", localConfirmed: true, localScore: 3, gemini: gemini("no_problem", 0.8) }).recommendation).toBe("likely_false_alarm");
    expect(localReview({ kind: "spaghetti", localConfirmed: false, localScore: 1 }).recommendation).toBe("keep_watching");
  });
});

describe("Swarms review", () => {
  it("is off without SWARMS_API_KEY and uses the local review", async () => {
    const f = vi.fn<FetchLike>();
    const c = swarmsFromEnv({}, { fetch: f });
    expect(c.enabled).toBe(false);
    expect((await c.review({ kind: "detachment", localConfirmed: true, localScore: 0.4 })).source).toBe("local");
    expect(f).not.toHaveBeenCalled();
  });

  it("uses a parsable remote answer and falls back on errors", async () => {
    const reply = { output: [{ role: "failure-analyst", content: 'Verdict: {"recommendation":"keep_watching","confidence":0.4,"rationale":"looks ok"}' }] };
    const f = vi.fn<FetchLike>(async () => ({ ok: true, status: 200, json: async () => reply, text: async () => "" }));
    const c = new SwarmsReviewClient({ apiKey: "sk", fetch: f });
    expect(await c.review({ kind: "spaghetti", localConfirmed: true, localScore: 3 })).toEqual({ source: "swarms", recommendation: "keep_watching", confidence: 0.4, rationale: "looks ok" });
    expect(f.mock.calls[0][1].headers["x-api-key"]).toBe("sk");
    const down = new SwarmsReviewClient({ apiKey: "sk", fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" }) });
    expect(await down.review({ kind: "spaghetti", localConfirmed: true, localScore: 3 })).toMatchObject({ source: "local", fallbackReason: "swarms HTTP 503" });
  });
});

describe("Tiger Data telemetry", () => {
  const rec = (i: number): TelemetryRecord => ({ at: `t${i}`, sessionId: "s", type: "observation", value: i });

  it("is off without TIGER_DATABASE_URL: records stay local, bounded", async () => {
    const sink = { insert: vi.fn(async () => undefined) };
    const t = telemetryFromEnv({}, sink);
    expect(t.enabled).toBe(false);
    const small = new TelemetrySync({ maxBuffer: 3 });
    for (let i = 0; i < 5; i++) small.record(rec(i));
    expect(small.pending.map((r) => r.value)).toEqual([2, 3, 4]);
    expect(small.dropped).toBe(2);
    expect(await t.flush()).toEqual({ sent: 0, pending: 0 });
    expect(sink.insert).not.toHaveBeenCalled();
  });

  it("flushes in batches and keeps records when the sink fails", async () => {
    const batches: number[] = [];
    let fail = true;
    const sink = { insert: async (r: TelemetryRecord[]) => { if (fail) throw new Error("offline"); batches.push(r.length); } };
    const t = telemetryFromEnv({ TIGER_DATABASE_URL: "postgres://example" }, sink);
    const sync = new TelemetrySync({ databaseUrl: "postgres://example", sink, batchSize: 2 });
    expect(t.enabled).toBe(true);
    for (let i = 0; i < 5; i++) sync.record(rec(i));
    expect(await sync.flush()).toMatchObject({ sent: 0, pending: 5, error: "offline" });
    fail = false;
    expect(await sync.flush()).toEqual({ sent: 5, pending: 0 });
    expect(batches).toEqual([2, 2, 1]);
  });
});
