// Alert state machine for the print guardian.
//
//   idle ──start──▶ monitoring ──possible──▶ possible_failure ──confirmed──▶ confirmed_failure
//                        ▲                        │ cleared                     │ requestPause()
//                        │                        ▼                             ▼
//                        └──── (closed) ◀── false_alarm            pause_requested ──printer PAUSED──▶ pause_confirmed
//                        └──── (closed) ◀── resolved                     │ timeout          ▲
//                                                                        ▼                  │ printer PAUSED
//                                                                  pause_unconfirmed ───────┘
//
// "Pause requested" never means "paused": only a printer status reporting a
// paused machine moves an alert to pause_confirmed. Auto-pause is OFF by
// default and this module never talks to the printer: requestPause() calls
// an injected PauseHook (to be wired by Phase 5) or, without one, asks the
// operator to pause at the printer.
import type { FailureKind, VisionEvent } from "./events";

export type AlertState =
  | "possible_failure"
  | "confirmed_failure"
  | "pause_requested"
  | "pause_confirmed"
  | "pause_unconfirmed"
  | "resolved"
  | "false_alarm";

export type GuardianState = "idle" | "monitoring" | AlertState;

/** Operator-facing wording. Deliberately never says "paused" before the printer confirms it. */
export const STATE_LABELS: Record<GuardianState, string> = {
  idle: "Guardian off",
  monitoring: "Watching the print",
  possible_failure: "Possible problem — checking more frames",
  confirmed_failure: "Print problem confirmed — pausing is recommended",
  pause_requested: "Pause requested — waiting for the printer to confirm (NOT paused yet)",
  pause_confirmed: "Printer confirmed it is paused",
  pause_unconfirmed: "Pause NOT confirmed by the printer — check the printer now",
  resolved: "Resolved",
  false_alarm: "False alarm",
};

export interface PauseRequest {
  source: "operator" | "auto";
  /** "hook": handed to the integrator's PauseHook; "operator_manual": the operator must pause at the printer. */
  delivery: "hook" | "operator_manual";
  requestedAt: string;
  hookAccepted?: boolean;
  hookDetail?: string;
}

export interface Transition {
  alertId: string | null;
  from: GuardianState;
  to: GuardianState;
  at: string;
  reason: string;
}

export interface AlertVerification {
  source: "gemini" | "local";
  problem?: string;
  confidence?: number;
  explanation?: string;
  model?: string;
  status: "ok" | "unavailable";
  detail?: string;
}

export interface Alert {
  id: string;
  sessionId: string | null;
  kind: FailureKind;
  /** Every kind the detector raised while this alert was open. */
  kinds: FailureKind[];
  state: AlertState;
  openedAt: string;
  updatedAt: string;
  score: number;
  evidence: string[];
  confirmedAt?: string;
  pause?: PauseRequest;
  pauseConfirmedAt?: string;
  /** "request": confirmed after our request; "external": someone paused at the printer. */
  pauseConfirmedBy?: "request" | "external";
  closedAt?: string;
  resolution?: string;
  /** Vision stopped seeing the problem after confirmation (operator still decides). */
  visionCleared?: boolean;
  verifications: AlertVerification[];
  transitions: Transition[];
}

export interface PauseHookResult {
  accepted: boolean;
  detail?: string;
}

/**
 * Integration point for Phase 5. Must only send a validated pause command and
 * report whether the printer ACCEPTED the request — not whether it paused.
 * The pause is confirmed separately from printer status.
 */
export type PauseHook = (alert: Readonly<Alert>) => Promise<PauseHookResult>;

export interface PrinterStatusLike {
  online?: boolean;
  machine?: string;
  moveMode?: string;
}

export interface AlertMachineOptions {
  /** Default false. Even when true, nothing happens unless pauseHook is also provided. */
  autoPause?: boolean;
  pauseHook?: PauseHook;
  /** How long to wait for the printer to report PAUSED before pause_unconfirmed. Default 90 s. */
  pauseConfirmTimeoutMs?: number;
  isPaused?: (s: PrinterStatusLike) => boolean;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  newId?: () => string;
  /** Closed alerts kept in memory for the UI. Default 50. */
  historyLimit?: number;
}

export const defaultIsPaused = (s: PrinterStatusLike): boolean =>
  s.online !== false && (["PAUSED", "PAUSE"].includes(String(s.machine ?? "").toUpperCase()) || String(s.moveMode ?? "").toUpperCase() === "PAUSED");

