import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createJobFileStore, JobManager, restoreJobs, trackPrepare, type JobsSnapshot } from "@morphix/jobs";

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

  it("file store writes atomically and tolerates a missing or corrupt file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morphix-jobs-"));
    const store = createJobFileStore(join(dir, "data", "jobs.json"));
    expect(await store.load()).toBeNull();
    const m = new JobManager({ now, persist: (s) => store.save(s) });
    m.create({ kind: "prepare", title: "x", id: "j1" });
    m.completeStage("j1", "prepare.check");
    await m.flush();
    const loaded = await store.load();
    expect(loaded!.jobs[0].stages[0].status).toBe("done");
    expect(JSON.parse(await readFile(store.path, "utf8")).version).toBe(1);
    await writeFile(store.path, "{not json");
    expect(await store.load()).toBeNull();
  });
});

describe("trackPrepare", () => {
  const stages = ["load", "validate", "repair", "place", "slice", "gx", "done"];
  const OK = { ok: true, slicer: { ok: true }, gx: { ok: true, validation: { ok: true, errors: [] } } };

  it("maps preparePrint progress to prepare.* stages and completes them", () => {
    const m = new JobManager({ now });
    const job = m.create({ kind: "text-to-print", title: "x", id: "t" });
    for (const k of ["understand", "generate", "download"]) m.completeStage(job.id, k);
    const t = trackPrepare(m, job.id);
    for (const s of stages.slice(0, 5)) t.onProgress(s);
    let j = m.get("t")!;
    expect(j.stages.filter((s) => s.group === "prepare").map((s) => s.status)).toEqual(["done", "done", "done", "running", "pending"]);
    expect(j.stages.find((s) => s.key === "prepare.slice")!.detail).toBe("Running the slicer");
    t.onProgress("gx");
    t.onProgress("done");
    j = t.finish(OK);
    expect(j.stages.filter((s) => s.group === "prepare").every((s) => s.status === "done")).toBe(true);
    expect(j.currentStage).toBe("approval");
  });

  it("fails the running stage with the slicer's error code", () => {
    const m = new JobManager({ now });
    m.create({ kind: "prepare", title: "x", id: "p" });
    const t = trackPrepare(m, "p");
    for (const s of stages.slice(0, 5)) t.onProgress(s);
    const j = t.finish({ ok: false, slicer: { ok: false, reason: "slicer-not-installed", message: "No slicer installed." }, gx: { ok: false, reason: "slicer-not-installed" } });
    expect(j.status).toBe("failed");
    expect(j.stages.find((s) => s.key === "prepare.slice")!.error!.code).toBe("MX-SLICE-001");
  });

  it("fails at orientation when the model is too big", () => {
    const m = new JobManager({ now });
    m.create({ kind: "prepare", title: "x", id: "p" });
    const t = trackPrepare(m, "p");
    for (const s of stages.slice(0, 4)) t.onProgress(s);
    const j = t.finish({ ok: false, slicer: { ok: false, reason: "too-large", message: "Too large" }, gx: { ok: false, reason: "too-large" } });
    expect(j.stages.find((s) => s.key === "prepare.orient")!.error!.code).toBe("MX-SLICE-006");
  });

  it("skips slicing when it was turned off, and flags bad .gx files", () => {
    const m = new JobManager({ now });
    m.create({ kind: "prepare", title: "x", id: "p" });
    const t = trackPrepare(m, "p");
    for (const s of stages.slice(0, 4)) t.onProgress(s);
    let j = t.finish({ ok: false, slicer: { ok: false, reason: "skipped" }, gx: { ok: false } });
    expect(j.status).toBe("done");
    expect(j.stages.find((s) => s.key === "prepare.slice")!.status).toBe("skipped");

    m.create({ kind: "prepare", title: "y", id: "q" });
    const t2 = trackPrepare(m, "q");
    for (const s of stages.slice(0, 6)) t2.onProgress(s);
    j = t2.finish({ ok: false, slicer: { ok: true }, gx: { ok: true, validation: { ok: false, errors: ["bad header"] } } });
    expect(j.stages.find((s) => s.key === "prepare.gx")!.error).toMatchObject({ code: "MX-SLICE-010", message: "bad header" });
  });

  it("fail() records a thrown error at the current stage", () => {
    const m = new JobManager({ now });
    m.create({ kind: "prepare", title: "x", id: "p" });
    const t = trackPrepare(m, "p");
    t.onProgress("load");
    const j = t.fail(Object.assign(new Error("not an STL"), { name: "MeshFormatError" }));
    expect(j.stages[0].error!.code).toBe("MX-GEN-008");
  });
});
