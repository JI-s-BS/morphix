// Runs model generation jobs (Meshy or demo) and stores every result locally.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { IPC, type GenerationProgress } from "@morphix/shared";
import type { ModelGenerator } from "@morphix/meshy";
import type { Row } from "@morphix/database";
import { type Ctx, moveProject, now } from "./context";
import type { Jobs } from "./jobs";

/** Default display height for Meshy models (their native units aren't millimetres). */
const MESHY_DEFAULT_HEIGHT_MM = 80;

export interface FinishedInfo {
  jobId: string | null;
  projectId: string;
  versionId: string;
  title: string;
  kind: "preview" | "refine" | "demo";
  ok: boolean;
  error?: string;
}

export interface StartRequest {
  projectId?: string | null;
  prompt: string;
  title: string;
  kind: "preview" | "refine";
  parentVersionId?: string | null;
  /** Who asked: "touchscreen", "voice" or a portal user id. */
  owner?: string;
  /** Continue an existing progress job (e.g. a portal request that waited for approval). */
  jobId?: string | null;
}

export class Generation {
  private running = new Set<string>();
  jobs: Jobs | null = null;

  constructor(
    private ctx: Ctx,
    private generator: () => ModelGenerator,
    private onFinished: (info: FinishedInfo) => void,
  ) {}

  get busy(): boolean {
    return this.running.size > 0;
  }

  start(req: StartRequest): { projectId: string; taskId: string; jobId: string | null } {
    const { db } = this.ctx;
    const gen = this.generator();
    const t = now();
    let projectId = req.projectId ?? null;
    if (!projectId) {
      projectId = randomUUID();
      db.run("INSERT INTO projects(id, title, prompt, state, created_at, updated_at) VALUES (?,?,?,?,?,?)", [
        projectId, req.title.slice(0, 60), req.prompt, "idea", t, t,
      ]);
    } else if (req.kind === "preview") {
      db.run("UPDATE projects SET prompt = ?, updated_at = ? WHERE id = ?", [req.prompt, t, projectId]);
    }
    moveProject(this.ctx, projectId, "generating");
    const taskId = randomUUID();
    db.run(
      "INSERT INTO generation_tasks(id, project_id, provider, kind, status, prompt, parent_version_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [taskId, projectId, gen.name, req.kind, "queued", req.prompt, req.parentVersionId ?? null, t, t],
    );
    db.flush();
    this.ctx.currentProjectId = projectId;
    let jobId = req.jobId ?? null;
    if (jobId && this.jobs?.manager.get(jobId)) this.jobs.manager.setMeta(jobId, { projectId, taskId });
    else jobId = this.jobs?.create("text-to-print", req.kind === "refine" ? `Colouring ${req.title}` : req.title, req.owner ?? "touchscreen", { projectId, taskId }, { print: false }).id ?? null;
    if (jobId) {
      this.jobs!.done(jobId, "understand");
    }
    void this.run(taskId, projectId, req.prompt, req.kind, req.parentVersionId ?? null, undefined, jobId);
    return { projectId, taskId, jobId };
  }

  /** Continue polling Meshy tasks that were running when the app stopped. */
  resume(rows: Row[]): void {
    for (const r of rows) {
      this.ctx.log.write("info", "resuming Meshy task", { taskId: r.id, remoteId: r.remote_id });
      void this.run(String(r.id), String(r.project_id), String(r.prompt), r.kind as "preview" | "refine", (r.parent_version_id as string) ?? null, String(r.remote_id), null);
    }
  }

