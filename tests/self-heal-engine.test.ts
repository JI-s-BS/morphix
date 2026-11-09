// Self-heal engine: every remediation with fakes, plus the limits (attempts, backoff, cooldown).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobManager } from "@morphix/jobs";
import { isKnownErrorCode, MorphixError } from "@morphix/errors";
import {
  Healer, REMEDIATIONS, REMEDIATION_IDS, runAction,
  type Diagnoser, type HealActions, type HealerOptions, type HealProbes, type Notice, type PrinterStatusLike,
} from "@morphix/healer";

const SEC = 1000;
const MIN = 60 * SEC;

function setup(o: { actions?: HealActions; probes?: HealProbes; diagnose?: Diagnoser | null; extra?: Partial<HealerOptions> } = {}) {
  const logs: { level: string; message: string }[] = [];
  const notices: Notice[] = [];
  const healer = new Healer({
    actions: o.actions ?? {},
    probes: o.probes,
    diagnose: o.diagnose ?? null,
    log: (level, message) => logs.push({ level, message }),
    notify: (n) => notices.push(n),
    isKnownCode: isKnownErrorCode,
    ...(o.extra ?? {}),
  });
  const heal = (h: Healer = healer) => ({
    async after(ms: number) {
      await vi.advanceTimersByTimeAsync(ms);
      await h.settle();
    },
  });
  const selfHealLines = () => logs.filter((l) => l.message.startsWith("self-heal:")).map((l) => l.message);
  return { healer, logs, notices, selfHealLines, ...heal() };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("safety whitelist", () => {
  it("has exactly the agreed remediations, none physical or costly", () => {
    expect(REMEDIATION_IDS.sort()).toEqual([
      "clean-disk", "printer-poll-backoff", "reconcile-print-state", "reconnect-gemini", "release-printer-control",
      "reset-voice-session", "restart-guardian-worker", "resume-meshy-polling", "retry-job", "retry-slice-safer",
    ]);
    for (const id of REMEDIATION_IDS) {
      expect(REMEDIATIONS[id].physical).toBe(false);
      expect(REMEDIATIONS[id].costly).toBe(false);
      expect(REMEDIATIONS[id].label).not.toMatch(/\b(start|heat|cancel|generate|buy|credit)/i);
    }
  });

  it("reports an action that isn't wired as skipped, once", async () => {
    const t = setup();
    t.healer.observeLog("info", "Gemini session closed", { reason: "1011 internal error" });
    t.healer.observeLog("info", "Gemini session closed", { reason: "1011 internal error" });
    await t.after(0);
    expect(t.selfHealLines()).toEqual(["self-heal: Gemini socket closed (1011 internal error) → reconnect to Gemini → skipped (not wired in this build)"]);
  });

  it("runAction normalises results, errors and timeouts", async () => {
    expect(await runAction(() => undefined, {}, 1000)).toEqual({ ok: true });
    expect(await runAction(() => false, {}, 1000)).toEqual({ ok: false });
    expect(await runAction(() => ({ ok: true, detail: "x" }), {}, 1000)).toEqual({ ok: true, detail: "x" });
    expect(await runAction(() => { throw new Error("boom"); }, {}, 1000)).toEqual({ ok: false, detail: "boom" });
    const slow = runAction(() => new Promise(() => {}), {}, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await slow).toEqual({ ok: false, detail: "timed out after 5 s" });
  });
});

describe("Gemini Live", () => {
  it("reconnects after an abnormal close (2 s backoff) and logs the result", async () => {
    const reconnectGemini = vi.fn(async () => ({ ok: true, detail: "Connected" }));
    const t = setup({ actions: { reconnectGemini } });
    t.healer.observeLog("info", "Gemini session closed", { reason: "1011 internal error" });
    await t.after(1000);
    expect(reconnectGemini).not.toHaveBeenCalled();
    await t.after(1000);
    expect(reconnectGemini).toHaveBeenCalledWith({ reason: "1011 internal error" });
    expect(t.selfHealLines()).toEqual(["self-heal: Gemini socket closed (1011 internal error) → reconnect to Gemini → fixed (Connected)"]);
    expect(t.healer.history()[0]).toMatchObject({ incident: "gemini-closed", action: "reconnect-gemini", result: "fixed", attempt: 1 });
  });

  it("stops after 3 attempts in 10 minutes with backoff 2 s / 10 s / 30 s, then tells the user", async () => {
    const reconnectGemini = vi.fn(async () => false);
    const t = setup({ actions: { reconnectGemini } });
    // Each failed reconnect leads to another close (the real-world loop the limits prevent).
    // The healer's own quiet window (15 s) swallows closes right after an attempt.
    const close = () => t.healer.observeLog("info", "Gemini session closed", { reason: "1006 abnormal" });
    close();
    await t.after(2 * SEC);
    expect(reconnectGemini).toHaveBeenCalledTimes(1);
    await t.after(20 * SEC);
    close();
    await t.after(9 * SEC);
    expect(reconnectGemini).toHaveBeenCalledTimes(1);
    await t.after(1 * SEC);
    expect(reconnectGemini).toHaveBeenCalledTimes(2);
    await t.after(20 * SEC);
    close();
    await t.after(30 * SEC);
    expect(reconnectGemini).toHaveBeenCalledTimes(3);
    expect(t.healer.history()[0].result).toBe("gave-up");
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0].message).toMatch(/couldn't/);
    await t.after(20 * SEC);
    close();
    await t.after(MIN);
    expect(reconnectGemini).toHaveBeenCalledTimes(3);
    // After the 10-minute window the healer tries again.
    await t.after(10 * MIN);
    close();
    await t.after(2 * SEC);
    expect(reconnectGemini).toHaveBeenCalledTimes(4);
  });

  it("does not reconnect an inactivity close when nobody is talking, but does after a recent turn", async () => {
    const reconnectGemini = vi.fn(async () => true);
    const t = setup({ actions: { reconnectGemini } });
    t.healer.observeLog("info", "Gemini session closed", { reason: "Session closed due to inactivity" });
    await t.after(5 * SEC);
    expect(reconnectGemini).not.toHaveBeenCalled();
    expect(t.healer.history()[0]).toMatchObject({ result: "noted", action: "none" });

    t.healer.observeLog("info", "voice turn", { seconds: 2 });
    t.healer.observeLog("info", "voice reply", {});
    await t.after(MIN);
    t.healer.observeLog("info", "Gemini session closed", { reason: "Session closed due to inactivity" });
    await t.after(5 * SEC);
    expect(reconnectGemini).toHaveBeenCalledTimes(1);
  });

  it("resets a hung voice turn after 75 s and tells the user to say it again", async () => {
    const resetVoiceSession = vi.fn(async () => true);
    const reconnectGemini = vi.fn(async () => true);
    const t = setup({ actions: { resetVoiceSession, reconnectGemini } });
    t.healer.observeLog("info", "voice turn", { seconds: 3 });
    await t.after(60 * SEC);
    t.healer.tick();
    expect(resetVoiceSession).not.toHaveBeenCalled();
    await t.after(15 * SEC);
    t.healer.tick();
    await t.after(0);
    expect(resetVoiceSession).toHaveBeenCalledTimes(1);
    expect(t.notices[0].message).toMatch(/say that again/);
    // The close caused by our own reset is not "healed" again.
    t.healer.observeLog("info", "Gemini session closed", { reason: "closed (1000)" });
    await t.after(5 * SEC);
    expect(reconnectGemini).not.toHaveBeenCalled();
  });

  it("leaves a turn alone when the reply or a tool call arrives in time", async () => {
    const resetVoiceSession = vi.fn(async () => true);
    const t = setup({ actions: { resetVoiceSession } });
    t.healer.observeLog("info", "voice turn", {});
    await t.after(60 * SEC);
    t.healer.observeLog("info", "tool make_model", { ok: true });
    await t.after(60 * SEC);
    t.healer.tick();
    t.healer.observeLog("info", "voice reply", {});
    await t.after(2 * MIN);
    t.healer.tick();
    await t.after(0);
    expect(resetVoiceSession).not.toHaveBeenCalled();
  });
});

