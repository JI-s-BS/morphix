// One progress model for every pipeline (text→model, photo→model, prepare, print),
// persisted so jobs survive a restart, and pushed to the touchscreen + web portal.
import { existsSync, readFileSync } from "node:fs";
import { JobManager, type Job, type JobKind } from "@morphix/jobs";
import { getErrorEntry, toMorphixError, type MorphixError } from "@morphix/errors";
import type { JobView } from "@morphix/shared";
import type { Ctx } from "./context";

export function jobView(j: Job): JobView {
  return {
    id: j.id,
    kind: j.kind,
    title: j.title,
    status: j.status,
    percent: j.percent,
    currentStage: j.currentStage,
    stages: j.stages.map((s) => ({ key: s.key, label: s.label, status: s.status, progress: s.progress, detail: s.detail })),
    error: j.error ? { code: j.error.code, title: j.error.title, hint: j.error.hint } : null,
    updatedAt: j.updatedAt,
  };
}

export class Jobs {
  readonly manager: JobManager;
  private file: string;

  constructor(private ctx: Ctx) {
    this.file = ctx.storage.path("database", "jobs.json");
    this.manager = new JobManager({
      persist: (snap) => ctx.storage.writeAtomic(this.file, JSON.stringify(snap)),
      persistDebounceMs: 400,
      onPersistError: (e) => ctx.log.write("warn", "jobs persist failed", { error: String(e) }),
    });
    if (existsSync(this.file)) {
      try {
        this.manager.restore(JSON.parse(readFileSync(this.file, "utf8")));
      } catch (e) {
        ctx.log.write("warn", "could not restore jobs", { error: (e as Error).message });
      }
    }
    this.manager.subscribeAll((ev) => ctx.event({ type: "job", job: jobView(ev.job) }));
  }

  create(kind: JobKind, title: string, owner: string, meta: Record<string, unknown> = {}, template?: Parameters<JobManager["create"]>[0]["template"]): Job {
    return this.manager.create({ kind, title, owner, meta, template });
  }

  /** Safe wrappers: progress reporting must never break the real work. */
  start(id: string | null | undefined, key: string, detail?: string) {
    this.safe(() => id && this.manager.startStage(id, key, detail));
  }
  update(id: string | null | undefined, key: string, progress: number, detail?: string) {
    this.safe(() => id && this.manager.updateStage(id, key, { progress, detail }));
  }
  done(id: string | null | undefined, key: string, detail?: string) {
    this.safe(() => id && this.manager.completeStage(id, key, detail));
  }
  skip(id: string | null | undefined, key: string, reason?: string) {
    this.safe(() => id && this.manager.skip(id, key, reason));
  }
  wait(id: string | null | undefined, key: string, question: string) {
    this.safe(() => id && this.manager.waitForUser(id, key, question));
  }
  fail(id: string | null | undefined, key: string, error: unknown, fallback = "MX-SYS-001"): MorphixError {
    const me = toMorphixError(error, fallback);
    this.safe(() => id && this.manager.failStage(id, key, me));
    return me;
  }
  cancel(id: string | null | undefined, reason?: string) {
    this.safe(() => id && this.manager.cancel(id, reason));
  }
  /** Skip every stage that hasn't started (e.g. the tail of a job that ends early). */
  finishRemaining(id: string | null | undefined, reason = "not needed") {
    if (!id) return;
    const j = this.manager.get(id);
    for (const s of j?.stages ?? []) if (s.status === "pending") this.skip(id, s.key, reason);
    const d = this.manager.get(id)?.stages.find((s) => s.key === "done");
    if (d && d.status !== "done") this.done(id, "done");
  }

  list(): JobView[] {
    return this.manager.list().map(jobView);
  }

  private safe(fn: () => unknown) {
    try {
      fn();
    } catch (e) {
      this.ctx.log.write("warn", "job update ignored", { error: (e as Error).message });
    }
  }
}

/** Friendly notice for the touchscreen from any error. */
export function noticeFor(e: unknown, fallback = "MX-SYS-001") {
  const me = toMorphixError(e, fallback);
  const entry = getErrorEntry(me.code);
  return { type: "notice" as const, level: "error" as const, message: entry?.title ?? me.message, code: me.code, hint: entry?.hint ?? me.hint };
}
