// Local policy layer for actions that cost money. Gemini or a button may
// PROPOSE; only an explicit user confirmation (a tap, or a spoken "yes" checked
// deterministically) starts the job. Daily cap and key checks happen here.
import { randomUUID } from "node:crypto";
import type { PendingAction } from "@morphix/shared";
import { MESHY_PREVIEW_CREDITS, MESHY_REFINE_CREDITS } from "@morphix/meshy";
import { type Ctx, latestVersion, now } from "./context";
import type { Generation } from "./generation";

const EXPIRY_MS = 10 * 60 * 1000;

export interface CostConfig {
  usingMeshy: () => boolean;
  meshyModel: string;
  dailyLimit: number;
}

export class PolicyError extends Error {}

export interface PrintHook {
  proposal(jobId: string): Omit<PendingAction, "id" | "createdAt">;
  start(jobId: string, approvedBy: "touch" | "voice"): Promise<void>;
}

export class Actions {
  private pending: PendingAction | null = null;
  /** For custom proposals (photo jobs): what to run once confirmed. */
  private onConfirm: ((source: "touch" | "voice" | "portal") => void) | null = null;
  private onCancel: (() => void) | null = null;
  printer: PrintHook | null = null;

  constructor(private ctx: Ctx, private generation: Generation, private cost: CostConfig) {}

  get current(): PendingAction | null {
    if (this.pending && Date.now() - Date.parse(this.pending.createdAt) > EXPIRY_MS) this.clear();
    return this.pending;
  }

  previewCredits(): number {
    return this.cost.usingMeshy() ? (MESHY_PREVIEW_CREDITS[this.cost.meshyModel] ?? 20) : 0;
  }

  private checkBudget(): void {
    if (!this.cost.usingMeshy()) return;
    const used = this.ctx.db.meshyTasksToday();
    if (used >= this.cost.dailyLimit) {
      throw new PolicyError(`Daily Meshy limit reached (${this.cost.dailyLimit} jobs). Change MORPHIX_MESHY_DAILY_LIMIT to allow more.`);
    }
    if (this.generation.busy) throw new PolicyError("A model is already being generated. Wait for it to finish.");
  }

  private set(action: Omit<PendingAction, "id" | "createdAt">): PendingAction {
    this.pending = { ...action, id: randomUUID(), createdAt: now() };
    this.ctx.event({ type: "pending", action: this.pending });
    this.ctx.log.write("info", "action proposed", { kind: action.kind, credits: action.credits, title: action.title });
    return this.pending;
  }

  clear(): void {
    const cancel = this.onCancel;
    this.onConfirm = null;
    this.onCancel = null;
    if (this.pending && cancel) cancel();
    this.pending = null;
    this.ctx.event({ type: "pending", action: null });
  }

  proposeGenerate(prompt: string, title: string, projectId: string | null = null): PendingAction {
    const p = prompt.trim().slice(0, 800);
    if (!p) throw new PolicyError("missing prompt");
    this.checkBudget();
    return this.set({ kind: "generate", title: title.trim().slice(0, 60) || p.slice(0, 60), prompt: p, projectId, versionId: null, credits: this.previewCredits() });
  }

  proposeRefine(versionId: string | null): PendingAction {
    const v = versionId
      ? this.ctx.db.get("SELECT * FROM model_versions WHERE id = ?", [versionId])
      : latestVersion(this.ctx, this.ctx.currentProjectId);
    if (!v) throw new PolicyError("there is no model to refine yet");
    if (v.source !== "meshy" || v.kind !== "preview" || !v.remote_task_id) {
      throw new PolicyError("only Meshy preview models can be refined");
    }
    this.checkBudget();
    const project = this.ctx.db.get("SELECT title, prompt FROM projects WHERE id = ?", [v.project_id]);
    return this.set({
      kind: "refine", title: String(project?.title ?? "model"), prompt: String(project?.prompt ?? ""),
      projectId: String(v.project_id), versionId: String(v.id), credits: MESHY_REFINE_CREDITS,
    });
  }

  /** Any other paid/important action (e.g. a photo-to-model job). Runs `run` only after confirmation. */
  proposeCustom(action: Omit<PendingAction, "id" | "createdAt">, run: (source: "touch" | "voice" | "portal") => void, onCancel?: () => void): PendingAction {
    if (action.credits > 0) this.checkBudget();
    const p = this.set(action);
    this.onConfirm = run;
    this.onCancel = onCancel ?? null;
    return p;
  }

  proposePrint(jobId: string): PendingAction {
    if (!this.printer) throw new PolicyError("printing is not available");
    try {
      return this.set(this.printer.proposal(jobId));
    } catch (e) {
      throw new PolicyError((e as Error).message);
    }
  }

  /** Starts the pending job. `source` records how the user approved it. */
  confirm(id: string, source: "touch" | "voice" | "portal"): { projectId: string; taskId: string; action: PendingAction; printing?: Promise<void> } {
    const action = this.current;
    if (!action || action.id !== id) throw new PolicyError("nothing is waiting for confirmation");
    if (this.onConfirm) {
      const run = this.onConfirm;
      this.onConfirm = null;
      this.onCancel = null;
      this.pending = null;
      this.ctx.event({ type: "pending", action: null });
      this.ctx.log.write("info", "action confirmed", { kind: action.kind, credits: action.credits, source });
      run(source);
      return { projectId: action.projectId ?? "", taskId: "", action };
    }
    if (action.kind === "print") {
      if (!this.printer || !action.jobId) throw new PolicyError("printing is not available");
      this.pending = null;
      this.ctx.event({ type: "pending", action: null });
      this.ctx.log.write("info", "print approved", { jobId: action.jobId, file: action.fileName, source });
      return { projectId: action.projectId ?? "", taskId: "", action, printing: this.printer.start(action.jobId, source === "voice" ? "voice" : "touch") };
    }
    this.checkBudget();
    this.pending = null;
    this.ctx.event({ type: "pending", action: null });
    this.ctx.log.write("info", "action confirmed", { kind: action.kind, credits: action.credits, source });
    const started =
      action.kind === "refine"
        ? this.generation.start({ projectId: action.projectId, prompt: action.prompt, title: action.title, kind: "refine", parentVersionId: action.versionId })
        : this.generation.start({ projectId: action.projectId, prompt: action.prompt, title: action.title, kind: "preview" });
    return { ...started, action };
  }
}
