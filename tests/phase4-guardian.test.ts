import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GeminiVisionClient, PrintGuardian } from "@morphix/guardian";
import { MemoryGuardianStore } from "./guardian-helpers";
import type { PrinterStatus } from "@morphix/shared";
import type { FetchLike, GuardianSnapshot, VisionEvent, VisionWorkerConfig, VisionWorkerHandlers, WorkerStatus } from "@morphix/guardian";

const env = (o: object) => ({ v: 1, seq: 1, ts: "2026-11-07T10:00:00.000Z", session: "sess-1", ...o }) as VisionEvent;
const win = (hits: number) => ({ hits, of: 5, need: 3, size: 5 });

function harness(opts: Partial<ConstructorParameters<typeof PrintGuardian>[0]> = {}) {
  let handlers!: VisionWorkerHandlers;
  let config!: VisionWorkerConfig;
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
    worker: { snapshotUrl: "http://192.168.10.51:8080/?action=snapshot", intervalSeconds: 10 },
    store,
    readFile: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    createWorker: (c, h) => { config = c; handlers = h; return worker; },
    ...opts,
  });
  const updates: GuardianSnapshot[] = [];
  g.onUpdate((s) => updates.push(s));
  return { g, store, worker, sent, updates, emit: (e: VisionEvent) => handlers.onEvent!(e), config: () => config };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("PrintGuardian orchestration", () => {
  it("starts a session with its own evidence folder and forwards printer state", () => {
    const { g, worker, sent, store, config } = harness();
    g.updatePrinterStatus({ online: true, machine: "READY" });
    const snap = g.start({ sessionId: "sess-1", printJobId: "job-9" });
    expect(snap.state).toBe("monitoring");
    expect(config()).toMatchObject({ cwd: "/opt/morphix/services/vision", session: "sess-1", evidenceDir: "/home/jd/Morphix/snapshots/sess-1" });
    expect(worker.start).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({ machine: "READY" });
    g.updatePrinterStatus({ online: true, machine: "BUILDING_FROM_SD", progress: 12 });
    expect(sent.at(-1)).toEqual({ online: true, machine: "BUILDING_FROM_SD", progress: 12 });
    expect(store.sessions.get("sess-1")).toMatchObject({ printJobId: "job-9", evidenceRelDir: "snapshots/sess-1" });
    expect(g.snapshot()).toMatchObject({ autoPause: false, gemini: { available: false } });
  });

  it("accepts the observer's PrinterStatus directly", () => {
    const { g, sent } = harness();
    const status: PrinterStatus = { online: true, checkedAt: "now", machine: "BUILDING_FROM_SD", progress: 33 };
    g.start({ sessionId: "sess-1" });
    g.updatePrinterStatus(status);
    expect(sent.at(-1)).toEqual({ online: true, machine: "BUILDING_FROM_SD", progress: 33 });
  });

  it("tracks camera health and observations", () => {
    const { g, emit } = harness();
    g.start({ sessionId: "sess-1" });
    emit(env({ type: "camera_ok", width: 1280, height: 720, recovered_from: null }));
    expect(g.snapshot()).toMatchObject({ camera: "ok", cameraDetail: "1280x720" });
    emit(env({ type: "observation", frame: 1, printer_state: null, detection_active: true, suspicions: [], metrics: { brightness: 80, contrast: 20 } }));
    expect(g.snapshot().lastObservation?.frame).toBe(1);
    emit(env({ type: "camera_lost", reason: "fetch_error", detail: "timed out", consecutive_failures: 3 }));
    expect(g.snapshot()).toMatchObject({ camera: "lost", cameraDetail: "fetch_error: timed out" });
    emit(env({ type: "frozen_frame", identical_frames: 7 }));
    expect(g.snapshot().camera).toBe("frozen");
    emit(env({ type: "camera_ok", width: 1, height: 1, recovered_from: "frozen", session: "other-session" }));
    expect(g.snapshot().camera).toBe("frozen"); // events from a stale session are ignored
  });

  it("confirmed failure: evidence stored, Gemini asked once, local review attached, no pause", async () => {
    const fetch = vi.fn<FetchLike>(async () => ({
      ok: true, status: 200, text: async () => "",
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"problem_type":"spaghetti","confidence":0.9,"explanation":"Strands everywhere."}' }] } }] }),
    }));
    const gemini = new GeminiVisionClient({ apiKey: "k", fetch, minIntervalMs: 0 });
    const { g, emit, store } = harness({ gemini });
    g.start({ sessionId: "sess-1" });
    emit(env({ type: "possible_failure", kind: "spaghetti", score: 2.5, window: win(1), evidence: "/home/jd/Morphix/snapshots/sess-1/a_suspect.jpg" }));
    expect(g.snapshot().state).toBe("possible_failure");
    emit(env({ type: "confirmed_failure", kind: "spaghetti", score: 3, window: win(3), evidence: "/home/jd/Morphix/snapshots/sess-1/c_confirmed.jpg", evidence_frames: [] }));
    emit(env({ type: "confirmed_failure", kind: "detachment", score: 0.5, window: win(3), evidence: null, evidence_frames: [] }));
    await flush();
    await flush();
    const snap = g.snapshot();
    expect(snap.state).toBe("confirmed_failure");
    expect(snap.label).toMatch(/pausing is recommended/);
    expect(fetch).toHaveBeenCalledOnce();
    expect(snap.alert?.verifications.map((v) => [v.source, v.problem])).toEqual([["gemini", "spaghetti"], ["local", "pause_recommended"]]);
    expect(store.evidence.map((e) => [e.label, e.relPath])).toEqual([
      ["suspect", "snapshots/sess-1/a_suspect.jpg"],
      ["confirmed", "snapshots/sess-1/c_confirmed.jpg"],
    ]);
    expect(store.alerts.get(snap.alert!.id)?.verifications).toHaveLength(2);
    expect(store.transitions.map((t) => t.to)).toEqual(["possible_failure", "confirmed_failure"]);
  });

  it("pause flow is only confirmed by printer status", async () => {
    const { g, emit } = harness();
    g.start({ sessionId: "sess-1" });
    emit(env({ type: "confirmed_failure", kind: "detachment", score: 0.6, window: win(3), evidence: null, evidence_frames: [] }));
    await g.requestPause();
    expect(g.snapshot().state).toBe("pause_requested");
    expect(g.snapshot().label).toMatch(/NOT paused yet/);
    g.updatePrinterStatus({ online: true, machine: "PAUSED" });
    expect(g.snapshot().state).toBe("pause_confirmed");
    g.resolve("removed the part");
    expect(g.snapshot().state).toBe("monitoring");
    expect(g.snapshot().history[0].state).toBe("resolved");
  });

  it("stop() ends the session and stops the worker", async () => {
    const { g, worker, store, emit } = harness();
    g.start({ sessionId: "sess-1" });
    emit(env({ type: "possible_failure", kind: "stalled", score: 700, window: win(1), evidence: null }));
    await g.stop("print finished");
    expect(worker.stop).toHaveBeenCalledOnce();
    expect(g.snapshot().state).toBe("idle");
    expect(store.sessions.get("sess-1")).toMatchObject({ endReason: "print finished" });
    expect(g.snapshot().history[0].resolution).toBe("print finished");
  });
});