describe("printer", () => {
  const refused: PrinterStatusLike = { online: false, error: "printer refused control: Control failed." };

  it("releases a stale control lock (M602) once, retries once after 2 min, then gives up", async () => {
    const releasePrinterControl = vi.fn(async () => ({ ok: false, detail: "still refused" }));
    let status = refused;
    const t = setup({ actions: { releasePrinterControl }, probes: { printerStatus: () => status } });
    t.healer.tick();
    await t.after(0);
    expect(releasePrinterControl).toHaveBeenCalledTimes(1);
    t.healer.tick();
    await t.after(MIN);
    expect(releasePrinterControl).toHaveBeenCalledTimes(1); // cooldown 2 min
    t.healer.tick();
    await t.after(MIN);
    t.healer.tick();
    await t.after(2 * MIN);
    expect(releasePrinterControl).toHaveBeenCalledTimes(2);
    expect(t.healer.history()[0].result).toBe("gave-up");
    t.healer.tick();
    await t.after(10 * MIN);
    expect(releasePrinterControl).toHaveBeenCalledTimes(2);
    status = { online: true, machine: "READY" };
    t.healer.tick();
  });

  it("never touches the control lock while Morphix is busy with the printer", async () => {
    const releasePrinterControl = vi.fn(async () => true);
    const t = setup({ actions: { releasePrinterControl }, probes: { printerStatus: () => refused, printerBusy: () => true } });
    t.healer.tick();
    await t.after(0);
    expect(releasePrinterControl).not.toHaveBeenCalled();
    expect(t.healer.history()[0]).toMatchObject({ action: "release-printer-control", result: "skipped" });
  });

  it("records the controller's own stale-lock recovery as fixed without acting", async () => {
    const releasePrinterControl = vi.fn(async () => true);
    const t = setup({ actions: { releasePrinterControl } });
    t.healer.observeLog("info", "printer-control", { op: "recoverControl", outcome: "confirmed", reason: "M602 cleared it" });
    expect(releasePrinterControl).not.toHaveBeenCalled();
    expect(t.healer.history()[0]).toMatchObject({ incident: "printer-stale-lock-cleared", result: "fixed" });
  });

  it("backs off polling while offline and restores it when the printer is back", async () => {
    const setPrinterPollInterval = vi.fn(async () => true);
    let status: PrinterStatusLike = { online: false, error: "cannot reach printer: ECONNREFUSED" };
    const t = setup({ actions: { setPrinterPollInterval }, probes: { printerStatus: () => status } });
    const tickFor = async (ms: number) => {
      for (let i = 0; i < ms / (15 * SEC); i++) {
        t.healer.tick();
        await t.after(15 * SEC);
      }
    };
    await tickFor(45 * SEC);
    expect(setPrinterPollInterval.mock.calls.map((c) => (c as unknown as [{ ms: number }])[0].ms)).toEqual([10_000]);
    await tickFor(2 * MIN);
    await tickFor(9 * MIN);
    expect(setPrinterPollInterval.mock.calls.map((c) => (c as unknown as [{ ms: number }])[0].ms)).toEqual([10_000, 30_000, 60_000]);
    expect(t.healer.status().printerPollMs).toBe(60_000);
    status = { online: true, machine: "READY" };
    t.healer.tick();
    await t.after(0);
    expect(setPrinterPollInterval).toHaveBeenLastCalledWith({ ms: 5_000 });
    expect(t.healer.history()[0]).toMatchObject({ incident: "printer-online", action: "printer-poll-backoff", result: "applied" });
  });

  it("reconciles a stale 'printing' job bar when the printer has been READY for 3 minutes", async () => {
    const jobs = new JobManager();
    const job = jobs.create({ kind: "print", title: "Printing dino", meta: { jobId: "p1" }, template: { approval: false } });
    jobs.startStage(job.id, "print");
    const reconcilePrintState = vi.fn(async ({ jobIds }: { jobIds: string[] }) => {
      for (const id of jobIds) jobs.cancel(id, "printer is idle");
      return true;
    });
    const unknownDiag = vi.fn(async () => null);
    let busy = true;
    const t = setup({
      actions: { reconcilePrintState },
      diagnose: unknownDiag,
      probes: { printerStatus: () => ({ online: true, machine: "READY" }), printPhase: () => "idle", printerBusy: () => busy, activeJobs: () => jobs.list({ active: true }) },
    });
    jobs.subscribeAll((ev) => t.healer.observeJob(ev));
    for (let i = 0; i < 20; i++) {
      t.healer.tick();
      await t.after(15 * SEC);
    }
    expect(reconcilePrintState).not.toHaveBeenCalled(); // uploading: hands off
    busy = false;
    for (let i = 0; i < 12; i++) {
      t.healer.tick();
      await t.after(15 * SEC);
    }
    expect(reconcilePrintState).not.toHaveBeenCalled(); // 165 s < 3 min
    for (let i = 0; i < 2; i++) {
      t.healer.tick();
      await t.after(15 * SEC);
    }
    expect(reconcilePrintState).toHaveBeenCalledTimes(1);
    expect(reconcilePrintState).toHaveBeenCalledWith({ jobIds: [job.id], machine: "READY" });
    expect(unknownDiag).not.toHaveBeenCalled(); // the cancel event it caused is ignored
    expect(jobs.get(job.id)?.status).toBe("cancelled");
  });

  it("does not reconcile while the printer is printing", async () => {
    const reconcilePrintState = vi.fn(async () => true);
    const jobs = [{ id: "j", kind: "print", status: "running", stages: [{ key: "print", status: "running" }] }];
    const t = setup({ actions: { reconcilePrintState }, probes: { printerStatus: () => ({ online: true, machine: "BUILDING_FROM_SD" }), printPhase: () => "printing", activeJobs: () => jobs } });
    for (let i = 0; i < 30; i++) {
      t.healer.tick();
      await t.after(15 * SEC);
    }
    expect(reconcilePrintState).not.toHaveBeenCalled();
  });
});

