// Types and the IPC contract shared by the Electron main process and the React renderer.
import type { WorkflowState } from "@morphix/domain";

export type { WorkflowState };

export interface Project {
  id: string;
  title: string;
  prompt: string;
  state: WorkflowState;
  createdAt: string;
  updatedAt: string;
  latestVersionId: string | null;
  thumbnailUrl: string | null;
}

export interface ModelVersion {
  id: string;
  projectId: string;
  version: number;
  source: "demo" | "meshy" | "openscad" | "scan" | "library";
  kind: "demo" | "preview" | "refine";
  format: "stl" | "glb";
  /** URL the renderer can load (served by the local app server). */
  url: string;
  /** Printable STL for this version, when one exists. */
  stlUrl: string | null;
  thumbnailUrl: string | null;
  bytes: number;
  targetHeightMm: number | null;
  createdAt: string;
}

export interface GenerationProgress {
  taskId: string;
  projectId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  stage: string;
  error?: string;
  versionId?: string;
  thumbnailUrl?: string;
  kind?: "preview" | "refine" | "demo";
}

export interface PrinterTemps {
  nozzle?: { current: number; target: number };
  bed?: { current: number; target: number };
}

export interface PrinterStatus {
  online: boolean;
  checkedAt: string;
  error?: string;
  machine?: string;
  moveMode?: string;
  currentFile?: string;
  temps?: PrinterTemps;
  position?: Record<string, number>;
  progress?: number;
  layer?: [number, number];
}

export interface PrinterInfo {
  machineType?: string;
  machineName?: string;
  firmware?: string;
  serial?: string;
  buildVolume?: string;
}

export interface AssistantTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  audioUrl?: string;
  createdAt: string;
}

export type ModelSource = "printables" | "thingiverse" | "makerworld" | "github" | "other";

/** One verified design from Smart Model Search (the page was opened and checked by the Pi). */
export interface SmartModelResult {
  id: string;
  source: ModelSource;
  /** From the page itself (og:title), not the AI. */
  name: string;
  pageUrl: string;
  /** The page's own preview image (og:image). */
  imageUrl: string | null;
  /** The same image kept on the Pi, for the touchscreen. */
  thumbUrl: string | null;
  /** QR code of pageUrl, to open the page on a phone. */
  qrDataUrl: string | null;
  description: string;
  license: string | null;
  /** True only when the page (or Thingiverse's API) states the licence. */
  licenseVerified: boolean;
  creator: string | null;
  /** From the search; check against the page. */
  parts: string[];
  nonPrintedParts: string[];
  assembly: string[];
  printAsIs: boolean;
  /** Facts that show it has been printed; empty = no evidence, so never call it tested. */
  evidence: string[];
  /** Model files the source lists (Thingiverse API). */
  files: { name: string; sizeBytes: number }[];
  thingId?: string;
  /** GitHub repository holding the files. */
  repo?: { owner: string; repo: string; branch: string };
  /** How Morphix gets the files: Thingiverse API, GitHub, needs a Thingiverse key, or by hand. */
  download: "manual" | "thingiverse-api" | "github" | "needs-key";
}

/** A finished import from a library design, as the model page shows it. */
export interface LibraryManifest {
  source: string;
  sourceName: string;
  license: string | null;
  licenseVerified: boolean;
  creator: string | null;
  parts: { name: string; sizeMm: { x: number; y: number; z: number }; fits: boolean; plate: number | null }[];
  plates: string[][];
  /** Plate currently loaded as the model (1-based). */
  currentPlate: number;
  tooBig: string[];
  preserved: string[];
  nonPrintedParts: string[];
  assembly: string[];
  evidence: string[];
  warnings: string[];
}

/** Claude designing a part, live: the step, the attempt, its OpenSCAD and a preview of each render. */
export interface ClaudeDesignView {
  jobId: string;
  title: string;
  status: "working" | "done" | "failed" | "stopped";
  /** designing | rendering | checking | repairing | done */
  stage: string;
  detail: string;
  attempt: number;
  maxAttempts: number;
  /** The OpenSCAD of the current attempt (last 6000 characters). */
  scad: string | null;
  /** The latest rendered attempt (STL), for the live 3D preview. */
  previewUrl: string | null;
  startedAt: string;
  projectId?: string;
  error?: string;
}

/** Gemini's "Meshy, Claude or open source?" question, shown as buttons on the Make page. */
export interface EngineChoice { request: string; recommended: "meshy" | "claude" | "open_source"; reason: string; claudeAvailable: boolean; at: string; }

export interface SmartSearchState { id: string; query: string; status: "searching" | "ready" | "failed"; results: SmartModelResult[]; error?: string; selectedId?: string; /** More results are still on their way. */ more?: boolean; }

