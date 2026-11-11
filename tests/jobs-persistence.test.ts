import { describe, expect, it, vi } from "vitest";
import { JobManager, restoreJobs, type JobsSnapshot } from "@morphix/jobs";

const now = () => new Date("2026-11-07T10:00:00Z");

describe("persistence", () => {
  it("persists every change and survives an app restart", async () => {
    const saved: JobsSnapshot[] = [];
    const m1 = new JobManager({ now, persist: (s) => void saved.push(s) });
    const a = m1.create({ kind: "text-to-print", title: "Dragon", id: "a" });
    m1.completeStage(a.id, "understand");
    m1.updateStage(a.id, "generate", { progress: 60 });
    const b = m1.create({ kind: "print", title: "Vase", id: "b" });
    m1.waitForUser(b.id, "approval", "Print it?");
    const c = m1.create({ kind: "print", title: "Done", id: "c", stages: [{ key: "x", label: "X", weight: 1 }] });
    m1.completeStage(c.id, "x");
    expect(saved.length).toBeGreaterThan(5);

    // "Restart": a new manager loads the last snapshot through JSON.
    const m2 = new JobManager({ now });
    const restored = m2.restore(JSON.parse(JSON.stringify(saved.at(-1))));
    expect(restored.map((j) => j.id).sort()).toEqual(["a", "b", "c"]);
    const ja = m2.get("a")!;
    expect(ja.status).toBe("interrupted");
    expect(ja.stages[1]).toMatchObject({ key: "generate", status: "failed", interrupted: true, error: { code: "MX-SYS-006" } });
    expect(ja.error!.code).toBe("MX-SYS-006");
    expect(ja.finishedAt).toBeDefined();
    expect(m2.get("b")!.status).toBe("waiting_for_user"); // approvals survive by default
    expect(m2.get("c")!.status).toBe("done");

    // The interrupted stage can be retried.
    expect(m2.startStage("a", "generate").status).toBe("running");
  });

  it("can interrupt waiting stages and drops malformed snapshots", () => {
    const m = new JobManager({ now });
    m.create({ kind: "print", title: "Vase", id: "b" });
    m.waitForUser("b", "approval");
    const jobs = restoreJobs(m.serialize(), { interruptWaiting: true, now: now() });
    expect(jobs[0].status).toBe("interrupted");
    expect(restoreJobs(null)).toEqual([]);
    expect(restoreJobs({ version: 2, jobs: [] })).toEqual([]);
    expect(restoreJobs({ version: 1, jobs: [{ id: 1 }, null] })).toEqual([]);
  });

  it("debounces saves and reports persist errors", async () => {
    vi.useFakeTimers();
    try {
      const persist = vi.fn();
      const m = new JobManager({ now, persist, persistDebounceMs: 500 });
      const j = m.create({ kind: "prepare", title: "x" });
      m.completeStage(j.id, "prepare.check");
      m.completeStage(j.id, "prepare.repair");
      expect(persist).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(persist).toHaveBeenCalledTimes(1);
      m.completeStage(j.id, "prepare.orient");
      await m.flush();
      expect(persist).toHaveBeenCalledTimes(2);
      m.dispose();
    } finally {
      vi.useRealTimers();
    }
    const onPersistError = vi.fn();
    const bad = new JobManager({ now, persist: () => { throw new Error("disk full"); }, onPersistError });
    bad.create({ kind: "prepare", title: "x" });
    await Promise.resolve();
    expect(onPersistError).toHaveBeenCalled();
  });
});
