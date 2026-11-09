import { describe, expect, it, vi } from "vitest";
import {
  ADVISOR_RESPONSE_SCHEMA,
  DEFAULT_GEMINI_TEXT_MODEL,
  adviseSlicing,
  advisorGeminiFromEnv,
  autoOrient,
  computeBounds,
  overhangStats,
  parseGeminiAdvice,
  validateMesh,
  type AdvisorFetch,
  type AdviseSlicingInput,
  type Mesh,
} from "@morphix/slicing";
import { box } from "./phase3-fixtures";
import { tShape } from "./advisor-fixtures";

const PRUSA = { kind: "prusaslicer" as const, path: "/usr/bin/prusa-slicer", version: "2.9.0" };
const input = (mesh: Mesh, extra: Partial<AdviseSlicingInput> = {}): AdviseSlicingInput => ({
  size: computeBounds(mesh).size,
  validation: validateMesh(mesh),
  overhang: overhangStats(mesh),
  orientation: autoOrient(mesh, { keepBias: Infinity }),
  availableSlicers: [PRUSA],
  ...extra,
});

function geminiReply(answer: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetch: AdvisorFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const payload = { candidates: [{ content: { parts: [{ text: typeof answer === "string" ? answer : JSON.stringify(answer) }] } }] };
    return { ok: status < 400, status, json: async () => payload, text: async () => "server says no" };
  };
  return { fetch, calls };
}

const GOOD = { layer_height_mm: 0.16, infill_percent: 20, walls: 3, supports: "none", orientation: "auto", brim: false, brim_width_mm: 0, reasons: ["Smoother layers will look nicer."], confidence: 0.8 };

describe("adviseSlicing with Gemini", () => {
  it("is heuristic-only without a key (no request is made)", async () => {
    const { fetch, calls } = geminiReply(GOOD);
    expect((await adviseSlicing(input(box(30, 30, 30)), { gemini: { fetch } })).source).toBe("heuristic");
    expect((await adviseSlicing(input(box(30, 30, 30)))).source).toBe("heuristic");
    expect(calls).toHaveLength(0);
  });

  it("asks generateContent for schema JSON and uses the refined answer", async () => {
    const { fetch, calls } = geminiReply(GOOD);
    const a = await adviseSlicing(input(box(30, 30, 30), { description: "a cute cat" }), { gemini: { apiKey: "k-123", fetch } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_TEXT_MODEL}:generateContent`);
    expect(calls[0].headers["x-goog-api-key"]).toBe("k-123");
    expect(calls[0].url).not.toContain("k-123");
    expect(calls[0].body.generationConfig).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: ADVISOR_RESPONSE_SCHEMA });
    expect(calls[0].body.contents[0].parts[0].text).toContain("a cute cat");
    expect(a).toMatchObject({ source: "gemini", model: DEFAULT_GEMINI_TEXT_MODEL, layerHeightMm: 0.16, infillPercent: 20, walls: 3, supports: "none", slicer: "prusaslicer", reasons: ["Smoother layers will look nicer."], confidence: 0.8 });
  });

  it("clamps out-of-range answers to safe values", async () => {
    const { fetch } = geminiReply({ ...GOOD, layer_height_mm: 0.6, infill_percent: 100, walls: 12, brim: true, brim_width_mm: 40, confidence: 3 });
    const a = await adviseSlicing(input(box(30, 30, 30)), { gemini: { apiKey: "k", fetch, model: "gemini-test" } });
    expect(a).toMatchObject({ layerHeightMm: 0.3, infillPercent: 80, walls: 5, brim: true, brimWidthMm: 10, confidence: 0.95, model: "gemini-test" });
  });

  it("never removes supports the geometry needs, nor a tall part's brim", async () => {
    const { fetch } = geminiReply({ ...GOOD, supports: "none" });
    const a = await adviseSlicing(input(tShape()), { gemini: { apiKey: "k", fetch } });
    expect(a.supports).toBe("buildplate");
    expect(a.reasons.join(" ")).toMatch(/kept the supports/);
    const tall = await adviseSlicing(input(box(10, 10, 80)), { gemini: { apiKey: "k", fetch } });
    expect(tall.brim).toBe(true);
    expect(tall.brimWidthMm).toBe(8);
  });

  it("falls back to the heuristic on HTTP errors, bad JSON, bad fields and network errors", async () => {
    const cases: AdvisorFetch[] = [
      geminiReply(GOOD, 500).fetch,
      geminiReply("not json at all").fetch,
      geminiReply({ ...GOOD, supports: "everywhere" }).fetch,
      geminiReply({ ...GOOD, layer_height_mm: "thin" }).fetch,
      async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) }); },
    ];
    for (const fetch of cases) {
      const a = await adviseSlicing(input(box(30, 30, 30)), { gemini: { apiKey: "k", fetch } });
      expect(a.source).toBe("heuristic");
      expect(a.fallback!.code).toBe("MX-SLICE-012");
      expect(a.layerHeightMm).toBe(0.2);
      expect(a.reasons.at(-1)).toMatch(/built-in rules/);
      expect(JSON.stringify(a.fallback)).not.toContain('"k"');
    }
    const net = await adviseSlicing(input(box(30, 30, 30)), { gemini: { apiKey: "k", fetch: cases[4] } });
    expect(net.fallback!.context).toMatchObject({ underlying: "MX-NET-002" });
  });

  it("times out slow requests", async () => {
    vi.useFakeTimers();
    try {
      const fetch: AdvisorFetch = (_url, init) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      const p = adviseSlicing(input(box(30, 30, 30)), { gemini: { apiKey: "k", fetch, timeoutMs: 1000 } });
      await vi.advanceTimersByTimeAsync(1000);
      expect((await p).fallback!.code).toBe("MX-SLICE-012");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads its configuration from the environment", () => {
    expect(advisorGeminiFromEnv({})).toBe(false);
    expect(advisorGeminiFromEnv({ GEMINI_API_KEY: " k ", MORPHIX_GEMINI_TEXT_MODEL: "gemini-3.6-flash" })).toEqual({ apiKey: "k", model: "gemini-3.6-flash" });
    expect(advisorGeminiFromEnv({ GEMINI_API_KEY: "k" })).toEqual({ apiKey: "k", model: undefined });
  });

  it("parses fenced JSON and rejects blocked prompts", () => {
    const fenced = { candidates: [{ content: { parts: [{ text: "```json\n" + JSON.stringify(GOOD) + "\n```" }] } }] };
    expect(parseGeminiAdvice(fenced).walls).toBe(3);
    expect(() => parseGeminiAdvice({ promptFeedback: { blockReason: "SAFETY" } })).toThrow(/blocked/);
    expect(() => parseGeminiAdvice({ candidates: [] })).toThrow(/no text/);
  });
});
