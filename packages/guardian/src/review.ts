// Local review of a confirmed alert: combines the detector and the optional Gemini
// check into one recommendation shown on the Printer page.
import type { FailureKind } from "./events";
import type { GeminiResult } from "./gemini";

export type ReviewRecommendation = "pause_recommended" | "keep_watching" | "likely_false_alarm";

export interface ReviewInput {
  kind: FailureKind;
  localConfirmed: boolean;
  localScore: number;
  gemini?: GeminiResult;
  printerState?: string | null;
}

export interface ReviewResult {
  source: "local";
  recommendation: ReviewRecommendation;
  confidence: number;
  rationale: string;
}

/** Deterministic second look at a confirmed alert. Conservative: an
 * unverified confirmed failure still recommends pausing. */
export function localReview(i: ReviewInput): ReviewResult {
  const g = i.gemini?.status === "ok" ? i.gemini : undefined;
  if (g && g.problem === "no_problem" && g.confidence >= 0.7) {
    return { source: "local", recommendation: "likely_false_alarm", confidence: g.confidence, rationale: `Gemini sees no problem: ${g.explanation}` };
  }
  if (g && g.failureLikely && g.confidence >= 0.6) {
    return { source: "local", recommendation: "pause_recommended", confidence: Math.min(0.95, (g.confidence + 0.8) / 2), rationale: `Local detector and Gemini agree (${g.problem}): ${g.explanation}` };
  }
  if (i.localConfirmed) {
    return { source: "local", recommendation: "pause_recommended", confidence: 0.6, rationale: `Local detector confirmed ${i.kind} over several frames${g ? `; Gemini: ${g.problem} (${g.confidence.toFixed(2)})` : "; no AI check available"}.` };
  }
  return { source: "local", recommendation: "keep_watching", confidence: 0.5, rationale: `Possible ${i.kind}; waiting for more frames.` };
}
