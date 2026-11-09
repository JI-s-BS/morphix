import { describe, expect, it } from "vitest";
import { computeJobPercent, JobManager, stageTemplate, stagesFrom, type JobEvent } from "@morphix/jobs";

function clock(start = Date.parse("2026-11-07T10:00:00Z")) {
  let t = start;
  return { now: () => new Date(t), tick: (ms = 1000) => (t += ms) };
}

let n = 0;
const mk = (opts: ConstructorParameters<typeof JobManager>[0] = {}) => new JobManager({ newId: () => `job${++n}`, ...clock(), ...opts });

describe("stage templates", () => {
  it("text-to-print follows the full pipeline", () => {
    expect(stageTemplate("text-to-print").map((s) => s.key)).toEqual([
      "understand", "generate", "download",
      "prepare.check", "prepare.repair", "prepare.orient", "prepare.slice", "prepare.gx",
      "approval", "send", "print", "done",
    ]);
  });

  it("photo-to-print has questions and a builder choice", () => {
    expect(stageTemplate("photo-to-print").slice(0, 4).map((s) => s.key)).toEqual(["photos", "questions", "build", "download"]);
    const scad = stageTemplate("photo-to-print", { builder: "openscad", questions: false });
    expect(scad.slice(0, 3).map((s) => s.key)).toEqual(["photos", "build", "prepare.check"]);
    expect(scad.find((s) => s.key === "build")!.label).toMatch(/shapes/);
  });

  it("prepare and print kinds, and options", () => {
    expect(stageTemplate("prepare").map((s) => s.key)).toEqual(["prepare.check", "prepare.repair", "prepare.orient", "prepare.slice", "prepare.gx", "done"]);
    expect(stageTemplate("print").map((s) => s.key)).toEqual(["approval", "send", "print", "done"]);
    expect(stageTemplate("print", { approval: false }).map((s) => s.key)).toEqual(["send", "print", "done"]);
    expect(stageTemplate("text-to-print", { print: false }).map((s) => s.key).slice(-2)).toEqual(["prepare.gx", "done"]);
    for (const s of stageTemplate("text-to-print")) expect(s.label.length).toBeGreaterThan(3);
  });

  it("rejects bad custom stages", () => {
    expect(() => stagesFrom([{ key: "a", label: "A", weight: 1 }, { key: "a", label: "B", weight: 1 }])).toThrow(/duplicate/);
    expect(() => stagesFrom([{ key: "a", label: "A", weight: -1 }])).toThrow(/weight/);
  });
});

describe("overall percent", () => {
  it("is weighted by stage, ignores skipped stages and hits 100 only at the end", () => {
    const stages = stagesFrom([{ key: "a", label: "A", weight: 1 }, { key: "b", label: "B", weight: 3 }, { key: "c", label: "C", weight: 0 }]);
    expect(computeJobPercent(stages)).toBe(0);
    stages[0].status = "done";
    expect(computeJobPercent(stages)).toBe(25);
    stages[1].status = "running";
    stages[1].progress = 50;
    expect(computeJobPercent(stages)).toBe(62);
    stages[1].status = "skipped";
    expect(computeJobPercent(stages)).toBe(99); // c (weight 0) still pending
    stages[2].status = "done";
    expect(computeJobPercent(stages)).toBe(100);
  });

  it("falls back to equal shares when all weights are 0", () => {
    const stages = stagesFrom([{ key: "a", label: "A", weight: 0 }, { key: "b", label: "B", weight: 0 }]);
    stages[0].status = "done";
    expect(computeJobPercent(stages)).toBe(50);
  });
});

