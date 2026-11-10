// Self-healing for the main process ("eternal Morphix", docs/SELF-HEAL.md).
// installSelfHealing() watches the log, the job manager and a few read-only probes, and runs
// whitelisted, non-physical, non-costly fixes (packages/healer). It never starts a print,
// heats, cancels a real print or spends Meshy credits. Everything is injected, so this file
// does not import main.ts and is tested with fakes (tests/self-heal*.test.ts).
import type { AppEvent, PrinterStatus } from "@morphix/shared";
import { isKnownErrorCode } from "@morphix/errors";
import {
  claudeDiagnoserFromEnv, cleanOldFiles, defaultCleanTargets, firstDiagnoser, Healer,
  type Diagnoser, type HealActions, type HealerConfig, type HealProbes, type HealRecord, type Incident, type JobEventLike, type JobLike, type Limits, type RemediationId,
} from "@morphix/healer";
import type { Logger, Storage } from "@morphix/storage";
import type { MorphixDb } from "@morphix/database";
import type { Jobs } from "./jobs";
import type { Printing } from "./printing";
import type { VoiceController } from "./voice";
import type { Generation } from "./generation";

type Level = "info" | "warn" | "error";

/** The Morphix Logger (or anything with write); its write() is tapped to watch the log. */
export interface LoggerLike {
  write(level: Level, message: string, extra?: unknown): void;
  tail?(lines?: number): string[];
}

/** JobManager subset. */
export interface JobsLike {
  subscribeAll(listener: (ev: JobEventLike) => void): () => void;
  list(filter?: { active?: boolean }): JobLike[];
  cancel?(jobId: string, reason?: string): unknown;
}

export interface SelfHealDeps {
  logger: LoggerLike;
  /** ctx.event: user notices go out as { type: "notice" }. */
  emit?: (e: AppEvent) => void;
  jobs?: JobsLike;
  actions?: HealActions;
  probes?: HealProbes;
  /** Default: Claude from ANTHROPIC_API_KEY / MORPHIX_CLAUDE_MODEL (null = off). */
  diagnose?: Diagnoser | null;
  onRecord?: (r: HealRecord) => void;
  env?: Record<string, string | undefined>;
  /** How often the probes are checked. Default 15 s. */
  tickMs?: number;
  config?: Partial<HealerConfig>;
  limits?: Partial<Record<RemediationId, Partial<Limits>>>;
  now?: () => number;
}

export interface SelfHealing {
  readonly enabled: boolean;
  readonly healer: Healer | null;
  /** Recent self-heal actions, newest first (for a Grown-ups log). */
  history(limit?: number): HealRecord[];
  status(): ReturnType<Healer["status"]> | { disabled: true };
  report(inc: Incident): void;
  dispose(): void;
}

let current: SelfHealing | null = null;

/** The installed instance (for IPC handlers added later). */
export function selfHealing(): SelfHealing | null {
  return current;
}

export function installSelfHealing(deps: SelfHealDeps): SelfHealing {
  current?.dispose();
  const env = deps.env ?? process.env;
  const logger = deps.logger;
  const ownWrite = Object.prototype.hasOwnProperty.call(logger, "write") ? logger.write : null;
  const write = logger.write.bind(logger);

  if (env.MORPHIX_SELF_HEAL === "0") {
    write("info", "self-heal: disabled (MORPHIX_SELF_HEAL=0)");
    current = { enabled: false, healer: null, history: () => [], status: () => ({ disabled: true }), report: () => {}, dispose: () => {} };
    return current;
  }

  const jobs = deps.jobs;
  const actions: HealActions = { ...(deps.actions ?? {}) };
  // Default reconcile: fix Morphix's own job record only (the printer is already idle).
  if (!actions.reconcilePrintState && jobs?.cancel) {
    actions.reconcilePrintState = ({ jobIds, machine }) => {
      for (const id of jobIds) jobs.cancel!(id, `The printer is ${machine || "idle"}, so this print isn't running any more`);
      return { ok: true, detail: `closed ${jobIds.length} stale print record(s)` };
    };
  }
  const probes: HealProbes = {
    activeJobs: jobs ? () => jobs.list({ active: true }) : undefined,
    recentLogLines: logger.tail ? (n) => logger.tail!(n) : undefined,
    ...(deps.probes ?? {}),
  };
  // Claude explains unknown errors (none without ANTHROPIC_API_KEY).
  const diagnose = deps.diagnose !== undefined ? deps.diagnose : firstDiagnoser([claudeDiagnoserFromEnv(env)]);

  const healer = new Healer({
    actions,
    probes,
    log: write,
    notify: (n) => deps.emit?.({ type: "notice", level: n.level, message: n.message, code: n.code, hint: n.hint }),
    onRecord: deps.onRecord,
    diagnose,
    isKnownCode: isKnownErrorCode,
    limits: deps.limits,
    config: deps.config,
    now: deps.now,
  });

  // Watch every log line (the healer ignores its own "self-heal:" lines).
  const tapped = (level: Level, message: string, extra?: unknown) => {
    write(level, message, extra);
    try {
      healer.observeLog(level, message, extra);
    } catch {
      /* healing must never break logging */
    }
  };
  (logger as { write: LoggerLike["write"] }).write = tapped;

  const unsubscribe = jobs?.subscribeAll((ev) => healer.observeJob(ev));
  // Jobs restored before we were installed (interrupted by the last restart).
  for (const j of jobs?.list() ?? []) if (j.status === "interrupted") healer.observeJob({ type: "restored", job: j });

  const timer = setInterval(() => healer.tick(), deps.tickMs ?? 15_000);
  timer.unref?.();

  write("info", "self-heal: watching", {
    ai: Boolean(diagnose),
    actions: Object.entries(actions).filter(([, f]) => typeof f === "function").map(([k]) => k),
  });

  const handle: SelfHealing = {
    enabled: true,
    healer,
    history: (limit) => healer.history(limit),
    status: () => healer.status(),
    report: (inc) => healer.report(inc),
    dispose: () => {
      clearInterval(timer);
      unsubscribe?.();
      healer.dispose();
      if ((logger as { write: unknown }).write === tapped) {
        if (ownWrite) (logger as { write: LoggerLike["write"] }).write = ownWrite;
        else delete (logger as { write?: unknown }).write; // back to the class method
      }
      if (current === handle) current = null;
    },
  };
  current = handle;
  return handle;
}

