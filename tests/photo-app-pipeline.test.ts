// End to end on the Pi side: PhotoPipeline's phone flow with a real database, storage and
// job manager, and fake Gemini (analysis + image cleanup), Meshy and Claude CAD.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger, Storage } from "@morphix/storage";
import { MorphixDb } from "@morphix/database";
import { computeBounds, parseStl } from "@morphix/slicing";
import type { CadPhotoRequest, PhotoToModelDeps } from "@morphix/photo3d";
import type { Ctx } from "../apps/desktop/electron/context";
import { Jobs } from "../apps/desktop/electron/jobs";
import { PhotoPipeline } from "../apps/desktop/electron/photo";
import { boxGlbYUp, boxStl, fakeGemini, fakeMeshy, geminiBody } from "./photo3d-helpers";
import { clipAnswer, fakeImageGemini, figureAnswer, JPEG } from "./photo-app-helpers";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));

async function until<T>(fn: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(analysis: unknown, o: { meshy?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "morphix-photo-app-")); roots.push(root);
  const storage = new Storage(root); storage.init();
  const db = await MorphixDb.open(storage);
  const ctx: Ctx = { db, storage, log: new Logger(storage), send: () => {}, event: () => {}, url: (r) => (r ? `/library/${r}` : null), currentProjectId: null };
  const jobs = new Jobs(ctx);
  const prepared: { versionId: string; jobId: string | null }[] = [];
  const printing = { prepare: async (versionId: string, _s: unknown, jobId: string | null) => { prepared.push({ versionId, jobId }); return {} as never; } };
  const g = fakeGemini({ analysis: [{ body: geminiBody(analysis) }] });
  const img = fakeImageGemini();
  const meshy = fakeMeshy({
    polls: [{ status: "IN_PROGRESS", progress: 40 }, { status: "SUCCEEDED", progress: 100, consumed_credits: 20, model_urls: { glb: "https://files.test/m.glb" } }],
    files: { "m.glb": boxGlbYUp(20, 10, 40) },
  });
  const deps: PhotoToModelDeps = { gemini: g.client, ...(o.meshy === false ? {} : { meshy: meshy.client }), meshyDefaults: { model: "meshy-6" } };
  const photo = new PhotoPipeline(ctx, jobs, {} as never, printing as never, { photo3d: () => deps, images: () => img.client });
  return { ctx, jobs, photo, prepared, gemini: g, img, meshy };
}

