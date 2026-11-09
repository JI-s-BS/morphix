// The self-heal engine: incidents in, whitelisted remediations out, under per-key limits
// (max attempts per window, backoff, cooldown). Every decision becomes a HealRecord and one
// log line "self-heal: <what> → <action> → <result>".
import { classifyJobEvent, classifyLog, CONTROL_REFUSED_RE, type LogLine } from "./rules";
import { limitsFor, REMEDIATIONS, REMEDIATION_IDS } from "./remediations";
import type {
  ActionFn, ActionOutcome, Diagnoser, HealActions, HealProbes, HealRecord, HealResult, Incident, IncidentKind,
  JobEventLike, Limits, Notice, PrinterStatusLike, RemediationId, SaferSliceSettings,
} from "./types";

export interface HealerConfig {
  /** Normal printer poll interval, restored when the printer is back. */
  normalPollMs: number;
  /** While offline: after `afterMs` offline, poll every `pollMs`. */
  offlineSteps: { afterMs: number; pollMs: number }[];
  /** A voice turn with no reply for this long is "hung". */
  voiceHungMs: number;
  /** An inactivity close is only reconnected when the user spoke within this window. */
  voiceActiveWindowMs: number;
  /** Ignore "Gemini session closed" this long after we reset/reconnect ourselves. */
  geminiQuietMs: number;
  /** Printer READY + job bar still "printing" for this long = stale. */
  staleAfterMs: number;
  readyStatuses: string[];
  /** Guardian wanted but its worker down for this long = restart. */
  guardianGraceMs: number;
  diskLowBytes: number;
  diskLowFraction: number;
  diskCheckEveryMs: number;
  historySize: number;
  /** Same "noted"/"skipped" record is not repeated within this window. */
  noteDedupeMs: number;
  diagnoseMinGapMs: number;
  diagnoseMaxPerDay: number;
  diagnoseSameKeyMs: number;
  diagnoseLogLines: number;
  /** Let a confident AI suggestion run an AI-triggerable whitelisted remediation. */
  aiMayRemediate: boolean;
  actionTimeoutMs: number;
  saferSlice: SaferSliceSettings;
}

const MIN = 60_000;

export const DEFAULT_HEALER_CONFIG: HealerConfig = {
  normalPollMs: 5_000,
  offlineSteps: [
    { afterMs: 30_000, pollMs: 10_000 },
    { afterMs: 2 * MIN, pollMs: 30_000 },
    { afterMs: 10 * MIN, pollMs: 60_000 },
  ],
  voiceHungMs: 75_000,
  voiceActiveWindowMs: 5 * MIN,
  geminiQuietMs: 15_000,
  staleAfterMs: 3 * MIN,
  readyStatuses: ["READY"],
  guardianGraceMs: 15_000,
  diskLowBytes: 1024 ** 3,
  diskLowFraction: 0.05,
  diskCheckEveryMs: 10 * MIN,
  historySize: 200,
  noteDedupeMs: 10 * MIN,
  diagnoseMinGapMs: 5 * MIN,
  diagnoseMaxPerDay: 20,
  diagnoseSameKeyMs: 6 * 60 * MIN,
  diagnoseLogLines: 80,
  aiMayRemediate: true,
  actionTimeoutMs: 2 * MIN,
  saferSlice: { supports: "auto", layerHeightMm: 0.2, infillPercent: 15 },
};

export interface HealerOptions {
  actions: HealActions;
  probes?: HealProbes;
  /** Where "self-heal: …" lines go (the Morphix Logger's write). */
  log: (level: "info" | "warn" | "error", message: string, extra?: unknown) => void;
  /** User-facing notices (touchscreen banner). */
  notify?: (n: Notice) => void;
  onRecord?: (r: HealRecord) => void;
  diagnose?: Diagnoser | null;
  /** From @morphix/errors isKnownErrorCode; unknown codes go to AI diagnosis. */
  isKnownCode?: (code: string) => boolean;
  limits?: Partial<Record<RemediationId, Partial<Limits>>>;
  config?: Partial<HealerConfig>;
  now?: () => number;
}

const ACTION_KEY: Record<RemediationId, keyof HealActions> = {
  "reconnect-gemini": "reconnectGemini",
  "reset-voice-session": "resetVoiceSession",
  "release-printer-control": "releasePrinterControl",
  "printer-poll-backoff": "setPrinterPollInterval",
  "retry-slice-safer": "retryPrepare",
  "resume-meshy-polling": "resumeMeshyPolling",
  "restart-guardian-worker": "restartGuardianWorker",
  "reconcile-print-state": "reconcilePrintState",
  "clean-disk": "cleanDisk",
  "retry-job": "retryJob",
};

