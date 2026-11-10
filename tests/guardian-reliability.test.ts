// Print Guardian against simulated QD330 status sequences (no printer, camera or
// Python): heating start-up, a real stall, the print ending, pauses, the printer
// going offline after an unseen stop, and the spoken warning on top.
import { describe, expect, it, vi } from "vitest";
import { PrintGuardian, StallMonitor, isHeating } from "@morphix/guardian";
import { MemoryGuardianStore } from "./guardian-helpers";
import type { GuardianPrinterStatus, VisionEvent, VisionWorkerHandlers, WorkerStatus } from "@morphix/guardian";
import { GuardianVoice, type GuardianVoiceDeps } from "../apps/desktop/electron/guardian-voice";

const MIN = 60_000;
const POLL = 10_000;

const building = (o: Partial<GuardianPrinterStatus> = {}): GuardianPrinterStatus => ({
  online: true, machine: "BUILDING_FROM_SD", moveMode: "MOVING", progress: 0, layer: [0, 120],
  temps: { nozzle: { current: 215, target: 215 }, bed: { current: 60, target: 60 } }, position: { x: 10, y: 20, z: 0.2 }, ...o,
});
const READY: GuardianPrinterStatus = { online: true, machine: "READY", moveMode: "READY", progress: 0, layer: [0, 0] };
const OFFLINE: GuardianPrinterStatus = { online: false };

function rig() {
  let t = Date.parse("2026-11-07T10:00:00Z");
  let handlers!: VisionWorkerHandlers;
  const sent: object[] = [];
  const worker = {
    status: { state: "running", since: 0 } as WorkerStatus,
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    sendPrinterState: vi.fn((s: object) => sent.push(s)),
    resetBaseline: vi.fn(),
  };
  const store = new MemoryGuardianStore();
  const g = new PrintGuardian({
    storageRoot: "/home/jd/Morphix",
    visionDir: "/opt/morphix/services/vision",
    store,
    now: () => t,
    readFile: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    createWorker: (_c, h) => { handlers = h; return worker; },
  });
  /** Poll every 10 s for `ms`, with the status made by `at(elapsedMs)`. */
  const run = (ms: number, at: (elapsed: number) => GuardianPrinterStatus) => {
    for (let e = 0; e < ms; e += POLL) {
      g.updatePrinterStatus(at(e));
      t += POLL;
    }
  };
  const vision = (o: object) => handlers.onEvent!({ v: 1, seq: 1, ts: new Date(t).toISOString(), session: g.sessionId, ...o } as VisionEvent);
  const kinds = () => store.transitions.filter((x) => x.alertId).map((x) => x.to);
  return { g, store, worker, sent, run, vision, kinds, advance: (ms: number) => (t += ms) };
}

