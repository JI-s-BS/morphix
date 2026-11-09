// Connects the Auth0 web portal (packages/portal) to the running app.
import { get as httpGet } from "node:http";
import type {
  ActionResult, CameraStream, JobEvent, PhotoRequest, PortalAction, PortalBackend, PortalFile, PortalMe, PortalPrinterStatus,
  PortalProject, PortalProjectDetail, PortalUser, PrinterCommand, RequestAccepted,
} from "@morphix/portal";
import type { Job } from "@morphix/jobs";
import type { PrinterStatus } from "@morphix/shared";
import { getErrorEntry } from "@morphix/errors";
import { safeId } from "@morphix/storage";
import type { Row } from "@morphix/database";
import type { Ctx } from "./context";
import type { Actions } from "./actions";
import type { Jobs } from "./jobs";
import type { PhotoPipeline } from "./photo";
import type { Printing } from "./printing";

export interface PortalDeps {
  ctx: Ctx;
  jobs: Jobs;
  actions: Actions;
  photo: PhotoPipeline;
  printing: Printing;
  printerStatus: () => PrinterStatus;
  cameraUrl: string;
  meshyReady: () => boolean;
  dailyLimit: number;
  startText: (prompt: string, owner: string, jobId: string) => void;
}

const STATUS: Record<string, JobEvent["status"]> = {
  pending: "queued", running: "running", waiting_for_user: "waiting", done: "succeeded", failed: "failed", cancelled: "cancelled", interrupted: "failed",
};
const STAGE_STATE: Record<string, "pending" | "active" | "done" | "failed" | "skipped"> = {
  pending: "pending", running: "active", waiting_for_user: "active", done: "done", skipped: "skipped", failed: "failed",
};