// -----------------------------------------------------------------------------------------
// Wiring for the real app (main.ts passes its objects; nothing here is imported by them).

export interface AppParts {
  log: Logger;
  emit: (e: AppEvent) => void;
  jobs: Jobs;
  /** PrinterObserver (QD330) or the server's DriverObserver. */
  printer: { readonly status: PrinterStatus; poll(): Promise<PrinterStatus>; start(ms: number): void };
  printing: Printing;
  voice: VoiceController;
  generation: Generation;
  db: () => MorphixDb | null | undefined;
  storage: Storage;
  /** Normal printer poll interval (POLL_SECONDS * 1000). */
  pollMs: number;
}

const ACTIVE_PRINT = ["printing", "paused"];

export function appSelfHealDeps(a: AppParts): SelfHealDeps {
  const iso = () => new Date().toISOString();
  return {
    logger: a.log,
    emit: a.emit,
    jobs: a.jobs.manager,
    config: { normalPollMs: a.pollMs },
    actions: {
      reconnectGemini: async () => {
        if (!a.voice.enabled) return { ok: false, detail: "Gemini is not configured" };
        const r = await a.voice.test();
        return { ok: r.ok, detail: r.message };
      },
      resetVoiceSession: async () => {
        if (!a.voice.enabled) return { ok: false, detail: "Gemini is not configured" };
        a.voice.close();
        const r = await a.voice.test();
        return { ok: r.ok, detail: r.message };
      },
      // With the stale-lock fix in packages/printer (pi-function-test 598bb9b) a fresh control
      // session sends M602 and asks again when none of ours is open; a poll opens one.
      releasePrinterControl: async () => {
        const s = await a.printer.poll();
        return { ok: s.online, detail: s.online ? `printer answered (${s.machine ?? "status unknown"})` : s.error };
      },
      setPrinterPollInterval: ({ ms }) => a.printer.start(ms),
      retryPrepare: async ({ versionId, owner, settings }) => {
        const s = await a.printing.prepare(versionId, settings, null, owner ?? "touchscreen");
        return { ok: s.ok, detail: s.ok ? "sliced with supports auto, 0.2 mm" : s.error ?? s.slicer?.message ?? s.errorCode };
      },
      // Polls the SAME remote Meshy task again (resumeRemoteId): no new task, no credits.
      resumeMeshyPolling: ({ taskId }) => {
        const db = a.db();
        if (!db) return { ok: false, detail: "database not open" };
        const row = db.get("SELECT * FROM generation_tasks WHERE id = ?", [taskId]);
        if (!row || row.provider !== "meshy" || !row.remote_id) return { ok: false, detail: "no Meshy task to resume" };
        if (row.status === "succeeded") return { ok: true, detail: "the task had already finished" };
        db.run("UPDATE generation_tasks SET status = 'running', error = NULL, updated_at = ? WHERE id = ?", [iso(), taskId]);
        db.run("UPDATE projects SET state = 'generating', updated_at = ? WHERE id = ? AND state = 'failed'", [iso(), row.project_id]);
        a.generation.resume([row]);
        return { ok: true, detail: `checking Meshy task ${String(row.remote_id)} again` };
      },
      restartGuardianWorker: async () => {
        await a.printing.guardianCommand("stop");
        const v = await a.printing.guardianCommand("start");
        return { ok: v.running, detail: v.label };
      },
      cleanDisk: () => {
        const r = cleanOldFiles(defaultCleanTargets(a.storage.root));
        return { ok: r.freedBytes > 0, detail: r.removed ? `removed ${r.removed} old file(s), freed ${Math.round(r.freedBytes / 1e6)} MB` : "nothing old enough to delete" };
      },
      // Only "prepare" jobs are ever retried (local slicing; nothing physical or paid).
      retryJob: async ({ jobId, kind }) => {
        const j = a.jobs.manager.get(jobId);
        const versionId = typeof j?.meta?.versionId === "string" ? j.meta.versionId : "";
        if (kind !== "prepare" || !versionId) return { ok: false, detail: "not a preparation job" };
        const s = await a.printing.prepare(versionId, "auto", null, j?.owner ?? "touchscreen");
        return { ok: s.ok, detail: s.ok ? "prepared again" : s.error ?? s.errorCode };
      },
    },
    probes: {
      printerStatus: () => a.printer.status,
      printPhase: () => a.printing.status().job?.phase ?? "idle",
      printerBusy: () => a.printing.status().busy !== null,
      guardian: () => ({
        wanted: a.printing.view().running && ACTIVE_PRINT.includes(a.printing.status().job?.phase ?? ""),
        workerState: a.printing.guardian.snapshot().worker.state,
      }),
      disk: () => a.storage.disk(),
    },
  };
}