let counter = 0;
const defaultId = () => `alert-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export class AlertStateMachine {
  private monitoring = false;
  private sessionId: string | null = null;
  private current: Alert | null = null;
  private closed: Alert[] = [];
  private pauseTimer: unknown = null;
  private listeners = new Set<(t: Transition, alert: Alert | null) => void>();
  private readonly o: Required<Omit<AlertMachineOptions, "pauseHook">> & { pauseHook?: PauseHook };

  constructor(opts: AlertMachineOptions = {}) {
    this.o = {
      autoPause: opts.autoPause ?? false,
      pauseHook: opts.pauseHook,
      pauseConfirmTimeoutMs: opts.pauseConfirmTimeoutMs ?? 90_000,
      isPaused: opts.isPaused ?? defaultIsPaused,
      now: opts.now ?? Date.now,
      setTimeout: opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeout: opts.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout)),
      newId: opts.newId ?? defaultId,
      historyLimit: opts.historyLimit ?? 50,
    };
  }

  get state(): GuardianState {
    if (this.current) return this.current.state;
    return this.monitoring ? "monitoring" : "idle";
  }

  get alert(): Alert | null {
    return this.current;
  }

  get history(): Alert[] {
    return [...this.closed];
  }

  get autoPauseActive(): boolean {
    return this.o.autoPause && !!this.o.pauseHook;
  }

  onTransition(cb: (t: Transition, alert: Alert | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  startMonitoring(sessionId: string | null = null): void {
    if (this.monitoring) return;
    this.sessionId = sessionId;
    this.monitoring = true;
    this.emit({ alertId: null, from: "idle", to: "monitoring", at: this.iso(), reason: "monitoring started" }, null);
  }

  /** Stops monitoring; an open alert is closed as resolved ("monitoring stopped"). */
  stopMonitoring(reason = "monitoring stopped"): void {
    if (this.current) this.close("resolved", reason);
    if (!this.monitoring) return;
    this.monitoring = false;
    this.emit({ alertId: null, from: "monitoring", to: "idle", at: this.iso(), reason }, null);
  }

  handleVisionEvent(ev: VisionEvent): void {
    if (!this.monitoring) return;
    switch (ev.type) {
      case "possible_failure": {
        const a = this.current ?? this.open(ev.kind, ev.score, `vision: possible ${ev.kind}`);
        this.addKind(a, ev.kind, ev.evidence ? [ev.evidence] : []);
        break;
      }
      case "confirmed_failure": {
        const a = this.current ?? this.open(ev.kind, ev.score, `vision: ${ev.kind} confirmed without prior warning`);
        this.addKind(a, ev.kind, [...ev.evidence_frames, ...(ev.evidence ? [ev.evidence] : [])]);
        a.score = Math.max(a.score, ev.score);
        if (a.state === "possible_failure") {
          a.confirmedAt = this.iso();
          this.move(a, "confirmed_failure", `vision: ${ev.kind} in ${ev.window.hits} of last ${ev.window.of} frames`);
          if (this.autoPauseActive) void this.requestPause("auto");
        }
        break;
      }
      case "suspicion_cleared": {
        const a = this.current;
        if (!a || !a.kinds.includes(ev.kind)) break;
        if (a.state === "possible_failure") {
          this.close("false_alarm", `vision: ${ev.kind} no longer detected (${ev.reason})`);
        } else {
          a.visionCleared = true;
          a.updatedAt = this.iso();
        }
        break;
      }
      default:
        break;
    }
  }

  /** Feed every printer status poll here. This is the ONLY way to reach pause_confirmed. */
  handlePrinterStatus(status: PrinterStatusLike): void {
    const a = this.current;
    if (!a || !this.o.isPaused(status)) return;
    if (a.state === "pause_requested" || a.state === "pause_unconfirmed") {
      this.confirmPause(a, "request", `printer reports ${status.machine}`);
    } else if (a.state === "possible_failure" || a.state === "confirmed_failure") {
      this.confirmPause(a, "external", `printer reports ${status.machine} (paused outside the guardian)`);
    }
  }

  /**
   * Request a pause for the open alert. With a PauseHook the request goes to
   * the integrator; without one the operator is asked to pause at the printer.
   * Either way the alert stays pause_requested until printer status confirms.
   */
  async requestPause(source: "operator" | "auto" = "operator"): Promise<Alert | null> {
    const a = this.current;
    if (!a || !["possible_failure", "confirmed_failure", "pause_unconfirmed"].includes(a.state)) return a;
    if (source === "auto" && !this.autoPauseActive) return a;
    const hook = this.o.pauseHook;
    a.pause = { source, delivery: hook ? "hook" : "operator_manual", requestedAt: this.iso() };
    this.move(a, "pause_requested", hook ? `${source} pause request sent to printer integration` : `${source} asked to pause at the printer`);
    this.armPauseTimeout(a);
    if (hook) {
      try {
        const r = await hook(a);
        a.pause.hookAccepted = r.accepted;
        a.pause.hookDetail = r.detail;
        if (!r.accepted && this.current === a && a.state === "pause_requested") {
          this.disarmPauseTimeout();
          this.move(a, "pause_unconfirmed", `printer integration rejected the pause: ${r.detail ?? "no detail"}`);
        }
      } catch (e) {
        a.pause.hookAccepted = false;
        a.pause.hookDetail = (e as Error).message;
        if (this.current === a && a.state === "pause_requested") {
          this.disarmPauseTimeout();
          this.move(a, "pause_unconfirmed", `pause request failed: ${(e as Error).message}`);
        }
      }
    }
    return a;
  }

  /** Operator: the problem was real and has been dealt with. */
  resolve(note = "resolved by operator"): void {
    if (this.current) this.close("resolved", note);
  }

  /** Operator: there was no problem. */
  dismiss(note = "dismissed by operator"): void {
    if (this.current) this.close("false_alarm", note);
  }

  /** Attach an AI/remote opinion. It informs the operator; it never changes the state. */
  addVerification(alertId: string, v: AlertVerification): boolean {
    const a = this.current?.id === alertId ? this.current : this.closed.find((x) => x.id === alertId);
    if (!a) return false;
    a.verifications.push(v);
    a.updatedAt = this.iso();
    return true;
  }

  // ----- internals --------------------------------------------------------
  private iso(): string {
    return new Date(this.o.now()).toISOString();
  }

  private open(kind: FailureKind, score: number, reason: string): Alert {
    const at = this.iso();
    const a: Alert = {
      id: this.o.newId(), sessionId: this.sessionId, kind, kinds: [kind], state: "possible_failure",
      openedAt: at, updatedAt: at, score, evidence: [], verifications: [], transitions: [],
    };
    this.current = a;
    const t: Transition = { alertId: a.id, from: "monitoring", to: "possible_failure", at, reason };
    a.transitions.push(t);
    this.emit(t, a);
    return a;
  }

  private addKind(a: Alert, kind: FailureKind, evidence: string[]): void {
    if (!a.kinds.includes(kind)) a.kinds.push(kind);
    for (const e of evidence) if (e && !a.evidence.includes(e)) a.evidence.push(e);
    a.visionCleared = false;
    a.updatedAt = this.iso();
  }

  private move(a: Alert, to: AlertState, reason: string): void {
    const t: Transition = { alertId: a.id, from: a.state, to, at: this.iso(), reason };
    a.state = to;
    a.updatedAt = t.at;
    a.transitions.push(t);
    this.emit(t, a);
  }

  private confirmPause(a: Alert, by: "request" | "external", reason: string): void {
    this.disarmPauseTimeout();
    a.pauseConfirmedAt = this.iso();
    a.pauseConfirmedBy = by;
    this.move(a, "pause_confirmed", reason);
  }

  private armPauseTimeout(a: Alert): void {
    this.disarmPauseTimeout();
    this.pauseTimer = this.o.setTimeout(() => {
      this.pauseTimer = null;
      if (this.current === a && a.state === "pause_requested") {
        this.move(a, "pause_unconfirmed", `printer did not report PAUSED within ${Math.round(this.o.pauseConfirmTimeoutMs / 1000)} s`);
      }
    }, this.o.pauseConfirmTimeoutMs);
  }

  private disarmPauseTimeout(): void {
    if (this.pauseTimer) this.o.clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
  }

  private close(to: "resolved" | "false_alarm", reason: string): void {
    const a = this.current;
    if (!a) return;
    this.disarmPauseTimeout();
    a.closedAt = this.iso();
    a.resolution = reason;
    this.move(a, to, reason);
    this.current = null;
    this.closed = [a, ...this.closed].slice(0, this.o.historyLimit);
  }

  private emit(t: Transition, a: Alert | null): void {
    for (const l of this.listeners) {
      try {
        l(t, a);
      } catch {
        /* a broken listener must not break the state machine */
      }
    }
  }
}
