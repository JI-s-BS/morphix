import { describe, expect, it } from "vitest";
import { computeBounds, parseStl, writeBinaryStl } from "@morphix/slicing";
import { engineOrder, GeminiJsonClient, MeshyImageClient, P3D_ERRORS, photo3dDepsFromEnv, photoToModel, type Photo3dProgress } from "@morphix/photo3d";
import { analysisAnswer, box, boxGlbYUp, boxStl, fakeGemini, fakeMeshy, fakeOpenscad, geminiBody, JPEG, missingOpenscad, PNG } from "./photo3d-helpers";

const GOOD = "translate([-40,-30,0]) cube([80,60,50]);";
const photos = [{ mime: "image/jpeg", bytes: JPEG }];

function meshyDone(glb: Buffer) {
  return fakeMeshy({
    polls: [{ status: "IN_PROGRESS", progress: 50 }, { status: "SUCCEEDED", progress: 100, consumed_credits: 20, model_urls: { glb: "https://files.test/m.glb" } }],
    files: { "m.glb": glb },
  });
}

describe("photoToModel", () => {
  it("functional part: analyse -> OpenSCAD -> exact-size STL with progress", async () => {
    const g = fakeGemini({ analysis: [{ body: geminiBody(analysisAnswer()) }], scad: [{ body: geminiBody({ scad: GOOD }) }] });
    const os = fakeOpenscad(() => ({ stl: boxStl(80, 60, 50) }));
    const progress: Photo3dProgress[] = [];
    const r = await photoToModel({ images: photos, description: "replace my snapped phone stand", referenceObject: "credit-card" }, { gemini: g.client, openscad: { exec: os.exec } }, (p) => progress.push(p));
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(r.engine).toBe("openscad");
    expect(r.files.scad).toBe(GOOD);
    expect(r.dimensions.check?.ok).toBe(true);
    expect(r.dimensions.actualMm).toEqual({ x: 80, y: 60, z: 50 });
    expect(r.costCredits).toBe(0);
    expect(r.warnings).toEqual([]);
    const b = computeBounds(parseStl(r.files.stl));
    expect(b.min.z).toBe(0);
    expect(r.report.validation.watertight).toBe(true);
    expect(r.report.fitsBuildVolume).toBe(true);
    expect(progress.map((p) => p.stage)).toEqual(expect.arrayContaining(["validate", "analyze", "design", "compile", "verify", "done"]));
    const pct = progress.map((p) => p.progress);
    expect(pct).toEqual([...pct].sort((a, b) => a - b));
    expect(pct[pct.length - 1]).toBe(100);
  });

  it("returns needsAnswers when the size is uncertain, then builds once answered", async () => {
    const low = analysisAnswer({
      dimensions: {
        width: { valueMm: 80, confidence: 0.3, method: "typical-size" },
        depth: { valueMm: 60, confidence: 0.3, method: "typical-size" },
        height: { valueMm: 50, confidence: 0.3, method: "typical-size" },
      },
      questions: ["How wide is your phone?"],
    });
    const g = fakeGemini({ analysis: [{ body: geminiBody(low) }], scad: [{ body: geminiBody({ scad: GOOD }) }] });
    const os = fakeOpenscad(() => ({ stl: boxStl(80, 60, 50) }));
    const first = await photoToModel({ images: photos, description: "phone stand" }, { gemini: g.client, openscad: { exec: os.exec } });
    expect(first).toMatchObject({ status: "needsAnswers", questions: ["How wide is your phone?"], costCredits: 0 });
    expect(os.runs).toHaveLength(0);
    if (first.status !== "needsAnswers") return;
    // The user confirms the size instead: reuse the analysis, no new Gemini analysis call.
    const before = g.calls.length;
    const second = await photoToModel({ images: photos, description: "phone stand", analysis: first.analysis, dimensionsMm: { width: 80, depth: 60, height: 50 } }, { gemini: g.client, openscad: { exec: os.exec } });
    expect(second.status).toBe("done");
    expect(g.calls.length - before).toBe(1); // only the OpenSCAD call
    // Answers re-run the analysis with them in the prompt.
    const third = await photoToModel({ images: photos, description: "phone stand", answers: [{ question: "How wide is your phone?", answer: "75 mm" }] }, { gemini: g.client, openscad: { exec: os.exec } });
    expect(third.status).toBe("done");
    expect(JSON.stringify(g.calls.filter((c) => !c.body.generationConfig.responseJsonSchema.properties?.scad).pop()!.body)).toContain("75 mm");
    if (third.status === "done") expect(third.warnings.map((w) => w.code)).toContain("MX-P3D-053");
  });

  it("falls back from a missing openscad binary to Meshy and scales to the most confident dimension", async () => {
    const answer = analysisAnswer({
      dimensions: {
        width: { valueMm: 80, confidence: 0.6, method: "reference-object" },
        depth: { valueMm: 60, confidence: 0.6, method: "reference-object" },
        height: { valueMm: 50, confidence: 1, method: "user-measurement" },
      },
    });
    const g = fakeGemini({ analysis: [{ body: geminiBody(answer) }], scad: [{ body: geminiBody({ scad: GOOD }) }] });
    // Meshy model in arbitrary units with the same proportions (1.6 : 1.2 : 1).
    const m = meshyDone(boxGlbYUp(1.6, 1.2, 1));
    const tasks: unknown[] = [];
    const r = await photoToModel({ images: photos, description: "stand" }, { gemini: g.client, meshy: m.client, openscad: { exec: missingOpenscad }, onMeshyTask: (t) => tasks.push(t) });
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(r.engine).toBe("meshy-image");
    expect(r.report.attempts).toEqual([
      { engine: "openscad", ok: false, error: expect.objectContaining({ code: "MX-P3D-030" }) },
      { engine: "meshy-image", ok: true },
    ]);
    expect(r.report.meshy).toMatchObject({ taskId: "task-123", scaledBy: "height", scaleFactor: 0.05 });
    expect(r.dimensions.actualMm.z).toBeCloseTo(50, 1);
    expect(r.dimensions.actualMm.x).toBeCloseTo(80, 1);
    expect(r.files.glb).toBeDefined();
    expect(r.costCredits).toBe(20);
    expect(tasks).toEqual([{ kind: "image-to-3d", id: "task-123" }]);
  });

  it("decorative object with several photos uses multi-image Meshy", async () => {
    const answer = analysisAnswer({ category: "decorative", mechanical: false, recommendedEngine: "meshy-multi-image", openscadSpec: { applicable: false } });
    const g = fakeGemini({ analysis: [{ body: geminiBody(answer) }] });
    const m = meshyDone(boxGlbYUp(1.6, 1.2, 1));
    const r = await photoToModel({ images: [...photos, { mime: "image/png", bytes: PNG }], description: "my cat drawing as a figurine" }, { gemini: g.client, meshy: m.client });
    expect(r).toMatchObject({ status: "done", engine: "meshy-multi-image" });
    expect(m.calls[0].url).toContain("/openapi/v1/multi-image-to-3d");
  });

  it("refuses Meshy over the credit budget and reports one clear code", async () => {
    const answer = analysisAnswer({ category: "decorative", recommendedEngine: "meshy-image", openscadSpec: { applicable: false } });
    const g = fakeGemini({ analysis: [{ body: geminiBody(answer) }] });
    const m = meshyDone(boxGlbYUp(1, 1, 1));
    const r = await photoToModel({ images: photos, description: "a dragon" }, { gemini: g.client, meshy: m.client, maxCredits: 10 });
    expect(r).toMatchObject({ status: "failed", error: { code: "MX-P3D-092" }, costCredits: 0 });
    expect(m.calls).toHaveLength(0);
  });

  it("reports MX-P3D-091 when every engine fails", async () => {
    const g = fakeGemini({ analysis: [{ body: geminiBody(analysisAnswer()) }], scad: [{ body: geminiBody({ scad: GOOD }) }] });
    const r = await photoToModel({ images: photos, description: "stand" }, { gemini: g.client, meshy: new MeshyImageClient({}), openscad: { exec: missingOpenscad } });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") return;
    expect(r.error.code).toBe("MX-P3D-091");
    expect(r.attempts.map((a) => a.error?.code)).toEqual(["MX-P3D-030", "MX-P3D-020"]);
  });

  it("imports a scan without Gemini and warns about uncertain units or size", async () => {
    const r = await photoToModel({ description: "my scanned knob", scan: { name: "knob.stl", bytes: writeBinaryStl(box(0.04, 0.04, 0.03)) } }, {});
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(r.engine).toBe("scan");
    expect(r.report.scan).toMatchObject({ format: "stl", units: "m", unitsConfident: true });
    expect(r.dimensions.actualMm).toEqual({ x: 40, y: 40, z: 30 });
    expect(r.warnings).toEqual([]);
    const tiny = await photoToModel({ description: "knob", scan: { name: "knob.stl", bytes: writeBinaryStl(box(4, 4, 3)) } }, {});
    expect(tiny.status === "done" && tiny.dimensions.actualMm).toEqual({ x: 4, y: 4, z: 3 });
    expect(tiny.warnings.map((w) => w.code)).toEqual(["MX-P3D-043"]);
    const huge = await photoToModel({ description: "bust", scan: { name: "bust.stl", bytes: writeBinaryStl(box(300, 200, 250)) } }, {});
    expect(huge.warnings.map((w) => w.code)).toEqual(["MX-P3D-051"]);
  });

  it("uses the photo analysis to size a scan", async () => {
    const answer = analysisAnswer({ recommendedEngine: "scan" });
    const g = fakeGemini({ analysis: [{ body: geminiBody(answer) }] });
    const r = await photoToModel({ images: photos, description: "stand", scan: { name: "s.stl", bytes: writeBinaryStl(box(8, 6, 5)) } }, { gemini: g.client });
    expect(r.status === "done" && r.dimensions.actualMm).toEqual({ x: 80, y: 60, z: 50 });
    expect(r.status === "done" && r.dimensions.check?.ok).toBe(true);
  });

  it("validates input and missing Gemini with codes", async () => {
    expect(await photoToModel({ images: [], description: "x" }, {})).toMatchObject({ status: "failed", error: { code: "MX-P3D-001" } });
    expect(await photoToModel({ images: photos, description: "" }, {})).toMatchObject({ error: { code: "MX-P3D-001" } });
    expect(await photoToModel({ images: photos, description: "x" }, { gemini: new GeminiJsonClient({}) })).toMatchObject({ error: { code: "MX-P3D-010" } });
  });

  it("cancels with MX-P3D-090", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const g = fakeGemini({ analysis: [{ body: geminiBody(analysisAnswer()) }] });
    expect(await photoToModel({ images: photos, description: "x" }, { gemini: g.client, signal: ctl.signal })).toMatchObject({ status: "failed", error: { code: "MX-P3D-090" } });
  });

  it("engine order honours overrides and resume", () => {
    const p = [{ mime: "image/jpeg" as const, bytes: JPEG }, { mime: "image/jpeg" as const, bytes: JPEG }];
    expect(engineOrder({ description: "x" }, null, p, true)).toEqual(["meshy-multi-image"]);
    expect(engineOrder({ description: "x", engine: "openscad" }, null, p, true)).toEqual(["openscad", "meshy-multi-image"]);
    expect(engineOrder({ description: "x", engine: "openscad" }, null, p, false)).toEqual(["openscad"]);
    expect(engineOrder({ description: "x", resumeMeshyTask: { kind: "image-to-3d", id: "t" } }, null, p, true)).toEqual(["meshy-image"]);
  });

  it("builds deps from the environment and documents every code", () => {
    const d = photo3dDepsFromEnv({ GEMINI_API_KEY: "g", MORPHIX_GEMINI_VISION_MODEL: "gemini-x", MESHY_API_KEY: "m", MORPHIX_OPENSCAD_BIN: "/usr/bin/openscad", MORPHIX_PHOTO3D_MAX_CREDITS: "30" });
    expect(d.gemini?.model).toBe("gemini-x");
    expect(d.meshy?.available).toBe(true);
    expect(d.openscad?.bin).toBe("/usr/bin/openscad");
    expect(d.maxCredits).toBe(30);
    expect(photo3dDepsFromEnv({}).gemini?.model).toBe("gemini-3.8-flash");
    for (const k of Object.keys(P3D_ERRORS)) expect(k).toMatch(/^MX-P3D-\d{3}$/);
  });
});
