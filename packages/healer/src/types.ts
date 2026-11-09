// Self-healing ("eternal Morphix") types. Plain data so records can cross IPC and be shown
// in the Grown-ups log. Nothing here talks to hardware: every fix is an injected function.

/** What went wrong (one class per known real-world failure, plus "unknown-error"). */
export type IncidentKind =
  | "gemini-closed"
  | "voice-turn-hung"
  | "printer-control-refused"
  | "printer-stale-lock-cleared"
  | "printer-offline"
  | "printer-online"
  | "slicer-failed"
  | "meshy-poll-failed"
  | "guardian-worker-down"
  | "stale-print-state"
  | "disk-low"
  | "job-interrupted"
  | "unknown-error";

/**
 * The whitelist of things the healer may do on its own. None of them is physical (no motion,
 * heating, printing or cancelling a real print) or costly (no Meshy credits, no new paid tasks).
 */
export type RemediationId =
  | "reconnect-gemini"
  | "reset-voice-session"
  | "release-printer-control"
  | "printer-poll-backoff"
  | "retry-slice-safer"
  | "resume-meshy-polling"
  | "restart-guardian-worker"
  | "reconcile-print-state"
  | "clean-disk"
  | "retry-job";

export interface Incident {
  kind: IncidentKind;
  /** Groups repeats of the same problem for the limits (job id, version id, "gemini"…). */
  key: string;
  /** Short human description: "Gemini socket closed (1011 internal error)". */
  what: string;
  code?: string;
  context?: Record<string, unknown>;
}

export type HealResult =
  /** The remediation ran and reported success. */
  | "fixed"
  /** The remediation ran and failed (it may be tried again within its limits). */
  | "failed"
  /** A setting was changed to ride out a problem that isn't over yet (e.g. slower polling). */
  | "applied"
  /** Not attempted (not wired, unsafe right now, or not needed). */
  | "skipped"
  /** The limit was reached: the healer stops trying and tells the user. */
  | "gave-up"
  /** Recorded only (nothing safe to do, or something else already fixed it). */
  | "noted"
  /** AI diagnosis produced an explanation / suggestion for the user. */
  | "suggested";

export interface Diagnosis {
  summary: string;
  likelyCause: string;
  userHint: string;
  /** Always one of the whitelisted remediations, or "none". */
  suggestedRemediation: RemediationId | "none";
  confidence: "low" | "medium" | "high";
  model?: string;
}

export interface HealRecord {
  id: number;
  at: string;
  incident: IncidentKind;
  key: string;
  what: string;
  action: RemediationId | "none" | "diagnose";
  /** Human label of the action ("reconnect to Gemini"). */
  actionLabel: string;
  result: HealResult;
  detail?: string;
  /** 1-based attempt number within the remediation's window. */
  attempt?: number;
  diagnosis?: Diagnosis;
}

export interface Limits {
  /** Attempts allowed per key inside windowMs. */
  maxAttempts: number;
  windowMs: number;
  /** Wait before attempt n (0-based within the window); the last entry repeats. */
  backoffMs: number[];
  /** Minimum gap between two attempts for the same key (storm protection). */
  cooldownMs: number;
}

export interface ActionOutcome {
  ok: boolean;
  detail?: string;
}

/** Actions may return nothing (= ok), a boolean, or { ok, detail }; throwing = failed. */
export type ActionFn<A> = (arg: A) => Promise<boolean | ActionOutcome | void> | boolean | ActionOutcome | void;

export interface SaferSliceSettings {
  supports: "auto";
  layerHeightMm: number;
  infillPercent: number;
}

/** Injected fixes. Missing ones are reported as "skipped: not wired". */
export interface HealActions {
  reconnectGemini?: ActionFn<{ reason: string }>;
  /** Close the stuck Live session and open a fresh one. */
  resetVoiceSession?: ActionFn<{ reason: string }>;
  /** Clear a stale printer control lock (M602 via the controller's recovery, see docs/SELF-HEAL.md). */
  releasePrinterControl?: ActionFn<{ reason: string }>;
  setPrinterPollInterval?: ActionFn<{ ms: number }>;
  retryPrepare?: ActionFn<{ jobId: string; versionId: string; owner?: string; settings: SaferSliceSettings }>;
  /** Poll an existing Meshy task again (never creates a new task, so no credits are spent). */
  resumeMeshyPolling?: ActionFn<{ jobId: string; taskId: string }>;
  restartGuardianWorker?: ActionFn<{ reason: string }>;
  /** Fix Morphix's own records only (job bar / project state); never sends a printer command. */
  reconcilePrintState?: ActionFn<{ jobIds: string[]; machine: string }>;
  cleanDisk?: ActionFn<{ reason: string }>;
  /** Re-run a job that is safe to repeat (only "prepare" jobs are ever passed). */
  retryJob?: ActionFn<{ jobId: string; kind: string }>;
}

export interface PrinterStatusLike {
  online: boolean;
  machine?: string;
  error?: string;
  checkedAt?: string;
}

export interface JobStageLike {
  key: string;
  status: string;
  error?: { code: string; message?: string; title?: string };
  interrupted?: boolean;
}

export interface JobLike {
  id: string;
  kind: string;
  status: string;
  owner?: string;
  stages: JobStageLike[];
  error?: { code: string; message?: string; title?: string };
  meta?: Record<string, unknown>;
}

export interface JobEventLike {
  type: string;
  job: JobLike;
}

/** Read-only getters polled by tick(). All optional. */
export interface HealProbes {
  printerStatus?: () => PrinterStatusLike | null | undefined;
  /** Phase of the printer job tracker ("idle", "printing", "paused", …). */
  printPhase?: () => string | null | undefined;
  /** True while Morphix is talking to the printer (upload/start): never touch it then. */
  printerBusy?: () => boolean;
  /** Unfinished jobs (JobManager.list({ active: true })). */
  activeJobs?: () => JobLike[];
  /** wanted = the guardian should be watching; workerState = VisionWorker state. */
  guardian?: () => { wanted: boolean; workerState: string } | null | undefined;
  disk?: () => { freeBytes: number; totalBytes: number } | null | undefined;
  /** Recent log lines for AI diagnosis (redacted before sending). */
  recentLogLines?: (n: number) => string[];
}

export interface Notice {
  level: "info" | "warn" | "error";
  message: string;
  hint?: string;
  code?: string;
}

export interface DiagnoseInput {
  incident: Incident;
  logLines: string[];
  remediations: { id: RemediationId; label: string }[];
}

export type Diagnoser = (input: DiagnoseInput) => Promise<Diagnosis | null>;
