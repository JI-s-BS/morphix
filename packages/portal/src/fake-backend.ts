// In-memory PortalBackend for tests and the local demo. Simulates jobs with stages,
// a cost confirmation, error codes, a printer and an MJPEG camera. Never talks to hardware.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type {
  ActionResult,
  CameraStream,
  JobEvent,
  JobStage,
  PhotoRequest,
  PortalAction,
  PortalBackend,
  PortalFile,
  PortalMe,
  PortalPrinterStatus,
  PortalProject,
  PortalProjectDetail,
  PortalUser,
  PrinterCommand,
  RequestAccepted,
} from "./types";

/** 1×1 grey JPEG used as camera frames. */
export const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

export function cubeStl(size = 20): string {
  const s = size;
  const v = [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
  ];
  const faces: [number, number, number, number[]][] = [
    [0, 2, 1, [0, 0, -1]], [0, 3, 2, [0, 0, -1]], [4, 5, 6, [0, 0, 1]], [4, 6, 7, [0, 0, 1]],
    [0, 1, 5, [0, -1, 0]], [0, 5, 4, [0, -1, 0]], [2, 3, 7, [0, 1, 0]], [2, 7, 6, [0, 1, 0]],
    [1, 2, 6, [1, 0, 0]], [1, 6, 5, [1, 0, 0]], [0, 4, 7, [-1, 0, 0]], [0, 7, 3, [-1, 0, 0]],
  ];
  const lines = ["solid cube"];
  for (const [a, b, c, n] of faces) {
    lines.push(`facet normal ${n.join(" ")}`, "outer loop");
    for (const i of [a, b, c]) lines.push(`vertex ${v[i].join(" ")}`);
    lines.push("endloop", "endfacet");
  }
  lines.push("endsolid cube");
  return lines.join("\n") + "\n";
}

const STAGES: [string, string][] = [
  ["upload", "Got your photos 📸"],
  ["look", "Looking closely 👀"],
  ["size", "Working out the size 📏"],
  ["generate", "Building the 3D model 🧱"],
  ["prepare", "Getting it ready to print 🖨️"],
];

interface FakeJob {
  event: JobEvent;
  listeners: Set<(e: JobEvent) => void>;
  stageIndex: number;
  fail: boolean;
  title: string;
  timer?: NodeJS.Timeout;
}

export interface FakeBackendOptions {
  storageRoot: string;
  /** Milliseconds between simulated job steps. 0 = only advance via advanceAll(). */
  tickMs?: number;
  /** Ask for a cost confirmation before generating (default true). */
  confirmCost?: boolean;
  printControlsEnabled?: boolean;
  cameraFrameMs?: number;
}

export class FakeBackend implements PortalBackend {
  readonly photoRequests: PhotoRequest[] = [];
  readonly textRequests: { prompt: string; user: PortalUser }[] = [];
  readonly commands: { command: PrinterCommand; user: PortalUser }[] = [];
  readonly projects = new Map<string, PortalProjectDetail>();
  readonly files = new Map<string, PortalFile>();
  readonly actions = new Map<string, PortalAction & { jobId: string }>();
  readonly jobs = new Map<string, FakeJob>();
  cameraEnabled = true;
  private seq = 0;
  private printer: PortalPrinterStatus;
  private readonly dir: string;

  constructor(private readonly opts: FakeBackendOptions) {
    this.dir = join(opts.storageRoot, "portal-demo");
    mkdirSync(this.dir, { recursive: true });
    this.printer = {
      online: true,
      state: "printing",
      progress: 42,
      layer: [84, 200],
      currentFile: "happy-cube.gx",
      temps: { nozzle: { current: 209, target: 210 }, bed: { current: 59, target: 60 } },
      light: true,
      fan: 100,
      controlsEnabled: opts.printControlsEnabled ?? false,
      cameraAvailable: true,
      checkedAt: new Date().toISOString(),
    };
    this.addProject("Happy cube", "a little cube to test the printer");
  }

  private id(prefix: string): string {
    return `${prefix}${++this.seq}${Math.random().toString(36).slice(2, 8)}`;
  }