export interface RecordingResult {
  turn: AssistantTurn;
  reply: AssistantTurn;
  /** When the assistant proposes generating a model, the prompt it would send. */
  proposedPrompt?: string;
}

export interface AiStatus {
  assistant: "gemini-live" | "missing";
  geminiModel: string;
  generator: "meshy" | "missing";
  meshyModel: string;
  previewCredits: number;
  refineCredits: number;
  dailyLimit: number;
  usedToday: number;
}

export interface AppSettings {
  storageRoot: string;
  ai: AiStatus;
  printerHost: string;
  cameraStreamUrl: string;
  cameraSnapshotUrl: string;
  printerPollSeconds: number;
  demoMode: boolean;
  keys: Record<"gemini" | "meshy" | "claude", boolean>;
  printControlsEnabled: false;
}

export interface SystemInfo {
  version: string;
  platform: string;
  arch: string;
  storageRoot: string;
  freeBytes: number;
  totalBytes: number;
  logFile: string;
  uptimeSeconds: number;
}

/** An action that costs money or changes things; waits for the user's explicit OK. */
export interface PendingAction {
  id: string;
  kind: "generate" | "refine" | "print";
  /** Print jobs: the prepared job and the file that will be sent. */
  jobId?: string;
  fileName?: string;
  details?: string[];
  title: string;
  prompt: string;
  projectId: string | null;
  versionId: string | null;
  credits: number;
  createdAt: string;
}

export type VoiceEvent =
  | { type: "status"; state: "connecting" | "ready" | "thinking" | "speaking" | "idle" | "offline" }
  | { type: "user-text"; text: string }
  | { type: "assistant-text"; text: string }
  | { type: "audio"; pcm: ArrayBuffer; sampleRate: number }
  | { type: "interrupted" }
  /** A Print Guardian warning is about to be spoken: play the alert chime. */
  | { type: "alert" }
  | { type: "turn-complete"; user: AssistantTurn | null; assistant: AssistantTurn | null }
  | { type: "error"; message: string };

export type AppEvent =
  | { type: "pending"; action: PendingAction | null }
  | { type: "navigate"; page: "viewer" | "library" | "assistant" | "prepare" | "printer" | "control"; projectId?: string }
  | { type: "model-height"; versionId: string; heightMm: number }
  | { type: "notice"; level: "info" | "warn" | "error"; message: string; code?: string; hint?: string }
  | { type: "job"; job: JobView }
  | { type: "prepare-progress"; jobId: string; stage: string }
  | { type: "print-status"; status: PrintControlStatus }
  | { type: "smart-search"; state: SmartSearchState }
  | { type: "engine-choice"; choice: EngineChoice | null }
  | { type: "claude-design"; design: ClaudeDesignView }
  | { type: "guardian"; snapshot: GuardianView };

/** Progress of one pipeline (text→print, photo→print, prepare, print) for the progress bar. */
export interface JobView {
  id: string;
  kind: string;
  title: string;
  status: string;
  percent: number;
  currentStage: string | null;
  stages: { key: string; label: string; status: string; progress: number; detail?: string }[];
  error?: { code: string; title: string; hint: string } | null;
  updatedAt: string;
}

export type MachineCommand =
  | { cmd: "light"; on: boolean }
  | { cmd: "fan"; percent: number }
  | { cmd: "home" }
  | { cmd: "nozzle"; celsius: number }
  | { cmd: "bed"; celsius: number }
  | { cmd: "cooldown" }
  | { cmd: "motorsOff" }
  | { cmd: "stop" };

export interface MachineCapability {
  command: string;
  verified: boolean;
  enabled: boolean;
  allowedNow: boolean;
  reason?: string;
}

export interface PrepareSettings {
  layerHeightMm: number;
  infillPercent: number;
  supports: "none" | "auto" | "buildplate";
  /** Generic filament profile id ("pla", "petg", …). Default: the loaded filament. */
  filament?: string;
  /** One print speed for every layer, first layer included (mm/s, up to the printer's 600). Unset: profile speeds. */
  speedMmS?: number;
  /** Nozzle height above the bed for this slice (mm, -0.5 to 1). Unset: the printer profile's z_offset. */
  zOffsetMm?: number;
}

/** Slicer defaults the Prepare page shows ("Normal"). */
export interface SlicerDefaults {
  /** The printer profile's z_offset (mm). */
  zOffsetMm: number;
  minZOffsetMm: number;
  maxZOffsetMm: number;
}

/** Afinia QD330 maximum print speed (brochure: 600 mm/s). */
export const QD330_MAX_SPEED_MMS = 600;

