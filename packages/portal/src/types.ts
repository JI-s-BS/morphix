// The contract between the web portal and the rest of Morphix.
// The portal never touches the database, Meshy, Gemini or the printer itself: every
// call goes through a PortalBackend that the Electron main process implements.
import type { Readable } from "node:stream";

export type Log = (line: string) => void;

/** A signed-in person. `isAdmin` comes from AUTH0_ADMIN_EMAILS, never from the browser. */
export interface PortalUser {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  isAdmin: boolean;
}

/** Extra things the UI may show about the signed-in person. Everything is optional. */
export interface PortalMe {
  displayName?: string;
  /** Meshy generations left today, if the backend tracks a daily limit. */
  generationsLeftToday?: number;
  /** Turn screens on/off. Missing = true. */
  features?: Partial<Record<"photo" | "text" | "printer" | "camera", boolean>>;
}

export interface PortalProject {
  id: string;
  title: string;
  prompt: string;
  /** Workflow state from @morphix/domain (e.g. "generated", "printing"). Shown as-is. */
  state: string;
  createdAt: string;
  updatedAt: string;
  latestVersionId: string | null;
  hasThumbnail: boolean;
}

export interface PortalModelVersion {
  id: string;
  version: number;
  kind: string;
  format: "stl" | "glb";
  bytes: number;
  targetHeightMm: number | null;
  createdAt: string;
  hasThumbnail: boolean;
}

export interface PortalProjectDetail extends PortalProject {
  versions: PortalModelVersion[];
}

/** A file on disk the portal may stream. It must live under `storageRoot`. */
export interface PortalFile {
  path: string;
  format: "stl" | "glb" | "png" | "jpg" | "webp";
}

export interface UploadedImage {
  /** Sanitised original file name (display only). */
  name: string;
  /** Detected from magic bytes, never from the browser's Content-Type. */
  mime: "image/jpeg" | "image/png" | "image/webp" | "image/heic";
  bytes: Buffer;
}

export interface UploadedScan {
  name: string;
  /** Detected from content + extension. */
  format: "obj" | "ply" | "stl" | "glb";
  size: number;
  /**
   * Temporary file under `<storageRoot>/portal/uploads`. Copy or move it before the
   * createPhotoRequest promise resolves: the portal deletes whatever is left afterwards.
   */
  path: string;
}

export interface Measurement {
  label: string;
  value: number;
  unit: "mm" | "cm" | "in";
}

export const REFERENCE_OBJECTS = ["none", "credit-card", "coin", "ruler", "phone"] as const;
export type ReferenceObject = (typeof REFERENCE_OBJECTS)[number];

export interface PhotoRequest {
  images: UploadedImage[];
  scan?: UploadedScan;
  description: string;
  measurements: Measurement[];
  referenceObject: ReferenceObject;
  user: PortalUser;
}

/** What the backend returns after accepting a request. The UI then follows the job over SSE. */
export interface RequestAccepted {
  jobId: string;
  projectId?: string;
}

/** A cost or print confirmation waiting for a human "yes". */
export interface PortalAction {
  id: string;
  kind: "generate" | "refine" | "print" | string;
  title: string;
  /** Plain-language lines such as "Uses 20 Meshy credits" or "Takes about 40 minutes". */
  details: string[];
  credits?: number;
  projectId?: string | null;
  createdAt: string;
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  jobId?: string;
}

export interface PortalErrorInfo {
  /** Morphix error code such as "MX-GEN-003" (from packages/errors). */
  code: string;
  message: string;
  /** "What to try" hint for the person, in friendly words. */
  hint?: string;
}

export interface JobStage {
  id: string;
  label: string;
  state: "pending" | "active" | "done" | "failed" | "skipped";
}

export interface JobEvent {
  jobId: string;
  status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  /** 0..100 */
  progress: number;
  /** Friendly label for the current step. */
  stage: string;
  stages?: JobStage[];
  message?: string;
  error?: PortalErrorInfo;
  projectId?: string;
  versionId?: string;
  /** Set while status is "waiting": the PortalAction the person must confirm. */
  actionId?: string;
  at: string;
}

export interface PortalPrinterStatus {
  online: boolean;
  /** Friendly state: "idle", "printing", "paused", "heating", "offline", ... */
  state: string;
  progress?: number;
  layer?: [number, number];
  currentFile?: string;
  temps?: { nozzle?: { current: number; target: number }; bed?: { current: number; target: number } };
  light?: boolean;
  fan?: number;
  /** False while MORPHIX_PRINT_CONTROLS is off; admin buttons are then shown disabled. */
  controlsEnabled: boolean;
  cameraAvailable: boolean;
  checkedAt: string;
  error?: string;
}

/** Commands the portal accepts; arguments are validated by the portal before the backend sees them. */
export type PrinterCommand =
  | { cmd: "light"; args: { on: boolean } }
  | { cmd: "fan"; args: { speed: number } }
  | { cmd: "home"; args: Record<string, never> }
  | { cmd: "pause"; args: Record<string, never> }
  | { cmd: "resume"; args: Record<string, never> }
  | { cmd: "cancel"; args: Record<string, never> }
  | { cmd: "temperature"; args: { heater: "nozzle" | "bed"; celsius: number } };

export interface CameraStream {
  /** e.g. "multipart/x-mixed-replace; boundary=boundarydonotcross" */
  contentType: string;
  stream: Readable;
}

export interface PortalBackend {
  me(user: PortalUser): Promise<PortalMe>;
  listProjects(user: PortalUser): Promise<PortalProject[]>;
  /** null = not found (404). */
  getProject(id: string, user: PortalUser): Promise<PortalProjectDetail | null>;
  /** Model file for the 3D viewer. null = not found. Must be inside storageRoot. */
  modelFile(versionId: string, user: PortalUser): Promise<PortalFile | null>;
  /** Optional thumbnail image for a version. */
  thumbnailFile?(versionId: string, user: PortalUser): Promise<PortalFile | null>;
  createPhotoRequest(req: PhotoRequest): Promise<RequestAccepted>;
  createTextRequest(prompt: string, user: PortalUser): Promise<RequestAccepted>;
  pendingActions(user: PortalUser): Promise<PortalAction[]>;
  confirmAction(id: string, user: PortalUser): Promise<ActionResult>;
  cancelAction(id: string, user: PortalUser): Promise<ActionResult>;
  /**
   * Subscribe to a job. Call onEvent with the current state right away, then on every change.
   * Return an unsubscribe function, or null when the job does not exist.
   */
  jobEvents(jobId: string, onEvent: (e: JobEvent) => void, user: PortalUser): (() => void) | null;
  printerStatus(user: PortalUser): Promise<PortalPrinterStatus>;
  /** Admins only (the portal checks). The backend must still honour MORPHIX_PRINT_CONTROLS. */
  printerCommand(command: PrinterCommand, user: PortalUser): Promise<ActionResult>;
  /** Live camera. Only ever called for signed-in users. null = camera unavailable. */
  cameraStream(user: PortalUser): Promise<CameraStream | null>;
}
