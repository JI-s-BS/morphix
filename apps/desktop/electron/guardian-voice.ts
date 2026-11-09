// Spoken Print Guardian warnings. When the guardian confirms a failure, Morphix says it
// out loud (Gemini's voice, or local espeak-ng when Gemini can't), asks whether to stop
// the print, and accepts "yes, stop it" / "no, keep printing" by voice or the matching
// touchscreen buttons. Stopping goes through the normal validated cancel and is only
// announced as done once the printer confirms it.
//
// One incident per guardian alert id: an alert is announced once, repeated at most
// `maxAnnouncements - 1` more times `repeatMs` apart while unanswered, then stays on
// screen silently. After "keep printing", new alerts of the same kind stay quiet for
// `quietAfterKeepMs` (still shown on screen).

export type WarningDecision = "stop" | "keep";

export interface GuardianAlertLike {
  id: string;
  kind: string;
  state: string;
  explanation?: string;
}

export interface IncidentView {
  alertId: string;
  kind: string;
  problem: string;
  announcements: number;
  awaitingAnswer: boolean;
  /** "gemini" | "local" | "none" for the last attempt. */
  lastSpokenBy: "gemini" | "local" | "none" | null;
  simulated: boolean;
}

export interface GuardianVoiceDeps {
  /** Stop any assistant speech now and play the alert chime. */
  interrupt(): void;
  /** Speak exactly this text with Gemini's voice; resolves true once audio actually started. */
  speakGemini(text: string): Promise<boolean>;
  /** Speak with the local engine; resolves true once audio was sent to the speaker. */
  speakLocal(text: string): Promise<boolean>;
  /** The existing, printer-confirmed cancel. */
  cancelPrint(): Promise<{ ok: boolean; message: string }>;
  /** Same as the touchscreen "It's fine" button. */
  keepPrinting(): void;
  /** Mark the guardian alert resolved after a confirmed stop. */
  resolveAlert(): void;
  /** True while the user is talking / a voice turn is in progress (repeats wait). */
  userBusy(): boolean;
  onChange(view: IncidentView | null): void;
  log(level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
  now?(): number;
}

export interface GuardianVoiceOptions {
  repeatMs?: number;
  maxAnnouncements?: number;
  quietAfterKeepMs?: number;
  /** When the user is mid-sentence at repeat time, try again this much later. */
  busyRetryMs?: number;
}

const PROBLEMS: Record<string, string> = {
  spaghetti: "a messy tangle of loose plastic, like spaghetti. The print may have come loose or failed",
  detachment: "the print may have come loose from the bed",
  stalled: "the printer seems to have stopped making progress",
};

export function describeProblem(kind: string, explanation?: string): string {
  const base = PROBLEMS[kind] ?? `a possible ${kind.replaceAll("_", " ")} problem`;
  const extra = explanation?.trim().replace(/\s+/g, " ");
  // Add the AI's own observation when it's short enough to say out loud.
  return extra && extra.length <= 160 && !base.toLowerCase().includes(extra.toLowerCase()) ? `${base}. ${extra.replace(/\.$/, "")}` : base;
}

export function warningText(problem: string, repeat: number): string {
  if (repeat > 0) return `Reminder: the print guardian still sees ${problem}. Should I stop the print? Say yes, stop it, or no, keep printing. You can also tap the screen.`;
  return `Warning! The print guardian sees ${problem}. Do you want me to stop the print? Say yes, stop it, or no, keep printing.`;
}

/**
 * Deterministic reading of the user's own words. Ambiguous or unrelated answers return
 * null so Morphix asks again instead of guessing.
 */
export function classifyWarningAnswer(utterance: string): WarningDecision | null {
  const t = ` ${utterance.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ")} `;
  const negatedStop = /\b(don'?t|do not|dont|not|never|no need to)\s+(stop|cancel|abort)\b/.test(t);
  const keep = negatedStop || /\b(no|nope|nah|keep|continue|carry on|let it (run|go|print|finish)|leave it|it'?s (fine|ok|okay)|its fine|false alarm|looks fine|all good|i'?ve checked|i checked|i have checked|checked it)\b/.test(t);
  const stop = !negatedStop && /\b(yes|yeah|yep|yup|sure|please do|stop|cancel|abort|kill|halt|end it|turn it off)\b/.test(t);
  if (stop && keep) return null;
  return stop ? "stop" : keep ? "keep" : null;
}

interface Incident {
  alert: GuardianAlertLike;
  problem: string;
  announcements: number;
  timer: unknown;
  lastSpokenBy: IncidentView["lastSpokenBy"];
  answering: boolean;
  simulated: boolean;
}

export class GuardianVoice {
  private incident: Incident | null = null;
  private announced = new Set<string>();
  private quietUntil = new Map<string, number>();
  private readonly o: Required<GuardianVoiceOptions>;

  constructor(private d: GuardianVoiceDeps, opts: GuardianVoiceOptions = {}) {
    this.o = {
      repeatMs: opts.repeatMs ?? 60_000,
      maxAnnouncements: opts.maxAnnouncements ?? 3,
      quietAfterKeepMs: opts.quietAfterKeepMs ?? 10 * 60_000,
      busyRetryMs: opts.busyRetryMs ?? 8_000,
    };
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }
  private setTimer(fn: () => void, ms: number): unknown {
    return this.d.setTimer ? this.d.setTimer(fn, ms) : setTimeout(fn, ms);
  }
  private clearTimer(t: unknown): void {
    if (t === null || t === undefined) return;
    if (this.d.clearTimer) this.d.clearTimer(t);
    else clearTimeout(t as ReturnType<typeof setTimeout>);
  }

  get open(): boolean {
    return this.incident !== null;
  }

  view(): IncidentView | null {
    const i = this.incident;
    return i
      ? {
          alertId: i.alert.id, kind: i.alert.kind, problem: i.problem, announcements: i.announcements,
          awaitingAnswer: !i.answering, lastSpokenBy: i.lastSpokenBy, simulated: i.simulated,
        }
      : null;
  }

  /** Feed every guardian snapshot's alert (or null). */
  onAlert(alert: GuardianAlertLike | null): void {
    const cur = this.incident;
    if (cur && !cur.simulated && (!alert || alert.id !== cur.alert.id || alert.state !== "confirmed_failure")) {
      // Answered on the touchscreen (pause / it's fine / resolved) or the alert went away.
      if (!cur.answering) this.close(`alert ${alert ? alert.state : "closed"}`);
    }
    if (!alert || alert.state !== "confirmed_failure" || this.announced.has(alert.id) || this.incident) return;
    const quiet = this.quietUntil.get(alert.kind) ?? 0;
    if (this.now() < quiet) {
      this.announced.add(alert.id);
      this.d.log("info", "guardian warning kept quiet (user said keep printing recently)", { alertId: alert.id, kind: alert.kind });
      return;
    }
    this.start(alert, false);
  }

  /** A pretend incident for testing speech and answers. Never touches the printer. */
  simulate(kind = "spaghetti"): IncidentView {
    if (this.incident) this.close("replaced by a simulation");
    this.start({ id: `simulated-${this.now()}`, kind, state: "confirmed_failure", explanation: "This is only a test." }, true);
    return this.view()!;
  }

  private start(alert: GuardianAlertLike, simulated: boolean): void {
    this.announced.add(alert.id);
    this.incident = { alert, problem: describeProblem(alert.kind, alert.explanation), announcements: 0, timer: null, lastSpokenBy: null, answering: false, simulated };
    this.d.log("warn", "guardian warning: asking the user", { alertId: alert.id, kind: alert.kind, simulated });
    void this.announce();
  }

  private async announce(): Promise<void> {
    const i = this.incident;
    if (!i || i.answering) return;
    i.timer = null;
    if (i.announcements > 0 && this.d.userBusy()) {
      i.timer = this.setTimer(() => void this.announce(), this.o.busyRetryMs);
      return;
    }
    const text = warningText(i.problem, i.announcements);
    i.announcements += 1;
    this.d.interrupt();
    i.lastSpokenBy = await this.say(text);
    if (this.incident !== i) return;
    this.d.log(i.lastSpokenBy === "none" ? "error" : "info", "guardian warning spoken", { alertId: i.alert.id, via: i.lastSpokenBy, n: i.announcements });
    this.d.onChange(this.view());
    if (!i.answering && i.announcements < this.o.maxAnnouncements) i.timer = this.setTimer(() => void this.announce(), this.o.repeatMs);
  }

  /** Gemini first, then the local voice. Never throws. */
  private async say(text: string): Promise<"gemini" | "local" | "none"> {
    try {
      if (await this.d.speakGemini(text)) return "gemini";
    } catch (e) {
      this.d.log("warn", "Gemini could not speak the warning", { error: (e as Error).message });
    }
    try {
      if (await this.d.speakLocal(text)) return "local";
    } catch (e) {
      this.d.log("warn", "local speech failed", { error: (e as Error).message });
    }
    return "none";
  }

  /**
   * The user's answer, from voice or the touchscreen. `speak` = false when Gemini will
   * relay the result itself (voice tool call).
   */
  async answer(decision: WarningDecision, by: "voice" | "touch", speak = true): Promise<{ ok: boolean; message: string; stopped?: boolean }> {
    const i = this.incident;
    if (!i) return { ok: false, message: "There is no print warning waiting for an answer." };
    if (i.answering) return { ok: false, message: "Already handling the answer." };
    i.answering = true;
    this.clearTimer(i.timer);
    i.timer = null;
    this.d.onChange(this.view());
    this.d.log("info", "guardian warning answered", { alertId: i.alert.id, decision, by, simulated: i.simulated });

    if (decision === "keep") {
      if (!i.simulated) {
        this.quietUntil.set(i.alert.kind, this.now() + this.o.quietAfterKeepMs);
        this.d.keepPrinting();
      }
      this.close("keep printing");
      const message = "Okay, I'll keep printing and keep watching.";
      if (speak) void this.say(message);
      return { ok: true, message, stopped: false };
    }

    if (speak) {
      this.d.interrupt();
      void this.say("Okay, asking the printer to stop.");
    }
    const r = i.simulated
      ? { ok: true, message: "Simulation: no command was sent to the printer." }
      : await this.d.cancelPrint().catch((e: Error) => ({ ok: false, message: e.message }));
    if (r.ok) {
      if (!i.simulated) this.d.resolveAlert();
      this.close("stopped");
      const message = i.simulated ? "Test finished. In a real warning, the printer would now confirm the print has stopped." : "The printer confirmed the print has stopped.";
      if (speak) void this.say(message);
      return { ok: true, message, stopped: !i.simulated };
    }
    // Not confirmed: keep the alert open and on screen, but don't nag with repeats.
    i.answering = false;
    i.announcements = this.o.maxAnnouncements;
    this.d.onChange(this.view());
    const message = `I asked the printer to stop, but it has not confirmed it. Please press stop on the printer's own screen. (${r.message})`;
    if (speak) void this.say(message);
    return { ok: false, message, stopped: false };
  }

  private close(reason: string): void {
    const i = this.incident;
    if (!i) return;
    this.clearTimer(i.timer);
    this.incident = null;
    this.d.log("info", "guardian warning closed", { alertId: i.alert.id, reason });
    this.d.onChange(null);
  }

  dispose(): void {
    if (this.incident) this.clearTimer(this.incident.timer);
    this.incident = null;
  }
}
