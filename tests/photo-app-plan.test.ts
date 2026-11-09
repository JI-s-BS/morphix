import { describe, expect, it } from "vitest";
import {
  cadRequestFromPlan, cleanupInstruction, cleanupPhoto, finishCadModel, GeminiImageClient, geminiImageFromEnv, meshyRequestFromPlan,
  parseGeminiImage, Photo3dError, PhotoPlanStore, planPhotoModel, planView, prepareMeshyImages, recommendRoute, routeOptions,
  stripJpegMetadata, DEFAULT_GEMINI_IMAGE_MODEL, type PlanDeps,
} from "@morphix/photo3d";
import { analysisAnswer, boxStl, fakeGemini, geminiBody } from "./photo3d-helpers";
import { CLEAN_PNG, clipAnswer, fakeImageGemini, figureAnswer, JPEG, jpegWithExif, PNG } from "./photo-app-helpers";

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as Photo3dError).code);

function deps(o: { analysis: unknown; images?: GeminiImageClient | null; meshy?: boolean; cad?: boolean; credits?: number; maxCredits?: number }) {
  const g = fakeGemini({ analysis: [{ body: geminiBody(o.analysis) }] });
  const img = o.images === undefined ? fakeImageGemini() : null;
  const d: PlanDeps = {
    gemini: g.client,
    images: o.images === undefined ? img!.client : o.images ?? undefined,
    meshy: { available: o.meshy ?? true, credits: o.credits ?? 30, maxCredits: o.maxCredits },
    cad: { available: o.cad ?? false },
    id: () => "plan1",
  };
  return { d, gemini: g, images: img };
}

describe("phone photo privacy", () => {
  it("strips EXIF/XMP and comments from JPEGs but keeps the image data", () => {
    const src = jpegWithExif();
    const out = stripJpegMetadata(src);
    expect(Buffer.from(out).includes(Buffer.from("GPS"))).toBe(false);
    expect(Buffer.from(out).includes(Buffer.from("hello"))).toBe(false);
    expect(Buffer.from(out).includes(Buffer.from("JFIF"))).toBe(true);
    expect([...out.subarray(-9)]).toEqual([0xff, 0xda, 0, 2, 0x11, 0x22, 0x33, 0xff, 0xd9]);
  });
  it("leaves non-JPEG and malformed input unchanged", () => {
    expect(stripJpegMetadata(PNG)).toBe(PNG);
    const broken = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1, 2]);
    expect(stripJpegMetadata(broken)).toBe(broken);
  });
});