export function createPortalBackend(d: PortalDeps): PortalBackend {
  const { ctx } = d;
  const project = (r: Row): PortalProject => {
    const v = r.latest_version_id ? ctx.db.get("SELECT thumbnail_rel_path FROM model_versions WHERE id = ?", [r.latest_version_id]) : undefined;
    return {
      id: String(r.id), title: String(r.title), prompt: String(r.prompt), state: String(r.state),
      createdAt: String(r.created_at), updatedAt: String(r.updated_at),
      latestVersionId: r.latest_version_id ? String(r.latest_version_id) : null, hasThumbnail: Boolean(v?.thumbnail_rel_path),
    };
  };
  const toEvent = (j: Job): JobEvent => {
    const current = j.stages.find((s) => s.key === j.currentStage);
    const entry = j.error ? getErrorEntry(j.error.code) : undefined;
    const meta = (j.meta ?? {}) as { projectId?: string; versionId?: string };
    return {
      jobId: j.id,
      status: STATUS[j.status] ?? "running",
      progress: j.percent,
      stage: current?.detail ? `${current.label} — ${current.detail}` : (current?.label ?? j.title),
      stages: j.stages.map((s) => ({ id: s.key, label: s.label, state: STAGE_STATE[s.status] ?? "pending" })),
      message: current?.question?.prompt ?? undefined,
      error: j.error ? { code: j.error.code, message: entry?.title ?? j.error.title, hint: entry?.hint ?? j.error.hint } : undefined,
      projectId: meta.projectId,
      versionId: meta.versionId,
      actionId: j.status === "waiting_for_user" ? d.actions.current?.id : undefined,
      at: j.updatedAt,
    };
  };
  const action = (): PortalAction[] => {
    const p = d.actions.current;
    if (!p) return [];
    return [{
      id: p.id, kind: p.kind, title: p.title,
      details: p.details?.length ? p.details : [p.credits > 0 ? `Uses ${p.credits} Meshy credits` : "Free", p.prompt.slice(0, 160)],
      credits: p.credits, projectId: p.projectId, createdAt: p.createdAt,
    }];
  };

  return {
    async me(_user: PortalUser): Promise<PortalMe> {
      return {
        generationsLeftToday: Math.max(0, d.dailyLimit - ctx.db.meshyTasksToday()),
        features: { photo: true, text: true, printer: true, camera: true },
      };
    },
    async listProjects() {
      return ctx.db.all("SELECT * FROM projects ORDER BY updated_at DESC LIMIT 200").map(project);
    },
    async getProject(id: string): Promise<PortalProjectDetail | null> {
      const r = ctx.db.get("SELECT * FROM projects WHERE id = ?", [safeId(id)]);
      if (!r) return null;
      const versions = ctx.db.all("SELECT * FROM model_versions WHERE project_id = ? ORDER BY version DESC", [id]).map((v) => ({
        id: String(v.id), version: Number(v.version), kind: String(v.kind ?? "preview"), format: String(v.format) as "stl" | "glb",
        bytes: Number(v.bytes), targetHeightMm: v.target_height_mm == null ? null : Number(v.target_height_mm),
        createdAt: String(v.created_at), hasThumbnail: Boolean(v.thumbnail_rel_path),
      }));
      return { ...project(r), versions };
    },
    async modelFile(versionId: string): Promise<PortalFile | null> {
      const v = ctx.db.get("SELECT rel_path, format FROM model_versions WHERE id = ?", [safeId(versionId)]);
      return v ? { path: ctx.storage.path(String(v.rel_path)), format: String(v.format) as "stl" | "glb" } : null;
    },
    async thumbnailFile(versionId: string): Promise<PortalFile | null> {
      const v = ctx.db.get("SELECT thumbnail_rel_path FROM model_versions WHERE id = ?", [safeId(versionId)]);
      return v?.thumbnail_rel_path ? { path: ctx.storage.path(String(v.thumbnail_rel_path)), format: "png" } : null;
    },
    async createPhotoRequest(req: PhotoRequest): Promise<RequestAccepted> {
      const r = d.photo.start({
        images: req.images.map((i) => ({ name: i.name, mime: i.mime, bytes: i.bytes })),
        scan: req.scan ? { name: req.scan.name, format: req.scan.format, path: req.scan.path } : undefined,
        description: req.description,
        measurements: req.measurements,
        referenceObject: req.referenceObject,
        owner: req.user.sub,
      });
      ctx.log.write("info", "portal photo request", { user: req.user.email, images: req.images.length, scan: Boolean(req.scan) });
      return { jobId: r.jobId };
    },
    async createTextRequest(prompt: string, user: PortalUser): Promise<RequestAccepted> {
      if (!d.meshyReady()) throw new Error("Meshy is not configured. Add MESHY_API_KEY to ~/Morphix/config/morphix.env and restart Morphix.");
      const job = d.jobs.create("text-to-print", prompt.slice(0, 60), user.sub, {}, { print: false });
      d.jobs.wait(job.id, "understand", "Waiting for your OK to use Meshy credits");
      try {
        d.startText(prompt, user.sub, job.id);
      } catch (e) {
        d.jobs.fail(job.id, "understand", e, "MX-GEN-001");
        throw e;
      }
      return { jobId: job.id };
    },
    async pendingActions() {
      return action();
    },
    async confirmAction(id: string, user: PortalUser): Promise<ActionResult> {
      try {
        const r = d.actions.confirm(id, "portal");
        ctx.log.write("info", "portal confirmed action", { user: user.email, kind: r.action.kind });
        return { ok: true, message: "Started!" };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    async cancelAction(id: string): Promise<ActionResult> {
      if (d.actions.current?.id === id) d.actions.clear();
      return { ok: true };
    },
    jobEvents(jobId: string, onEvent: (e: JobEvent) => void): (() => void) | null {
      const j = d.jobs.manager.get(jobId);
      if (!j) return null;
      onEvent(toEvent(j));
      return d.jobs.manager.subscribe(jobId, (ev) => onEvent(toEvent(ev.job)));
    },
    async printerStatus(): Promise<PortalPrinterStatus> {
      const s = d.printerStatus();
      const ctl = d.printing.status();
      const heating = (s.temps?.nozzle?.target ?? 0) > 0 || (s.temps?.bed?.target ?? 0) > 0;
      const state = !s.online ? "offline" : ctl.job?.phase === "paused" ? "paused" : s.machine === "BUILDING_FROM_SD" ? "printing" : heating ? "heating" : "idle";
      return {
        online: s.online, state, progress: s.progress, layer: s.layer, currentFile: s.currentFile,
        temps: s.temps, controlsEnabled: ctl.enabled, cameraAvailable: s.online, checkedAt: s.checkedAt, error: s.error,
      };
    },
    async printerCommand(c: PrinterCommand, user: PortalUser): Promise<ActionResult> {
      ctx.log.write("info", "portal printer command", { user: user.email, cmd: c.cmd });
      switch (c.cmd) {
        case "pause":
          return d.printing.pause();
        case "cancel":
          return d.printing.cancel();
        case "resume":
          return { ok: false, message: "Resume from the touchscreen (it needs a fresh confirmation)." };
        case "light":
          return d.printing.machine({ cmd: "light", on: c.args.on }, "portal");
        case "fan":
          return d.printing.machine({ cmd: "fan", percent: c.args.speed }, "portal");
        case "home":
          return d.printing.machine({ cmd: "home" }, "portal");
        case "temperature":
          return d.printing.machine({ cmd: c.args.heater, celsius: c.args.celsius }, "portal");
      }
    },
    cameraStream(): Promise<CameraStream | null> {
      return new Promise((resolve) => {
        const req = httpGet(d.cameraUrl, { timeout: 5000 }, (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            resolve(null);
            return;
          }
          resolve({ contentType: String(res.headers["content-type"] ?? "multipart/x-mixed-replace"), stream: res });
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => {
          req.destroy();
          resolve(null);
        });
      });
    },
  };
}
