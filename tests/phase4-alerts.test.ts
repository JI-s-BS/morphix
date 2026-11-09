import { describe, expect, it, vi } from "vitest";
import { AlertStateMachine, STATE_LABELS } from "@morphix/guardian";
import type { FailureKind, GuardianState, PauseHook, VisionEvent } from "@morphix/guardian";

const env = { v: 1, seq: 1, ts: "t", session: "s" };
const win = { hits: 1, of: 5, need: 3, size: 5 };
const possible = (kind: FailureKind = "spaghetti"): VisionEvent => ({ ...env, type: "possible_failure", kind, score: 2, window: win, evidence: "/e/1.jpg" });
const confirmed = (kind: FailureKind = "spaghetti"): VisionEvent => ({ ...env, type: "confirmed_failure", kind, score: 3, window: { ...win, hits: 3 }, evidence: "/e/c.jpg", evidence_frames: ["/e/1.jpg", "/e/2.jpg"] });
const cleared = (kind: FailureKind = "spaghetti"): VisionEvent => ({ ...env, type: "suspicion_cleared", kind, reason: "no_longer_detected", was_confirmed: false });

function machine(opts: ConstructorParameters<typeof AlertStateMachine>[0] = {}) {
  let t = 0;
  const timers: { fn: () => void; at: number }[] = [];
  const m = new AlertStateMachine({
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
    ...opts,
  });
  const states: GuardianState[] = [];
  m.onTransition((tr) => states.push(tr.to));
  const advance = (ms: number) => {
    t += ms;
    for (const h of [...timers]) if (h.at <= t) { timers.splice(timers.indexOf(h), 1); h.fn(); }
  };
  return { m, states, advance };
}