describe("Gemini photo cleanup", () => {
  it("sends the photo with an edit instruction to the configured image model", async () => {
    const f = fakeImageGemini();
    const out = await f.client.edit({ image: { mime: "image/jpeg", bytes: JPEG }, instruction: cleanupInstruction("the red can", "a pen holder") });
    expect(out).toEqual({ mime: "image/png", bytes: CLEAN_PNG });
    const c = f.calls[0];
    expect(c.url).toMatch(/\/models\/gemini-image-test:generateContent$/);
    expect(c.headers["x-goog-api-key"]).toBe("img-key");
    expect(c.body.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(c.body.contents[0].parts[0].text).toContain("the red can");
    expect(c.body.contents[0].parts[0].text).toMatch(/plain, evenly lit white background/);
    expect(c.body.contents[0].parts[1].inlineData.mimeType).toBe("image/jpeg");
  });
  it("defaults to the stable Nano Banana model and reads MORPHIX_GEMINI_IMAGE_MODEL", () => {
    expect(geminiImageFromEnv({ GEMINI_API_KEY: "k" }).model).toBe(DEFAULT_GEMINI_IMAGE_MODEL);
    expect(geminiImageFromEnv({ GEMINI_API_KEY: "k", MORPHIX_GEMINI_IMAGE_MODEL: "gemini-3-pro-image" }).model).toBe("gemini-3-pro-image");
    expect(geminiImageFromEnv({}).available).toBe(false);
  });
  it("maps image answers and failures to MX-P3D codes", async () => {
    expect(parseGeminiImage(JSON.stringify({ candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/png", data: Buffer.from(CLEAN_PNG).toString("base64") } }] } }] })).mime).toBe("image/png");
    expect(() => parseGeminiImage(JSON.stringify({ candidates: [{ content: { parts: [{ text: "no" }] }, finishReason: "STOP" }] }))).toThrow(/no image/);
    expect(() => parseGeminiImage(JSON.stringify({ candidates: [{ finishReason: "IMAGE_SAFETY" }] }))).toThrowError(expect.objectContaining({ code: "MX-P3D-014" }));
    const http = fakeImageGemini(() => ({ status: 500, body: JSON.stringify({ error: { message: "boom" } }) }));
    expect(await code(http.client.edit({ image: { mime: "image/jpeg", bytes: JPEG }, instruction: "x" }))).toBe("MX-P3D-011");
    const quota = fakeImageGemini(() => ({ status: 429, body: "{}" }));
    expect(await code(quota.client.edit({ image: { mime: "image/jpeg", bytes: JPEG }, instruction: "x" }))).toBe("MX-P3D-015");
    expect(await code(new GeminiImageClient({}).edit({ image: { mime: "image/jpeg", bytes: JPEG }, instruction: "x" }))).toBe("MX-P3D-061");
  });
  it("keeps the original photo (with a note) when cleanup fails", async () => {
    const bad = fakeImageGemini(() => ({ status: 500, body: "{}" }));
    const r = await cleanupPhoto({ mime: "image/jpeg", bytes: JPEG }, { subject: "toy", description: "a toy" }, { images: bad.client });
    expect(r.cleaned).toBe(false);
    expect(r.image.bytes).toBe(JPEG);
    expect(r.note).toMatch(/original photo is used/);
    const none = await cleanupPhoto({ mime: "image/jpeg", bytes: JPEG }, { subject: "toy", description: "a toy" }, {});
    expect(none.cleaned).toBe(false);
  });
});

describe("photo plan (phone flow)", () => {
  it("recommends Meshy for a figure, cleans the photo up front and spends nothing", async () => {
    const { d, gemini, images } = deps({ analysis: figureAnswer() });
    const plan = await planPhotoModel({ images: [{ mime: "image/jpeg", bytes: jpegWithExif() }], description: "a keychain of my friend" }, d);
    expect(plan.recommended).toBe("meshy");
    expect(plan.options.map((o) => o.route)).toEqual(["meshy", "cad"]);
    expect(plan.options[0]).toMatchObject({ title: "Meshy", recommended: true, available: true, credits: 30 });
    expect(plan.options[1]).toMatchObject({ title: "Claude CAD", available: false, unavailableReason: expect.stringMatching(/not available yet/i) });
    expect(plan.cleanup).toMatchObject({ needed: true, ready: true, cleaned: true, model: "gemini-image-test" });
    expect(plan.meshyImages).toEqual([{ mime: "image/png", bytes: CLEAN_PNG }]);
    // EXIF never reaches Gemini.
    const sent = Buffer.from(gemini.calls[0].body.contents[0].parts.find((p: any) => p.inlineData).inlineData.data, "base64");
    expect(sent.includes(Buffer.from("GPS"))).toBe(false);
    expect(images!.calls[0].body.contents[0].parts[0].text).toContain("the person in the blue jacket");
    // The analysis prompt asks for the photo/subject assessment.
    expect(gemini.calls[0].body.generationConfig.responseJsonSchema.properties.photo).toBeTruthy();

    const view = planView(plan);
    expect(view).toMatchObject({ id: "plan1", recommended: "meshy", photoCount: 1, cleanup: { previews: 1, cleaned: true }, started: null });
    expect(JSON.stringify(view)).not.toContain("bytes");
  });

  it("recommends Claude CAD for a functional part and does not clean until Meshy is chosen", async () => {
    const { d, images } = deps({ analysis: clipAnswer(), cad: true });
    const plan = await planPhotoModel({ images: [{ mime: "image/jpeg", bytes: JPEG }, { mime: "image/jpeg", bytes: JPEG }], description: "a replacement for this broken clip" }, d);
    expect(plan.recommended).toBe("cad");
    expect(plan.options[0]).toMatchObject({ route: "cad", recommended: true, available: true, credits: 0 });
    expect(plan.cleanup.ready).toBe(false);
    expect(images!.calls).toHaveLength(0);
    // User picks Meshy anyway: same object in both photos -> multi-image, both cleaned.
    await prepareMeshyImages(plan, d);
    expect(images!.calls).toHaveLength(2);
    expect(plan.meshySources).toEqual([0, 1]);
    expect(meshyRequestFromPlan(plan).engine).toBe("meshy-multi-image");
    const orig = meshyRequestFromPlan(plan, { useOriginal: true });
    expect(orig.images!.map((i) => i.bytes)).toEqual([JPEG, JPEG]);
    expect(orig.analysis).toBe(plan.analysis);
    const cad = cadRequestFromPlan(plan);
    expect(cad).toMatchObject({ description: "a replacement for this broken clip", objectName: "replacement belt clip" });
    expect(cad.spec?.holes[0].diameterMm).toBe(12);
    expect(cad.images).toHaveLength(2);
  });

  it("prepares Meshy up front when CAD is recommended but not available", async () => {
    const { d, images } = deps({ analysis: clipAnswer(), cad: false });
    const plan = await planPhotoModel({ images: [{ mime: "image/jpeg", bytes: JPEG }], description: "a replacement clip" }, d);
    expect(plan.recommended).toBe("cad");
    expect(plan.cleanup.ready).toBe(true);
    expect(images!.calls).toHaveLength(1);
  });

  it("sends a clean photo as it is", async () => {
    const { d, images } = deps({ analysis: figureAnswer({ photo: { subject: "toy", needsCleanup: false } }) });
    const plan = await planPhotoModel({ images: [{ mime: "image/jpeg", bytes: JPEG }], description: "a figurine of this toy" }, d);
    expect(images!.calls).toHaveLength(0);
    expect(plan.cleanup).toMatchObject({ needed: false, ready: true, cleaned: false });
    expect(plan.meshyImages![0].bytes).toEqual(JPEG);
  });

  it("marks Meshy unavailable when it is not configured or over the credit limit", () => {
    expect(routeOptions("meshy", { meshy: { available: false, credits: 30 }, cad: { available: true } })[0]).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/MESHY_API_KEY/) });
    expect(routeOptions("meshy", { meshy: { available: true, credits: 30, maxCredits: 20 }, cad: { available: true } })[0]).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/limit is 20/) });
  });

  it("rejects bad input before calling Gemini", async () => {
    const { d, gemini } = deps({ analysis: figureAnswer() });
    expect(await code(planPhotoModel({ images: [{ mime: "image/jpeg", bytes: JPEG }], description: "  " }, d))).toBe("MX-P3D-001");
    expect(await code(planPhotoModel({ images: Array(5).fill({ mime: "image/jpeg", bytes: JPEG }), description: "x" }, d))).toBe("MX-P3D-001");
    expect(await code(planPhotoModel({ images: [{ mime: "image/gif", bytes: Uint8Array.from([0x47, 0x49, 0x46, 0x38]) }], description: "x" }, d))).toBe("MX-P3D-001");
    expect(gemini.calls).toHaveLength(0);
  });

  it("routes by what the thing is for", () => {
    const a = (over: Record<string, unknown>) => ({ object: { name: "can", description: "", category: "decorative", mechanical: false }, recommendedEngine: "meshy-image", engineReason: "", ...over }) as never;
    expect(recommendRoute(a({})).route).toBe("meshy");
    expect(recommendRoute(a({ recommendedEngine: "openscad" })).route).toBe("cad");
    expect(recommendRoute(a({ object: { name: "pen-holder can", description: "", category: "functional", mechanical: true } })).route).toBe("cad");
    expect(recommendRoute(a({ engineReason: "Organic shape (no usable CAD spec, so Meshy is used)" })).reason).toBe("Organic shape");
  });

  it("finishes a CAD STL: repaired, on the bed, size reported", () => {
    const out = finishCadModel({ stl: boxStl(40, 20, 10), warnings: ["check the hole"] });
    expect(out.sizeMm).toEqual({ x: 40, y: 20, z: 10 });
    expect(out.warnings).toContain("check the hole");
    expect(() => finishCadModel({ stl: new Uint8Array(10) })).toThrowError(expect.objectContaining({ code: "MX-P3D-071" }));
    expect(finishCadModel({ stl: boxStl(300, 20, 10) }).warnings.join(" ")).toMatch(/printer fits/);
  });

  it("keeps plans for a while, then forgets them", () => {
    let t = Date.parse("2026-11-07T12:00:00Z");
    const store = new PhotoPlanStore({ ttlMs: 60_000, max: 2, now: () => t });
    const mk = (id: string) => ({ id, createdAt: new Date(t).toISOString() }) as never;
    store.put(mk("a"));
    expect(store.get("a").id).toBe("a");
    t += 61_000;
    expect(() => store.get("a")).toThrowError(expect.objectContaining({ code: "MX-P3D-080" }));
    store.put(mk("b")); store.put(mk("c")); store.put(mk("d"));
    expect(store.size).toBe(2);
    expect(() => store.get("b")).toThrow();
  });

  it("normalises the photo assessment from Gemini", async () => {
    const { d } = deps({ analysis: figureAnswer({ photo: { subject: "", needsCleanup: "yes", bestPhotoIndex: 7 } }) });
    const plan = await planPhotoModel({ images: [{ mime: "image/jpeg", bytes: JPEG }], description: "a figure" }, d);
    expect(plan.analysis.photo).toEqual({ subject: "keychain figure of a person", needsCleanup: false, cleanupReason: "", bestPhotoIndex: 0, sameObjectAllPhotos: false });
    // Older answers without the field still work.
    const old = deps({ analysis: analysisAnswer() });
    const p2 = await planPhotoModel({ images: [{ mime: "image/jpeg", bytes: JPEG }], description: "a stand" }, { ...old.d, cad: { available: true } });
    expect(p2.analysis.photo).toBeUndefined();
    expect(p2.cleanup.needed).toBe(false);
  });
});
