// Deterministic project workflow. Printer-facing states can only be reached
// through validation and explicit approval; nothing may skip them.

export const WORKFLOW_STATES = [
  "idea",
  "clarification",
  "generating",
  "reviewing",
  "sizing",
  "validating",
  "slicing",
  "approval",
  "uploading",
  "ready",
  "printing",
  "completed",
  "failed",
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

const TRANSITIONS: Record<WorkflowState, readonly WorkflowState[]> = {
  idea: ["clarification", "generating", "failed"],
  clarification: ["generating", "idea", "failed"],
  generating: ["reviewing", "failed"],
  reviewing: ["sizing", "generating", "idea"],
  sizing: ["validating", "reviewing"],
  validating: ["slicing", "sizing", "failed"],
  slicing: ["approval", "sizing", "failed"],
  approval: ["uploading", "sizing", "reviewing"],
  uploading: ["ready", "failed"],
  ready: ["printing", "approval"],
  printing: ["completed", "failed"],
  completed: ["reviewing"],
  failed: ["idea", "reviewing", "generating"],
};

/** States that touch the physical printer. Disabled until Phase 5. */
export const PRINTER_STATES: readonly WorkflowState[] = ["uploading", "ready", "printing"];

export interface TransitionContext {
  /** True only when the user explicitly approved this specific print. */
  userApproved?: boolean;
  /** True once printer control has been validated and enabled (Phase 5). */
  printControlsEnabled?: boolean;
}

export class WorkflowError extends Error {}

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(from: WorkflowState, to: WorkflowState, ctx: TransitionContext = {}): WorkflowState {
  if (!canTransition(from, to)) {
    throw new WorkflowError(`invalid transition ${from} -> ${to}`);
  }
  if (PRINTER_STATES.includes(to)) {
    if (!ctx.printControlsEnabled) throw new WorkflowError("printer controls are not enabled");
    if (to === "uploading" && !ctx.userApproved) throw new WorkflowError("explicit user approval required");
  }
  return to;
}

/** Scale factor that makes a model `targetMm` tall, given its current height. */
export function scaleForHeight(currentHeightMm: number, targetMm: number): number {
  if (!(currentHeightMm > 0) || !(targetMm > 0)) throw new WorkflowError("heights must be positive");
  return targetMm / currentHeightMm;
}

export function fitsBuildVolume(
  size: { x: number; y: number; z: number },
  volume: { x: number; y: number; z: number },
): boolean {
  return size.x <= volume.x && size.y <= volume.y && size.z <= volume.z;
}

export const MM_PER_INCH = 25.4;
