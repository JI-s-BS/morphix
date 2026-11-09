// Photo / drawing / scan → printable model, from the web portal (or later the touchscreen).
// analyse (free) → confirm cost when Meshy is needed → build → store → AI-advised print prep.
// Phone "Photo to 3D" (Morphix Remote): analyseForRemote → the user picks Meshy or Claude CAD
// on the phone (that tap is the approval) → createFromPlan → My Things. Nothing prints by itself.
import type { ClaudeDesignView } from "@morphix/shared";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzePhotos, cadRequestFromPlan, finishCadModel, geminiImageFromEnv, meshyImageCost, meshyRequestFromPlan, photo3dDepsFromEnv,
  photoToModel, planPhotoModel, planView, prepareMeshyImages, Photo3dError, PhotoPlanStore, P3D_ERRORS,
  type GeminiImageClient, type CadPhotoRequest, type CadProgress, type GenerateCadFn, type PhotoAnalysis, type PhotoPlan, type PhotoPlanView, type PhotoRoute,
  type PhotoToModelDeps, type PhotoToModelRequest,
} from "@morphix/photo3d";
import { registerErrorCodes, toMorphixError } from "@morphix/errors";
import { type Ctx, moveProject, now } from "./context";
import type { Actions } from "./actions";
import type { Jobs } from "./jobs";
import type { Printing } from "./printing";

let registered = false;
/** Fold the photo pipeline's MX-P3D codes into the shared error registry once. */
export function registerPhotoErrors(): void {
  if (registered) return;
  registered = true;
  try {
    registerErrorCodes(
      Object.entries(P3D_ERRORS).map(([code, e]) => ({
        code,
        area: "P3D",
        title: e.message.split(/[.:]/)[0],
        hint: e.retryable ? "Try again in a moment." : "Check the photos and description, then try again.",
        description: e.message,
        severity: "error" as const,
        retryable: Boolean(e.retryable),
      })),
      { owner: "photo3d" },
    );
  } catch {
    /* already registered */
  }
}

export interface PhotoJobInput {
  images: { name: string; mime: string; bytes: Buffer }[];
  scan?: { name: string; format: "obj" | "ply" | "stl" | "glb"; path: string };
  description: string;
  measurements: { label: string; value: number; unit: "mm" | "cm" | "in" }[];
  referenceObject: string;
  owner: string;
}

/** Photos from the phone: already resized and EXIF-stripped there; the Pi strips JPEG metadata again. */
export interface RemotePhotoInput {
  images: { mime: string; bytes: Buffer }[];
  description: string;
  owner: string;
}

export interface PhotoPipelineDeps {
  /** Pipeline clients; defaults to the Morphix environment. Tests inject fakes. */
  photo3d?: () => PhotoToModelDeps;
  /** Gemini image model used to clean photos before Meshy (MORPHIX_GEMINI_IMAGE_MODEL). */
  images?: () => GeminiImageClient | undefined;
}

export class PhotoPipeline {
  /**
   * Claude + headless CAD (packages/cad). Set by main once it is wired; until then
   * the phone shows "Claude CAD — not available yet".
   */
  generateCad: GenerateCadFn | null = null;
  /** Told when a Claude CAD model is saved or fails (main: open the model page, tell the voice). */
  onCadFinished: ((r: { ok: true; jobId: string; projectId: string; versionId: string; title: string } | { ok: false; jobId: string; title: string; error: string }) => void) | null = null;
  private plans = new PhotoPlanStore();
  /** Running Claude CAD designs, so the user can stop one. */
  private cadRuns = new Map<string, { abort: AbortController; title: string }>();

  constructor(private ctx: Ctx, private jobs: Jobs, private actions: Actions, private printing: Printing, private deps: PhotoPipelineDeps = {}) {
    registerPhotoErrors();
  }

  private photoDeps(): PhotoToModelDeps {
    return this.deps.photo3d ? this.deps.photo3d() : photo3dDepsFromEnv(process.env);
  }

  // ---------------------------------------------------------------- phone flow