describe("alert state machine", () => {
  it("goes monitoring → possible → confirmed and ignores events while idle", () => {
    const { m, states } = machine();
    m.handleVisionEvent(possible());
    expect(m.state).toBe("idle");
    m.startMonitoring("s1");
    m.handleVisionEvent(possible());
    expect(m.state).toBe("possible_failure");
    m.handleVisionEvent(confirmed());
    expect(m.state).toBe("confirmed_failure");
    expect(m.alert?.evidence).toEqual(["/e/1.jpg", "/e/2.jpg", "/e/c.jpg"]);
    expect(m.alert?.sessionId).toBe("s1");
    expect(states).toEqual(["monitoring", "possible_failure", "confirmed_failure"]);
  });

  it("possible failure that clears becomes a false alarm and monitoring resumes", () => {
    const { m, states } = machine();
    m.startMonitoring();
    m.handleVisionEvent(possible());
    m.handleVisionEvent(cleared("detachment")); // other kind: ignored
    expect(m.state).toBe("possible_failure");
    m.handleVisionEvent(cleared());
    expect(m.state).toBe("monitoring");
    expect(states.at(-1)).toBe("false_alarm");
    expect(m.history[0].state).toBe("false_alarm");
  });

  it("a confirmed failure is not auto-dismissed when vision clears", () => {
    const { m } = machine();
    m.startMonitoring();
    m.handleVisionEvent(confirmed());
    m.handleVisionEvent(cleared());
    expect(m.state).toBe("confirmed_failure");
    expect(m.alert?.visionCleared).toBe(true);
  });

  it("does NOT auto-pause by default, even with a hook", async () => {
    const hook = vi.fn<PauseHook>(async () => ({ accepted: true }));
    const { m } = machine({ pauseHook: hook });
    m.startMonitoring();
    m.handleVisionEvent(confirmed());
    await Promise.resolve();
    expect(hook).not.toHaveBeenCalled();
    expect(m.state).toBe("confirmed_failure");
    expect(m.autoPauseActive).toBe(false);
    // autoPause without a hook is inert too
    expect(machine({ autoPause: true }).m.autoPauseActive).toBe(false);
  });

  it("pause request without hook waits for printer confirmation", async () => {
    const { m, states } = machine();
    m.startMonitoring();
    m.handleVisionEvent(confirmed());
    await m.requestPause();
    expect(m.state).toBe("pause_requested");
    expect(m.alert?.pause).toMatchObject({ source: "operator", delivery: "operator_manual" });
    m.handlePrinterStatus({ online: true, machine: "BUILDING_FROM_SD" });
    expect(m.state).toBe("pause_requested");
    m.handlePrinterStatus({ online: true, machine: "PAUSED" });
    expect(m.state).toBe("pause_confirmed");
    expect(m.alert?.pauseConfirmedBy).toBe("request");
    expect(states.slice(-2)).toEqual(["pause_requested", "pause_confirmed"]);
  });

  it("times out to pause_unconfirmed, and a late PAUSED still confirms", async () => {
    const { m, advance } = machine({ pauseConfirmTimeoutMs: 60_000 });
    m.startMonitoring();
    m.handleVisionEvent(confirmed());
    await m.requestPause();
    advance(59_000);
    expect(m.state).toBe("pause_requested");
    advance(1_000);
    expect(m.state).toBe("pause_unconfirmed");
    expect(STATE_LABELS.pause_unconfirmed).toMatch(/NOT confirmed/);
    m.handlePrinterStatus({ machine: "PAUSED" });
    expect(m.state).toBe("pause_confirmed");
  });

  it("an offline printer reporting PAUSED does not confirm", async () => {
    const { m } = machine();
    m.startMonitoring();
    m.handleVisionEvent(confirmed());
    await m.requestPause();
    m.handlePrinterStatus({ online: false, machine: "PAUSED" });
    expect(m.state).toBe("pause_requested");
  });

  it("uses the hook; rejection or failure means pause_unconfirmed, acceptance still needs status", async () => {
    const accepted = machine({ pauseHook: async () => ({ accepted: true, detail: "sent" }) });
    accepted.m.startMonitoring();
    accepted.m.handleVisionEvent(confirmed());
    await accepted.m.requestPause();
    expect(accepted.m.state).toBe("pause_requested");
    expect(accepted.m.alert?.pause).toMatchObject({ delivery: "hook", hookAccepted: true });

    const rejected = machine({ pauseHook: async () => ({ accepted: false, detail: "not validated" }) });
    rejected.m.startMonitoring();
    rejected.m.handleVisionEvent(confirmed());
    await rejected.m.requestPause();
    expect(rejected.m.state).toBe("pause_unconfirmed");

    const broken = machine({ pauseHook: async () => { throw new Error("socket closed"); } });
    broken.m.startMonitoring();
    broken.m.handleVisionEvent(confirmed());
    await broken.m.requestPause();
    expect(broken.m.state).toBe("pause_unconfirmed");
    expect(broken.m.alert?.transitions.at(-1)?.reason).toMatch(/socket closed/);
  });

  it("auto-pause only when explicitly enabled AND a hook exists", async () => {
    const hook = vi.fn<PauseHook>(async () => ({ accepted: true }));
    const { m } = machine({ autoPause: true, pauseHook: hook });
    m.startMonitoring();
    m.handleVisionEvent(possible());
    m.handleVisionEvent(confirmed());
    await Promise.resolve();
    expect(hook).toHaveBeenCalledOnce();
    expect(m.state).toBe("pause_requested");
    expect(m.alert?.pause?.source).toBe("auto");
  });

  it("external pause at the printer is recorded as such", () => {
    const { m } = machine();
    m.startMonitoring();
    m.handleVisionEvent(confirmed());
    m.handlePrinterStatus({ machine: "paused" });
    expect(m.state).toBe("pause_confirmed");
    expect(m.alert?.pauseConfirmedBy).toBe("external");
  });

  it("operator resolve/dismiss close the alert; requestPause is a no-op without an alert", async () => {
    const { m, states } = machine();
    m.startMonitoring();
    expect(await m.requestPause()).toBeNull();
    m.handleVisionEvent(confirmed());
    m.resolve("cleared the bed");
    expect(m.state).toBe("monitoring");
    expect(m.history[0]).toMatchObject({ state: "resolved", resolution: "cleared the bed" });
    m.handleVisionEvent(possible("detachment"));
    m.dismiss();
    expect(states.at(-1)).toBe("false_alarm");
    m.handleVisionEvent(possible());
    m.stopMonitoring();
    expect(m.state).toBe("idle");
    expect(m.history[0].resolution).toBe("monitoring stopped");
  });

  it("verifications are attached without changing state", () => {
    const { m } = machine();
    m.startMonitoring();
    m.handleVisionEvent(confirmed());
    const id = m.alert!.id;
    expect(m.addVerification(id, { source: "gemini", status: "ok", problem: "no_problem", confidence: 0.9 })).toBe(true);
    expect(m.state).toBe("confirmed_failure");
    expect(m.addVerification("missing", { source: "local", status: "ok" })).toBe(false);
  });

  it("a throwing listener does not break transitions", () => {
    const { m } = machine();
    m.onTransition(() => { throw new Error("boom"); });
    m.startMonitoring();
    m.handleVisionEvent(possible());
    expect(m.state).toBe("possible_failure");
  });
});