// End-to-end with the real Python worker. Runs only when MORPHIX_TEST_PYTHON
// points at an interpreter with numpy + OpenCV (see services/vision/README.md).
const python = process.env.MORPHIX_TEST_PYTHON;
describe.skipIf(!python)("PrintGuardian + real Python vision worker", () => {
  it("detects synthetic spaghetti from a replay folder", async () => {
    const visionDir = resolve(__dirname, "../services/vision");
    const root = mkdtempSync(join(tmpdir(), "morphix-e2e-"));
    const frames = join(root, "frames");
    execFileSync(python!, ["-c", `
import os, sys
sys.path[:0] = ["tests"]
from synth import scene, jpeg
d = sys.argv[1]; os.makedirs(d)
for i in range(6): open(os.path.join(d, "%03d.jpg" % i), "wb").write(jpeg(scene(i, head_x=100 + 50 * i)))
for i in range(6, 10): open(os.path.join(d, "%03d.jpg" % i), "wb").write(jpeg(scene(i, spaghetti=45)))
`, frames], { cwd: visionDir });
    const store = new MemoryGuardianStore();
    const g = new PrintGuardian({
      storageRoot: root, visionDir, store,
      worker: { pythonPath: python, extraArgs: ["--replay-dir", frames], maxRestarts: 0 },
    });
    const done = new Promise<void>((res) => g.onUpdate((s) => { if (s.worker.state === "failed" || s.worker.state === "restarting") res(); }));
    g.start({ sessionId: "e2e" });
    await Promise.race([done, new Promise((r) => setTimeout(r, 15_000))]);
    const snap = g.snapshot();
    expect(snap.alert?.kind).toBe("spaghetti");
    expect(snap.alert?.state).toBe("confirmed_failure");
    expect(readdirSync(join(root, "snapshots", "e2e")).some((f) => f.includes("confirmed_spaghetti"))).toBe(true);
    expect(store.evidence.length).toBeGreaterThanOrEqual(2);
    await g.stop();
  }, 30_000);
});