  addProject(title: string, prompt: string): PortalProjectDetail {
    const pid = this.id("p");
    const vid = this.id("v");
    const path = join(this.dir, `${vid}.stl`);
    writeFileSync(path, cubeStl());
    this.files.set(vid, { path, format: "stl" });
    const now = new Date().toISOString();
    const project: PortalProjectDetail = {
      id: pid,
      title,
      prompt,
      state: "generated",
      createdAt: now,
      updatedAt: now,
      latestVersionId: vid,
      hasThumbnail: false,
      versions: [{ id: vid, version: 1, kind: "preview", format: "stl", bytes: cubeStl().length, targetHeightMm: 20, createdAt: now, hasThumbnail: false }],
    };
    this.projects.set(pid, project);
    return project;
  }

  async me(user: PortalUser): Promise<PortalMe> {
    return { displayName: user.name, generationsLeftToday: 12, features: { photo: true, text: true, printer: true, camera: this.cameraEnabled } };
  }

  async listProjects(): Promise<PortalProject[]> {
    return [...this.projects.values()].map(({ versions: _v, ...p }) => p).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getProject(id: string): Promise<PortalProjectDetail | null> {
    return this.projects.get(id) ?? null;
  }

  async modelFile(versionId: string): Promise<PortalFile | null> {
    return this.files.get(versionId) ?? null;
  }

  async createPhotoRequest(req: PhotoRequest): Promise<RequestAccepted> {
    this.photoRequests.push(req);
    return { jobId: this.startJob(req.description || "Photo model", /fail/i.test(req.description)) };
  }

  async createTextRequest(prompt: string, user: PortalUser): Promise<RequestAccepted> {
    this.textRequests.push({ prompt, user });
    return { jobId: this.startJob(prompt, /fail/i.test(prompt)) };
  }

  private stages(job: FakeJob): JobStage[] {
    return STAGES.map(([id, label], i) => ({
      id,
      label,
      state: i < job.stageIndex ? "done" : i === job.stageIndex ? (job.event.status === "failed" ? "failed" : job.event.status === "succeeded" ? "done" : "active") : "pending",
    }));
  }

  private emit(job: FakeJob, patch: Partial<JobEvent>): void {
    job.event = { ...job.event, ...patch, at: new Date().toISOString() };
    job.event.stages = this.stages(job);
    for (const l of job.listeners) l(job.event);
  }

  private startJob(title: string, fail: boolean): string {
    const jobId = this.id("j");
    const job: FakeJob = {
      event: { jobId, status: "queued", progress: 0, stage: STAGES[0][1], at: new Date().toISOString() },
      listeners: new Set(),
      stageIndex: 0,
      fail,
      title: title.slice(0, 60),
    };
    this.jobs.set(jobId, job);
    this.emit(job, { status: "running" });
    this.schedule(job);
    return jobId;
  }

  private schedule(job: FakeJob): void {
    if (!this.opts.tickMs) return;
    job.timer = setTimeout(() => {
      this.step(job);
      if (job.event.status === "running") this.schedule(job);
    }, this.opts.tickMs);
  }

  /** Move every running job one step (for tests with tickMs = 0). */
  advanceAll(): void {
    for (const job of this.jobs.values()) if (job.event.status === "running") this.step(job);
  }

  private step(job: FakeJob): void {
    const stageId = STAGES[job.stageIndex]?.[0];
    if (stageId === "generate" && job.fail) {
      this.emit(job, {
        status: "failed",
        error: { code: "MX-GEN-003", message: "The model maker couldn't finish this one.", hint: "Try photos with more light, from a few more sides, or describe it in a few more words." },
      });
      return;
    }
    if (stageId === "size" && (this.opts.confirmCost ?? true) && !job.event.actionId) {
      const actionId = this.id("a");
      this.actions.set(actionId, {
        id: actionId,
        jobId: job.event.jobId,
        kind: "generate",
        title: `Make “${job.title}”?`,
        details: ["Uses 20 Meshy credits", "Takes about 3 minutes"],
        credits: 20,
        projectId: null,
        createdAt: new Date().toISOString(),
      });
      this.emit(job, { status: "waiting", actionId, message: "Waiting for a yes ✋" });
      return;
    }
    job.stageIndex++;
    if (job.stageIndex >= STAGES.length) {
      job.stageIndex = STAGES.length - 1;
      const project = this.addProject(job.title, job.title);
      this.emit(job, { status: "succeeded", progress: 100, stage: "All done! 🎉", projectId: project.id, versionId: project.latestVersionId!, message: undefined });
      return;
    }
    this.emit(job, { progress: Math.round((job.stageIndex / STAGES.length) * 100), stage: STAGES[job.stageIndex][1] });
  }

  async pendingActions(): Promise<PortalAction[]> {
    return [...this.actions.values()].map(({ jobId: _j, ...a }) => a);
  }

  async confirmAction(id: string): Promise<ActionResult> {
    const action = this.actions.get(id);
    if (!action) return { ok: false, message: "Already answered" };
    this.actions.delete(id);
    const job = this.jobs.get(action.jobId);
    if (job) {
      job.stageIndex++;
      this.emit(job, { status: "running", actionId: undefined, message: undefined, stage: STAGES[job.stageIndex][1], progress: Math.round((job.stageIndex / STAGES.length) * 100) });
      this.schedule(job);
    }
    return { ok: true, jobId: action.jobId };
  }

  async cancelAction(id: string): Promise<ActionResult> {
    const action = this.actions.get(id);
    if (!action) return { ok: false, message: "Already answered" };
    this.actions.delete(id);
    const job = this.jobs.get(action.jobId);
    if (job) this.emit(job, { status: "cancelled", actionId: undefined, message: "Stopped. Nothing was spent." });
    return { ok: true };
  }

  jobEvents(jobId: string, onEvent: (e: JobEvent) => void): (() => void) | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    job.listeners.add(onEvent);
    onEvent(job.event);
    return () => job.listeners.delete(onEvent);
  }