/** Remediations that must never run while Morphix itself is talking to the printer. */
const NEEDS_IDLE_PRINTER = new Set<RemediationId>(["release-printer-control", "reconcile-print-state"]);

interface KeyState {
  attempts: number[];
  lastAt: number;
  pending: boolean;
  gaveUp: boolean;
}

interface AttemptOpts {
  /** Runs just before the action (e.g. mark jobs whose events the fix itself will emit). */
  before?: () => void;
  onFailed?: () => void;
  fixedNotice?: Notice;
}

export class Healer {
  readonly config: HealerConfig;
  private readonly now: () => number;
  private records: HealRecord[] = [];
  private seq = 0;
  private keys = new Map<string, KeyState>();
  private notes = new Map<string, number>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private inflight = new Set<Promise<unknown>>();
  private disposed = false;

  private voiceTurnAt: number | null = null;
  private lastVoiceActivity = -Infinity;
  private geminiQuietUntil = 0;
  private offlineSince: number | null = null;
  private pollMs: number;
  private staleSince: number | null = null;
  private guardianDownSince: number | null = null;
  private lastDiskCheck = -Infinity;
  private reconciled = new Set<string>();
  private lastDiagnoseAt = -Infinity;
  private diagnoseDay = "";
  private diagnoseCount = 0;
  private diagnosed = new Map<string, number>();

  constructor(private readonly o: HealerOptions) {
    this.config = { ...DEFAULT_HEALER_CONFIG, ...(o.config ?? {}) };
    this.now = o.now ?? Date.now;
    this.pollMs = this.config.normalPollMs;
  }

  // ---------------------------------------------------------------------------------------
  // Inputs

  observeLog(level: LogLine["level"], message: string, extra?: unknown): void {
    if (this.disposed || message.startsWith("self-heal")) return;
    const t = this.now();
    if (message === "voice turn") {
      this.voiceTurnAt = t;
      this.lastVoiceActivity = t;
    } else if (message === "voice reply" || message === "voice error shown" || message === "voice turn too quiet" || message === "Gemini session closed") {
      this.voiceTurnAt = null;
    } else if (message.startsWith("tool ") && this.voiceTurnAt !== null) {
      this.voiceTurnAt = t; // a tool call means Gemini is still answering
    }
    const inc = classifyLog({ level, message, extra });
    if (inc) this.handle(inc);
  }

  observeJob(ev: JobEventLike): void {
    if (this.disposed || this.reconciled.has(ev.job.id)) return;
    const inc = classifyJobEvent(ev, this.o.isKnownCode);
    if (inc) this.handle(inc);
  }

  observePrinter(s: PrinterStatusLike): void {
    if (this.disposed) return;
    const t = this.now();
    if (!s.online) {
      this.offlineSince ??= t;
      if (CONTROL_REFUSED_RE.test(s.error ?? "")) {
        this.handle({ kind: "printer-control-refused", key: "printer", what: "printer refused control (shown as offline)", code: "MX-PRINT-005", context: { error: s.error } });
        return;
      }
      const offFor = t - this.offlineSince;
      let target: number | null = null;
      for (const step of this.config.offlineSteps) if (offFor >= step.afterMs) target = step.pollMs;
      if (target !== null && target !== this.pollMs) {
        this.setPoll(target, { kind: "printer-offline", key: "printer", what: `printer offline for ${Math.round(offFor / 1000)} s (${(s.error ?? "no answer").slice(0, 80)})` });
      }
      return;
    }
    if (this.offlineSince !== null) {
      this.offlineSince = null;
      if (this.pollMs !== this.config.normalPollMs) {
        this.setPoll(this.config.normalPollMs, { kind: "printer-online", key: "printer", what: "printer is back online" });
      }
    }
  }

  /** Report an incident directly (e.g. from code that already knows what went wrong). */
  report(inc: Incident): void {
    if (!this.disposed) this.handle(inc);
  }

