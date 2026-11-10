import { describe, expect, it } from "vitest";
import { localReview } from "@morphix/guardian";

const gemini = (problem: string, confidence: number) =>
  ({ status: "ok", problem, confidence, explanation: "x", model: "m", failureLikely: !["no_problem", "uncertain", "camera_issue"].includes(problem) }) as never;

describe("local review", () => {
  it("is conservative", () => {
    expect(localReview({ kind: "spaghetti", localConfirmed: true, localScore: 3 }).recommendation).toBe("pause_recommended");
    expect(localReview({ kind: "spaghetti", localConfirmed: true, localScore: 3, gemini: gemini("spaghetti", 0.9) }).recommendation).toBe("pause_recommended");
    expect(localReview({ kind: "spaghetti", localConfirmed: true, localScore: 3, gemini: gemini("no_problem", 0.8) }).recommendation).toBe("likely_false_alarm");
    expect(localReview({ kind: "spaghetti", localConfirmed: false, localScore: 1 }).recommendation).toBe("keep_watching");
  });
});