describe("jobs: slicer, Meshy, interrupted", () => {
  function failPrepare(jobs: JobManager, versionId: string, code: string, stage = "prepare.slice") {
    const j = jobs.create({ kind: "prepare", title: "Getting dino ready", owner: "voice", meta: { projectId: "p", versionId } });
    jobs.startStage(j.id, stage);
    jobs.failStage(j.id, stage, new Error("slicer exited with code 1"), code);
    return j;
  }

  it("re-slices once with safer settings, then gives up", async () => {
    const jobs = new JobManager();
    const retryPrepare = vi.fn(async () => {
      failPrepare(jobs, "v1", "MX-SLICE-003"); // the retry fails too
      return false;
    });
    const t = setup({ actions: { retryPrepare } });
    jobs.subscribeAll((ev) => t.healer.observeJob(ev));
    const j = failPrepare(jobs, "v1", "MX-SLICE-003");
    await t.after(3 * SEC);
    expect(retryPrepare).toHaveBeenCalledTimes(1);
    expect(retryPrepare).toHaveBeenCalledWith({ jobId: j.id, versionId: "v1", owner: "voice", settings: { supports: "auto", layerHeightMm: 0.2, infillPercent: 15 } });
    await t.after(MIN);
    expect(retryPrepare).toHaveBeenCalledTimes(1);
    expect(t.healer.history().map((r) => r.result)).toContain("gave-up");
  });

  it("does not re-slice problems settings can't fix (too big, no slicer)", async () => {
    const jobs = new JobManager();
    const retryPrepare = vi.fn(async () => true);
    const t = setup({ actions: { retryPrepare } });
    jobs.subscribeAll((ev) => t.healer.observeJob(ev));
    failPrepare(jobs, "v2", "MX-SLICE-004", "prepare.orient");
    failPrepare(jobs, "v3", "MX-SLICE-001");
    await t.after(MIN);
    expect(retryPrepare).not.toHaveBeenCalled();
  });

  it("resumes polling the same Meshy task after a network error, at most twice", async () => {
    const jobs = new JobManager();
    const resumeMeshyPolling = vi.fn(async () => true);
    const t = setup({ actions: { resumeMeshyPolling } });
    jobs.subscribeAll((ev) => t.healer.observeJob(ev));
    const fail = (code: string, taskId = "task-1") => {
      const j = jobs.create({ kind: "text-to-print", title: "dino", meta: { projectId: "p", taskId }, template: { print: false } });
      jobs.startStage(j.id, "generate");
      jobs.failStage(j.id, "generate", new MorphixError(code, { message: "Meshy polling failed" }));
      return j;
    };
    const j = fail("MX-NET-001");
    await t.after(29 * SEC);
    expect(resumeMeshyPolling).not.toHaveBeenCalled();
    await t.after(1 * SEC);
    expect(resumeMeshyPolling).toHaveBeenCalledWith({ jobId: j.id, taskId: "task-1" });
    fail("MX-NET-003");
    await t.after(2 * MIN);
    fail("MX-NET-003");
    await t.after(5 * MIN);
    expect(resumeMeshyPolling).toHaveBeenCalledTimes(2);
    // Out of credits / Meshy FAILED: resuming can't help and a new task would cost credits.
    fail("MX-GEN-003", "task-2");
    fail("MX-GEN-005", "task-3");
    await t.after(5 * MIN);
    expect(resumeMeshyPolling).toHaveBeenCalledTimes(2);
  });

  it("re-runs an interrupted preparation, but only notes interrupted generation or printing", async () => {
    const retryJob = vi.fn(async () => true);
    const t = setup({ actions: { retryJob } });
    const job = (kind: string, id: string) => ({ id, kind, status: "interrupted", stages: [] });
    t.healer.observeJob({ type: "restored", job: job("prepare", "a") });
    t.healer.observeJob({ type: "restored", job: job("text-to-print", "b") });
    t.healer.observeJob({ type: "restored", job: job("print", "c") });
    await t.after(10 * SEC);
    expect(retryJob).toHaveBeenCalledTimes(1);
    expect(retryJob).toHaveBeenCalledWith({ jobId: "a", kind: "prepare" });
    expect(t.healer.history().filter((r) => r.result === "noted")).toHaveLength(2);
  });
});