describe("PhotoPipeline: phone Photo to 3D", () => {
  it("Meshy route: plan is free, the tap starts one job, the model lands in My Things, nothing prints", async () => {
    const s = await setup(figureAnswer());
    const plan = await s.photo.analyzeForRemote({ images: [{ mime: "image/jpeg", bytes: Buffer.from(JPEG) }], description: "a keychain of my friend", owner: "morphix-remote" });
    expect(plan).toMatchObject({ recommended: "meshy", cleanup: { cleaned: true, previews: 1 } });
    expect(plan.options.find((o) => o.route === "meshy")).toMatchObject({ credits: 20, available: true });
    expect(plan.options.find((o) => o.route === "cad")).toMatchObject({ available: false });
    expect(s.meshy.calls).toHaveLength(0); // nothing generated before the choice
    expect(s.jobs.list()).toHaveLength(0);
    expect(s.photo.planPreview(plan.id, 0)?.mime).toBe("image/png");

    const started = await s.photo.createFromPlan({ planId: plan.id, route: "meshy", owner: "morphix-remote" });
    expect(started).toMatchObject({ route: "meshy", credits: 20 });
    // A double tap returns the same job and never creates a second Meshy task.
    expect((await s.photo.createFromPlan({ planId: plan.id, route: "meshy", owner: "morphix-remote" })).jobId).toBe(started.jobId);

    await until(() => s.prepared.length > 0);
    expect(s.prepared[0].jobId).toBe(started.jobId);
    const creates = s.meshy.calls.filter((c) => c.method === "POST");
    expect(creates).toHaveLength(1);
    // Meshy got the cleaned PNG, not the original JPEG.
    expect(JSON.stringify(creates[0].body)).toContain("data:image/png;base64,");
    const job = s.jobs.manager.get(started.jobId)!;
    expect(job.meta).toMatchObject({ planId: plan.id, route: "meshy", engine: "meshy-image" });
    expect(job.stages.map((x) => x.key)).not.toContain("print");
    const v = s.ctx.db.get("SELECT * FROM model_versions WHERE id = ?", [job.meta!.versionId as string])!;
    expect(v.source).toBe("meshy");
    const stl = s.ctx.storage.path(...String(v.stl_rel_path).split("/"));
    expect(existsSync(stl)).toBe(true);
    // Scaled to the estimated 60 mm height.
    const { readFileSync } = await import("node:fs");
    expect(computeBounds(parseStl(readFileSync(stl))).size.z).toBeCloseTo(60, 0);
  });

  it("Meshy with the original photo when the user unticks the cleaned one", async () => {
    const s = await setup(figureAnswer());
    const plan = await s.photo.analyzeForRemote({ images: [{ mime: "image/jpeg", bytes: Buffer.from(JPEG) }], description: "a figure", owner: "o" });
    await s.photo.createFromPlan({ planId: plan.id, route: "meshy", useOriginal: true, owner: "o" });
    await until(() => s.prepared.length > 0);
    expect(JSON.stringify(s.meshy.calls.find((c) => c.method === "POST")!.body)).toContain("data:image/jpeg;base64,");
  });

  it("Claude CAD route says 'not available yet' until generateCad is wired, then builds", async () => {
    const s = await setup(clipAnswer());
    const plan = await s.photo.analyzeForRemote({ images: [{ mime: "image/jpeg", bytes: Buffer.from(JPEG) }], description: "a replacement for this broken clip", owner: "o" });
    expect(plan.recommended).toBe("cad");
    await expect(s.photo.createFromPlan({ planId: plan.id, route: "cad", owner: "o" })).rejects.toMatchObject({ code: "MX-P3D-070" });
    expect(s.jobs.list()).toHaveLength(0);

    const requests: CadPhotoRequest[] = [];
    s.photo.generateCad = async (req, ctx) => { requests.push(req); ctx.onProgress?.({ progress: 50, detail: "Claude is writing the CAD" }); return { stl: boxStl(40, 12, 8), scad: "cube([40,12,8]);", name: "Belt clip" }; };
    const plan2 = await (async () => { const t = await setup(clipAnswer()); t.photo.generateCad = s.photo.generateCad; return { t, view: await t.photo.analyzeForRemote({ images: [{ mime: "image/jpeg", bytes: Buffer.from(JPEG) }], description: "a replacement for this broken clip", owner: "o" }) }; })();
    expect(plan2.view.options[0]).toMatchObject({ route: "cad", available: true, recommended: true, credits: 0 });
    const started = await plan2.t.photo.createFromPlan({ planId: plan2.view.id, route: "cad", owner: "o" });
    await until(() => plan2.t.prepared.length > 0);
    expect(requests[0]).toMatchObject({ description: "a replacement for this broken clip", objectName: "replacement belt clip" });
    const job = plan2.t.jobs.manager.get(started.jobId)!;
    expect(job.meta).toMatchObject({ route: "cad", engine: "claude-cad", credits: 0 });
    const p = plan2.t.ctx.db.get("SELECT * FROM projects WHERE id = ?", [job.meta!.projectId as string])!;
    expect(p.title).toBe("Belt clip");
    expect(plan2.t.meshy.calls).toHaveLength(0);
  });

  it("a CAD failure fails the job with a clear code", async () => {
    const s = await setup(clipAnswer());
    s.photo.generateCad = async () => { throw new Error("Claude is overloaded"); };
    const plan = await s.photo.analyzeForRemote({ images: [{ mime: "image/jpeg", bytes: Buffer.from(JPEG) }], description: "clip", owner: "o" });
    const started = await s.photo.createFromPlan({ planId: plan.id, route: "cad", owner: "o" });
    const job = await until(() => { const j = s.jobs.manager.get(started.jobId); return j?.status === "failed" ? j : null; });
    expect(job.error?.code).toBe("MX-P3D-071");
  });

  it("refuses Meshy when it isn't configured and unknown plans", async () => {
    const s = await setup(figureAnswer(), { meshy: false });
    const plan = await s.photo.analyzeForRemote({ images: [{ mime: "image/jpeg", bytes: Buffer.from(JPEG) }], description: "figure", owner: "o" });
    expect(plan.options.find((o) => o.route === "meshy")).toMatchObject({ available: false });
    await expect(s.photo.createFromPlan({ planId: plan.id, route: "meshy", owner: "o" })).rejects.toMatchObject({ code: "MX-P3D-081" });
    await expect(s.photo.createFromPlan({ planId: "nope", route: "meshy", owner: "o" })).rejects.toMatchObject({ code: "MX-P3D-080" });
  });
});
