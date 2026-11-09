// installSelfHealing (Electron main side) with a fake logger, a real JobManager and fake app parts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobManager } from "@morphix/jobs";
import type { AppEvent } from "@morphix/shared";
import { appSelfHealDeps, installSelfHealing, selfHealing, type AppParts, type LoggerLike } from "../apps/desktop/electron/self-heal";

function fakeLogger() {
  const lines: { level: string; message: string; extra?: unknown }[] = [];
  const logger: LoggerLike = {
    write: (level, message, extra) => void lines.push({ level, message, extra }),
    tail: (n = 200) => lines.slice(-n).map((l) => JSON.stringify(l)),
  };
  return { logger, lines, original: logger.write };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  selfHealing()?.dispose();
  vi.useRealTimers();
});

describe("installSelfHealing", () => {
  it("taps the logger: a Gemini close in the log leads to a reconnect and a self-heal line", async () => {
    const { logger, lines } = fakeLogger();
    const reconnectGemini = vi.fn(async () => true);
    const sh = installSelfHealing({ logger, actions: { reconnectGemini }, diagnose: null, env: {} });
    logger.write("info", "Gemini session closed", { reason: "1011 internal error" });
    await vi.advanceTimersByTimeAsync(2000);
    await sh.healer!.settle();
    expect(reconnectGemini).toHaveBeenCalledTimes(1);
    const msgs = lines.map((l) => l.message);
    expect(msgs).toContain("Gemini session closed"); // still written to the real log
    expect(msgs).toContain("self-heal: Gemini socket closed (1011 internal error) → reconnect to Gemini → fixed");
    expect(sh.history()[0]).toMatchObject({ action: "reconnect-gemini", result: "fixed" });
    expect(selfHealing()).toBe(sh);
  });

  it("restores a class logger's own method on dispose", () => {
    class L {
      n = 0;
      write() {
        this.n++;
      }
    }
    const l = new L();
    const sh = installSelfHealing({ logger: l, env: {}, diagnose: null });
    expect(Object.prototype.hasOwnProperty.call(l, "write")).toBe(true);
    sh.dispose();
    expect(Object.prototype.hasOwnProperty.call(l, "write")).toBe(false);
    l.write();
    expect(l.n).toBe(2); // the "self-heal: watching" line, then this call
  });

  it("can be switched off, and dispose restores the logger", () => {
    const a = fakeLogger();
    const off = installSelfHealing({ logger: a.logger, env: { MORPHIX_SELF_HEAL: "0" } });
    expect(off.enabled).toBe(false);
    expect(a.logger.write).toBe(a.original);
    const b = fakeLogger();
    const on = installSelfHealing({ logger: b.logger, env: {}, diagnose: null });
    expect(b.logger.write).not.toBe(b.original);
    on.dispose();
    expect(b.logger.write).toBe(b.original);
    expect(selfHealing()).toBeNull();
  });

  it("watches JobManager events and picks up jobs interrupted before it was installed", async () => {
    const { logger } = fakeLogger();
    const jobs = new JobManager();
    const prep = jobs.create({ kind: "prepare", title: "x", meta: { versionId: "v1" } });
    jobs.startStage(prep.id, "prepare.slice");
    const restored = new JobManager();
    restored.restore(jobs.serialize()); // simulates the app restart: the stage was running
    expect(restored.get(prep.id)?.status).toBe("interrupted");

    const retryJob = vi.fn(async () => true);
    const retryPrepare = vi.fn(async () => true);
    const sh = installSelfHealing({ logger, jobs: restored, actions: { retryJob, retryPrepare }, diagnose: null, env: {} });
    await vi.advanceTimersByTimeAsync(5000);
    await sh.healer!.settle();
    expect(retryJob).toHaveBeenCalledWith({ jobId: prep.id, kind: "prepare" });

    const j = restored.create({ kind: "prepare", title: "y", owner: "touchscreen", meta: { versionId: "v2" } });
    restored.startStage(j.id, "prepare.slice");
    restored.failStage(j.id, "prepare.slice", new Error("slicer exited 1"), "MX-SLICE-003");
    await vi.advanceTimersByTimeAsync(3000);
    await sh.healer!.settle();
    expect(retryPrepare).toHaveBeenCalledWith(expect.objectContaining({ versionId: "v2", settings: { supports: "auto", layerHeightMm: 0.2, infillPercent: 15 } }));
  });

  it("reconciles a stale print job record by default (job record only) and shows notices", async () => {
    const { logger } = fakeLogger();
    const jobs = new JobManager();
    const pj = jobs.create({ kind: "print", title: "Printing dino", template: { approval: false } });
    jobs.startStage(pj.id, "print");
    const events: AppEvent[] = [];
    const sh = installSelfHealing({
      logger, jobs, emit: (e) => events.push(e), diagnose: null, env: {}, tickMs: 15_000,
      probes: { printerStatus: () => ({ online: true, machine: "READY" }), printPhase: () => "idle", printerBusy: () => false },
    });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await sh.healer!.settle();
    expect(jobs.get(pj.id)?.status).toBe("cancelled");
    expect(sh.history()[0]).toMatchObject({ incident: "stale-print-state", result: "fixed" });

    expect(events).toEqual([]);
  });

  it("tells the user (AppEvent notice) when it gives up", async () => {
    const { logger } = fakeLogger();
    const events: AppEvent[] = [];
    const cleanDisk = vi.fn(async () => ({ ok: false, detail: "nothing old enough to delete" }));
    const sh = installSelfHealing({ logger, emit: (e) => events.push(e), actions: { cleanDisk }, diagnose: null, env: {} });
    sh.report({ kind: "disk-low", key: "disk", what: "the disk is full", code: "MX-STORE-001" });
    await sh.healer!.settle();
    expect(cleanDisk).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: "notice", level: "warn", message: "I tried to fix this myself but couldn't: the disk is full.", code: "MX-STORE-001", hint: expect.any(String) }]);
  });
});

