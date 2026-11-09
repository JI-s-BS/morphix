// Follows one print from status polls (feed it PrinterObserver statuses).
// Passive: it never talks to the printer, so it is safe while control is disabled.
import { EventEmitter } from "node:events";
import type { PrinterStatus } from "@morphix/shared";
import { baseName } from "./protocol";
import { DEFAULT_PAUSED_STATUSES, STATUS_BUILDING, STATUS_READY } from "./control";
import { isPausedStatus } from "./machine";

export type JobPhase = "idle" | "printing" | "paused" | "completed" | "cancelled" | "failed";

export interface TrackedJob {
  jobId?: string;
  fileName?: string;
  phase: JobPhase;
  progress: number;
  layer: [number, number];
  /** True when the print was found already running (app restart, or started at the printer). */
  recovered: boolean;
  /** True while the printer is unreachable during an active job (the SD print carries on). */
  offline: boolean;
  startedAt?: string;
  endedAt?: string;
  reason?: string;
  lastMachineStatus?: string;
}

export interface JobTrackerEvents {
  started: [TrackedJob];
  recovered: [TrackedJob];
  progress: [TrackedJob];
  paused: [TrackedJob];
  resumed: [TrackedJob];
  completed: [TrackedJob];
  cancelled: [TrackedJob];
  failed: [TrackedJob];
  offline: [TrackedJob];
  online: [TrackedJob];
  unknownStatus: [TrackedJob, string];
  change: [TrackedJob];
}

export interface JobTrackerOptions {
  pausedStatuses?: string[];
  /** Last seen progress (%) at or above which a return to READY counts as completed. Default 99. */
  completeAtProgress?: number;
}

export interface ActivePrint {
  fileName?: string;
  paused: boolean;
  progress: number;
  layer: [number, number];
}

/** For app start-up: is the printer already running (or paused in) a job? */
export function detectActivePrint(status: PrinterStatus, pausedStatuses: string[] = DEFAULT_PAUSED_STATUSES): ActivePrint | null {
  if (!status.online) return null;
  const paused = isPausedStatus(status, pausedStatuses);
  if (status.machine !== STATUS_BUILDING && !paused) return null;
  return {
    fileName: status.currentFile ? baseName(status.currentFile) : undefined,
    paused,
    progress: status.progress ?? 0,
    layer: status.layer ?? [0, 0],
  };
}

const ACTIVE: JobPhase[] = ["printing", "paused"];

export class JobTracker {
  private emitter = new EventEmitter();
  private j: TrackedJob = { phase: "idle", progress: 0, layer: [0, 0], recovered: false, offline: false };
  private cancelRequested = false;
  private trackedSince = 0;
  private paused: string[];
  private completeAt: number;

  constructor(opts: JobTrackerOptions = {}) {
    this.paused = opts.pausedStatuses ?? DEFAULT_PAUSED_STATUSES;
    this.completeAt = opts.completeAtProgress ?? 99;
  }

  get job(): TrackedJob {
    return { ...this.j, layer: [...this.j.layer] as [number, number] };
  }

  get active(): boolean {
    return ACTIVE.includes(this.j.phase);
  }

  on<E extends keyof JobTrackerEvents>(event: E, cb: (...args: JobTrackerEvents[E]) => void): () => void {
    this.emitter.on(event, cb as (...a: unknown[]) => void);
    return () => this.emitter.off(event, cb as (...a: unknown[]) => void);
  }

  /** Call after QD330Controller.startPrint() returned confirmed. Statuses older than this call are ignored. */
  track(job: { jobId: string; fileName: string; status?: PrinterStatus }): void {
    this.cancelRequested = false;
    this.trackedSince = Date.now();
    this.j = {
      jobId: job.jobId,
      fileName: job.fileName,
      phase: "printing",
      progress: job.status?.progress ?? 0,
      layer: job.status?.layer ?? [0, 0],
      recovered: false,
      offline: false,
      startedAt: new Date().toISOString(),
      lastMachineStatus: job.status?.machine,
    };
    this.emit("started");
  }

  /** Links a recovered print to the app's job record. */
  attachJob(jobId: string): void {
    this.j.jobId = jobId;
    this.emit("change");
  }

  /** Call when a cancel is sent, so the following READY is reported as cancelled rather than failed. */
  noteCancelRequested(): void {
    this.cancelRequested = true;
  }

