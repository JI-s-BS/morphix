import { describe, expect, it } from "vitest";
import {
  analyzePhotos,
  checkPhotos,
  GeminiJsonClient,
  overallAxisOf,
  parseGeminiJson,
  Photo3dError,
  sniffImageMime,
  toMm,
} from "@morphix/photo3d";
import { analysisAnswer, fakeGemini, geminiBody, HEIC, JPEG, PNG } from "./photo3d-helpers";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as Photo3dError).code;
  }
  return "no error";
};

describe("photo input", () => {
  it("sniffs image types from bytes", () => {
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(HEIC)).toBe("image/heic");
    expect(sniffImageMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageMime(Buffer.from("hello"))).toBeNull();
  });

  it("rejects empty, non-image, too many and oversized photos", () => {
    expect(() => checkPhotos([])).toThrow(Photo3dError);
    expect(() => checkPhotos([{ mime: "image/jpeg", bytes: Buffer.from("<html>") }])).toThrow(/not a JPEG/);
    expect(() => checkPhotos(Array.from({ length: 9 }, () => ({ mime: "image/jpeg", bytes: JPEG })))).toThrow(/At most 8/);
    const big = new Uint8Array(15 * 1024 * 1024);
    big.set(JPEG);
    try {
      checkPhotos([{ mime: "image/jpeg", bytes: big }]);
      expect.unreachable();
    } catch (e) {
      expect((e as Photo3dError).code).toBe("MX-P3D-002");
    }
    // Declared type is ignored in favour of the bytes.
    expect(checkPhotos([{ mime: "image/png", bytes: JPEG }])[0].mime).toBe("image/jpeg");
  });

  it("converts units and maps overall-dimension labels", () => {
    expect(toMm(2, "in")).toBeCloseTo(50.8);
    expect(toMm(3.5, "cm")).toBe(35);
    expect(toMm(1, "furlong")).toBeNull();
    expect(overallAxisOf("Height")).toBe("height");
    expect(overallAxisOf("overall width")).toBe("width");
    expect(overallAxisOf("length")).toBe("depth");
    expect(overallAxisOf("hole diameter")).toBeNull();
  });
});

describe("Gemini JSON client", () => {
  it("sends inline images, the schema and the key header only", async () => {
    const g = fakeGemini({ analysis: [{ body: geminiBody(analysisAnswer()) }] });
    await analyzePhotos({ images: [{ mime: "image/jpeg", bytes: JPEG }, { mime: "image/png", bytes: PNG }], description: "replace my snapped phone stand", referenceObject: "credit-card" }, { gemini: g.client });
    const c = g.calls[0];
    expect(c.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect(c.headers["x-goog-api-key"]).toBe("test-key");
    expect(c.url).not.toContain("test-key");
    const parts = c.body.contents[0].parts;
    expect(parts.filter((p: any) => p.inlineData).map((p: any) => p.inlineData.mimeType)).toEqual(["image/jpeg", "image/png"]);
    expect(parts[0].text).toContain("85.60 x 53.98 mm");
    expect(c.body.generationConfig.responseMimeType).toBe("application/json");
    expect(c.body.generationConfig.responseJsonSchema.required).toContain("dimensions");
  });

  it("maps failures to MX-P3D codes", async () => {
    const no = new GeminiJsonClient({ apiKey: "", fetch: async () => ({ ok: true, status: 200, text: async () => "" }) });
    expect(await code(no.generateJson({ parts: [], schema: {} }))).toBe("MX-P3D-010");
    const http = (status: number, body = '{"error":{"message":"nope"}}') =>
      new GeminiJsonClient({ apiKey: "k", fetch: async () => ({ ok: false, status, text: async () => body }) }).generateJson({ parts: [], schema: {} });
    expect(await code(http(500))).toBe("MX-P3D-011");
    expect(await code(http(429))).toBe("MX-P3D-015");
    const net = new GeminiJsonClient({ apiKey: "k", fetch: async () => { throw new Error("ECONNRESET"); } });
    expect(await code(net.generateJson({ parts: [], schema: {} }))).toBe("MX-P3D-012");
    expect(() => parseGeminiJson(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }))).toThrow(/blocked/);
    expect(() => parseGeminiJson(geminiBody("{not json", "MAX_TOKENS"))).toThrow(/MAX_TOKENS/);
    expect(() => parseGeminiJson(JSON.stringify({ candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] }))).toThrow(Photo3dError);
    expect(parseGeminiJson(geminiBody("```json\n{\"a\":1}\n```"))).toEqual({ a: 1 });
  });

  it("aborts on the caller's signal", async () => {
    const ctl = new AbortController();
    const slow = new GeminiJsonClient({
      apiKey: "k",
      fetch: (_u, init) => new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted")))),
    });
    const p = slow.generateJson({ parts: [], schema: {}, signal: ctl.signal });
    ctl.abort();
    expect(await code(p)).toBe("MX-P3D-090");
  });
});