  private async run(taskId: string, projectId: string, prompt: string, kind: "preview" | "refine", parentVersionId: string | null, resumeRemoteId: string | undefined, jobId: string | null) {
    const { db, storage, log } = this.ctx;
    const gen = this.generator();
    const title = String(db.get("SELECT title FROM projects WHERE id = ?", [projectId])?.title ?? prompt);
    const report = (p: Omit<GenerationProgress, "taskId" | "projectId">) =>
      this.ctx.send(IPC.generationProgress, { taskId, projectId, ...p } satisfies GenerationProgress);
    this.running.add(taskId);
    try {
      const previewRemoteId = parentVersionId
        ? String(db.get("SELECT remote_task_id FROM model_versions WHERE id = ?", [parentVersionId])?.remote_task_id ?? "")
        : undefined;
      const model = await gen.generate(
        prompt,
        (u) => {
          db.run("UPDATE generation_tasks SET status = ?, progress = ?, updated_at = ? WHERE id = ?", [
            u.status === "succeeded" ? "running" : u.status, u.progress, now(), taskId,
          ]);
          if (u.status !== "succeeded") report(u);
          if (u.stage.startsWith("Downloading")) {
            this.jobs?.done(jobId, "generate");
            this.jobs?.start(jobId, "download", "Saving to the Pi");
          } else if (u.status !== "succeeded") {
            this.jobs?.start(jobId, "generate", u.stage);
            this.jobs?.update(jobId, "generate", u.progress, u.stage);
          }
        },
        {
          kind,
          previewRemoteId: previewRemoteId || undefined,
          resumeRemoteId,
          onRemoteId: (id) => {
            db.run("UPDATE generation_tasks SET remote_id = ?, status = 'running', updated_at = ? WHERE id = ?", [id, now(), taskId]);
            db.flush();
          },
        },
      );

      const versionId = randomUUID();
      const n = Number(db.get("SELECT COUNT(*) AS n FROM model_versions WHERE project_id = ?", [projectId])?.n ?? 0) + 1;
      const dir = storage.modelDir(projectId, versionId);
      const main = join(dir, `model.${model.format}`);
      storage.writeAtomic(main, model.data);
      let stlRel: string | null = null;
      if (model.format === "stl") stlRel = storage.relative(main);
      else if (model.stl) {
        const stlFile = join(dir, "model.stl");
        storage.writeAtomic(stlFile, model.stl);
        stlRel = storage.relative(stlFile);
      }
      let thumbRel: string | null = null;
      if (model.thumbnail) {
        const thumb = storage.path("previews", `${versionId}.png`);
        storage.writeAtomic(thumb, model.thumbnail);
        thumbRel = storage.relative(thumb);
      }
      const versionKind = gen.name === "demo" ? "demo" : kind;
      db.run(
        `INSERT INTO model_versions(id, project_id, version, source, kind, format, rel_path, stl_rel_path, bytes,
           target_height_mm, thumbnail_rel_path, remote_task_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          versionId, projectId, n, gen.name, versionKind, model.format, storage.relative(main), stlRel, model.data.length,
          gen.name === "meshy" ? MESHY_DEFAULT_HEIGHT_MM : null, thumbRel, model.remoteId ?? null, now(),
        ],
      );
      const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
      db.run("INSERT INTO assets(id, version_id, kind, rel_path, bytes, sha256, created_at) VALUES (?,?,?,?,?,?,?)", [
        randomUUID(), versionId, model.format, storage.relative(main), model.data.length, hash(model.data), now(),
      ]);
      if (model.stl && model.format !== "stl") {
        db.run("INSERT INTO assets(id, version_id, kind, rel_path, bytes, sha256, created_at) VALUES (?,?,?,?,?,?,?)", [
          randomUUID(), versionId, "stl", stlRel, model.stl.length, hash(model.stl), now(),
        ]);
      }
      db.run("UPDATE projects SET latest_version_id = ?, updated_at = ? WHERE id = ?", [versionId, now(), projectId]);
      db.run("UPDATE generation_tasks SET status = 'succeeded', progress = 100, credits = ?, updated_at = ? WHERE id = ?", [
        model.credits ?? null, now(), taskId,
      ]);
      moveProject(this.ctx, projectId, "reviewing");
      db.flush();
      log.write("info", "model generated", { projectId, versionId, kind: versionKind, bytes: model.data.length, source: gen.name, credits: model.credits });
      report({ status: "succeeded", progress: 100, stage: "Model ready", versionId, kind: versionKind, thumbnailUrl: this.ctx.url(thumbRel) ?? undefined });
      this.jobs?.done(jobId, "download");
      this.onFinished({ jobId, projectId, versionId, title, kind: versionKind, ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      db.run("UPDATE generation_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", [msg, now(), taskId]);
      try {
        const hasVersion = db.get("SELECT 1 FROM model_versions WHERE project_id = ?", [projectId]);
        moveProject(this.ctx, projectId, hasVersion ? "reviewing" : "failed");
      } catch {
        /* state already terminal */
      }
      db.flush();
      log.write("error", "generation failed", { projectId, error: msg });
      report({ status: "failed", progress: 0, stage: "Failed", error: msg });
      const running = this.jobs?.manager.get(jobId ?? "")?.stages.find((s) => s.status === "running")?.key ?? "generate";
      this.jobs?.fail(jobId, running, e, "MX-SYS-001");
      this.onFinished({ jobId, projectId, versionId: "", title, kind, ok: false, error: msg });
    } finally {
      this.running.delete(taskId);
    }
  }
}