  async printerStatus(): Promise<PortalPrinterStatus> {
    if (this.printer.state === "printing" && this.printer.progress !== undefined) {
      this.printer.progress = Math.min(100, this.printer.progress + 1);
      this.printer.layer = [Math.round((this.printer.progress / 100) * 200), 200];
    }
    return { ...this.printer, checkedAt: new Date().toISOString() };
  }

  async printerCommand(command: PrinterCommand, user: PortalUser): Promise<ActionResult> {
    this.commands.push({ command, user });
    if (!this.printer.controlsEnabled && command.cmd !== "light") return { ok: false, message: "Printer controls are switched off (MORPHIX_PRINT_CONTROLS)." };
    switch (command.cmd) {
      case "light":
        this.printer.light = command.args.on;
        break;
      case "fan":
        this.printer.fan = command.args.speed;
        break;
      case "pause":
        this.printer.state = "paused";
        break;
      case "resume":
        this.printer.state = "printing";
        break;
      case "cancel":
        this.printer.state = "idle";
        this.printer.progress = undefined;
        break;
      default:
        break;
    }
    return { ok: true };
  }

  async cameraStream(): Promise<CameraStream | null> {
    if (!this.cameraEnabled) return null;
    const boundary = "morphixframe";
    const frameMs = this.opts.cameraFrameMs ?? 500;
    let timer: NodeJS.Timeout | undefined;
    const stream = new Readable({
      read() {
        if (timer) return;
        const push = () => {
          this.push(Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${TINY_JPEG.length}\r\n\r\n`), TINY_JPEG, Buffer.from("\r\n")]));
        };
        push();
        timer = setInterval(push, frameMs);
      },
      destroy(err, cb) {
        clearInterval(timer);
        cb(err);
      },
    });
    return { contentType: `multipart/x-mixed-replace; boundary=${boundary}`, stream };
  }

  /** Stop timers (tests). */
  close(): void {
    for (const job of this.jobs.values()) clearTimeout(job.timer);
  }
}
