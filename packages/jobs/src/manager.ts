// JobManager: in-memory job store with weighted progress, change events and
// persistence hooks. One instance lives in the Electron main process; the touchscreen
// (IPC) and the web portal (HTTP/SSE) both read snapshots and subscribe to events.
import { MorphixError, toMorphixError, type ErrorCode } from "@morphix/errors";
import { stagesFrom, stageTemplate, type StageTemplate, type TemplateOptions } from "./templates";
import type { Job, JobEvent, JobKind, JobsSnapshot, JobStage, JobStatus, StageQuestion } from "./types";

export type JobListener = (event: JobEvent) => void;

export interface JobManagerOptions {
  now?: () => Date;
  newId?: () => string;
  /** Called with the full snapshot after every change (or debounced, see below). */
  persist?: (snapshot: JobsSnapshot) => void | Promise<void>;
  /** 0 (default) saves synchronously on every change; > 0 coalesces saves. */
  persistDebounceMs?: number;
  onPersistError?: (error: unknown) => void;
  /** Oldest finished jobs beyond this count are dropped (default 50). */
  maxFinishedJobs?: number;
}

export interface CreateJobInput {
  kind: JobKind;
  title: string;
  owner?: string;
  id?: string;
  meta?: Record<string, unknown>;
  /** Custom stages; default is stageTemplate(kind, template). */
  stages?: readonly StageTemplate[];
  template?: TemplateOptions;
}

export interface StageUpdate {
  progress?: number;
  detail?: string;
  label?: string;
}

export interface RestoreOptions {
  /**
   * Also interrupt stages waiting for the user (default false: a pending approval
   * survives a restart, as long as the app can still find the job's files).
   */
  interruptWaiting?: boolean;
}

const FINISHED: ReadonlySet<JobStatus> = new Set(["done", "failed", "cancelled", "interrupted"]);
const ALL = "*";

export function isJobFinished(job: Pick<Job, "status">): boolean {
  return FINISHED.has(job.status);
}

/** Weighted overall percent. Skipped stages leave the total; 100 only when all are done/skipped. */
export function computeJobPercent(stages: readonly JobStage[]): number {
  const counted = stages.filter((s) => s.status !== "skipped");
  if (counted.every((s) => s.status === "done")) return 100;
  const total = counted.reduce((a, s) => a + s.weight, 0);
  const frac = (s: JobStage) => (s.status === "done" ? 1 : s.status === "pending" ? 0 : clamp(s.progress, 0, 100) / 100);
  const value = total > 0
    ? counted.reduce((a, s) => a + s.weight * frac(s), 0) / total
    : counted.reduce((a, s) => a + frac(s), 0) / counted.length;
  return Math.min(99, Math.floor(value * 100));
}

/** Status derived from the stages (cancellation is stored, not derived). */
export function deriveJobStatus(stages: readonly JobStage[]): JobStatus {
  const failed = stages.filter((s) => s.status === "failed");
  if (failed.length) return failed.every((s) => s.interrupted) ? "interrupted" : "failed";
  if (stages.some((s) => s.status === "waiting_for_user")) return "waiting_for_user";
  if (stages.every((s) => s.status === "done" || s.status === "skipped")) return "done";
  if (stages.some((s) => s.status !== "pending")) return "running";
  return "pending";
}