describe("guardian and disk", () => {
  it("restarts a crashed print watcher during a print (after a 15 s grace), with backoff", async () => {
    const restartGuardianWorker = vi.fn(async () => false);
    const t = setup({ actions: { restartGuardianWorker }, probes: { guardian: () => ({ wanted: true, workerState: "failed" }) } });
    t.healer.tick();
    await t.after(10 * SEC);
    t.healer.tick();
    await t.after(0);
    expect(restartGuardianWorker).not.toHaveBeenCalled();
    await t.after(5 * SEC);
    t.healer.tick();
    await t.after(5 * SEC);
    expect(restartGuardianWorker).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 40; i++) {
      t.healer.tick();
      await t.after(15 * SEC);
    }
    expect(restartGuardianWorker).toHaveBeenCalledTimes(3);
  });

  it("leaves the watcher alone when no print is running", async () => {
    const restartGuardianWorker = vi.fn(async () => true);
    const t = setup({ actions: { restartGuardianWorker }, probes: { guardian: () => ({ wanted: false, workerState: "failed" }) } });
    for (let i = 0; i < 5; i++) {
      t.healer.tick();
      await t.after(15 * SEC);
    }
    t.healer.observeLog("info", "[guardian] vision worker failed after 5 restarts");
    await t.after(MIN);
    expect(restartGuardianWorker).not.toHaveBeenCalled();
  });

  it("cleans old files when the disk is nearly full, checking at most every 10 minutes", async () => {
    const cleanDisk = vi.fn(async () => ({ ok: true, detail: "freed 900 MB" }));
    const disk = vi.fn(() => ({ freeBytes: 300e6, totalBytes: 32e9 }));
    const t = setup({ actions: { cleanDisk }, probes: { disk } });
    t.healer.tick();
    await t.after(0);
    expect(cleanDisk).toHaveBeenCalledTimes(1);
    t.healer.tick();
    await t.after(MIN);
    expect(disk).toHaveBeenCalledTimes(1);
    // Max once per 6 hours even if still low.
    for (let i = 0; i < 6; i++) {
      await t.after(10 * MIN);
      t.healer.tick();
    }
    expect(cleanDisk).toHaveBeenCalledTimes(1);
  });

  it("treats ENOSPC in the log as a full disk", async () => {
    const cleanDisk = vi.fn(async () => true);
    const t = setup({ actions: { cleanDisk } });
    t.healer.observeLog("warn", "jobs persist failed", { error: "ENOSPC: no space left on device, write" });
    await t.after(0);
    expect(cleanDisk).toHaveBeenCalledTimes(1);
  });
});