  reset(): void {
    this.cancelRequested = false;
    this.j = { phase: "idle", progress: 0, layer: [0, 0], recovered: false, offline: false };
    this.emit("change");
  }

  update(status: PrinterStatus): void {
    if (this.trackedSince && Date.parse(status.checkedAt) < this.trackedSince) return; // stale poll from before track()

    if (!status.online) {
      if (this.active && !this.j.offline) {
        this.j.offline = true;
        this.emit("offline");
      }
      return;
    }
    if (this.j.offline) {
      this.j.offline = false;
      this.emit("online");
    }

    const machine = status.machine ?? "";
    const paused = isPausedStatus(status, this.paused);
    const building = machine === STATUS_BUILDING && !paused;
    const file = status.currentFile ? baseName(status.currentFile) : undefined;

    if (!this.active) {
      if (building || paused) {
        this.cancelRequested = false;
        this.j = {
          fileName: file,
          phase: paused ? "paused" : "printing",
          progress: status.progress ?? 0,
          layer: status.layer ?? [0, 0],
          recovered: true,
          offline: false,
          startedAt: new Date().toISOString(),
          lastMachineStatus: machine,
        };
        this.emit("recovered");
      }
      return;
    }

    this.j.lastMachineStatus = machine;
    if (building || paused) {
      const progress = status.progress ?? this.j.progress;
      const layer = status.layer ?? this.j.layer;
      if (progress !== this.j.progress || layer[0] !== this.j.layer[0] || layer[1] !== this.j.layer[1]) {
        this.j.progress = progress;
        this.j.layer = [layer[0], layer[1]];
        this.emit("progress");
      }
      if (paused && this.j.phase === "printing") {
        this.j.phase = "paused";
        this.emit("paused");
      } else if (building && this.j.phase === "paused") {
        this.j.phase = "printing";
        this.emit("resumed");
      }
      return;
    }

    if (machine === STATUS_READY) {
      // Polls can miss the last few percent, so also look at what M27 says now that the printer is READY.
      const reached = (p: number | undefined, l: [number, number] | undefined) =>
        (p ?? 0) >= this.completeAt || (!!l && l[1] > 0 && l[0] >= l[1]);
      const done = reached(this.j.progress, this.j.layer) || reached(status.progress, status.layer);
      this.j.endedAt = new Date().toISOString();
      if (this.cancelRequested) {
        this.end("cancelled", `cancelled at ${this.j.progress}%`);
      } else if (done) {
        this.j.progress = Math.max(this.j.progress, 100);
        this.end("completed", "printer returned to READY after the last layer");
      } else {
        this.end("failed", `printer returned to READY at ${this.j.progress}% without a cancel from Morphix`);
      }
      return;
    }

    // Not READY, not printing, not a known pause value: report, but don't guess an outcome.
    this.emitter.emit("unknownStatus", this.job, machine);
  }

  private end(phase: "completed" | "cancelled" | "failed", reason: string) {
    this.cancelRequested = false;
    this.trackedSince = 0;
    this.j.phase = phase;
    this.j.reason = reason;
    this.emit(phase);
  }

  private emit(event: Exclude<keyof JobTrackerEvents, "unknownStatus">) {
    const snap = this.job;
    this.emitter.emit(event, snap);
    if (event !== "change") this.emitter.emit("change", snap);
  }
}

/**
 * Time left. Early on (heating, first layers) trust the slicer's estimate; as the print goes
 * on, lean more on the real pace (elapsed / progress), which corrects a slicer that is off for
 * this printer. Null when there's nothing to go on.
 */
export function remainingSeconds(progress: number, elapsedS: number | null, estimateS: number | null): number | null {
  const p = Math.max(0, Math.min(100, progress));
  if (p >= 100) return 0;
  const fromEstimate = estimateS ? estimateS * (1 - p / 100) : null;
  const fromPace = elapsedS !== null && p >= 5 ? (elapsedS * (100 - p)) / p : null;
  if (fromPace === null) return fromEstimate === null ? null : Math.round(fromEstimate);
  if (fromEstimate === null) return Math.round(fromPace);
  const w = Math.min(1, (p - 5) / 30); // 5 % → all estimate, 35 %+ → all real pace
  return Math.round((1 - w) * fromEstimate + w * fromPace);
}