function currentStageOf(job: Job): string | null {
  if (job.status === "done") return null;
  const active = job.stages.find((s) => s.status === "running" || s.status === "waiting_for_user" || s.status === "failed");
  return (active ?? job.stages.find((s) => s.status === "pending"))?.key ?? null;
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Map<string, Set<JobListener>>();
  private readonly o: Required<Pick<JobManagerOptions, "now" | "newId" | "persistDebounceMs" | "maxFinishedJobs">> & JobManagerOptions;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: JobManagerOptions = {}) {
    this.o = {
      now: () => new Date(),
      newId: defaultId,
      persistDebounceMs: 0,
      maxFinishedJobs: 50,
      ...opts,
    };
  }

  // ------------------------------------------------------------- queries

  get(id: string): Job | undefined {
    const j = this.jobs.get(id);
    return j ? structuredClone(j) : undefined;
  }

  /** Newest first. `active: true` = not finished; `owner` filters by owner. */
  list(filter: { owner?: string; active?: boolean; kind?: JobKind } = {}): Job[] {
    return [...this.jobs.values()]
      .filter((j) => (filter.owner === undefined ? true : j.owner === filter.owner))
      .filter((j) => (filter.kind === undefined ? true : j.kind === filter.kind))
      .filter((j) => (filter.active === undefined ? true : !isJobFinished(j) === filter.active))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((j) => structuredClone(j));
  }

  /** Listen to one job (by id) or to every job ("*"). Returns an unsubscribe function. */
  subscribe(target: string, listener: JobListener): () => void {
    const set = this.listeners.get(target) ?? new Set<JobListener>();
    set.add(listener);
    this.listeners.set(target, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(target);
    };
  }

  subscribeAll(listener: JobListener): () => void {
    return this.subscribe(ALL, listener);
  }

  // ------------------------------------------------------------- lifecycle

  create(input: CreateJobInput): Job {
    const id = input.id ?? this.o.newId();
    if (this.jobs.has(id)) throw new Error(`job ${id} already exists`);
    const stages = stagesFrom(input.stages ?? stageTemplate(input.kind, input.template));
    if (!stages.length) throw new Error("a job needs at least one stage");
    const now = this.iso();
    const job: Job = {
      id,
      kind: input.kind,
      title: input.title,
      status: "pending",
      stages,
      percent: 0,
      currentStage: null,
      createdAt: now,
      updatedAt: now,
    };
    if (input.owner !== undefined) job.owner = input.owner;
    if (input.meta) job.meta = structuredClone(input.meta);
    this.recompute(job);
    this.jobs.set(id, job);
    this.prune();
    this.emit("created", job);
    return structuredClone(job);
  }

  startStage(jobId: string, key: string, detail?: string): Job {
    return this.mutate(jobId, key, (job, s) => {
      this.begin(job, s);
      s.status = "running";
      s.progress = 0;
      delete s.error;
      delete s.question;
      delete s.interrupted;
      delete s.finishedAt;
      if (detail !== undefined) s.detail = detail;
    });
  }

  /** Completes any running stage, then starts `key` (the common "next step" call). */
  advance(jobId: string, key: string, detail?: string): Job {
    const job = this.require(jobId);
    this.stage(job, key);
    for (const s of job.stages) if (s.status === "running" && s.key !== key) this.finishStage(job, s, "done");
    return this.startStage(jobId, key, detail);
  }

  updateStage(jobId: string, key: string, update: StageUpdate): Job {
    return this.mutate(jobId, key, (job, s) => {
      if (s.status === "pending" || s.status === "failed") {
        this.begin(job, s);
        s.status = "running";
        delete s.error;
        delete s.interrupted;
      }
      if (update.progress !== undefined && Number.isFinite(update.progress)) s.progress = clamp(update.progress, 0, 100);
      if (update.detail !== undefined) s.detail = update.detail;
      if (update.label !== undefined) s.label = update.label;
    });
  }

  completeStage(jobId: string, key: string, detail?: string): Job {
    return this.mutate(jobId, key, (job, s) => {
      if (!s.startedAt) this.begin(job, s);
      if (detail !== undefined) s.detail = detail;
      this.finishStage(job, s, "done");
    });
  }

  skip(jobId: string, key: string, reason?: string): Job {
    return this.mutate(jobId, key, (job, s) => {
      if (reason !== undefined) s.detail = reason;
      this.finishStage(job, s, "skipped");
    });
  }

  /** Marks the stage (and so the job) failed with a serialised MorphixError. */
  failStage(jobId: string, key: string, error: unknown, fallbackCode: ErrorCode | string = "MX-SYS-001"): Job {
    const serialized = toMorphixError(error, fallbackCode, { context: { jobId, stage: key } }).toJSON();
    return this.mutate(jobId, key, (job, s) => {
      if (!s.startedAt) this.begin(job, s);
      s.error = serialized;
      delete s.question;
      this.finishStage(job, s, "failed");
      job.error ??= serialized;
    });
  }

  waitForUser(jobId: string, key: string, question?: StageQuestion | string, detail?: string): Job {
    return this.mutate(jobId, key, (job, s) => {
      this.begin(job, s);
      s.status = "waiting_for_user";
      if (question !== undefined) s.question = typeof question === "string" ? { prompt: question } : structuredClone(question);
      if (detail !== undefined) s.detail = detail;
    });
  }

  /** Stops the job: running/waiting stages fail with MX-SYS-004 (cancelled). */
  cancel(jobId: string, reason = "cancelled"): Job {
    const job = this.require(jobId);
    if (isJobFinished(job)) return structuredClone(job);
    const serialized = new MorphixError("MX-SYS-004", { message: reason, context: { jobId }, at: this.o.now() }).toJSON();
    for (const s of job.stages) {
      if (s.status === "running" || s.status === "waiting_for_user") {
        s.status = "failed";
        s.error = serialized;
        s.finishedAt = this.iso();
        delete s.question;
      }
    }
    job.status = "cancelled";
    job.finishedAt = this.iso();
    job.updatedAt = job.finishedAt;
    job.percent = computeJobPercent(job.stages);
    job.currentStage = null;
    this.emit("finished", job);
    return structuredClone(job);
  }

  /** Merges keys into job.meta. */
  setMeta(jobId: string, meta: Record<string, unknown>): Job {
    const job = this.require(jobId);
    job.meta = { ...job.meta, ...structuredClone(meta) };
    job.updatedAt = this.iso();
    this.emit("updated", job);
    return structuredClone(job);
  }

  remove(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    this.jobs.delete(jobId);
    this.emit("removed", job);
    return true;
  }

  // ------------------------------------------------------------- persistence

  serialize(): JobsSnapshot {
    return { version: 1, savedAt: this.iso(), jobs: [...this.jobs.values()].map((j) => structuredClone(j)) };
  }

  /**
   * Loads jobs saved by serialize(). Stages that were running are marked failed with
   * MX-SYS-006 and `interrupted: true`, so the job reads "interrupted". Jobs with the same
   * id are replaced. Returns the restored jobs.
   */
  restore(snapshot: unknown, opts: RestoreOptions = {}): Job[] {
    const jobs = restoreJobs(snapshot, { ...opts, now: this.o.now() });
    for (const j of jobs) {
      this.jobs.set(j.id, j);
      this.emit("restored", j, undefined, false);
    }
    this.prune();
    this.save();
    return jobs.map((j) => structuredClone(j));
  }

  /** Forces a pending debounced save now. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.callPersist();
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.listeners.clear();
  }

  // ------------------------------------------------------------- internals

  private iso(): string {
    return this.o.now().toISOString();
  }

  private require(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`unknown job ${jobId}`);
    return job;
  }

  private stage(job: Job, key: string): JobStage {
    const s = job.stages.find((x) => x.key === key);
    if (!s) throw new Error(`job ${job.id} has no stage "${key}"`);
    return s;
  }

  private mutate(jobId: string, key: string, fn: (job: Job, s: JobStage) => void): Job {
    const job = this.require(jobId);
    if (job.status === "cancelled") throw new Error(`job ${jobId} was cancelled`);
    const s = this.stage(job, key);
    const wasFinished = isJobFinished(job);
    fn(job, s);
    this.recompute(job);
    const nowFinished = isJobFinished(job);
    if (nowFinished && !wasFinished) job.finishedAt = this.iso();
    if (!nowFinished) delete job.finishedAt;
    this.emit(nowFinished && !wasFinished ? "finished" : "updated", job, key);
    return structuredClone(job);
  }

  private begin(job: Job, s: JobStage): void {
    const now = this.iso();
    s.startedAt ??= now;
    job.startedAt ??= now;
  }

  private finishStage(job: Job, s: JobStage, status: "done" | "skipped" | "failed"): void {
    s.status = status;
    if (status === "done") s.progress = 100;
    s.finishedAt = this.iso();
    if (status !== "failed") {
      delete s.error;
      delete s.interrupted;
    }
    delete s.question;
  }

  private recompute(job: Job): void {
    // A trailing zero-weight "done" stage completes itself once everything else has.
    const done = job.stages.find((s) => s.key === "done");
    if (done && done.status === "pending" && job.stages.every((s) => s === done || s.status === "done" || s.status === "skipped")) {
      done.status = "done";
      done.progress = 100;
      done.startedAt = done.finishedAt = this.iso();
    }
    if (job.status !== "cancelled") job.status = deriveJobStatus(job.stages);
    if (!job.stages.some((s) => s.status === "failed")) delete job.error;
    job.percent = computeJobPercent(job.stages);
    job.currentStage = currentStageOf(job);
    job.updatedAt = this.iso();
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter(isJobFinished).sort((a, b) => (a.finishedAt ?? a.updatedAt).localeCompare(b.finishedAt ?? b.updatedAt));
    while (finished.length > this.o.maxFinishedJobs) this.jobs.delete(finished.shift()!.id);
  }

  private emit(type: JobEvent["type"], job: Job, stageKey?: string, persist = true): void {
    const event: JobEvent = { type, job: structuredClone(job) };
    if (stageKey) event.stageKey = stageKey;
    for (const target of [job.id, ALL]) {
      for (const l of this.listeners.get(target) ?? []) {
        try {
          l(event);
        } catch {
          // A broken listener (e.g. a closed SSE stream) must not break the pipeline.
        }
      }
    }
    if (persist) this.save();
  }

  private save(): void {
    if (!this.o.persist) return;
    if (this.o.persistDebounceMs <= 0) {
      void this.callPersist();
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.callPersist();
    }, this.o.persistDebounceMs);
  }

  private async callPersist(): Promise<void> {
    if (!this.o.persist) return;
    try {
      await this.o.persist(this.serialize());
    } catch (e) {
      this.o.onPersistError?.(e);
    }
  }
}

/** Pure restore step (see JobManager.restore). Malformed jobs are dropped. */
export function restoreJobs(snapshot: unknown, opts: RestoreOptions & { now?: Date } = {}): Job[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const snap = snapshot as Partial<JobsSnapshot>;
  if (snap.version !== 1 || !Array.isArray(snap.jobs)) return [];
  const now = (opts.now ?? new Date()).toISOString();
  const out: Job[] = [];
  for (const raw of snap.jobs) {
    if (!isJobLike(raw)) continue;
    const job = structuredClone(raw);
    let interrupted = false;
    for (const s of job.stages) {
      if (s.status === "running" || (opts.interruptWaiting && s.status === "waiting_for_user")) {
        s.status = "failed";
        s.interrupted = true;
        s.finishedAt = now;
        delete s.question;
        s.error = new MorphixError("MX-SYS-006", { context: { jobId: job.id, stage: s.key }, at: now }).toJSON();
        interrupted = true;
      }
    }
    if (job.status !== "cancelled") job.status = deriveJobStatus(job.stages);
    if (interrupted) {
      job.finishedAt ??= now;
      job.error ??= job.stages.find((s) => s.interrupted)?.error;
      job.updatedAt = now;
    }
    job.percent = computeJobPercent(job.stages);
    job.currentStage = currentStageOf(job);
    out.push(job);
  }
  return out;
}

function isJobLike(v: unknown): v is Job {
  if (!v || typeof v !== "object") return false;
  const j = v as Partial<Job>;
  return typeof j.id === "string" && typeof j.kind === "string" && typeof j.title === "string" && Array.isArray(j.stages) &&
    j.stages.every((s) => s && typeof s.key === "string" && typeof s.status === "string" && typeof s.weight === "number") && typeof j.createdAt === "string";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function defaultId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return `job_${c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}`;
}
