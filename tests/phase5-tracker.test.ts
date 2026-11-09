import { describe, expect, it } from "vitest";
import type { PrinterStatus } from "@morphix/shared";
import { detectActivePrint, JobTracker, PrinterObserver } from "@morphix/printer";
import { guardLoopbackOnly, startRig, useCleanup } from "./phase5-helpers";

guardLoopbackOnly();
const cleanup = useCleanup();

const st = (machine: string, extra: Partial<PrinterStatus> = {}): PrinterStatus => ({
  online: true,
  checkedAt: new Date(Date.now() + 1).toISOString(),
  machine,
  ...extra,
});

function record(t: JobTracker): string[] {
  const events: string[] = [];
  for (const e of ["started", "recovered", "progress", "paused", "resumed", "completed", "cancelled", "failed", "offline", "online"] as const) {
    t.on(e, () => events.push(e));
  }
  t.on("unknownStatus", (_j, s) => events.push(`unknown:${s}`));
  return events;
}

describe("JobTracker", () => {
  it("follows a print to completion with progress and layer", () => {
    const t = new JobTracker();
    const ev = record(t);
    t.track({ jobId: "job-1", fileName: "cube.gx" });
    t.update(st("BUILDING_FROM_SD", { currentFile: "cube.gx", progress: 10, layer: [5, 100] }));
    t.update(st("BUILDING_FROM_SD", { currentFile: "cube.gx", progress: 10, layer: [5, 100] }));
    t.update(st("BUILDING_FROM_SD", { currentFile: "cube.gx", progress: 99, layer: [99, 100] }));
    t.update(st("READY", { progress: 0, layer: [0, 0] }));
    expect(ev).toEqual(["started", "progress", "progress", "completed"]);
    expect(t.job).toMatchObject({ jobId: "job-1", phase: "completed", progress: 100, recovered: false });
    expect(t.active).toBe(false);
  });

  it("reports pause/resume, a cancel it was told about, and an unexplained stop as failed", () => {
    const t = new JobTracker();
    const ev = record(t);
    t.track({ jobId: "a", fileName: "a.gx" });
    t.update(st("BUILDING_FROM_SD", { progress: 20, layer: [10, 100] }));
    t.update(st("PAUSED", { progress: 20, layer: [10, 100] }));
    t.update(st("BUILDING_FROM_SD", { progress: 20, layer: [10, 100] }));
    t.noteCancelRequested();
    t.update(st("READY"));
    expect(ev).toEqual(["started", "progress", "paused", "resumed", "cancelled"]);

    ev.length = 0;
    t.track({ jobId: "b", fileName: "b.gx" });
    t.update(st("BUILDING_FROM_SD", { progress: 40, layer: [40, 100] }));
    t.update(st("READY"));
    expect(ev).toEqual(["started", "progress", "failed"]);
    expect(t.job.reason).toMatch(/40%/);
  });

  it("keeps the job through offline gaps and unknown statuses without guessing an outcome", () => {
    const t = new JobTracker();
    const ev = record(t);
    t.track({ jobId: "a", fileName: "a.gx" });
    t.update({ online: false, checkedAt: new Date(Date.now() + 1).toISOString(), error: "timeout" });
    t.update({ online: false, checkedAt: new Date(Date.now() + 1).toISOString(), error: "timeout" });
    t.update(st("BUILDING_FROM_SD", { progress: 50 }));
    t.update(st("SOMETHING_NEW", { progress: 50 }));
    expect(ev).toEqual(["started", "offline", "online", "progress", "unknown:SOMETHING_NEW"]);
    expect(t.job.phase).toBe("printing");
  });

  it("ignores statuses polled before track() was called", () => {
    const t = new JobTracker();
    const stale = { ...st("READY"), checkedAt: new Date(Date.now() - 1000).toISOString() };
    t.track({ jobId: "a", fileName: "a.gx" });
    t.update(stale);
    expect(t.job.phase).toBe("printing");
  });

  it("detects a print already running after an app restart", () => {
    expect(detectActivePrint(st("READY"))).toBeNull();
    expect(detectActivePrint({ online: false, checkedAt: "" })).toBeNull();
    expect(detectActivePrint(st("BUILDING_FROM_SD", { currentFile: "/data/cube.gx", progress: 33, layer: [3, 9] }))).toEqual({
      fileName: "cube.gx",
      paused: false,
      progress: 33,
      layer: [3, 9],
    });
    expect(detectActivePrint(st("PAUSE_X"), ["PAUSE_X"])?.paused).toBe(true);

    const t = new JobTracker();
    const ev = record(t);
    t.update(st("BUILDING_FROM_SD", { currentFile: "cube.gx", progress: 33, layer: [3, 9] }));
    expect(ev).toEqual(["recovered"]);
    expect(t.job).toMatchObject({ phase: "printing", recovered: true, fileName: "cube.gx", progress: 33 });
    t.attachJob("job-from-db");
    expect(t.job.jobId).toBe("job-from-db");
    t.update(st("BUILDING_FROM_SD", { currentFile: "cube.gx", progress: 100, layer: [9, 9] }));
    t.update(st("READY"));
    expect(t.job.phase).toBe("completed");
  });
});

describe("controller + observer + tracker against the fake printer", () => {
  it("starts, follows, and completes a print end to end", async () => {
    const rig = await startRig({}, cleanup);
    const c = rig.controller();
    const tracker = new JobTracker();
    const ev = record(tracker);
    const observer = new PrinterObserver(c.transport, (s) => tracker.update(s));

    await observer.poll();
    expect(tracker.job.phase).toBe("idle");
    const file = "Afinia_Cube.gx";
    const r = await c.startPrint({ jobId: "job-9", fileName: file, authorization: rig.auth.authorize({ jobId: "job-9", fileName: file, approvedBy: "touch" }) });
    expect(r.confirmed).toBe(true);
    tracker.track({ jobId: "job-9", fileName: file, status: r.status });

    rig.fake.setProgress(45, [45, 100]);
    await observer.poll();
    expect(tracker.job).toMatchObject({ phase: "printing", progress: 45, layer: [45, 100] });
    rig.fake.finishPrint();
    await observer.poll();
    expect(tracker.job.phase).toBe("completed");
    expect(ev).toEqual(["started", "progress", "completed"]);
  });

  it("recovers a print the app did not start (restart), and reports an unexplained stop", async () => {
    const rig = await startRig({}, cleanup);
    rig.fake.machineStatus = "BUILDING_FROM_SD";
    rig.fake.currentFile = "Afinia_Cube.gx";
    rig.fake.setProgress(12, [12, 100]);
    const c = rig.controller({ enabled: false }); // recovery works with control disabled
    const tracker = new JobTracker();
    const ev = record(tracker);
    const observer = new PrinterObserver(c.transport, (s) => tracker.update(s));
    await observer.poll();
    expect(detectActivePrint(observer.status)?.fileName).toBe("Afinia_Cube.gx");
    expect(tracker.job).toMatchObject({ phase: "printing", recovered: true, progress: 12 });
    rig.fake.abortPrint();
    await observer.poll();
    expect(ev).toEqual(["recovered", "failed"]);
  });
});
