// Shared services for the main-process modules.
import type { AppEvent, ModelVersion, Project } from "@morphix/shared";
import type { WorkflowState } from "@morphix/domain";
import { transition, canTransition } from "@morphix/domain";
import type { Logger, Storage } from "@morphix/storage";
import type { MorphixDb, Row } from "@morphix/database";

export interface Ctx {
  db: MorphixDb;
  storage: Storage;
  log: Logger;
  send(channel: string, payload: unknown): void;
  event(e: AppEvent): void;
  url(rel: string | null | undefined): string | null;
  /** Project the user is looking at / working on (for voice commands). */
  currentProjectId: string | null;
}

export const now = () => new Date().toISOString();

export function toProject(ctx: Ctx, r: Row): Project {
  const thumb = r.latest_version_id
    ? ctx.db.get("SELECT thumbnail_rel_path FROM model_versions WHERE id = ?", [r.latest_version_id])
    : undefined;
  return {
    id: String(r.id),
    title: String(r.title),
    prompt: String(r.prompt),
    state: r.state as WorkflowState,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    latestVersionId: r.latest_version_id ? String(r.latest_version_id) : null,
    thumbnailUrl: ctx.url(thumb?.thumbnail_rel_path as string | undefined),
  };
}

export function toVersion(ctx: Ctx, r: Row): ModelVersion {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    version: Number(r.version),
    source: r.source as ModelVersion["source"],
    kind: (r.kind as ModelVersion["kind"]) ?? "demo",
    format: r.format as ModelVersion["format"],
    url: ctx.url(String(r.rel_path))!,
    stlUrl: ctx.url(r.stl_rel_path as string | null),
    thumbnailUrl: ctx.url(r.thumbnail_rel_path as string | null),
    bytes: Number(r.bytes),
    targetHeightMm: r.target_height_mm == null ? null : Number(r.target_height_mm),
    createdAt: String(r.created_at),
  };
}

/**
 * Move a project to `to`, stepping back to "reviewing" first when the direct
 * transition isn't allowed (e.g. sizing -> generating for a revision).
 * Printer states stay blocked by the domain rules.
 */
export function moveProject(ctx: Ctx, id: string, to: WorkflowState): void {
  const r = ctx.db.get("SELECT state FROM projects WHERE id = ?", [id]);
  if (!r) throw new Error("project not found");
  let state = r.state as WorkflowState;
  if (state === to) return;
  if (!canTransition(state, to) && canTransition(state, "reviewing") && canTransition("reviewing", to)) {
    state = transition(state, "reviewing");
  }
  const next = transition(state, to, { printControlsEnabled: false });
  ctx.db.run("UPDATE projects SET state = ?, updated_at = ? WHERE id = ?", [next, now(), id]);
}

export function latestVersion(ctx: Ctx, projectId: string | null): Row | undefined {
  if (!projectId) return undefined;
  return ctx.db.get("SELECT * FROM model_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1", [projectId]);
}
