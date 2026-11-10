// PrintGuardian: wires the vision worker, the alert state machine, Gemini
// verification, a local review and a persistence hook together.
// Electron main process only. It never sends anything to the printer; pausing
// goes through AlertMachineOptions.pauseHook (the printer controller) or the operator.
import { readFile as fsReadFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { AlertStateMachine, STATE_LABELS, defaultIsPaused } from "./alerts";
import type { Alert, AlertMachineOptions, GuardianState, PrinterStatusLike, Transition } from "./alerts";
import type { FailureKind, VisionEvent, VisionEventOf } from "./events";
import type { GeminiVisionClient } from "./gemini";
import { localReview } from "./review";
import { StallMonitor } from "./stall";
import type { GuardianPrinterStatus, StallOptions, StallPhase } from "./stall";
import { VisionWorker } from "./worker";
import type { VisionWorkerConfig, VisionWorkerHandlers, WorkerStatus } from "./worker";

export interface EvidenceRecord {
  id: string;
  sessionId: string;
  alertId: string | null;
  at: string;
  label: "suspect" | "confirmed";
  kind: FailureKind;
  path: string;
  relPath: string;
}

export interface SessionRecord {
  id: string;
  printJobId: string | null;
  startedAt: string;
  endedAt?: string;
  endReason?: string;
  snapshotUrl?: string;
  evidenceDir: string;
  evidenceRelDir: string;
  workerRestarts: number;
}

/** Persistence hook. Implement it over packages/database using schema.ts. */
export interface GuardianStore {
  sessionStarted(s: SessionRecord): void | Promise<void>;
  sessionEnded(s: SessionRecord): void | Promise<void>;
  alertChanged(alert: Alert, transition: Transition | null): void | Promise<void>;
  evidenceSaved(e: EvidenceRecord): void | Promise<void>;
}

export type CameraState = "unknown" | "ok" | "lost" | "frozen";

export interface GuardianSnapshot {
  state: GuardianState;
  label: string;
  sessionId: string | null;
  camera: CameraState;
  cameraDetail?: string;
  worker: WorkerStatus;
  alert: Alert | null;
  history: Alert[];
  lastObservation: VisionEventOf<"observation"> | null;
  lastHeartbeatAt: string | null;
  /** What the printer is doing as far as the stall check is concerned. */
  printerPhase: StallPhase;
  autoPause: boolean;
  gemini: { available: boolean; model?: string; callsToday?: number; dailyCap?: number };
}

export interface VisionWorkerLike {
  start(): void;
  stop(): Promise<void>;
  sendPrinterState(s: PrinterStatusLike & { progress?: number }): void;
  resetBaseline(): void;
  readonly status: WorkerStatus;
}

export interface PrintGuardianOptions {
  /** Morphix storage root. Evidence goes to <root>/snapshots/<session>/. */
  storageRoot: string;
  /** services/vision directory (contains the morphix_vision package). */
  visionDir: string;
  worker?: Partial<Omit<VisionWorkerConfig, "cwd" | "session" | "evidenceDir">>;
  alerts?: AlertMachineOptions;
  /** Printer-status stall check (progress / layer / head position). */
  stall?: StallOptions;
  /** Printer unreachable this long before the camera checks are switched off. Default 60 s. */
  offlineGraceMs?: number;
  gemini?: GeminiVisionClient;
  /** @deprecated Removed (Swarms / Tiger Data); ignored. Drop with compat.ts. */
  swarms?: undefined;
  /** @deprecated Removed (Swarms / Tiger Data); ignored. Drop with compat.ts. */
  telemetry?: undefined;
  store?: GuardianStore;
  readFile?: (path: string) => Promise<Uint8Array>;
  createWorker?: (config: VisionWorkerConfig, handlers: VisionWorkerHandlers) => VisionWorkerLike;
  log?: (line: string) => void;
  now?: () => number;
}

export class PrintGuardian {
  readonly alerts: AlertStateMachine;
  private worker: VisionWorkerLike | null = null;
  private session: SessionRecord | null = null;
  private camera: CameraState = "unknown";
  private cameraDetail?: string;
  private lastObservation: VisionEventOf<"observation"> | null = null;
  private lastHeartbeatAt: string | null = null;
  private printer: (PrinterStatusLike & { progress?: number }) | null = null;
  private readonly stall: StallMonitor;
  private offlineSince: number | null = null;
  private listeners = new Set<(s: GuardianSnapshot) => void>();
  private evidenceCount = 0;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly o: PrintGuardianOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => undefined);
    this.alerts = new AlertStateMachine({ now: this.now, ...o.alerts });
    this.stall = new StallMonitor({ isPaused: o.alerts?.isPaused, ...o.stall });
    this.alerts.onTransition((t, a) => {
      if (a) this.persist(() => this.o.store?.alertChanged(a, t));
      this.changed();
    });
  }

  get sessionId(): string | null {
    return this.session?.id ?? null;
  }

  onUpdate(cb: (s: GuardianSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(opts: { sessionId?: string; printJobId?: string } = {}): GuardianSnapshot {
    if (this.session) return this.snapshot();
    const startedAt = new Date(this.now()).toISOString();
    const id = opts.sessionId ?? `guardian-${startedAt.replace(/[-:]/g, "").replace(/\..*$/, "")}`;
    const evidenceDir = join(this.o.storageRoot, "snapshots", id);
    this.session = {
      id, printJobId: opts.printJobId ?? null, startedAt, snapshotUrl: this.o.worker?.snapshotUrl,
      evidenceDir, evidenceRelDir: relative(this.o.storageRoot, evidenceDir), workerRestarts: 0,
    };
    this.camera = "unknown";
    this.cameraDetail = undefined;
    this.lastObservation = null;
    this.stall.reset();
    this.persist(() => this.o.store?.sessionStarted({ ...this.session! }));
    const config: VisionWorkerConfig = { ...this.o.worker, cwd: this.o.visionDir, session: id, evidenceDir };
    const handlers: VisionWorkerHandlers = {
      onEvent: (e) => this.onVisionEvent(e),
      onStatus: (s) => {
        if (s.state === "restarting" && this.session) this.session.workerRestarts += 1;
        if (s.state !== "running") this.camera = "unknown";
        this.changed();
      },
      onLog: (line, stream) => this.log(`[vision ${stream}] ${line}`),
    };
    this.worker = this.o.createWorker ? this.o.createWorker(config, handlers) : new VisionWorker(config, handlers);
    this.alerts.startMonitoring(id);
    if (this.printer) this.worker.sendPrinterState(this.printer);
    this.worker.start();
    this.changed();
    return this.snapshot();
  }

  async stop(reason = "monitoring stopped"): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.alerts.stopMonitoring(reason);
    if (worker) await worker.stop();
    if (this.session) {
      this.session.endedAt = new Date(this.now()).toISOString();
      this.session.endReason = reason;
      const s = { ...this.session };
      this.persist(() => this.o.store?.sessionEnded(s));
    }
    this.session = null;
    this.camera = "unknown";
    this.changed();
  }

  /**
   * Call on every printer poll (e.g. from PrinterObserver's callback), offline ones too.
   * Drives the stall check, pause confirmation and closing alerts when the job ends.
   */
  updatePrinterStatus(status: GuardianPrinterStatus): void {
    const now = this.now();
    if (status.online === false) {
      // A missed poll or two is normal; the camera checks keep the last known state for a
      // while, then switch off so an empty bed after an unseen stop can't raise alarms.
      this.offlineSince ??= now;
      if (now - this.offlineSince >= (this.o.offlineGraceMs ?? 60_000) && this.printer?.online !== false) {
        this.printer = { online: false, machine: "OFFLINE" };
        this.worker?.sendPrinterState(this.printer);
      }
    } else {
      this.offlineSince = null;
      this.printer = { online: status.online, machine: status.machine, moveMode: status.moveMode, progress: status.progress };
      this.worker?.sendPrinterState(this.printer);
    }
    this.alerts.handlePrinterStatus(status);

    if (!this.session) return;
    for (const e of this.stall.update(status, now)) {
      const ev = { v: 1, seq: 0, ts: new Date(now).toISOString(), session: this.session.id, ...e } as VisionEvent;
      this.onVisionEvent(ev);
      // the printer is moving again: a confirmed stall with nothing else seen is over
      const a = this.alerts.alert;
      if (e.type === "suspicion_cleared" && a && a.kinds.every((k) => k === "stalled") && a.state === "confirmed_failure") {
        this.alerts.resolve(`stall cleared: ${e.reason}`);
      }
    }
    // The job is over (printer online, READY, not paused): nothing left to warn about.
    const ended = status.online !== false && String(status.machine ?? "").toUpperCase() === "READY" && !(this.o.alerts?.isPaused ?? defaultIsPaused)(status);
    if (ended && this.alerts.alert) this.alerts.resolve("print ended (printer is READY)");
  }

  requestPause(): Promise<Alert | null> {
    return this.alerts.requestPause("operator");
  }

  resolve(note?: string): void {
    this.alerts.resolve(note);
  }

  dismiss(note?: string): void {
    this.alerts.dismiss(note);
  }

  /** E.g. after the operator cleared the bed or the lighting changed. */
  resetBaseline(): void {
    this.worker?.resetBaseline();
  }

  snapshot(): GuardianSnapshot {
    const g = this.o.gemini;
    const usage = g?.available ? g.usage() : undefined;
    return {
      state: this.alerts.state,
      label: STATE_LABELS[this.alerts.state],
      sessionId: this.session?.id ?? null,
      camera: this.camera,
      cameraDetail: this.cameraDetail,
      worker: this.worker?.status ?? { state: "stopped" },
      alert: this.alerts.alert,
      history: this.alerts.history,
      lastObservation: this.lastObservation,
      lastHeartbeatAt: this.lastHeartbeatAt,
      printerPhase: this.stall.phase,
      autoPause: this.alerts.autoPauseActive,
      gemini: { available: !!g?.available, model: g?.model, callsToday: usage?.callsToday, dailyCap: usage?.dailyCap },
    };
  }

  // ----- internals --------------------------------------------------------
  private onVisionEvent(e: VisionEvent): void {
    if (e.session && this.session && e.session !== this.session.id) return; // stale worker
    switch (e.type) {
      case "camera_ok":
        this.camera = "ok";
        this.cameraDetail = `${e.width}x${e.height}`;
        break;
      case "camera_lost":
        this.camera = "lost";
        this.cameraDetail = `${e.reason}: ${e.detail}`;
        break;
      case "frozen_frame":
        this.camera = "frozen";
        this.cameraDetail = `${e.identical_frames} identical frames`;
        break;
      case "observation":
        this.lastObservation = e;
        break;
      case "heartbeat":
        this.lastHeartbeatAt = e.ts;
        break;
      default:
        break;
    }
    const before = this.alerts.alert?.state;
    this.alerts.handleVisionEvent(e);
    const alert = this.alerts.alert;

    if (e.type === "possible_failure" || e.type === "confirmed_failure") {
      if (e.evidence) this.recordEvidence(e.evidence, e.type === "confirmed_failure" ? "confirmed" : "suspect", e.kind, alert?.id ?? null, e.ts);
    }
    // verify once, when this event is what confirmed the alert
    if (e.type === "confirmed_failure" && alert && alert.state !== before && (before === undefined || before === "possible_failure")) {
      void this.verify(alert, e);
    }
    if (["camera_ok", "camera_lost", "frozen_frame", "observation", "heartbeat", "suspicion_cleared"].includes(e.type)) this.changed();
  }

  private recordEvidence(path: string, label: "suspect" | "confirmed", kind: FailureKind, alertId: string | null, at: string): void {
    if (!this.session) return;
    const rel = isAbsolute(path) ? relative(this.o.storageRoot, path) : path;
    const rec: EvidenceRecord = { id: `${this.session.id}-ev${++this.evidenceCount}`, sessionId: this.session.id, alertId, at, label, kind, path, relPath: rel };
    this.persist(() => this.o.store?.evidenceSaved(rec));
  }

  /** Gemini (rate-limited) and the review run once per confirmed alert. */
  private async verify(alert: Alert, e: VisionEventOf<"confirmed_failure">): Promise<void> {
    const gemini = this.o.gemini;
    let geminiResult;
    if (gemini && e.evidence) {
      try {
        const jpeg = await (this.o.readFile ?? fsReadFile)(e.evidence);
        geminiResult = await gemini.verify({
          jpeg, suspectedKind: e.kind, printerState: this.printer?.machine, progress: this.printer?.progress,
          metrics: this.lastObservation ? { ...this.lastObservation.metrics } : undefined,
        });
      } catch (err) {
        geminiResult = { status: "unavailable" as const, reason: "bad_response" as const, detail: `could not read evidence: ${(err as Error).message}` };
      }
      this.alerts.addVerification(alert.id, geminiResult.status === "ok"
        ? { source: "gemini", status: "ok", problem: geminiResult.problem, confidence: geminiResult.confidence, explanation: geminiResult.explanation, model: geminiResult.model }
        : { source: "gemini", status: "unavailable", detail: geminiResult.reason + (geminiResult.detail ? `: ${geminiResult.detail}` : "") });
    }
    const review = localReview({ kind: e.kind, localConfirmed: true, localScore: e.score, gemini: geminiResult, printerState: this.printer?.machine });
    this.alerts.addVerification(alert.id, {
      source: review.source, status: "ok", problem: review.recommendation, confidence: review.confidence, explanation: review.rationale,
    });
    this.persist(() => this.o.store?.alertChanged(alert, null));
    this.changed();
  }

  private persist(fn: () => void | Promise<void> | undefined): void {
    try {
      const r = fn();
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch((err) => this.log(`[guardian store] ${(err as Error).message}`));
    } catch (err) {
      this.log(`[guardian store] ${(err as Error).message}`);
    }
  }

  private changed(): void {
    if (!this.listeners.size) return;
    const s = this.snapshot();
    for (const l of this.listeners) {
      try {
        l(s);
      } catch {
        /* ignore listener errors */
      }
    }
  }
}