describe("JobManager", () => {
  it("runs a text-to-print job end to end", () => {
    const m = mk();
    const events: JobEvent[] = [];
    const job = m.create({ kind: "text-to-print", title: "Little dinosaur", owner: "touchscreen" });
    m.subscribe(job.id, (e) => events.push(e));
    expect(job.status).toBe("pending");
    expect(job.currentStage).toBe("understand");

    m.startStage(job.id, "understand");
    m.completeStage(job.id, "understand");
    let j = m.updateStage(job.id, "generate", { progress: 40, detail: "Meshy: 2 ahead in the queue" });
    expect(j.status).toBe("running");
    expect(j.stages[1]).toMatchObject({ status: "running", progress: 40, detail: "Meshy: 2 ahead in the queue" });
    expect(j.percent).toBeGreaterThan(5);
    j = m.updateStage(job.id, "generate", { progress: 400 });
    expect(j.stages[1].progress).toBe(100);
    m.advance(job.id, "download");
    expect(m.get(job.id)!.stages[1].status).toBe("done");
    for (const k of ["download", "prepare.check", "prepare.repair", "prepare.orient", "prepare.slice", "prepare.gx"]) m.completeStage(job.id, k);

    j = m.waitForUser(job.id, "approval", { prompt: "Shall I print it?", options: ["Print", "Not now"] });
    expect(j.status).toBe("waiting_for_user");
    expect(j.currentStage).toBe("approval");
    expect(j.stages.find((s) => s.key === "approval")!.question!.options).toEqual(["Print", "Not now"]);

    m.completeStage(job.id, "approval", "Approved on the touchscreen");
    expect(m.get(job.id)!.stages.find((s) => s.key === "approval")!.question).toBeUndefined();
    m.advance(job.id, "send");
    m.advance(job.id, "print");
    m.updateStage(job.id, "print", { progress: 50 });
    const before = m.get(job.id)!.percent;
    expect(before).toBeGreaterThan(50);
    expect(before).toBeLessThan(100);
    j = m.completeStage(job.id, "print");
    expect(j.status).toBe("done");
    expect(j.percent).toBe(100);
    expect(j.stages.at(-1)).toMatchObject({ key: "done", status: "done" });
    expect(j.currentStage).toBeNull();
    expect(j.finishedAt).toBeDefined();
    expect(events.at(-1)!.type).toBe("finished");
    expect(events.every((e) => e.job.id === job.id)).toBe(true);
  });

  it("records failures as serialised MorphixErrors and allows a retry", () => {
    const m = mk();
    const job = m.create({ kind: "text-to-print", title: "Cup" });
    m.startStage(job.id, "understand");
    m.completeStage(job.id, "understand");
    m.startStage(job.id, "generate");
    let j = m.failStage(job.id, "generate", new Error("Meshy 402: Insufficient credits"), "MX-GEN-005");
    expect(j.status).toBe("failed");
    expect(j.error).toMatchObject({ code: "MX-GEN-003", title: "The model maker ran out of credits", context: { jobId: job.id, stage: "generate", service: "meshy" } });
    expect(j.stages[1].error!.code).toBe("MX-GEN-003");
    expect(JSON.parse(JSON.stringify(j))).toEqual(j);
    expect(j.finishedAt).toBeDefined();

    j = m.startStage(job.id, "generate");
    expect(j.status).toBe("running");
    expect(j.error).toBeUndefined();
    expect(j.finishedAt).toBeUndefined();
    expect(j.stages[1].error).toBeUndefined();
  });

  it("skips stages and drops them from the percentage", () => {
    const m = mk();
    const job = m.create({ kind: "photo-to-print", title: "Robot" });
    m.completeStage(job.id, "photos");
    const j = m.skip(job.id, "questions", "No questions needed");
    expect(j.stages[1]).toMatchObject({ status: "skipped", detail: "No questions needed" });
  });

  it("cancels running and waiting stages", () => {
    const m = mk();
    const job = m.create({ kind: "print", title: "Vase" });
    m.waitForUser(job.id, "approval", "Print it?");
    const j = m.cancel(job.id, "user said no");
    expect(j.status).toBe("cancelled");
    expect(j.stages[0]).toMatchObject({ status: "failed", error: { code: "MX-SYS-004", message: "user said no" } });
    expect(() => m.startStage(job.id, "send")).toThrow(/cancelled/);
    expect(m.cancel(job.id).status).toBe("cancelled");
  });

  it("filters, subscribes to all jobs, and isolates snapshots", () => {
    const c = clock();
    const m = mk(c);
    const all: string[] = [];
    const off = m.subscribeAll((e) => all.push(`${e.type}:${e.job.id}`));
    const a = m.create({ kind: "prepare", title: "A", owner: "auth0|kid" });
    c.tick();
    const b = m.create({ kind: "print", title: "B", owner: "touchscreen" });
    m.subscribe(a.id, () => { throw new Error("broken listener"); });
    m.completeStage(a.id, "prepare.check");
    expect(m.list().map((j) => j.id)).toEqual([b.id, a.id]);
    expect(m.list({ owner: "auth0|kid" }).map((j) => j.id)).toEqual([a.id]);
    expect(m.list({ kind: "print" }).map((j) => j.id)).toEqual([b.id]);
    expect(m.list({ active: false })).toEqual([]);
    const snap = m.get(a.id)!;
    snap.stages[0].status = "failed";
    expect(m.get(a.id)!.stages[0].status).toBe("done");
    off();
    m.remove(b.id);
    expect(all).toEqual([`created:${a.id}`, `created:${b.id}`, `updated:${a.id}`]);
    expect(m.get(b.id)).toBeUndefined();
  });

  it("throws on unknown jobs and stages", () => {
    const m = mk();
    const job = m.create({ kind: "prepare", title: "x" });
    expect(() => m.startStage("nope", "prepare.check")).toThrow(/unknown job/);
    expect(() => m.startStage(job.id, "nope")).toThrow(/no stage/);
    expect(() => m.create({ kind: "prepare", title: "y", id: job.id })).toThrow(/exists/);
  });

  it("prunes the oldest finished jobs", () => {
    const c = clock();
    const m = mk({ ...c, maxFinishedJobs: 2 });
    const ids = [1, 2, 3].map((i) => {
      const j = m.create({ kind: "print", title: `j${i}`, stages: [{ key: "x", label: "X", weight: 1 }] });
      c.tick();
      m.completeStage(j.id, "x");
      return j.id;
    });
    m.create({ kind: "print", title: "active" });
    expect(m.list().map((j) => j.title)).toEqual(["active", "j3", "j2"]);
    expect(m.get(ids[0])).toBeUndefined();
  });
});
