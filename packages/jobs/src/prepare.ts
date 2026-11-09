// Bridges preparePrint()/prepareWithAdvice() progress callbacks to the prepare.*
// stages of a job. Structural types only, so @morphix/jobs does not depend on slicing.
import type { ErrorCode } from "@morphix/errors";
import type { JobManager } from "./manager";
import type { Job } from "./types";

/** preparePrint stage -> job stage. "advise" comes from prepareWithAdvice. */
export const PREPARE_STAGE_MAP: Readonly<Record<string, string>> = {
  load: "prepare.check",
  validate: "prepare.check",
  repair: "prepare.repair",
  place: "prepare.orient",
  advise: "prepare.slice",
  slice: "prepare.slice",
  gx: "prepare.gx",
};

const DETAIL: Readonly<Record<string, string>> = {
  load: "Opening the model",
  validate: "Looking for problems",
  repair: "Fixing little problems",
  place: "Sizing and turning the model",
  advise: "Choosing the best settings",
  slice: "Running the slicer",
  gx: "Writing the printer file",
};

const ORDER = ["prepare.check", "prepare.repair", "prepare.orient", "prepare.slice", "prepare.gx"];

/** The parts of a PreparePrintResult the tracker looks at. */
export interface PrepareOutcomeLike {
  ok: boolean;
  slicer: { ok: boolean; reason?: string; message?: string };
  gx: { ok: boolean; reason?: string; message?: string; validation?: { ok: boolean; errors?: string[] } };
}

export interface PrepareTracker {
  /** Pass as options.onProgress. */
  onProgress(stage: string): void;
  /** Call with the result: completes, skips or fails the prepare stages. */
  finish(result: PrepareOutcomeLike): Job;
  /** Call if preparePrint threw. */
  fail(error: unknown, fallbackCode?: ErrorCode | string): Job;
}

export function trackPrepare(manager: JobManager, jobId: string): PrepareTracker {
  const stagesOf = () => {
    const job = manager.get(jobId);
    if (!job) throw new Error(`unknown job ${jobId}`);
    return job.stages.filter((s) => ORDER.includes(s.key));
  };
  const running = () => stagesOf().find((s) => s.status === "running")?.key;

  return {
    onProgress(stage) {
      const target = PREPARE_STAGE_MAP[stage];
      if (!target) return; // "done" and unknown stages: finish() decides
      const stages = stagesOf();
      const t = stages.find((s) => s.key === target);
      if (!t) return;
      if (t.status === "running") {
        manager.updateStage(jobId, target, { detail: DETAIL[stage] });
        return;
      }
      // Complete everything before the target, then start it.
      for (const s of stages) {
        if (s.key === target) break;
        if (s.status === "running" || s.status === "pending") manager.completeStage(jobId, s.key);
      }
      manager.startStage(jobId, target, DETAIL[stage]);
    },

    finish(result) {
      if (result.slicer.ok && result.gx.ok) {
        if (result.gx.validation && !result.gx.validation.ok) {
          for (const s of stagesOf()) if (s.key !== "prepare.gx" && s.status !== "done") manager.completeStage(jobId, s.key);
          return manager.failStage(jobId, "prepare.gx", { code: "MX-SLICE-010", message: result.gx.validation.errors?.join("; ") }, "MX-SLICE-010");
        }
        let job: Job | undefined;
        for (const s of stagesOf()) if (s.status !== "done" && s.status !== "skipped") job = manager.completeStage(jobId, s.key);
        return job ?? manager.get(jobId)!;
      }
      if (!result.slicer.ok && result.slicer.reason === "skipped") {
        let job: Job | undefined;
        for (const s of stagesOf()) {
          if (s.status === "done" || s.status === "skipped") continue;
          job = s.key === "prepare.slice" || s.key === "prepare.gx" ? manager.skip(jobId, s.key, "Slicing was turned off") : manager.completeStage(jobId, s.key);
        }
        return job ?? manager.get(jobId)!;
      }
      const failure = !result.slicer.ok ? result.slicer : result.gx;
      const at = running() ?? "prepare.slice";
      for (const s of stagesOf()) {
        if (s.key === at) break;
        if (s.status === "pending" || s.status === "running") manager.completeStage(jobId, s.key);
      }
      return manager.failStage(jobId, at, { ok: false, reason: failure.reason, message: failure.message }, "MX-SLICE-003");
    },

    fail(error, fallbackCode = "MX-SLICE-003") {
      return manager.failStage(jobId, running() ?? "prepare.check", error, fallbackCode);
    },
  };
}