describe("AI diagnosis of unknown errors", () => {
  const dg = (suggestedRemediation: string, confidence = "high") =>
    vi.fn(async () => ({ summary: "The voice helper lost its connection.", likelyCause: "socket reset", userHint: "Try again.", suggestedRemediation, confidence })) as unknown as Diagnoser & ReturnType<typeof vi.fn>;

  it("explains the error to the user and may run a whitelisted, AI-triggerable fix", async () => {
    const reconnectGemini = vi.fn(async () => true);
    const diagnose = dg("reconnect-gemini");
    const t = setup({ actions: { reconnectGemini }, diagnose, probes: { recentLogLines: () => ['{"message":"x"}'] } });
    t.healer.observeLog("error", "tool response failed", { error: "socket hang up" });
    await t.after(0);
    expect(diagnose).toHaveBeenCalledTimes(1);
    const input = (diagnose.mock.calls[0] as unknown as [Parameters<Diagnoser>[0]])[0];
    expect(input.logLines).toEqual(['{"message":"x"}']);
    expect(input.remediations.map((r) => r.id)).toEqual(REMEDIATION_IDS);
    expect(t.notices[0]).toMatchObject({ level: "warn", message: "The voice helper lost its connection.", hint: "Try again." });
    await t.after(2 * SEC);
    expect(reconnectGemini).toHaveBeenCalledTimes(1);
    expect(t.healer.history().map((r) => r.action)).toEqual(["reconnect-gemini", "diagnose"]);
  });

  it("never runs a suggestion that isn't AI-triggerable or is low confidence", async () => {
    const cleanDisk = vi.fn(async () => true);
    const reconnectGemini = vi.fn(async () => true);
    const t = setup({ actions: { cleanDisk, reconnectGemini }, diagnose: dg("clean-disk") });
    t.healer.observeLog("error", "uncaughtException", { message: "boom" });
    await t.after(MIN);
    expect(cleanDisk).not.toHaveBeenCalled();
    const t2 = setup({ actions: { reconnectGemini }, diagnose: dg("reconnect-gemini", "low") });
    t2.healer.observeLog("error", "uncaughtException", { message: "boom" });
    await t2.after(MIN);
    expect(reconnectGemini).not.toHaveBeenCalled();
  });

  it("is rate limited and de-duplicated", async () => {
    const diagnose = dg("none");
    const t = setup({ diagnose });
    t.healer.observeLog("error", "uncaughtException", { message: "boom 1" });
    t.healer.observeLog("error", "uncaughtException", { message: "boom 2" }); // same fingerprint
    t.healer.observeLog("error", "renderer crashed, reloading", { reason: "oom" }); // within 5 min
    await t.after(0);
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(t.healer.history().map((r) => r.result).sort()).toEqual(["skipped", "suggested"]);
    await t.after(5 * MIN);
    t.healer.observeLog("error", "renderer crashed, reloading", { reason: "oom" });
    await t.after(0);
    expect(diagnose).toHaveBeenCalledTimes(2);
  });

  it("records a failed diagnosis and goes on", async () => {
    const diagnose = vi.fn(async () => { throw new Error("Claude HTTP 529"); });
    const t = setup({ diagnose });
    t.healer.observeLog("error", "uncaughtException", { message: "boom" });
    await t.after(0);
    expect(t.healer.history()[0]).toMatchObject({ action: "diagnose", result: "failed", detail: "Claude HTTP 529" });
  });

  it("sends unknown job failures (MX-SYS-001 or unregistered codes) to diagnosis, not known user errors", async () => {
    const diagnose = dg("none");
    const t = setup({ diagnose, extra: { config: { diagnoseMinGapMs: 0 } } });
    const jobs = new JobManager();
    jobs.subscribeAll((ev) => t.healer.observeJob(ev));
    const fail = (code: string, msg: string) => {
      const j = jobs.create({ kind: "prepare", title: "x", meta: {} });
      jobs.startStage(j.id, "prepare.check");
      jobs.failStage(j.id, "prepare.check", new Error(msg), code);
    };
    fail("MX-SLICE-006", "too big");
    await t.after(0);
    expect(diagnose).not.toHaveBeenCalled();
    fail("MX-SYS-001", "weird");
    await t.after(0);
    expect(diagnose).toHaveBeenCalledTimes(1);
  });

  it("history is newest first and capped", async () => {
    const t = setup({ extra: { config: { historySize: 3 } } });
    for (let i = 0; i < 5; i++) t.healer.report({ kind: "printer-stale-lock-cleared", key: "printer", what: `lock ${i}` });
    const h = t.healer.history();
    expect(h.map((r) => r.what)).toEqual(["lock 4", "lock 3", "lock 2"]);
    expect(t.healer.status().counts.fixed).toBe(3);
  });
});