describe("stall check from printer status", () => {
  it("heating start-up with progress 0 never raises an alert", () => {
    const { g, run, kinds } = rig();
    g.start({ sessionId: "s1" });
    // 12 min heating: nozzle and bed climbing, nothing moves
    run(12 * MIN, (e) => building({ temps: { nozzle: { current: 30 + e / 4000, target: 215 }, bed: { current: 25 + e / 30000, target: 60 } } }));
    expect(g.snapshot().printerPhase).toBe("heating");
    // at temperature, still progress 0 (purge, first layer starting) until minute 19
    run(7 * MIN, () => building());
    expect(g.snapshot().printerPhase).toBe("starting");
    // printing: progress creeps up, head moves
    run(30 * MIN, (e) => building({ progress: 1 + Math.floor(e / (7 * MIN)), layer: [1 + Math.floor(e / (3 * MIN)), 120], position: { x: (e / 1000) % 200, y: 20, z: 0.2 } }));
    expect(kinds()).toEqual([]);
    expect(g.snapshot().state).toBe("monitoring");
  });

  it("no temperatures known: progress 0 in the first 20 min is start-up, not a stall", () => {
    const { g, run, kinds } = rig();
    g.start({ sessionId: "s1" });
    run(19 * MIN, () => building({ temps: undefined, position: undefined }));
    expect(kinds()).toEqual([]);
  });

  it("a real stall mid-print is raised, confirmed over several polls, then closes when the print ends", () => {
    const { g, run, kinds, store } = rig();
    g.start({ sessionId: "s1" });
    run(30 * MIN, (e) => building({ progress: 10 + Math.floor(e / (5 * MIN)), layer: [20 + Math.floor(e / MIN), 120], position: { x: (e / 1000) % 200, y: 50, z: 4 } }));
    expect(kinds()).toEqual([]);
    // frozen: progress, layer and head position stop changing
    run(14 * MIN, () => building({ progress: 15, layer: [49, 120], position: { x: 88, y: 50, z: 9.8 } }));
    expect(kinds()).toEqual([]);
    run(2 * MIN, () => building({ progress: 15, layer: [49, 120], position: { x: 88, y: 50, z: 9.8 } }));
    expect(g.snapshot().state).toBe("possible_failure");
    run(2 * MIN, () => building({ progress: 15, layer: [49, 120], position: { x: 88, y: 50, z: 9.8 } }));
    expect(g.snapshot().state).toBe("confirmed_failure");
    expect(g.snapshot().alert).toMatchObject({ kind: "stalled", kinds: ["stalled"] });
    expect(g.snapshot().alert!.score).toBeGreaterThanOrEqual(17 * 60);
    // the operator stops it at the printer: READY closes the alert at once
    run(POLL, () => READY);
    expect(g.snapshot().state).toBe("monitoring");
    expect(kinds()).toEqual(["possible_failure", "confirmed_failure", "resolved"]);
    expect([...store.alerts.values()][0].resolution).toMatch(/print ended/);
  });

  it("a stall that recovers by itself closes again", () => {
    const { g, run } = rig();
    g.start({ sessionId: "s1" });
    run(25 * MIN, (e) => building({ progress: 20 + Math.floor(e / (5 * MIN)) }));
    run(18 * MIN, () => building({ progress: 25 }));
    expect(g.snapshot().state).toBe("confirmed_failure");
    run(POLL, () => building({ progress: 26 }));
    expect(g.snapshot().state).toBe("monitoring");
    expect(g.snapshot().history[0]).toMatchObject({ state: "resolved", kind: "stalled" });
  });

  it("paused (MoveMode PAUSED with BUILDING_FROM_SD) is never a stall; the clock restarts on resume", () => {
    const { g, run, kinds } = rig();
    g.start({ sessionId: "s1" });
    run(25 * MIN, (e) => building({ progress: 30 + Math.floor(e / (5 * MIN)) }));
    run(40 * MIN, () => building({ progress: 35, moveMode: "PAUSED" }));
    expect(g.snapshot().printerPhase).toBe("paused");
    run(10 * MIN, () => building({ progress: 35 }));
    expect(kinds()).toEqual([]);
  });

  it("does not re-raise a dismissed stall until the printer has moved again", () => {
    const { g, run, kinds } = rig();
    g.start({ sessionId: "s1" });
    run(25 * MIN, (e) => building({ progress: 20 + Math.floor(e / (5 * MIN)) }));
    run(18 * MIN, () => building({ progress: 25 }));
    g.dismiss("operator: false alarm");
    run(30 * MIN, () => building({ progress: 25 }));
    expect(kinds()).toEqual(["possible_failure", "confirmed_failure", "false_alarm"]);
  });

  it("printer offline after a stop Morphix didn't see: no stall, camera checks switched off, alerts close when it reports READY", () => {
    const { g, run, kinds, sent, vision } = rig();
    g.start({ sessionId: "s1" });
    run(25 * MIN, (e) => building({ progress: 9 + Math.floor(e / (5 * MIN)) }));
    run(30 * POLL, () => OFFLINE); // 5 minutes unreachable, empty bed in front of the camera
    expect(sent.at(-1)).toEqual({ online: false, machine: "OFFLINE" });
    expect(sent.filter((s) => (s as { machine?: string }).machine === "OFFLINE")).toHaveLength(1); // sent once
    run(18 * MIN, () => OFFLINE);
    expect(kinds()).toEqual([]);
    expect(g.snapshot().printerPhase).toBe("inactive");
    // a single missed poll does not switch the camera checks off
    const before = sent.length;
    run(25 * MIN, (e) => building({ progress: 15 + Math.floor(e / (5 * MIN)) }));
    run(POLL, () => OFFLINE);
    expect(sent.length).toBe(before + 150);
    // any alert still open is closed once the printer is back and READY
    vision({ type: "possible_failure", kind: "detachment", score: 0.5, window: { hits: 1, of: 5, need: 3, size: 5 }, evidence: null });
    run(POLL, () => READY);
    expect(g.snapshot().state).toBe("monitoring");
    expect(kinds()).toEqual(["possible_failure", "resolved"]);
  });

  it("a confirmed camera failure also closes when the print ends", () => {
    const { g, run, vision } = rig();
    g.start({ sessionId: "s1" });
    run(MIN, (e) => building({ progress: 50, position: { x: e / 1000 } }));
    vision({ type: "possible_failure", kind: "spaghetti", score: 2.4, window: { hits: 1, of: 5, need: 3, size: 5 }, evidence: null });
    vision({ type: "confirmed_failure", kind: "spaghetti", score: 3.1, window: { hits: 3, of: 5, need: 3, size: 5 }, evidence: null, evidence_frames: [] });
    expect(g.snapshot().state).toBe("confirmed_failure");
    run(POLL, () => READY);
    expect(g.snapshot().state).toBe("monitoring");
  });

  it("forwards MoveMode to the camera worker so a pause stops the camera checks too", () => {
    const { g, sent } = rig();
    g.start({ sessionId: "s1" });
    g.updatePrinterStatus(building({ moveMode: "PAUSED", progress: 40 }));
    expect(sent.at(-1)).toEqual({ online: true, machine: "BUILDING_FROM_SD", moveMode: "PAUSED", progress: 40 });
  });
});

