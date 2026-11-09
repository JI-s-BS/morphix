// The whitelist of self-heal remediations and their limits. Adding an entry here is the only
// way to give the healer a new power; anything physical or costly must never be added.
import type { Limits, RemediationId } from "./types";

export interface Remediation {
  id: RemediationId;
  label: string;
  /** Moves, heats, starts, pauses or cancels anything on the printer. Always false. */
  physical: false;
  /** Spends money or credits (Meshy tasks, paid API calls). Always false. */
  costly: false;
  /** May be run when the AI diagnosis suggests it (only argument-free, idempotent fixes). */
  aiTriggerable: boolean;
  limits: Limits;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export const REMEDIATIONS: Readonly<Record<RemediationId, Remediation>> = Object.freeze({
  "reconnect-gemini": {
    id: "reconnect-gemini", label: "reconnect to Gemini", physical: false, costly: false, aiTriggerable: true,
    limits: { maxAttempts: 3, windowMs: 10 * MIN, backoffMs: [2_000, 10_000, 30_000], cooldownMs: 5_000 },
  },
  "reset-voice-session": {
    id: "reset-voice-session", label: "restart the voice connection", physical: false, costly: false, aiTriggerable: true,
    limits: { maxAttempts: 2, windowMs: 10 * MIN, backoffMs: [0, 5_000], cooldownMs: 30_000 },
  },
  "release-printer-control": {
    id: "release-printer-control", label: "release the printer's control lock (M602) and ask again", physical: false, costly: false, aiTriggerable: true,
    limits: { maxAttempts: 2, windowMs: 30 * MIN, backoffMs: [0, 2 * MIN], cooldownMs: 2 * MIN },
  },
  "printer-poll-backoff": {
    id: "printer-poll-backoff", label: "check the printer less often", physical: false, costly: false, aiTriggerable: false,
    limits: { maxAttempts: 10, windowMs: HOUR, backoffMs: [0], cooldownMs: 0 },
  },
  "retry-slice-safer": {
    id: "retry-slice-safer", label: "slice again with safer settings (supports auto, 0.2 mm)", physical: false, costly: false, aiTriggerable: false,
    limits: { maxAttempts: 1, windowMs: HOUR, backoffMs: [3_000], cooldownMs: 0 },
  },
  "resume-meshy-polling": {
    id: "resume-meshy-polling", label: "keep checking the existing Meshy task", physical: false, costly: false, aiTriggerable: false,
    limits: { maxAttempts: 2, windowMs: HOUR, backoffMs: [30_000, 2 * MIN], cooldownMs: 30_000 },
  },
  "restart-guardian-worker": {
    id: "restart-guardian-worker", label: "restart the print watcher", physical: false, costly: false, aiTriggerable: true,
    limits: { maxAttempts: 3, windowMs: 30 * MIN, backoffMs: [5_000, 30_000, 2 * MIN], cooldownMs: 5_000 },
  },
  "reconcile-print-state": {
    id: "reconcile-print-state", label: "update Morphix's print record to match the idle printer", physical: false, costly: false, aiTriggerable: false,
    limits: { maxAttempts: 1, windowMs: HOUR, backoffMs: [0], cooldownMs: 0 },
  },
  "clean-disk": {
    id: "clean-disk", label: "delete old temporary and slicing files", physical: false, costly: false, aiTriggerable: false,
    limits: { maxAttempts: 1, windowMs: 6 * HOUR, backoffMs: [0], cooldownMs: 0 },
  },
  "retry-job": {
    id: "retry-job", label: "run the interrupted preparation again", physical: false, costly: false, aiTriggerable: false,
    limits: { maxAttempts: 1, windowMs: 6 * HOUR, backoffMs: [5_000], cooldownMs: 0 },
  },
});

export const REMEDIATION_IDS = Object.keys(REMEDIATIONS) as RemediationId[];

export function isRemediationId(v: unknown): v is RemediationId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(REMEDIATIONS, v);
}

export function limitsFor(id: RemediationId, overrides?: Partial<Record<RemediationId, Partial<Limits>>>): Limits {
  return { ...REMEDIATIONS[id].limits, ...(overrides?.[id] ?? {}) };
}
