import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GEMINI_VISION_MODEL, GeminiVisionClient, geminiVisionFromEnv, parseGeminiAnswer } from "@morphix/guardian";
import type { FetchLike } from "@morphix/guardian";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const answer = (o: object | string) => ({
  candidates: [{ content: { parts: [{ text: typeof o === "string" ? o : JSON.stringify(o) }] }, finishReason: "STOP" }],
});
const okFetch = (body: unknown, status = 200) =>
  vi.fn<FetchLike>(async () => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }));

describe("Gemini vision client", () => {
  it("is unavailable without a key and never calls fetch", async () => {
    const f = okFetch({});
    const c = new GeminiVisionClient({ fetch: f });
    expect(c.available).toBe(false);
    expect(await c.verify({ jpeg })).toEqual({ status: "unavailable", reason: "no_api_key" });
    expect(f).not.toHaveBeenCalled();
  });

  it("sends generateContent with inline JPEG + JSON schema, key in header only", async () => {
    const f = okFetch(answer({ problem_type: "spaghetti", confidence: 0.83, explanation: "Tangled strands above the part." }));
    const c = new GeminiVisionClient({ apiKey: "test-key-123", model: "gemini-test-vision", fetch: f });
    const r = await c.verify({ jpeg, suspectedKind: "spaghetti", printerState: "BUILDING_FROM_SD", progress: 40, metrics: { spaghetti_score: 2.4 } });
    expect(r).toEqual({ status: "ok", problem: "spaghetti", confidence: 0.83, explanation: "Tangled strands above the part.", model: "gemini-test-vision", failureLikely: true });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test-vision:generateContent");
    expect(url).not.toContain("test-key-123");
    expect(init.headers["x-goog-api-key"]).toBe("test-key-123");
    const body = JSON.parse(init.body);
    const parts = body.contents[0].parts;
    expect(parts[0].text).toMatch(/QD330/);
    expect(parts[0].text).toMatch(/spaghetti/);
    expect(parts[1].inlineData).toEqual({ mimeType: "image/jpeg", data: Buffer.from(jpeg).toString("base64") });
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseJsonSchema.required).toEqual(["problem_type", "confidence", "explanation"]);
  });

  it("enforces the minimum interval and the daily cap", async () => {
    let t = Date.parse("2026-11-07T10:00:00Z");
    const f = okFetch(answer({ problem_type: "no_problem", confidence: 0.9, explanation: "ok" }));
    const c = new GeminiVisionClient({ apiKey: "k", fetch: f, minIntervalMs: 60_000, dailyCap: 2, now: () => t });
    expect((await c.verify({ jpeg })).status).toBe("ok");
    const limited = await c.verify({ jpeg });
    expect(limited).toMatchObject({ status: "unavailable", reason: "rate_limited", retryAfterMs: 60_000 });
    t += 60_000;
    expect((await c.verify({ jpeg })).status).toBe("ok");
    t += 60_000;
    expect(await c.verify({ jpeg })).toMatchObject({ reason: "daily_cap" });
    expect(c.usage()).toMatchObject({ callsToday: 2, dailyCap: 2 });
    t = Date.parse("2026-11-08T00:00:01Z");
    expect((await c.verify({ jpeg })).status).toBe("ok");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("maps HTTP, network and response errors to unavailable", async () => {
    const http = new GeminiVisionClient({ apiKey: "k", minIntervalMs: 0, fetch: okFetch({ error: { message: "quota" } }, 429) });
    expect(await http.verify({ jpeg })).toMatchObject({ status: "unavailable", reason: "http_error" });
    const net = new GeminiVisionClient({ apiKey: "k", minIntervalMs: 0, fetch: async () => { throw new Error("ENOTFOUND"); } });
    expect(await net.verify({ jpeg })).toMatchObject({ reason: "network_error", detail: "ENOTFOUND" });
    const big = new GeminiVisionClient({ apiKey: "k", maxImageBytes: 4, fetch: okFetch({}) });
    expect(await big.verify({ jpeg })).toMatchObject({ reason: "image_too_large" });
  });

  it("parses fenced JSON, clamps confidence and rejects junk", () => {
    expect(parseGeminiAnswer(answer('```json\n{"problem_type":"no_problem","confidence":1.4,"explanation":"fine"}\n```'), "m"))
      .toMatchObject({ status: "ok", problem: "no_problem", confidence: 1, failureLikely: false });
    expect(parseGeminiAnswer(answer({ problem_type: "camera_issue", confidence: 0.5, explanation: "dark" }), "m")).toMatchObject({ failureLikely: false });
    expect(parseGeminiAnswer(answer("I think it is fine"), "m")).toMatchObject({ reason: "bad_response" });
    expect(parseGeminiAnswer(answer({ problem_type: "ufo", confidence: 0.5 }), "m")).toMatchObject({ reason: "bad_response" });
    expect(parseGeminiAnswer({ candidates: [] }, "m")).toMatchObject({ reason: "bad_response" });
    expect(parseGeminiAnswer({ promptFeedback: { blockReason: "SAFETY" } }, "m")).toMatchObject({ detail: "blocked: SAFETY" });
  });

  it("reads configuration from env", () => {
    expect(geminiVisionFromEnv({}).available).toBe(false);
    expect(geminiVisionFromEnv({}).model).toBe(DEFAULT_GEMINI_VISION_MODEL);
    const c = geminiVisionFromEnv({ GEMINI_API_KEY: "k", MORPHIX_GEMINI_VISION_MODEL: "gemini-custom", MORPHIX_GEMINI_VISION_DAILY_CAP: "5" }, { fetch: okFetch({}) });
    expect(c.available).toBe(true);
    expect(c.model).toBe("gemini-custom");
    expect(c.usage().dailyCap).toBe(5);
  });
});