/** A generic filament profile, as the touchscreen shows it. */
export interface FilamentInfo {
  id: string;
  label: string;
  blurb: string;
  nozzleC: number;
  bedC: number;
  /** Nozzle temperature for loading / unloading. */
  changeC: number;
  /** How fast this filament can melt (mm³/s): the slicer won't print faster than this allows. */
  maxVolumetricMm3S: number;
  notes: string[];
}

export interface FilamentState {
  /** What the user says is in the printer now. */
  loaded: string;
  list: FilamentInfo[];
}

export interface PrepareAdvice {
  slicer: string | null;
  layerHeightMm: number;
  infillPercent: number;
  supports: string;
  brim: boolean;
  reasons: string[];
  warnings: string[];
  source: "heuristic" | "gemini";
}

export interface PrepareSummary {
  jobId: string;
  projectId: string;
  versionId: string;
  createdAt: string;
  settings: PrepareSettings;
  ok: boolean;
  error?: string;
  size?: { x: number; y: number; z: number };
  fits?: boolean;
  upAxis?: string;
  repairs: string[];
  issues: string[];
  warnings: string[];
  slicer: { ok: boolean; name?: string; reason?: string; message?: string };
  estimates?: { printTimeS: number | null; filamentG: number | null; filamentMm: number | null; layerCount: number | null; source: string };
  gx: { ok: boolean; verified: boolean; fileName?: string; bytes?: number; reason?: string };
  previewUrl?: string | null;
  advice?: PrepareAdvice;
  errorCode?: string;
}

export interface PrintControlStatus {
  /** Printer control switched on by the operator (MORPHIX_PRINT_CONTROLS=1). */
  enabled: boolean;
  /** Generated .gx files may be sent (MORPHIX_GX_VERIFIED=1 after comparing with Afinia output). */
  gxVerified: boolean;
  job: {
    jobId?: string;
    fileName?: string;
    phase: string;
    progress: number;
    layer: [number, number];
    recovered: boolean;
    offline: boolean;
    /** Seconds since Morphix saw the print start (null after an app restart). */
    elapsedS?: number | null;
    /** Best guess of the time left, seconds (null when unknown). */
    remainingS?: number | null;
    /** The slicer's estimate for the whole print, seconds. */
    estimateS?: number | null;
  } | null;
  busy: string | null;
  lastMessage: string | null;
}

/** Plain-JSON view of the AI Print Guardian for the UI. */
export interface GuardianView {
  running: boolean;
  state: string;
  label: string;
  camera: string;
  cameraDetail?: string;
  worker: string;
  alert: { id: string; kind: string; state: string; score: number; openedAt: string; evidenceUrls: string[]; explanation?: string } | null;
  gemini: boolean;
  autoPause: boolean;
  pauseAvailable: boolean;
  /** Spoken warning waiting for "stop" / "keep printing" (voice or touch). */
  voice?: GuardianVoiceView | null;
}

export interface GuardianVoiceView {
  alertId: string;
  kind: string;
  problem: string;
  announcements: number;
  awaitingAnswer: boolean;
  lastSpokenBy: "gemini" | "local" | "none" | null;
  /** A test from Grown-ups: no printer commands are ever sent. */
  simulated: boolean;
}

export interface WifiNetwork {
  ssid: string;
  signal: number;
  security: string;
  inUse: boolean;
  saved: boolean;
}

export interface NetworkStatus {
  hostname: string;
  wifi: { device: string; state: string; ssid: string | null; ip: string | null; signal: number | null } | null;
  ethernet: { device: string; state: string; connection: string | null; ip: string | null } | null;
}

/** Everything the renderer may call. Exposed by preload as window.morphix. */
export interface MorphixApi {
  getSettings(): Promise<AppSettings>;
  getSystemInfo(): Promise<SystemInfo>;
  recentLogs(lines?: number): Promise<string[]>;
  log(level: "info" | "warn" | "error", message: string): void;

  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<{ project: Project; versions: ModelVersion[] } | null>;
  createProjectFromPrompt(prompt: string): Promise<{ project: Project; taskId: string } | { pending: PendingAction }>;
  setTargetHeight(versionId: string, heightMm: number | null): Promise<ModelVersion>;
  saveThumbnail(versionId: string, pngDataUrl: string): Promise<void>;
  onGenerationProgress(cb: (p: GenerationProgress) => void): () => void;