describe("analyzePhotos normalisation", () => {
  const run = (answer: unknown, input: Partial<Parameters<typeof analyzePhotos>[0]> = {}) =>
    analyzePhotos({ images: [{ mime: "image/jpeg", bytes: JPEG }], description: "make this", ...input }, { gemini: fakeGemini({ analysis: [{ body: geminiBody(answer) }] }).client });

  it("returns a functional openscad plan with a spec", async () => {
    const a = await run(analysisAnswer());
    expect(a.recommendedEngine).toBe("openscad");
    expect(a.object.mechanical).toBe(true);
    expect(a.openscadSpec?.holes).toEqual([{ description: "cable hole", diameterMm: 12, depthMm: null }]);
    expect(a.dimensions.width).toMatchObject({ valueMm: 80, method: "reference-object" });
    expect(a.needsAnswers).toBe(false);
    expect(a.model).toBe("gemini-test");
  });

  it("user measurements override Gemini's numbers", async () => {
    const a = await run(analysisAnswer(), { measurements: [{ label: "height", value: 2, unit: "in" }, { label: "slot width", value: 11, unit: "mm" }] });
    expect(a.dimensions.height).toMatchObject({ valueMm: 50.8, confidence: 1, method: "user-measurement" });
    expect(a.dimensions.width.valueMm).toBe(80);
  });

  it("asks questions only when confidence is low, max 3, and caps typical-size priors at 0.5", async () => {
    const low = analysisAnswer({
      dimensions: {
        width: { valueMm: 80, confidence: 0.9, method: "typical-size" },
        depth: { valueMm: 60, confidence: 0.4, method: "typical-size" },
        height: { valueMm: 50, confidence: 0.4, method: "typical-size" },
      },
      questions: ["How thick is your phone with its case?", "How wide?", "How tall?", "A fourth?"],
    });
    const a = await run(low);
    expect(a.needsAnswers).toBe(true);
    expect(a.questions).toHaveLength(3);
    expect(a.dimensions.width.confidence).toBe(0.5);
    // Once answers are given it does not ask again.
    const b = await run(low, { answers: [{ question: "How thick?", answer: "11 mm" }] });
    expect(b.needsAnswers).toBe(false);
  });

  it("fixes impossible engine choices", async () => {
    expect((await run(analysisAnswer({ recommendedEngine: "meshy-multi-image", category: "decorative" }))).recommendedEngine).toBe("meshy-image");
    expect((await run(analysisAnswer({ recommendedEngine: "scan" }))).recommendedEngine).toBe("openscad");
    expect((await run(analysisAnswer(), { hasScanFile: true })).recommendedEngine).toBe("scan");
    const noSpec = await run(analysisAnswer({ openscadSpec: { applicable: false } }));
    expect(noSpec.recommendedEngine).toBe("meshy-image");
    expect(noSpec.openscadSpec).toBeNull();
  });

  it("rejects an analysis without usable dimensions", async () => {
    expect(await code(run({ ...analysisAnswer(), dimensions: { width: { valueMm: -1 }, depth: {}, height: {} } }))).toBe("MX-P3D-013");
    expect(await code(run(analysisAnswer(), { description: "  " }))).toBe("MX-P3D-001");
  });
});