  /** Free: Gemini looks at the photos, recommends Meshy or Claude CAD and (for Meshy) cleans the photo. */
  async analyzeForRemote(input: RemotePhotoInput): Promise<PhotoPlanView> {
    const deps = this.photoDeps();
    if (!deps.gemini?.available) throw new Photo3dError("MX-P3D-010");
    const plan = await planPhotoModel(
      { images: input.images.map((i) => ({ mime: i.mime, bytes: i.bytes })), description: input.description },
      {
        gemini: deps.gemini,
        images: this.imageClient(),
        meshy: { available: Boolean(deps.meshy?.available), credits: meshyImageCost(deps.meshyDefaults ?? {}), maxCredits: deps.maxCredits },
        cad: { available: this.generateCad !== null },
      },
    );
    this.plans.put(plan);
    this.ctx.log.write("info", "photo plan", {
      planId: plan.id, owner: input.owner, photos: plan.photos.length, object: plan.analysis.object.name,
      recommended: plan.recommended, cleanupNeeded: plan.cleanup.needed, cleaned: plan.cleanup.cleaned,
    });
    return planView(plan);
  }

  /** Prepares the (cleaned) photo Meshy would get, e.g. when the user picks Meshy on a CAD recommendation. */
  async cleanForRemote(planId: string): Promise<PhotoPlanView> {
    const plan = this.plans.get(planId);
    await prepareMeshyImages(plan, { images: this.imageClient() });
    return planView(plan);
  }

  /** The exact image Meshy will receive (index into the plan's Meshy images). */
  planPreview(planId: string, index: number): { mime: string; bytes: Uint8Array } | null {
    const plan = this.plans.get(planId);
    const img = plan.meshyImages?.[index];
    return img ? { mime: img.mime, bytes: img.bytes } : null;
  }

  /** The user's tap on the phone: starts generation with the chosen route. A second tap returns the same job. */
  async createFromPlan(input: { planId: string; route: PhotoRoute; useOriginal?: boolean; owner: string }): Promise<{ jobId: string; route: PhotoRoute; credits: number }> {
    const plan = this.plans.get(input.planId);
    if (plan.started) return { jobId: plan.started.jobId, route: plan.started.route, credits: plan.started.route === "meshy" ? this.optionCredits(plan, "meshy") : 0 };
    const option = plan.options.find((o) => o.route === input.route);
    if (!option) throw new Photo3dError("MX-P3D-081");
    if (input.route === "cad" && !this.generateCad) throw new Photo3dError("MX-P3D-070");
    if (!option.available) throw new Photo3dError("MX-P3D-081", option.unavailableReason ?? undefined);
    const deps = this.photoDeps();
    if (input.route === "meshy" && !deps.meshy?.available) throw new Photo3dError("MX-P3D-020");
    const title = plan.analysis.object.name.slice(0, 60) || plan.description.slice(0, 60);
    const job = this.jobs.create("photo-to-print", title, input.owner, { planId: plan.id, route: input.route }, { print: false, questions: false, builder: input.route === "cad" ? "openscad" : "meshy" });
    plan.started = { route: input.route, jobId: job.id, useOriginal: Boolean(input.useOriginal) };
    this.jobs.done(job.id, "photos", `${plan.analysis.object.name} — ${input.route === "cad" ? "Claude CAD" : "Meshy"} chosen on the phone`);
    this.ctx.log.write("info", "photo create", { planId: plan.id, jobId: job.id, route: input.route, useOriginal: Boolean(input.useOriginal) });
    if (input.route === "meshy") {
      if (!input.useOriginal) await prepareMeshyImages(plan, { images: this.imageClient() }).catch(() => undefined);
      const req = meshyRequestFromPlan(plan, { useOriginal: input.useOriginal });
      void this.build(job.id, title, req, deps, option.credits, false);
      return { jobId: job.id, route: "meshy", credits: option.credits };
    }
    void this.buildCad(job.id, title, plan.description, cadRequestFromPlan(plan), plan.analysis.object.name);
    return { jobId: job.id, route: "cad", credits: 0 };
  }

  private optionCredits(plan: PhotoPlan, route: PhotoRoute): number {
    return plan.options.find((o) => o.route === route)?.credits ?? 0;
  }

  private imageClient(): GeminiImageClient | undefined {
    return this.deps.images ? this.deps.images() : geminiImageFromEnv(process.env);
  }