  submitRecording(pcm16: ArrayBuffer, sampleRate: number): Promise<RecordingResult>;
  sendText(text: string): Promise<RecordingResult>;
  conversation(): Promise<AssistantTurn[]>;
  smartSearch(query: string): Promise<SmartSearchState>;
  smartSearchState(): Promise<SmartSearchState | null>;
  selectSmartModel(id: string): Promise<SmartModelResult>;
  importSmartModel(resultId: string, files: { name: string; bytes: ArrayBuffer }[]): Promise<{ projectId: string; versionId: string; parts: string[]; warnings: string[] }>;
  /** Model files from this device (STL, 3MF, OBJ, PLY, GLB): a new project, no AI needed. */
  importModelFiles(files: { name: string; bytes: ArrayBuffer }[]): Promise<{ projectId: string; versionId: string; parts: string[]; warnings: string[] }>;
  /** Thingiverse results only (official API, needs THINGIVERSE_TOKEN). */
  downloadSmartModel(resultId: string): Promise<{ projectId: string; versionId: string; parts: string[]; warnings: string[] }>;
  /** Source, licence, parts, plates and assembly of an imported library model (null otherwise). */
  libraryManifest(versionId: string): Promise<LibraryManifest | null>;
  /** Load build plate N of a multi-plate library model as its current model. */
  libraryPlate(projectId: string, plate: number): Promise<{ versionId: string; manifest: LibraryManifest }>;

  printerStatus(): Promise<PrinterStatus>;
  printerInfo(): Promise<PrinterInfo>;
  onPrinterStatus(cb: (s: PrinterStatus) => void): () => void;

  /** Live voice (Gemini): send one push-to-talk utterance; replies stream via onVoiceEvent. */
  voiceTurn(pcm16: ArrayBuffer, sampleRate: number): Promise<void>;
  voiceText(text: string): Promise<void>;
  onVoiceEvent(cb: (e: VoiceEvent) => void): () => void;
  onAppEvent(cb: (e: AppEvent) => void): () => void;
  pendingAction(): Promise<PendingAction | null>;
  confirmAction(id: string): Promise<void>;
  cancelAction(id: string): Promise<void>;
  requestRefine(versionId: string): Promise<void>;
  meshyBalance(): Promise<{ balance: number } | { error: string }>;
  testGemini(): Promise<{ ok: boolean; message: string }>;

  /** settings "auto" = let the AI slicer advisor choose. */
  /** `speedMmS` (with "auto"): one speed for every layer; the agent slicer still picks the rest. */
  preparePrint(versionId: string, settings: PrepareSettings | "auto", opts?: { speedMmS?: number; zOffsetMm?: number }): Promise<PrepareSummary>;
  /** The printer profile's slicer defaults (Z offset…). */
  slicerDefaults(): Promise<SlicerDefaults>;
  machineCommand(command: MachineCommand): Promise<{ ok: boolean; message: string; code?: string }>;
  machineCapabilities(): Promise<MachineCapability[]>;
  jobs(): Promise<JobView[]>;
  latestPrintJob(projectId: string): Promise<PrepareSummary | null>;
  requestPrint(jobId: string): Promise<void>;
  printStatus(): Promise<PrintControlStatus>;
  pausePrint(): Promise<{ ok: boolean; message: string }>;
  resumePrint(): Promise<{ ok: boolean; message: string }>;
  filaments(): Promise<FilamentState>;
  setLoadedFilament(id: string): Promise<FilamentState>;
  /** Run the feeder: a tiny print job that heats and loads/unloads. */
  filamentJob(kind: "load" | "unload", filament?: string): Promise<{ ok: boolean; message: string }>;
  /** Tells Morphix which page is on screen, so the voice assistant can help with it. */
  uiPage(page: string): Promise<void>;
  cancelPrint(): Promise<{ ok: boolean; message: string }>;
  guardian(): Promise<GuardianView>;
  guardianCommand(cmd: "start" | "stop" | "requestPause" | "resolve" | "dismiss" | "resetBaseline"): Promise<GuardianView>;
  /** Answer the spoken print warning: same as saying "yes, stop it" / "no, keep printing". */
  guardianAnswer(decision: "stop" | "keep"): Promise<{ ok: boolean; message: string }>;
  /** Speak a pretend warning to test audio and answers. Never sends printer commands. */
  guardianSimulate(): Promise<{ ok: boolean; message: string }>;

  networkStatus(): Promise<NetworkStatus>;
  wifiScan(): Promise<WifiNetwork[]>;
  wifiConnect(ssid: string, password: string | null): Promise<{ ok: boolean; message: string }>;
  wifiForget(ssid: string): Promise<{ ok: boolean; message: string }>;
}

export { IPC } from "./ipc";

/** QD330 build volume as reported by the printer (M115: X 220, Y 220, Z 220). */
export const QD330_BUILD_VOLUME_MM = { x: 220, y: 220, z: 220 } as const;
export * from "./wire";
export { createHttpApi, RpcError, type HttpApiOptions } from "./http-client";