  /** Periodic checks of the probes (main calls this every ~15 s). */
  tick(): void {
    if (this.disposed) return;
    const p = this.o.probes ?? {};
    const t = this.now();
    const status = safe(() => p.printerStatus?.());
    if (status) this.observePrinter(status);

    if (this.voiceTurnAt !== null && t - this.voiceTurnAt >= this.config.voiceHungMs) {
      const secs = Math.round((t - this.voiceTurnAt) / 1000);
      this.voiceTurnAt = null;
      this.handle({ kind: "voice-turn-hung", key: "voice", what: `a voice turn got no answer for ${secs} s` });
    }

    const g = safe(() => p.guardian?.());
    if (g && g.wanted && (g.workerState === "failed" || g.workerState === "stopped")) {
      this.guardianDownSince ??= t;
      if (t - this.guardianDownSince >= this.config.guardianGraceMs) {
        this.guardianDownSince = null;
        this.handle({ kind: "guardian-worker-down", key: "guardian", what: `print watcher is ${g.workerState} during a print`, code: "MX-GUARD-003", context: { workerState: g.workerState } });
      }
    } else this.guardianDownSince = null;

    this.checkStalePrint(status, t);

    if (p.disk && t - this.lastDiskCheck >= this.config.diskCheckEveryMs) {
      this.lastDiskCheck = t;
      const d = safe(() => p.disk?.());
      if (d && d.totalBytes > 0 && (d.freeBytes < this.config.diskLowBytes || d.freeBytes / d.totalBytes < this.config.diskLowFraction)) {
        this.handle({ kind: "disk-low", key: "disk", what: `only ${Math.round(d.freeBytes / 1e6)} MB free on the disk`, code: "MX-STORE-001", context: { freeBytes: d.freeBytes, totalBytes: d.totalBytes } });
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Outputs

  /** Recent self-heal records, newest first. */
  history(limit = 50): HealRecord[] {
    return this.records.slice(-limit).reverse().map((r) => ({ ...r }));
  }

  status() {
    const counts: Partial<Record<HealResult, number>> = {};
    for (const r of this.records) counts[r.result] = (counts[r.result] ?? 0) + 1;
    return {
      aiDiagnosis: Boolean(this.o.diagnose),
      printerOfflineSince: this.offlineSince === null ? null : new Date(this.offlineSince).toISOString(),
      printerPollMs: this.pollMs,
      pending: this.timers.size + this.inflight.size,
      counts,
      recent: this.history(20),
    };
  }

  /** Resolves when no action or diagnosis is running (scheduled backoffs are not awaited). */
  async settle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // ---------------------------------------------------------------------------------------
  // Policy

  private handle(inc: Incident): void {
    const c = inc.context ?? {};
    switch (inc.kind) {
      case "gemini-closed": {
        if (this.now() < this.geminiQuietUntil) return; // our own reset/reconnect
        if (c.inactivity === true && this.now() - this.lastVoiceActivity > this.config.voiceActiveWindowMs) {
          this.note(inc, "nobody was talking; it reconnects on the next voice turn");
          return;
        }
        this.attempt("reconnect-gemini", inc, { reason: String(c.reason ?? inc.what) });
        return;
      }
      case "voice-turn-hung":
        this.attempt("reset-voice-session", inc, { reason: inc.what }, {
          fixedNotice: { level: "info", message: "I got stuck, so I restarted my voice connection. Please say that again." },
        });
        return;
      case "printer-control-refused":
        this.attempt("release-printer-control", inc, { reason: inc.what });
        return;
      case "printer-stale-lock-cleared":
        this.record(inc, "release-printer-control", "fixed", "the printer controller sent M602 and got control back");
        return;
      case "printer-offline":
      case "printer-online":
        this.note(inc);
        return;
      case "slicer-failed": {
        const versionId = typeof c.versionId === "string" ? c.versionId : "";
        if (!versionId) return this.note(inc, "no model version on the job, so it can't be sliced again");
        this.attempt("retry-slice-safer", inc, { jobId: String(c.jobId ?? ""), versionId, owner: typeof c.owner === "string" ? c.owner : undefined, settings: { ...this.config.saferSlice } });
        return;
      }
      case "meshy-poll-failed":
        this.attempt("resume-meshy-polling", inc, { jobId: String(c.jobId ?? ""), taskId: String(c.taskId ?? inc.key) });
        return;
      case "guardian-worker-down": {
        const g = safe(() => this.o.probes?.guardian?.());
        if (g && !g.wanted) return this.note(inc, "no print is running, so the watcher isn't needed");
        this.attempt("restart-guardian-worker", inc, { reason: inc.what });
        return;
      }
      case "stale-print-state": {
        const jobIds = (c.jobIds as string[]) ?? [];
        this.attempt("reconcile-print-state", inc, { jobIds, machine: String(c.machine ?? "") }, {
          before: () => jobIds.forEach((id) => this.reconciled.add(id)),
          onFailed: () => jobIds.forEach((id) => this.reconciled.delete(id)),
        });
        return;
      }
      case "disk-low":
        this.attempt("clean-disk", inc, { reason: inc.what });
        return;
      case "job-interrupted":
        if (c.jobKind === "prepare") this.attempt("retry-job", inc, { jobId: String(c.jobId), kind: "prepare" });
        else this.note(inc, "left for you to start again (it may cost credits or move the printer)");
        return;
      case "unknown-error":
        this.diagnoseIncident(inc);
        return;
    }
  }

  private checkStalePrint(status: PrinterStatusLike | null | undefined, t: number): void {
    const p = this.o.probes ?? {};
    const phase = safe(() => p.printPhase?.()) ?? "idle";
    const machine = status?.machine ?? "";
    const idle = status?.online === true && this.config.readyStatuses.includes(machine) && phase !== "printing" && phase !== "paused" && !safe(() => p.printerBusy?.());
    const stale = idle
      ? (safe(() => p.activeJobs?.()) ?? []).filter((j) => j.kind === "print" && !this.reconciled.has(j.id) && j.stages.some((s) => s.key === "print" && s.status === "running"))
      : [];
    if (!stale.length) {
      this.staleSince = null;
      return;
    }
    this.staleSince ??= t;
    if (t - this.staleSince < this.config.staleAfterMs) return;
    this.staleSince = null;
    const jobIds = stale.map((j) => j.id);
    this.handle({ kind: "stale-print-state", key: jobIds.join(","), what: `job bar says printing but the printer is ${machine}`, context: { jobIds, machine } });
  }

  private setPoll(ms: number, inc: Incident): void {
    const fn = this.o.actions.setPrinterPollInterval;
    if (!fn) return this.note(inc, "poll interval change not wired");
    this.pollMs = ms;
    this.track(
      runAction(fn, { ms }, this.config.actionTimeoutMs).then((r) =>
        this.record(inc, "printer-poll-backoff", r.ok ? "applied" : "failed", r.ok ? `checking every ${Math.round(ms / 1000)} s` : r.detail),
      ),
    );
  }

  private attempt<A>(rid: RemediationId, inc: Incident, arg: A, opts: AttemptOpts = {}): void {
    const fn = this.o.actions[ACTION_KEY[rid]] as ActionFn<A> | undefined;
    const k = `${rid}|${inc.key}`;
    const lim = limitsFor(rid, this.o.limits);
    const t = this.now();
    const st = this.keys.get(k) ?? { attempts: [], lastAt: -Infinity, pending: false, gaveUp: false };
    this.keys.set(k, st);
    if (st.pending) return;
    st.attempts = st.attempts.filter((a) => t - a < lim.windowMs);
    if (!st.attempts.length) st.gaveUp = false;
    if (!fn) return this.note(inc, "not wired in this build", rid, "skipped");
    if (st.attempts.length >= lim.maxAttempts) {
      if (!st.gaveUp) this.giveUp(inc, rid, st, lim);
      return;
    }
    if (t - st.lastAt < lim.cooldownMs) return;
    if (NEEDS_IDLE_PRINTER.has(rid) && safe(() => this.o.probes?.printerBusy?.())) {
      return this.note(inc, "Morphix is busy talking to the printer; will try later", rid, "skipped");
    }
    const n = st.attempts.length;
    const delay = lim.backoffMs[Math.min(n, lim.backoffMs.length - 1)] ?? 0;
    st.attempts.push(t);
    st.pending = true;
    const run = () => {
      if (this.disposed) return;
      if (rid === "reconnect-gemini" || rid === "reset-voice-session") this.geminiQuietUntil = this.now() + this.config.geminiQuietMs;
      opts.before?.();
      const p = runAction(fn, arg, this.config.actionTimeoutMs).then((r) => {
        st.pending = false;
        st.lastAt = this.now();
        this.record(inc, rid, r.ok ? "fixed" : "failed", r.detail, n + 1);
        if (r.ok) {
          if (opts.fixedNotice) this.o.notify?.(opts.fixedNotice);
          return;
        }
        opts.onFailed?.();
        if (st.attempts.length >= lim.maxAttempts && !st.gaveUp) this.giveUp(inc, rid, st, lim);
      });
      this.track(p);
    };
    if (delay <= 0) run();
    else {
      const h = setTimeout(() => {
        this.timers.delete(h);
        run();
      }, delay);
      this.timers.add(h);
    }
  }

  private giveUp(inc: Incident, rid: RemediationId, st: KeyState, lim: Limits): void {
    st.gaveUp = true;
    const mins = Math.round(lim.windowMs / MIN);
    this.record(inc, rid, "gave-up", `${lim.maxAttempts} attempt(s) in ${mins} min did not fix it`);
    this.o.notify?.({ level: "warn", message: `I tried to fix this myself but couldn't: ${inc.what}.`, hint: "A grown-up can look at the self-heal log in Grown-ups.", code: inc.code });
  }

  private diagnoseIncident(inc: Incident): void {
    const t = this.now();
    const d = this.o.diagnose;
    if (!d) return this.note(inc, "no AI diagnosis configured", "diagnose");
    const last = this.diagnosed.get(inc.key);
    if (last !== undefined && t - last < this.config.diagnoseSameKeyMs) return;
    const day = new Date(t).toISOString().slice(0, 10);
    if (day !== this.diagnoseDay) {
      this.diagnoseDay = day;
      this.diagnoseCount = 0;
    }
    if (t - this.lastDiagnoseAt < this.config.diagnoseMinGapMs || this.diagnoseCount >= this.config.diagnoseMaxPerDay) {
      return this.note(inc, "AI diagnosis is resting (rate limit)", "diagnose", "skipped");
    }
    this.lastDiagnoseAt = t;
    this.diagnoseCount++;
    this.diagnosed.set(inc.key, t);
    const logLines = safe(() => this.o.probes?.recentLogLines?.(this.config.diagnoseLogLines)) ?? [];
    const remediations = REMEDIATION_IDS.map((id) => ({ id, label: REMEDIATIONS[id].label }));
    const p = Promise.resolve()
      .then(() => d({ incident: inc, logLines, remediations }))
      .then(
        (dg) => {
          if (!dg) return this.record(inc, "diagnose", "failed", "no usable answer");
          this.record(inc, "diagnose", "suggested", dg.summary, undefined, dg);
          this.o.notify?.({ level: "warn", message: dg.summary, hint: dg.userHint || undefined, code: inc.code });
          const sug = dg.suggestedRemediation;
          if (sug !== "none" && this.config.aiMayRemediate && REMEDIATIONS[sug].aiTriggerable && dg.confidence !== "low") {
            this.attempt(sug, { ...inc, key: `ai:${sug}`, what: `${inc.what} (AI suggestion)` }, { reason: `AI diagnosis: ${dg.summary}` });
          }
        },
        (e) => this.record(inc, "diagnose", "failed", (e as Error).message),
      );
    this.track(p);
  }

  // ---------------------------------------------------------------------------------------
  // Records

  private note(inc: Incident, detail?: string, action: RemediationId | "none" | "diagnose" = "none", result: HealResult = "noted"): void {
    const k = `${inc.kind}|${inc.key}|${action}|${result}`;
    const t = this.now();
    const last = this.notes.get(k);
    if (last !== undefined && t - last < this.config.noteDedupeMs) return;
    this.notes.set(k, t);
    this.record(inc, action, result, detail);
  }

  private record(inc: Incident, action: RemediationId | "none" | "diagnose", result: HealResult, detail?: string, attempt?: number, diagnosis?: HealRecord["diagnosis"]): void {
    const actionLabel = action === "none" ? "no action" : action === "diagnose" ? "ask Claude what went wrong" : REMEDIATIONS[action].label;
    const r: HealRecord = {
      id: ++this.seq,
      at: new Date(this.now()).toISOString(),
      incident: inc.kind as IncidentKind,
      key: inc.key,
      what: inc.what,
      action,
      actionLabel,
      result,
      ...(detail ? { detail: detail.slice(0, 300) } : {}),
      ...(attempt ? { attempt } : {}),
      ...(diagnosis ? { diagnosis } : {}),
    };
    this.records.push(r);
    if (this.records.length > this.config.historySize) this.records.splice(0, this.records.length - this.config.historySize);
    const level = result === "failed" || result === "gave-up" || result === "skipped" ? "warn" : "info";
    try {
      this.o.log(level, `self-heal: ${inc.what} → ${actionLabel} → ${result}${detail ? ` (${detail.slice(0, 160)})` : ""}`, { incident: inc.kind, key: inc.key, action, result, attempt, code: inc.code });
    } catch {
      /* logging must never break healing */
    }
    try {
      this.o.onRecord?.({ ...r });
    } catch {
      /* listeners must never break healing */
    }
  }

  private track(p: Promise<unknown>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Runs an injected action with a timeout and normalises its result. Never throws. */
export async function runAction<A>(fn: ActionFn<A>, arg: A, timeoutMs: number): Promise<ActionOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<ActionOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, detail: `timed out after ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    });
    const r = await Promise.race([Promise.resolve().then(() => fn(arg)), timeout]);
    if (r === undefined || r === true) return { ok: true };
    if (r === false) return { ok: false };
    return { ok: Boolean((r as ActionOutcome).ok), detail: (r as ActionOutcome).detail };
  } catch (e) {
    return { ok: false, detail: (e as Error)?.message ?? String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