  /**
   * Voice / typed request the user chose Claude for: Claude designs it in OpenSCAD (no photos,
   * no Meshy credits). Returns at once; the job shows progress and the model opens when done.
   */
  designFromText(input: { description: string; title?: string; owner: string; baseScad?: string }): { jobId: string } {
    if (!this.generateCad) throw new Photo3dError("MX-P3D-070");
    const description = input.description.trim().slice(0, 1000);
    if (!description) throw new Error("Say what Claude should design.");
    const title = (input.title?.trim() || description).slice(0, 60);
    const job = this.jobs.create("text-to-print", title, input.owner, { route: "cad" }, { print: false, builder: "openscad" });
    this.jobs.done(job.id, "understand", "Claude CAD chosen");
    this.ctx.log.write("info", "claude cad request", { jobId: job.id, title });
    const none = { valueMm: 0, confidence: 0, method: "typical-size" as const };
    const request: CadPhotoRequest = { description, objectName: title, summary: "", dimensions: { width: none, depth: none, height: none }, spec: null, measurements: [], images: [], baseScad: input.baseScad };
    void this.buildCad(job.id, title, description, request, title);
    return { jobId: job.id };
  }

  /** Stops the running Claude design(s); returns the title stopped, or null if none was running. */
  stopCad(): string | null {
    let stopped: string | null = null;
    for (const [jobId, run] of this.cadRuns) {
      run.abort.abort();
      this.jobs.cancel(jobId, "Stopped by the user");
      this.ctx.log.write("info", "claude cad stopped", { jobId });
      stopped = run.title;
    }
    this.cadRuns.clear();
    return stopped;
  }

  /**
   * Shows Claude's work live on the touchscreen ("claude-design" events): the step, the
   * attempt, the OpenSCAD it wrote and a 3D preview of each rendered attempt.
   */
  private liveDesign(jobId: string, title: string) {
    const view: ClaudeDesignView = {
      jobId, title, status: "working", stage: "designing", detail: "Claude is thinking about the design", attempt: 1, maxAttempts: 2,
      scad: null, previewUrl: null, startedAt: new Date().toISOString(),
    };
    const send = () => this.ctx.event({ type: "claude-design", design: { ...view } });
    send();
    return {
      step: (p: CadProgress) => {
        if (p.stage) view.stage = p.stage;
        view.detail = p.detail;
        if (p.attempt) view.attempt = p.attempt;
        if (p.maxAttempts) view.maxAttempts = p.maxAttempts;
        if (p.scad) view.scad = p.scad.slice(-6000);
        if (p.previewStl?.length) {
          try {
            const abs = this.ctx.storage.path("previews", "claude", `${jobId}-${view.attempt}.stl`);
            this.ctx.storage.writeAtomic(abs, Buffer.from(p.previewStl));
            view.previewUrl = this.ctx.url(this.ctx.storage.relative(abs));
          } catch {
            /* the preview is a nice-to-have */
          }
        }
        send();
      },
      end: (status: ClaudeDesignView["status"], extra: { projectId?: string; error?: string } = {}) => {
        view.status = status;
        view.stage = status === "done" ? "done" : view.stage;
        view.detail = status === "done" ? "Claude finished the design" : status === "stopped" ? "Stopped" : (extra.error ?? "Claude couldn't finish this design").slice(0, 300);
        Object.assign(view, extra);
        send();
      },
    };
  }

  private async buildCad(jobId: string, title: string, prompt: string, request: CadPhotoRequest, objectName: string) {
    this.jobs.start(jobId, "build", "Claude is designing the part");
    const abort = new AbortController();
    this.cadRuns.set(jobId, { abort, title });
    const live = this.liveDesign(jobId, title);
    try {
      const generate = this.generateCad;
      if (!generate) throw new Photo3dError("MX-P3D-070");
      let result;
      try {
        result = await generate(request, {
          signal: abort.signal,
          onProgress: (p) => {
            this.jobs.update(jobId, "build", p.progress, p.detail);
            live.step(p);
          },
        });
      } catch (e) {
        if (e instanceof Photo3dError) throw e;
        throw new Photo3dError("MX-P3D-071", `Claude CAD could not design this part: ${(e as Error).message}`);
      }
      const done = finishCadModel(result);
      this.jobs.done(jobId, "build", `${done.sizeMm.x} × ${done.sizeMm.y} × ${done.sizeMm.z} mm`);
      const { versionId } = this.saveModel(jobId, {
        name: result.name || objectName || title,
        prompt,
        source: "openscad",
        stl: done.stl,
        scad: result.scad,
        thumbnail: result.thumbnail ? Buffer.from(result.thumbnail) : undefined,
        meta: { engine: "claude-cad", credits: 0, warnings: done.warnings },
      });
      const projectId = String(this.jobs.manager.get(jobId)?.meta?.projectId ?? "");
      live.end("done", { projectId });
      this.onCadFinished?.({ ok: true, jobId, projectId, versionId, title });
      await this.printing.prepare(versionId, "auto", jobId);
    } catch (e) {
      if (abort.signal.aborted) {
        live.end("stopped");
        return; // stopped by the user: the job is already cancelled
      }
      live.end("failed", { error: (e as Error).message });
      const running = this.jobs.manager.get(jobId)?.stages.find((s) => s.status === "running")?.key ?? "build";
      this.jobs.fail(jobId, running, e, "MX-P3D-071");
      this.ctx.log.write("error", "photo CAD build failed", { jobId, error: (e as Error).message });
      this.onCadFinished?.({ ok: false, jobId, title, error: (e as Error).message });
    } finally {
      this.cadRuns.delete(jobId);
    }
  }

