// Unified pipeline progress model shared by the touchscreen and the web portal.
// Everything here is plain JSON so jobs can cross IPC/HTTP and be persisted as is.
import type { SerializedMorphixError } from "@morphix/errors";

export type JobKind = "text-to-print" | "photo-to-print" | "prepare" | "print";

export type StageStatus = "pending" | "running" | "done" | "skipped" | "failed" | "waiting_for_user";

/**
 * Derived from the stages: failed > cancelled > interrupted > waiting_for_user > running
 * > done. "interrupted" means the app restarted while a stage was running.
 */
export type JobStatus = "pending" | "running" | "waiting_for_user" | "done" | "failed" | "cancelled" | "interrupted";

export interface StageQuestion {
  /** What the user is asked ("Shall I print it?"). */
  prompt: string;
  /** Optional fixed answers for buttons ("Print", "Not now"). */
  options?: string[];
}

export interface JobStage {
  /** Stable key, e.g. "generate" or "prepare.slice". */
  key: string;
  /** Kid-friendly label shown on the progress bar. */
  label: string;
  /** Optional group for collapsing sub-stages ("prepare"), with its own label. */
  group?: string;
  groupLabel?: string;
  /** Relative share of the overall bar (>= 0). Skipped stages drop out of the total. */
  weight: number;
  status: StageStatus;
  /** 0-100 within this stage. */
  progress: number;
  /** Short live detail ("Meshy: 2 ahead in the queue"). */
  detail?: string;
  error?: SerializedMorphixError;
  question?: StageQuestion;
  /** True when the stage was running at an app restart (status is then "failed"). */
  interrupted?: boolean;
  startedAt?: string;
  finishedAt?: string;
}

export interface Job {
  id: string;
  kind: JobKind;
  title: string;
  status: JobStatus;
  stages: JobStage[];
  /** Weighted overall progress, 0-100 (100 only when every stage is done or skipped). */
  percent: number;
  /** Key of the stage to highlight (running, waiting, failed, or next pending). */
  currentStage: string | null;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  /** Who started it: "touchscreen", "voice", or a portal user id (Auth0 sub). */
  owner?: string;
  /** First failure, for a one-line error banner. */
  error?: SerializedMorphixError;
  /** Free JSON for the app (project id, model id, file paths…). */
  meta?: Record<string, unknown>;
}

export type JobEventType = "created" | "updated" | "finished" | "removed" | "restored";

export interface JobEvent {
  type: JobEventType;
  /** Snapshot (a copy; mutating it does not change the job). */
  job: Job;
  /** Stage that changed, when the event is about one stage. */
  stageKey?: string;
}

export interface JobsSnapshot {
  version: 1;
  savedAt: string;
  jobs: Job[];
}