describe("StallMonitor details", () => {
  it("isHeating looks at both heaters with a tolerance", () => {
    expect(isHeating(building({ temps: { nozzle: { current: 205, target: 215 } } }))).toBe(true);
    expect(isHeating(building({ temps: { nozzle: { current: 212, target: 215 }, bed: { current: 50, target: 60 } } }))).toBe(true);
    expect(isHeating(building({ temps: { nozzle: { current: 212, target: 215 }, bed: { current: 58, target: 60 } } }))).toBe(false);
    expect(isHeating(building({ temps: { nozzle: { current: 25, target: 0 } } }))).toBe(false);
  });

  it("emits nothing before the stall time and is quiet without a running job", () => {
    const m = new StallMonitor({ stallMs: 5 * MIN, confirmMs: MIN, startupGraceMs: 0 });
    let t = 0;
    const out: string[] = [];
    for (let i = 0; i < 60; i++, t += POLL) out.push(...m.update(READY, t).map((e) => e.type));
    for (let i = 0; i < 29; i++, t += POLL) out.push(...m.update(building({ progress: 5 }), t).map((e) => e.type));
    expect(out).toEqual([]);
    for (let i = 0; i < 10; i++, t += POLL) out.push(...m.update(building({ progress: 5 }), t).map((e) => e.type));
    expect(out).toEqual(["possible_failure", "confirmed_failure"]);
    expect(m.update(READY, t).map((e) => e.type)).toEqual(["suspicion_cleared"]);
  });
});

describe("spoken warning on top of the guardian", () => {
  it("announces a confirmed stall once (with its repeats) and goes quiet when the print ends", async () => {
    const { g, run } = rig();
    const spoken: string[] = [];
    const timers: (() => void)[] = [];
    const deps: GuardianVoiceDeps = {
      interrupt: () => undefined,
      speakGemini: async (text) => (spoken.push(text), true),
      speakLocal: async () => true,
      cancelPrint: async () => ({ ok: true, message: "ok" }),
      keepPrinting: () => g.dismiss("operator: false alarm"),
      resolveAlert: () => g.resolve("operator"),
      userBusy: () => false,
      onChange: () => undefined,
      log: () => undefined,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => undefined,
    };
    const voice = new GuardianVoice(deps);
    g.onUpdate((s) => voice.onAlert(s.alert ? { id: s.alert.id, kind: s.alert.kind, state: s.alert.state } : null));
    g.start({ sessionId: "s1" });
    // heating and start-up: silent
    run(15 * MIN, () => building({ progress: 0, temps: { nozzle: { current: 100, target: 215 } } }));
    run(10 * MIN, (e) => building({ progress: Math.floor(e / MIN) }));
    expect(spoken).toEqual([]);
    run(16 * MIN, () => building({ progress: 9 }));
    await Promise.resolve();
    expect(spoken).toEqual([]); // possible only: not spoken
    run(2 * MIN, () => building({ progress: 9 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatch(/stopped making progress/);
    expect(voice.open).toBe(true);
    run(POLL, () => READY);
    expect(voice.open).toBe(false);
    // the stale repeat timer finds no incident and says nothing
    timers.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 0));
    expect(spoken).toHaveLength(1);
  });
});
