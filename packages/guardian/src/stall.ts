// Stall check from printer status (not the camera). A still camera is normal while
// the printer heats up, and an empty bed after a stopped print never changes either,
// so "stalled" is decided only from what the printer itself reports:
//
//   - only while MachineStatus is BUILDING_FROM_SD and the job is not paused
//     (MoveMode PAUSED counts as paused);
//   - never while heating (nozzle or bed below its target) or while progress and
//     layer are still 0 in the first minutes of a job;
//   - progress %, layer and head position (M114) all count as "making progress";
//   - the suspicion is dropped as soon as the job pauses, ends or the printer is
//     unreachable, and the clock restarts when it comes back.
//
// It emits the same possible/confirmed/cleared events as the vision worker so the
// alert state machine treats both sources alike.
import type { ConfirmWindow } from "./events";
import { defaultIsPaused } from "./alerts";
import type { PrinterStatusLike } from "./alerts";

export interface GuardianPrinterStatus extends PrinterStatusLike {
  progress?: number;
  layer?: [number, number];
  position?: Record<string, number>;
  temps?: { nozzle?: { current: number; target: number }; bed?: { current: number; target: number } };
  currentFile?: string;
}

export interface StallOptions {
  /** No progress, layer or head movement for this long while building = stalled. Default 15 min. */
  stallMs?: number;
  /** A stall must last this much longer (over at least 2 more polls) to be confirmed. Default 2 min. */
  confirmMs?: number;
  /** Progress 0 / layer 0 counts as start-up (heating, levelling, purge) for this long. Default 20 min. */
  startupGraceMs?: number;
  /** A heater this many °C below its target means "still heating". Default 5. */
  heatingToleranceC?: number;
  isPaused?: (s: PrinterStatusLike) => boolean;
}

export type StallEvent =
  | { type: "possible_failure"; kind: "stalled"; score: number; window: ConfirmWindow; evidence: null }
  | { type: "confirmed_failure"; kind: "stalled"; score: number; window: ConfirmWindow; evidence: null; evidence_frames: string[] }
  | { type: "suspicion_cleared"; kind: "stalled"; reason: string; was_confirmed: boolean };

export type StallPhase = "inactive" | "paused" | "heating" | "starting" | "printing" | "stalled";

const BUILDING = "BUILDING_FROM_SD";

export class StallMonitor {
  private readonly o: Required<StallOptions>;
  private jobStartAt: number | null = null;
  private lastChangeAt: number | null = null;
  private signature: string | null = null;
  private possible = false;
  private confirmed = false;
  private pollsSincePossible = 0;
  private _phase: StallPhase = "inactive";

  constructor(opts: StallOptions = {}) {
    this.o = {
      stallMs: opts.stallMs ?? 15 * 60_000,
      confirmMs: opts.confirmMs ?? 2 * 60_000,
      startupGraceMs: opts.startupGraceMs ?? 20 * 60_000,
      heatingToleranceC: opts.heatingToleranceC ?? 5,
      isPaused: opts.isPaused ?? defaultIsPaused,
    };
  }

  get phase(): StallPhase {
    return this._phase;
  }

  /** Forget everything (new monitoring session). */
  reset(): void {
    this.jobStartAt = this.lastChangeAt = null;
    this.signature = null;
    this.possible = this.confirmed = false;
    this.pollsSincePossible = 0;
    this._phase = "inactive";
  }

  /** Feed every printer poll, including offline ones. */
  update(s: GuardianPrinterStatus, now: number): StallEvent[] {
    const online = s.online !== false;
    const paused = online && this.o.isPaused(s);
    const building = online && String(s.machine ?? "").toUpperCase() === BUILDING && !paused;

    if (!building) {
      // Job over (printer online and neither building nor paused): next BUILDING is a new job.
      if (online && !paused) this.jobStartAt = null;
      this.lastChangeAt = null;
      this.signature = null;
      this._phase = paused ? "paused" : "inactive";
      return this.clear(!online ? "printer not reachable" : paused ? "print paused" : "print ended");
    }

    if (this.jobStartAt === null) this.jobStartAt = now;
    const sig = signature(s);
    const changed = sig !== this.signature;
    this.signature = sig;

    const heating = isHeating(s, this.o.heatingToleranceC);
    const starting = !(s.progress ?? 0) && !(s.layer?.[0] ?? 0) && now - this.jobStartAt < this.o.startupGraceMs;
    if (heating || starting || changed || this.lastChangeAt === null) {
      this.lastChangeAt = now;
      this._phase = heating ? "heating" : starting ? "starting" : "printing";
      return this.clear(heating ? "printer is heating" : "printer is making progress again");
    }

    const stillMs = now - this.lastChangeAt;
    if (stillMs < this.o.stallMs) {
      this._phase = "printing";
      return [];
    }
    this._phase = "stalled";
    const score = Math.round(stillMs / 1000);
    const events: StallEvent[] = [];
    if (!this.possible) {
      this.possible = true;
      this.pollsSincePossible = 0;
      events.push({ type: "possible_failure", kind: "stalled", score, window: { hits: 1, of: 1, need: 3, size: 3 }, evidence: null });
      return events;
    }
    this.pollsSincePossible += 1;
    if (!this.confirmed && this.pollsSincePossible >= 2 && stillMs >= this.o.stallMs + this.o.confirmMs) {
      this.confirmed = true;
      const polls = this.pollsSincePossible + 1;
      events.push({ type: "confirmed_failure", kind: "stalled", score, window: { hits: polls, of: polls, need: 3, size: polls }, evidence: null, evidence_frames: [] });
    }
    return events;
  }

  private clear(reason: string): StallEvent[] {
    if (!this.possible && !this.confirmed) return [];
    const was = this.confirmed;
    this.possible = this.confirmed = false;
    this.pollsSincePossible = 0;
    return [{ type: "suspicion_cleared", kind: "stalled", reason, was_confirmed: was }];
  }
}

/** Nozzle or bed has a target and is still more than `tol` °C below it. */
export function isHeating(s: GuardianPrinterStatus, tol = 5): boolean {
  const below = (h?: { current: number; target: number }) => !!h && h.target > 0 && h.current < h.target - tol;
  return below(s.temps?.nozzle) || below(s.temps?.bed);
}

/** Everything that moves while a print is really running. Position is rounded to 0.1 mm. */
function signature(s: GuardianPrinterStatus): string {
  const pos = s.position ? Object.keys(s.position).sort().map((k) => `${k}${Math.round((s.position![k] ?? 0) * 10)}`).join(",") : "";
  return `${s.progress ?? ""}|${s.layer?.[0] ?? ""}|${pos}`;
}