describe("appSelfHealDeps (real-app wiring) with fakes", () => {
  function parts(over: Partial<Record<string, unknown>> = {}) {
    const rows: Record<string, Record<string, unknown>> = {
      t1: { id: "t1", provider: "meshy", remote_id: "r-1", status: "failed", project_id: "p1", prompt: "dino", kind: "preview" },
      t2: { id: "t2", provider: "meshy", remote_id: null, status: "failed", project_id: "p2" },
    };
    const runs: [string, unknown[]][] = [];
    const db = { get: (_sql: string, [id]: [string]) => rows[id], run: (sql: string, args: unknown[]) => void runs.push([sql, args]) };
    const generation = { resume: vi.fn() };
    const printer = { status: { online: true, machine: "READY" }, poll: vi.fn(async () => ({ online: true, machine: "READY", checkedAt: "" })), start: vi.fn(), stop: vi.fn() };
    const voice = { enabled: true, test: vi.fn(async () => ({ ok: true, message: "Connected to gemini" })), close: vi.fn() };
    const printing = {
      status: () => ({ job: { phase: "printing" }, busy: null }),
      view: () => ({ running: true }),
      guardian: { snapshot: () => ({ worker: { state: "failed" } }) },
      guardianCommand: vi.fn(async () => ({ running: true, label: "Watching" })),
      prepare: vi.fn(async () => ({ ok: true })),
    };
    const p = { log: fakeLogger().logger, emit: vi.fn(), jobs: { manager: new JobManager() }, printer, printing, voice, generation, db: () => db, storage: { root: "/nonexistent/morphix", disk: () => ({ freeBytes: 1, totalBytes: 2 }) }, pollMs: 5000, ...over };
    return { p: p as unknown as AppParts, runs, generation, printer, voice, printing };
  }

  it("resumes the existing Meshy task (no new task) and refuses when there is nothing to resume", async () => {
    const f = parts();
    const d = appSelfHealDeps(f.p);
    expect(await d.actions!.resumeMeshyPolling!({ jobId: "j", taskId: "t1" })).toMatchObject({ ok: true });
    expect(f.generation.resume).toHaveBeenCalledWith([expect.objectContaining({ id: "t1", remote_id: "r-1" })]);
    expect(f.runs[0][0]).toMatch(/UPDATE generation_tasks SET status = 'running'/);
    expect(await d.actions!.resumeMeshyPolling!({ jobId: "j", taskId: "t2" })).toEqual({ ok: false, detail: "no Meshy task to resume" });
    expect(f.generation.resume).toHaveBeenCalledTimes(1);
  });

  it("wires printer, voice, guardian and slicing actions to the app objects", async () => {
    const f = parts();
    const d = appSelfHealDeps(f.p);
    expect(await d.actions!.releasePrinterControl!({ reason: "x" })).toMatchObject({ ok: true });
    expect(f.printer.poll).toHaveBeenCalled();
    d.actions!.setPrinterPollInterval!({ ms: 30_000 });
    expect(f.printer.start).toHaveBeenCalledWith(30_000);
    await d.actions!.resetVoiceSession!({ reason: "x" });
    expect(f.voice.close).toHaveBeenCalled();
    expect(f.voice.test).toHaveBeenCalled();
    await d.actions!.restartGuardianWorker!({ reason: "x" });
    expect(f.printing.guardianCommand.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["stop", "start"]);
    await d.actions!.retryPrepare!({ jobId: "j", versionId: "v", settings: { supports: "auto", layerHeightMm: 0.2, infillPercent: 15 } });
    expect(f.printing.prepare).toHaveBeenCalledWith("v", { supports: "auto", layerHeightMm: 0.2, infillPercent: 15 }, null, "touchscreen");
    expect(d.probes!.guardian!()).toEqual({ wanted: true, workerState: "failed" });
    expect(d.probes!.printPhase!()).toBe("printing");
    expect(d.probes!.printerBusy!()).toBe(false);
    expect(d.config).toEqual({ normalPollMs: 5000 });
  });

  it("exposes no action that prints, heats, cancels a print or generates", () => {
    const d = appSelfHealDeps(parts().p);
    expect(Object.keys(d.actions!).sort()).toEqual([
      "cleanDisk", "reconnectGemini", "releasePrinterControl", "resetVoiceSession", "restartGuardianWorker",
      "resumeMeshyPolling", "retryJob", "retryPrepare", "setPrinterPollInterval",
    ]);
  });
});