  /** Stores an STL (mm) as a new project + version in My Things. */
  private saveModel(
    jobId: string,
    m: { name: string; prompt: string; source: "openscad" | "scan" | "meshy"; stl: Buffer; scad?: string; thumbnail?: Buffer; meta: Record<string, unknown> },
  ): { projectId: string; versionId: string } {
    const { db, storage } = this.ctx;
    const projectId = randomUUID();
    const versionId = randomUUID();
    const t = now();
    db.run("INSERT INTO projects(id, title, prompt, state, created_at, updated_at) VALUES (?,?,?,?,?,?)", [projectId, m.name.slice(0, 60), m.prompt, "idea", t, t]);
    moveProject(this.ctx, projectId, "generating");
    const dir = storage.modelDir(projectId, versionId);
    const stlFile = join(dir, "model.stl");
    storage.writeAtomic(stlFile, m.stl);
    if (m.scad) storage.writeAtomic(join(dir, "model.scad"), m.scad);
    let thumbRel: string | null = null;
    if (m.thumbnail) {
      const thumb = storage.path("previews", `${versionId}.png`);
      storage.writeAtomic(thumb, m.thumbnail);
      thumbRel = storage.relative(thumb);
    }
    // STL is in real millimetres here (dimensions were solved), so keep its native size.
    db.run(
      `INSERT INTO model_versions(id, project_id, version, source, kind, format, rel_path, stl_rel_path, bytes, target_height_mm, thumbnail_rel_path, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [versionId, projectId, 1, m.source, "preview", "stl", storage.relative(stlFile), storage.relative(stlFile), m.stl.length, null, thumbRel, t],
    );
    db.run("INSERT INTO assets(id, version_id, kind, rel_path, bytes, sha256, created_at) VALUES (?,?,?,?,?,?,?)", [
      randomUUID(), versionId, "stl", storage.relative(stlFile), m.stl.length, createHash("sha256").update(m.stl).digest("hex"), t,
    ]);
    db.run("UPDATE projects SET latest_version_id = ?, updated_at = ? WHERE id = ?", [versionId, t, projectId]);
    moveProject(this.ctx, projectId, "reviewing");
    db.flush();
    this.jobs.manager.setMeta(jobId, { projectId, versionId, ...m.meta });
    return { projectId, versionId };
  }

  // ---------------------------------------------------------------- portal flow

  /** Starts the job and returns at once; progress follows on the job. */
  start(input: PhotoJobInput): { jobId: string } {
    const title = input.description.trim().slice(0, 60) || "Something from my photos";
    const job = this.jobs.create("photo-to-print", title, input.owner, {}, { print: false });
    // Copy the scan now: the portal deletes its temp upload when the request returns.
    const scan = input.scan ? { name: input.scan.name, bytes: readFileSync(input.scan.path) } : undefined;
    void this.run(job.id, title, input, scan);
    return { jobId: job.id };
  }

  private async run(jobId: string, title: string, input: PhotoJobInput, scan?: { name: string; bytes: Buffer }) {
    const deps = this.photoDeps();
    const base: PhotoToModelRequest = {
      images: input.images.map((i) => ({ mime: i.mime as never, bytes: i.bytes })),
      description: input.description,
      measurements: input.measurements,
      referenceObject: input.referenceObject as PhotoToModelRequest["referenceObject"],
      skipQuestions: true,
      ...(scan ? { scan } : {}),
    };
    try {
      // 1. Look at the photos (free). Scans skip the AI analysis when there are no photos.
      this.jobs.start(jobId, "photos", "Looking at your photos");
      let analysis: PhotoAnalysis | undefined;
      if (input.images.length) {
        if (!deps.gemini) throw new Error("Gemini is not configured (GEMINI_API_KEY)");
        analysis = await analyzePhotos(
          { images: base.images ?? [], description: input.description, measurements: input.measurements, referenceObject: base.referenceObject, hasScanFile: Boolean(scan) },
          { gemini: deps.gemini },
        );
      }
      this.jobs.done(jobId, "photos", analysis ? `${analysis.object.name} — ${analysis.engineReason}` : "Using your 3D scan");
      this.jobs.skip(jobId, "questions", "Using best guesses");

      const engine = scan ? "scan" : (analysis?.recommendedEngine ?? "meshy-image");
      const usesMeshy = engine === "meshy-image" || engine === "meshy-multi-image";
      const credits = usesMeshy ? meshyImageCost({}) : 0;
      const go = () => void this.build(jobId, title, { ...base, analysis, engine: scan ? "scan" : "auto" }, deps, credits);

      if (usesMeshy) {
        if (!deps.meshy) throw new Error("Meshy is not configured (MESHY_API_KEY)");
        this.jobs.wait(jobId, "build", `Uses ${credits} Meshy credits — waiting for OK`);
        this.actions.proposeCustom(
          {
            kind: "generate",
            title: analysis?.object.name ?? title,
            prompt: analysis?.meshyPrompt ?? input.description,
            projectId: null,
            versionId: null,
            credits,
            details: [
              `${input.images.length} photo${input.images.length === 1 ? "" : "s"}`,
              analysis ? `about ${fmtDims(analysis)}` : "",
              `Uses ${credits} Meshy credits`,
            ].filter(Boolean),
          },
          () => go(),
          () => this.jobs.cancel(jobId, "cancelled by the user"),
        );
      } else {
        go();
      }
    } catch (e) {
      this.jobs.fail(jobId, "photos", e, "MX-P3D-001");
      this.ctx.log.write("error", "photo job failed", { jobId, error: (e as Error).message });
    }
  }

  private async build(jobId: string, title: string, req: PhotoToModelRequest, deps: PhotoToModelDeps, credits: number, allowFallback = true) {
    this.jobs.start(jobId, "build", credits ? `Building (${credits} credits)` : "Building your model");
    try {
      const result = await photoToModel(req, { ...deps, allowFallback }, (p) => {
        if (p.stage === "download") {
          this.jobs.done(jobId, "build");
          this.jobs.start(jobId, "download", p.detail);
        } else if (p.stage !== "done" && p.stage !== "failed") {
          this.jobs.update(jobId, "build", p.progress, p.detail);
        }
      });
      if (result.status === "needsAnswers") {
        this.jobs.wait(jobId, "questions", result.questions.join(" "));
        return;
      }
      if (result.status === "failed") {
        throw toMorphixError(Object.assign(new Error(result.error.message), { code: result.error.code }), result.error.code);
      }
      this.jobs.done(jobId, "build");
      this.jobs.done(jobId, "download");

      // Store as a project + version (STL is printable; GLB for a nicer preview when we have one).
      const name = result.analysis?.object.name ?? title;
      const source = result.engine === "openscad" ? "openscad" : result.engine === "scan" ? "scan" : "meshy";
      const { projectId, versionId } = this.saveModel(jobId, {
        name,
        prompt: req.description,
        source,
        stl: result.files.stl,
        scad: result.files.scad,
        thumbnail: result.files.thumbnail,
        meta: { engine: result.engine, credits: result.costCredits },
      });
      this.ctx.log.write("info", "photo model built", { jobId, projectId, engine: result.engine, size: result.dimensions.actualMm, credits: result.costCredits });

      // Get it ready to print straight away (free), reporting into the same job.
      await this.printing.prepare(versionId, "auto", jobId);
    } catch (e) {
      const running = this.jobs.manager.get(jobId)?.stages.find((s) => s.status === "running")?.key ?? "build";
      this.jobs.fail(jobId, running, e, "MX-P3D-001");
      this.ctx.log.write("error", "photo build failed", { jobId, error: (e as Error).message });
    }
  }
}

function fmtDims(a: PhotoAnalysis): string {
  const d = a.dimensions;
  return `${Math.round(d.width.valueMm)} × ${Math.round(d.depth.valueMm)} × ${Math.round(d.height.valueMm)} mm`;
}
