// Morphix core: everything the app does, with no screen and no Electron. It builds the modules
// (database, printing, voice, generation, search, guardian, self-healing) and registers every
// MorphixApi handler in a HandlerRegistry. apps/server serves the registry over HTTP + SSE;
// the optional Electron kiosk (apps/desktop/electron/main.ts) serves the same registry over IPC.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { arch, platform } from "node:os";

import { IPC, type AppEvent, type AppSettings, type MachineCommand, type PrinterStatus } from "@morphix/shared";
import { SECRET_KEYS, type ConfigStore, type MorphixConfig } from "@morphix/config";
import { Logger, Storage, safeId } from "@morphix/storage";
import { MorphixDb } from "@morphix/database";
import { PrinterObserver, type PrinterDriver } from "@morphix/printer";
import { MeshyClient, MeshyGenerator, MESHY_PREVIEW_CREDITS, MESHY_REFINE_CREDITS, type ModelGenerator } from "@morphix/meshy";
import { DEFAULT_LIVE_MODEL } from "@morphix/gemini";
import { NetworkManager } from "@morphix/network";
import { levelingPlan, type LevelingPlan } from "@morphix/slicing";
import { DEFAULT_SEARCH_MODEL, SmartModelSearch } from "@morphix/model-search";
import QRCode from "qrcode";
import { type Ctx, moveProject, now, toProject, toVersion } from "../../desktop/electron/context";
import { Generation, type FinishedInfo } from "../../desktop/electron/generation";
import { Actions, PolicyError } from "../../desktop/electron/actions";
import { VoiceController } from "../../desktop/electron/voice";
import { Printing } from "../../desktop/electron/printing";
import { Jobs } from "../../desktop/electron/jobs";
import { PhotoPipeline } from "../../desktop/electron/photo";
import { GuardianVoice } from "../../desktop/electron/guardian-voice";
import { LocalTts } from "../../desktop/electron/tts";
import { importLibraryModel, libraryManifest, useLibraryPlate } from "../../desktop/electron/library-import";
import { cadGeneratorFromEnv } from "../../desktop/electron/cad";
import { startBusyMarker } from "../../desktop/electron/busy";
import { appSelfHealDeps, installSelfHealing } from "../../desktop/electron/self-heal";
import { HandlerRegistry } from "./registry";
import { findPrinter } from "@morphix/catalog";
import type { SlicerAdapter } from "@morphix/slicing";
import { DriverControl, DriverObserver, resolveActivePrinter, type ActivePrinter } from "./printers";
import { createDriverSlicer, installedAdapters } from "./slicers";

export interface CoreOptions {
  /** Data dir (Storage root). */
  dataDir: string;
  /** Repository / install root (config/slicer-profiles, services/vision). */
  repoRoot: string;
  version: string;
  /** Setup module's store (packages/config). Without one, keys come from the environment only. */
  store?: ConfigStore | null;
  /** Overrides store.load() (tests). */
  config?: MorphixConfig | null;
  /** Test seam: replaces the driver registry lookup. */
  driverLookup?: (id: string) => PrinterDriver | undefined;
  /** Test seam: slicer adapters (default: packages/slicing's SLICERS). */
  slicers?: SlicerAdapter[];
  /** Test seam: how often / how long to wait for a driver print to report it started. */
  driverStartChecks?: { everyMs: number; times: number };
}

export interface Core {
  registry: HandlerRegistry;
  storage: Storage;
  log: Logger;
  version: string;
  active: ActivePrinter;
  /** Shared module context (database, storage, events). */
  ctx: Ctx;
  /** The printer camera's own addresses (proxied as /api/camera/*). */
  camera(): { stream: string | null; snapshot: string | null };
  /** Opens the database and starts polling. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

export function readVersion(repoRoot: string): string {
  try {
    return String(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function wav(pcm16: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm16.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([h, pcm16]);
}

const toBuffer = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : v instanceof ArrayBuffer ? Buffer.from(v) : ArrayBuffer.isView(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : Buffer.alloc(0));

export async function createCore(o: CoreOptions): Promise<Core> {
  const storage = new Storage(o.dataDir);
  storage.init();
  // Legacy key file (still read so existing Pi installs keep working); real env wins.
  loadEnvFile(storage.path("config", "morphix.env"));
  const log = new Logger(storage);
  const registry = new HandlerRegistry();
  const store = o.store ?? null;
  const config = o.config !== undefined ? o.config : store ? await store.load().catch(() => null) : null;
  // Keys saved on the setup page feed the modules that read process.env. Kept in memory only.
  if (store) {
    for (const k of SECRET_KEYS) {
      if (process.env[k]?.trim()) continue;
      const v = await store.getSecret(k).catch(() => undefined);
      if (v) process.env[k] = v;
    }
  }

  const env = (k: string) => (process.env[k] ?? "").trim();
  const has = (k: string) => env(k).length > 0;
  const feature = (k: keyof MorphixConfig["features"]) => config?.features?.[k] !== false;

  const active = await resolveActivePrinter(config, store, { lookup: o.driverLookup, deps: { log: (level, message, data) => log.write(level === "debug" ? "info" : level, `[driver] ${message}`, data) } });
  const driverMode = active.kind === "driver";
  const PRINTER_HOST = driverMode ? String(active.printer.connection.host ?? "") : env("MORPHIX_PRINTER_HOST") || "192.168.10.51";
  const CAMERA_BASE = `http://${PRINTER_HOST}:8080`;
  const POLL_SECONDS = Number(env("MORPHIX_PRINTER_POLL_SECONDS") || 5);
  const GEMINI_MODEL = env("MORPHIX_GEMINI_MODEL") || DEFAULT_LIVE_MODEL;
  const MESHY_MODEL = env("MORPHIX_MESHY_MODEL") || "meshy-6";
  const DAILY_LIMIT = Number(env("MORPHIX_MESHY_DAILY_LIMIT") || 15);
  // QD330 control stays behind its operator switches, and is never used while a driver printer is active.
  const PRINT_CONTROLS = !driverMode && env("MORPHIX_PRINT_CONTROLS") === "1";
  const GX_VERIFIED = env("MORPHIX_GX_VERIFIED") === "1";

  const meshy = feature("aiGeneration") && has("MESHY_API_KEY") ? new MeshyClient(env("MESHY_API_KEY"), MESHY_MODEL) : null;
  const generator: ModelGenerator | null = meshy ? new MeshyGenerator(meshy) : null;
  const network = new NetworkManager();
  const send = (channel: string, payload: unknown) => registry.emit(channel, payload);

  const ctx: Ctx = {
    db: null as unknown as MorphixDb, // set in start()
    storage,
    log,
    send,
    event: (e: AppEvent) => send(IPC.appEvent, e),
    // Same-origin relative URLs work for the browser and for the Electron window alike.
    url: (rel) => (rel ? `/library/${rel}` : null),
    currentProjectId: null,
  };
  const ALLOW_UNVERIFIED = new Set((env("MORPHIX_ALLOW_UNVERIFIED") || "").split(",").map((x) => x.trim()).filter(Boolean));
  const levelingFromEnv = (): LevelingPlan => {
    try {
      const leave = (env("MORPHIX_LEVELING") || "").trim().toLowerCase();
      return levelingPlan({ printerOnly: leave === "printer" || leave === "off", commandsText: env("MORPHIX_LEVEL_GCODE") });
    } catch (e) {
      log.write("error", "MORPHIX_LEVEL_GCODE refused; G29 levels the bed instead", { error: (e as Error).message });
      return levelingPlan();
    }
  };
  // A printer from the setup page: its driver, polled by DriverObserver, sliced for its catalog model.
  let driverObserver: DriverObserver | null = null;
  const model = active.kind === "driver" ? findPrinter(active.printer.modelId) : undefined;
  if (active.kind === "driver" && !model) log.write("warn", "printer model not in the catalog: printing from Morphix is off", { modelId: active.printer.modelId });
  const driverSlice = createDriverSlicer(o.slicers ?? installedAdapters(), { preferred: config?.slicer?.preferred, paths: config?.slicer?.paths });
  const target = active.kind === "driver" && model
    ? {
        name: active.printer.name,
        model,
        connection: active.connection,
        slice: driverSlice,
        state: async () => (driverObserver ? (await driverObserver.poll(), driverObserver.driverStatus) : null),
        lastState: () => driverObserver?.driverStatus ?? null,
        startChecks: o.driverStartChecks,
      }
    : undefined;
  const printing = new Printing(ctx, {
    target,
    repoRoot: o.repoRoot,
    printerHost: PRINTER_HOST || "127.0.0.1",
    controlsEnabled: PRINT_CONTROLS,
    gxVerified: GX_VERIFIED,
    pausedStatuses: (env("MORPHIX_PAUSED_STATUSES") || "PAUSED").split(",").map((x) => x.trim()).filter(Boolean),
    allowUnverified: {
      light: ALLOW_UNVERIFIED.has("light"),
      fan: ALLOW_UNVERIFIED.has("fan"),
      temperatures: ALLOW_UNVERIFIED.has("temperatures"),
      motors: ALLOW_UNVERIFIED.has("motors"),
    },
    // Default: every print levels the bed (G29 after homing, bed hot; the command is UNVERIFIED on
    // the QD330). MORPHIX_LEVELING=printer leaves it to the printer's own pre-print routine.
    leveling: levelingFromEnv(),
  });
  const jobs = new Jobs(ctx);
  printing.jobs = jobs;

  // The printer: a configured driver, or the QD330 (all its traffic through the controller's queue).
  const onPrinterStatus = (s: PrinterStatus, prev: PrinterStatus): void => {
    send(IPC.printerStatusEvent, s);
    try {
      if (driverMode) printing.onDriverStatus(driverObserver?.driverStatus ?? null);
      else printing.onPrinterStatus(s);
    } catch (e) {
      log.write("warn", "print tracking error", { error: (e as Error).message });
    }
    if (!ctx.db) return;
    if (s.online !== prev.online || s.machine !== prev.machine) {
      const kind = s.online ? `status:${s.machine ?? "unknown"}` : "offline";
      ctx.db.run("INSERT INTO printer_events(at, kind, detail) VALUES (?, ?, ?)", [now(), kind, s.error ?? s.currentFile ?? null]);
      log.write("info", `printer ${kind}`, s.error ? { error: s.error } : undefined);
    }
  };
  if (active.kind === "driver") driverObserver = new DriverObserver(active.connection, onPrinterStatus);
  const driverControl = active.kind === "driver" && driverObserver ? new DriverControl(active.connection, active.printer, driverObserver) : null;
  const printer: { readonly status: PrinterStatus; poll(): Promise<PrinterStatus>; start(ms: number): void; stop(): void; info(): Promise<import("@morphix/shared").PrinterInfo> } =
    driverObserver ?? new PrinterObserver(printing.controller.transport, onPrinterStatus);

  const onGenerationFinished = (info: FinishedInfo): void => {
    if (info.ok) {
      ctx.currentProjectId = info.projectId;
      ctx.event({ type: "navigate", page: "viewer", projectId: info.projectId });
      // Get it ready to print straight away (free; AI picks the settings), in the same progress job.
      void printing.prepare(info.versionId, "auto", info.jobId).catch((e) => log.write("warn", "auto-prepare failed", { error: (e as Error).message }));
      void voice.notify(
        info.kind === "refine"
          ? `The coloured version of "${info.title}" is ready on screen.`
          : `The model "${info.title}" finished generating and is on screen now. Tell the user and ask: "How big would you like it?"`,
      );
    } else {
      void voice.notify(`Generating "${info.title}" failed: ${info.error}. Apologise briefly and offer to try again.`);
    }
  };
  const NO_MESHY = "Meshy is not configured. Add the Meshy API key on the setup page (Settings → API keys).";
  const generation = new Generation(
    ctx,
    () => {
      if (!generator) throw new Error(NO_MESHY);
      return generator;
    },
    onGenerationFinished,
  );
  generation.jobs = jobs;
  const actions = new Actions(ctx, generation, { usingMeshy: () => meshy !== null, meshyModel: MESHY_MODEL, dailyLimit: DAILY_LIMIT });
  const photo = new PhotoPipeline(ctx, jobs, actions, printing);
  // Claude + headless OpenSCAD for parts that must fit or work (null until ANTHROPIC_API_KEY is set).
  photo.generateCad = cadGeneratorFromEnv();
  log.write("info", "claude cad", { available: photo.generateCad !== null });
  photo.onCadFinished = (r) => {
    if (r.ok) {
      ctx.currentProjectId = r.projectId;
      ctx.event({ type: "navigate", page: "viewer", projectId: r.projectId });
      void voice.notify(`Claude finished designing "${r.title}" and it's on screen now, at its exact size. Tell the user and say it's being got ready to print.`);
    } else {
      void voice.notify(`Claude couldn't design "${r.title}": ${r.error}. Apologise briefly and offer to try again or use another option.`);
    }
  };
  // Smart Model Search: real designs from model libraries before Meshy (see packages/model-search).
  const searchImages = new Map<string, string>(); // result id -> picture kept locally (relative path)
  const smartSearch: SmartModelSearch = new SmartModelSearch({
    apiKey: feature("modelSearch") && has("GEMINI_API_KEY") ? env("GEMINI_API_KEY") : undefined,
    model: env("MORPHIX_GEMINI_TEXT_MODEL") || DEFAULT_SEARCH_MODEL,
    thingiverseToken: env("THINGIVERSE_TOKEN") || undefined,
    onChange: (state) => {
      ctx.event({ type: "smart-search", state });
      if (state.status !== "searching") {
        log.write(state.status === "ready" ? "info" : "warn", "smart search", {
          query: state.query, status: state.status, error: state.error,
          results: state.results.map((r) => `${r.source} | ${r.name} | ${r.pageUrl} | img:${r.thumbUrl ? "yes" : "no"} | licence:${r.license ?? "-"}${r.licenseVerified ? " (verified)" : ""}`),
          imageErrors: smartSearch?.imageErrors,
          timing: smartSearch?.timing,
        });
      }
    },
    saveImage: (id, bytes, type) => {
      const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("gif") ? "gif" : "jpg";
      const abs = storage.path("previews", `search-${safeId(id)}.${ext}`);
      storage.writeAtomic(abs, bytes);
      const rel = storage.relative(abs);
      searchImages.set(id, rel);
      return ctx.url(rel);
    },
    qrFor: (url) => QRCode.toDataURL(url, { width: 220, margin: 1, color: { dark: "#071018", light: "#ffffff" } }),
  });

  /** Import files for a search result (downloaded by the user, or via the Thingiverse API). */
  const importSearchResult = (resultId: string, files: { name: string; bytes: Buffer }[]) => {
    const result = smartSearch.find(resultId);
    if (!result) throw new Error("That search result is no longer available — search again, then import.");
    smartSearch.select(resultId);
    const r = importLibraryModel(ctx, result, files, { thumbnailRel: searchImages.get(resultId) ?? null });
    ctx.currentProjectId = r.projectId;
    ctx.event({ type: "navigate", page: "viewer", projectId: r.projectId });
    return { projectId: r.projectId, versionId: r.versionId, parts: r.parts, warnings: r.warnings };
  };
  /** "Choose this one": download every model file through the site's supported route and import it. */
  const downloadSearchResult = async (resultId: string) => {
    smartSearch.select(resultId);
    return importSearchResult(resultId, await smartSearch.download(resultId));
  };
  actions.printer = {
    proposal: (jobId) => {
      if (driverMode && !target) throw new Error("Pick your printer's model on the setup page so Morphix can slice for it.");
      return printing.printProposal(jobId);
    },
    start: (jobId, by) => printing.startApprovedPrint(jobId, by),
  };
  const cancelPrint = () => {
    if (!driverControl) return printing.cancel();
    printing.noteCancelRequested();
    return driverControl.cancel();
  };
  const voice = new VoiceController(ctx, actions, {
    apiKey: feature("voice") && has("GEMINI_API_KEY") ? env("GEMINI_API_KEY") : undefined,
    model: GEMINI_MODEL,
    meshyBalance: async () => (meshy ? (await meshy.balance()).balance : null),
    printing: () => printing,
    smartSearch,
    downloadSearchResult: (id) => downloadSearchResult(id),
    claudeCad: () => (photo.generateCad ? (input) => photo.designFromText({ ...input, owner: "voice" }) : null),
    stopCad: () => photo.stopCad(),
  });

  // Spoken Print Guardian warnings: Gemini's voice, or espeak-ng when Gemini can't.
  const localTts = new LocalTts();
  const guardianVoice = new GuardianVoice({
    interrupt: () => voice.interruptForAlert(),
    speakGemini: (text) => voice.speakExact(text),
    speakLocal: async (text) => {
      if (!localTts.available) return false;
      const { pcm, sampleRate } = await localTts.synthesize(text);
      send(IPC.voiceEvent, { type: "audio", pcm: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength), sampleRate });
      voice.localSpeechContext(text);
      return true;
    },
    cancelPrint: () => cancelPrint(),
    keepPrinting: () => void printing.guardianCommand("dismiss"),
    resolveAlert: () => void printing.guardianCommand("resolve"),
    userBusy: () => voice.busy,
    onChange: () => ctx.event({ type: "guardian", snapshot: printing.view() }),
    log: (level, message, extra) => log.write(level, message, extra),
  });
  voice.guardianVoice = guardianVoice;
  printing.voiceInfo = () => guardianVoice.view();
  printing.guardian.onUpdate((snap) => guardianVoice.onAlert(printing.view(snap).alert));
  log.write("info", "spoken print warnings", { gemini: voice.enabled, localVoice: localTts.available });

  const settings = (): AppSettings => ({
    storageRoot: storage.root,
    ai: {
      assistant: voice.enabled ? "gemini-live" : "missing",
      geminiModel: GEMINI_MODEL,
      generator: meshy ? "meshy" : "missing",
      meshyModel: MESHY_MODEL,
      previewCredits: meshy ? (MESHY_PREVIEW_CREDITS[MESHY_MODEL] ?? 20) : 0,
      refineCredits: meshy ? MESHY_REFINE_CREDITS : 0,
      dailyLimit: DAILY_LIMIT,
      usedToday: ctx.db ? ctx.db.meshyTasksToday() : 0,
    },
    printerHost: PRINTER_HOST,
    cameraStreamUrl: "/api/camera/stream",
    cameraSnapshotUrl: "/api/camera/snapshot",
    printerPollSeconds: POLL_SECONDS,
    demoMode: false,
    keys: {
      gemini: has("GEMINI_API_KEY"),
      meshy: has("MESHY_API_KEY"),
      claude: has("ANTHROPIC_API_KEY"),
      // Removed integrations (always off; the fields stay until the Settings page drops them).
      vultr: false,
      tiger: false,
      swarms: false,
      auth0: false,
    },
    printControlsEnabled: false,
  });

  const camera = (): { stream: string | null; snapshot: string | null } => {
    if (active.kind === "driver") {
      const c = active.connection.capabilities().camera;
      if (!c) return { stream: null, snapshot: null };
      return { stream: c.kind === "mjpeg" ? c.url : null, snapshot: c.kind === "snapshot" ? c.url : null };
    }
    return { stream: `${CAMERA_BASE}/?action=stream`, snapshot: `${CAMERA_BASE}/?action=snapshot` };
  };

  const saveRecording = (pcm: Buffer, rate: number): string => {
    if (pcm.length > 16000 * 2 * 120) throw new Error("recording too long (2 minute limit)");
    const file = storage.path("cache", "recordings", `${randomUUID()}.wav`);
    storage.writeAtomic(file, wav(pcm, rate));
    return storage.relative(file);
  };
  const friendly = (e: unknown) => (e instanceof PolicyError ? e.message : (e as Error).message);

  /** Deletes the chat history and its voice recordings (run at start-up). */
  const clearConversation = (): { messages: number; recordings: number } => {
    const messages = Number(ctx.db.get("SELECT COUNT(*) AS n FROM conversation")?.n ?? 0);
    ctx.db.run("DELETE FROM conversation");
    ctx.db.flush();
    let recordings = 0;
    const dir = storage.path("cache", "recordings");
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".wav")) continue;
        rmSync(join(dir, f), { force: true });
        recordings++;
      }
    } catch {
      /* no recordings folder yet */
    }
    return { messages, recordings };
  };

  // -------------------------------------------------------------------------
  // Handlers: one per MorphixApi call (channel names from IPC in packages/shared).
  const handle = registry.handle.bind(registry);
  const db = () => ctx.db;

  handle(IPC.getSettings, () => settings());
  handle(IPC.getSystemInfo, () => ({
    version: o.version,
    platform: platform(),
    arch: arch(),
    storageRoot: storage.root,
    ...storage.disk(),
    logFile: log.file(),
    uptimeSeconds: Math.round(process.uptime()),
  }));
  handle(IPC.recentLogs, (lines?: number) => log.tail(Math.min(Number(lines) || 100, 500)));
  handle(IPC.log, (level: unknown, message: unknown) => {
    const l = level === "warn" || level === "error" ? level : "info";
    log.write(l, `[renderer] ${String(message).slice(0, 2000)}`);
  });

  handle(IPC.listProjects, () => db().all("SELECT * FROM projects ORDER BY updated_at DESC").map((r) => toProject(ctx, r)));
  handle(IPC.getProject, (id: string) => {
    const r = db().get("SELECT * FROM projects WHERE id = ?", [safeId(String(id))]);
    if (!r) return null;
    ctx.currentProjectId = String(id);
    return {
      project: toProject(ctx, r),
      versions: db().all("SELECT * FROM model_versions WHERE project_id = ? ORDER BY version DESC", [String(id)]).map((v) => toVersion(ctx, v)),
    };
  });
  handle(IPC.createProjectFromPrompt, (prompt: string) => {
    const text = String(prompt ?? "").trim().slice(0, 500);
    if (!text) throw new Error("describe what to make first");
    try {
      if (!meshy) throw new Error(NO_MESHY);
      return { pending: actions.proposeGenerate(text, text.slice(0, 60)) };
    } catch (e) {
      throw new Error(friendly(e));
    }
  });
  handle(IPC.setTargetHeight, (versionId: string, heightMm: number | null) => {
    // null / 0 = original size
    const h = heightMm == null || Number(heightMm) === 0 ? null : Number(heightMm);
    if (h !== null && !(h > 0 && h <= 1000)) throw new Error("height must be between 0 and 1000 mm");
    db().run("UPDATE model_versions SET target_height_mm = ? WHERE id = ?", [h, safeId(String(versionId))]);
    const r = db().get("SELECT * FROM model_versions WHERE id = ?", [String(versionId)]);
    if (!r) throw new Error("model not found");
    try {
      moveProject(ctx, String(r.project_id), "sizing");
    } catch {
      /* keep state */
    }
    return toVersion(ctx, r);
  });
  handle(IPC.saveThumbnail, (versionId: string, dataUrl: string) => {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!m) throw new Error("expected a PNG data URL");
    const png = Buffer.from(m[1], "base64");
    if (png.length > 5_000_000) throw new Error("thumbnail too large");
    const id = safeId(String(versionId));
    const existing = db().get("SELECT thumbnail_rel_path FROM model_versions WHERE id = ?", [id]);
    if (existing?.thumbnail_rel_path) return; // keep Meshy's own thumbnail
    const file = storage.path("previews", `${id}.png`);
    storage.writeAtomic(file, png);
    db().run("UPDATE model_versions SET thumbnail_rel_path = ? WHERE id = ?", [storage.relative(file), id]);
  });

  // Without a Gemini key there is no assistant (demo mode removed).
  const noGemini = () => {
    throw new Error("Gemini is not configured. Add the Gemini API key on the setup page (Settings → API keys).");
  };
  handle(IPC.submitRecording, noGemini);
  handle(IPC.sendText, noGemini);
  handle(IPC.conversation, () =>
    db()
      .all("SELECT * FROM conversation ORDER BY created_at DESC LIMIT 50")
      .reverse()
      .map((r) => ({
        id: String(r.id),
        role: r.role as "user" | "assistant",
        text: String(r.text),
        audioUrl: ctx.url(r.audio_rel_path as string | null) ?? undefined,
        createdAt: String(r.created_at),
      })),
  );
  handle(IPC.smartSearch, (query: string) => smartSearch.search(String(query ?? "")));
  handle(IPC.smartSearchState, () => smartSearch.state);
  handle(IPC.selectSmartModel, (id: string) => smartSearch.select(String(id)));
  handle(IPC.importSmartModel, (resultId: string, files: { name: string; bytes: ArrayBuffer }[]) => {
    if (!Array.isArray(files) || files.length > 200) throw new Error("choose between 1 and 200 files");
    return importSearchResult(String(resultId), files.map((f) => ({ name: String(f?.name), bytes: toBuffer(f?.bytes) })));
  });
  handle(IPC.downloadSmartModel, (resultId: string) => downloadSearchResult(String(resultId)));
  handle(IPC.libraryManifest, (versionId: string) => libraryManifest(ctx, safeId(String(versionId))));
  handle(IPC.libraryPlate, (projectId: string, plate: number) => {
    const r = useLibraryPlate(ctx, safeId(String(projectId)), Number(plate));
    ctx.event({ type: "navigate", page: "viewer", projectId: String(projectId) });
    return r;
  });

  // Gemini Live voice
  handle(IPC.voiceTurn, async (pcm: ArrayBuffer, sampleRate: number) => {
    const buf = toBuffer(pcm);
    if (Math.round(Number(sampleRate)) !== 16000) throw new Error("voice input must be 16 kHz");
    const rel = saveRecording(buf, 16000);
    try {
      await voice.utterance(buf, rel);
    } catch (e) {
      send(IPC.voiceEvent, { type: "error", message: friendly(e) });
      send(IPC.voiceEvent, { type: "status", state: "offline" });
    }
  });
  handle(IPC.voiceText, async (text: string) => {
    try {
      await voice.text(String(text ?? ""));
    } catch (e) {
      send(IPC.voiceEvent, { type: "error", message: friendly(e) });
    }
  });
  handle(IPC.pendingAction, () => actions.current);
  handle(IPC.confirmAction, (id: string) => {
    try {
      const r = actions.confirm(String(id), "touch");
      if (r.printing) {
        ctx.event({ type: "navigate", page: "printer" });
        r.printing.then(
          () => {
            ctx.event({ type: "notice", level: "info", message: "The printer confirmed the print has started." });
            void voice.notify("The user tapped Confirm and the printer confirmed the print has started.");
          },
          (e) => ctx.event({ type: "notice", level: "error", message: `Print not started: ${(e as Error).message}` }),
        );
        return;
      }
      void voice.notify(`The user tapped Confirm. Generating "${r.action.title}" has started (${r.action.credits} credits). It takes about one to three minutes.`);
    } catch (e) {
      throw new Error(friendly(e));
    }
  });
  handle(IPC.cancelAction, (id: string) => {
    if (actions.current?.id === id) {
      actions.clear();
      void voice.notify("The user tapped Cancel on the pending action.");
    }
  });
  handle(IPC.requestRefine, (versionId: string) => {
    try {
      actions.proposeRefine(safeId(String(versionId)));
    } catch (e) {
      throw new Error(friendly(e));
    }
  });
  handle(IPC.meshyBalance, async () => {
    if (!meshy) return { error: "Meshy is not configured" };
    try {
      return { balance: (await meshy.balance()).balance };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
  handle(IPC.testGemini, () => voice.test());

  handle(IPC.printerStatus, () => printer.status);
  handle(IPC.printerInfo, () => printer.info());

  // Print preparation, printing, guardian
  handle(IPC.preparePrint, (versionId: string, s: Record<string, unknown> | "auto", opts?: { speedMmS?: unknown; zOffsetMm?: unknown }) =>
    printing.prepare(safeId(String(versionId)), s === "auto" || !s || typeof s !== "object" ? "auto" : s, null, "touchscreen", {
      speedMmS: Number(opts?.speedMmS) || undefined,
      zOffsetMm: opts?.zOffsetMm === undefined || opts?.zOffsetMm === null || !Number.isFinite(Number(opts.zOffsetMm)) ? undefined : Number(opts.zOffsetMm),
    }),
  );
  handle(IPC.slicerDefaults, () => printing.slicerDefaults());
  handle(IPC.machineCommand, (c: MachineCommand) => {
    if (!c || typeof c !== "object") throw new Error("unknown printer command");
    return driverControl ? driverControl.machine(c) : printing.machine(c, "touch");
  });
  handle(IPC.machineCapabilities, () => (driverControl ? driverControl.capabilities() : printing.capabilities()));
  handle(IPC.jobs, () => jobs.list());
  // The Auth0 portal and the phone app were removed: this Morphix's own address works on phones.
  handle(IPC.portalInfo, () => ({ running: false, url: null, authConfigured: false, missing: [] }));
  handle(IPC.remotePairing, () => ({ running: false, qrDataUrl: null, expiresAt: null, message: "Open this Morphix's web address on your phone instead." }));
  handle(IPC.latestPrintJob, (projectId: string) => printing.latest(safeId(String(projectId))));
  handle(IPC.requestPrint, (jobId: string) => {
    try {
      actions.proposePrint(safeId(String(jobId)));
    } catch (e) {
      throw new Error(friendly(e));
    }
  });
  handle(IPC.printStatus, () => printing.status());
  handle(IPC.pausePrint, () => (driverControl ? driverControl.pause() : printing.pause()));
  handle(IPC.resumePrint, () => (driverControl ? driverControl.resume() : printing.resume("touch")));
  handle(IPC.cancelPrint, () => cancelPrint());
  handle(IPC.uiPage, (page: string) => voice.setPage(String(page)));
  handle(IPC.filaments, () => printing.filaments());
  handle(IPC.setLoadedFilament, (id: string) => printing.setLoadedFilament(String(id)));
  handle(IPC.filamentJob, (kind: string, filament?: string) => {
    if (kind !== "load" && kind !== "unload") throw new Error("unknown filament action");
    if (driverMode) return { ok: false, message: "Load or unload filament from the printer's own screen." };
    return printing.filamentJob(kind, filament ? String(filament) : undefined);
  });
  handle(IPC.guardian, () => printing.view());
  handle(IPC.guardianCommand, (cmd: string) => {
    const allowed = ["start", "stop", "requestPause", "resolve", "dismiss", "resetBaseline"] as const;
    if (!(allowed as readonly string[]).includes(cmd)) throw new Error("unknown guardian command");
    return printing.guardianCommand(cmd as (typeof allowed)[number]);
  });
  handle(IPC.guardianAnswer, (decision: string) => {
    if (decision !== "stop" && decision !== "keep") throw new Error("unknown answer");
    return guardianVoice.answer(decision, "touch");
  });
  handle(IPC.guardianSimulate, () => {
    guardianVoice.simulate("spaghetti");
    ctx.event({ type: "navigate", page: "printer" });
    return { ok: true, message: "Test warning started. Listen, then answer out loud (hold the mic) or tap a button. No printer commands are sent." };
  });

  // Network (Wi-Fi only; NetworkManager on the host)
  handle(IPC.networkStatus, () => network.status());
  handle(IPC.wifiScan, () => network.scan());
  handle(IPC.wifiConnect, async (ssid: string, password: string | null) => {
    try {
      const message = await network.connect(String(ssid), password === null || password === undefined ? null : String(password));
      log.write("info", "wifi connected", { ssid: String(ssid) });
      return { ok: true, message };
    } catch (e) {
      log.write("warn", "wifi connect failed", { ssid: String(ssid), error: (e as Error).message });
      return { ok: false, message: (e as Error).message };
    }
  });
  handle(IPC.wifiForget, async (ssid: string) => {
    try {
      return { ok: true, message: await network.forget(String(ssid)) };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  });

  // -------------------------------------------------------------------------
  let backupTimer: NodeJS.Timeout | null = null;
  let stopBusy: (() => void) | null = null;
  let started = false;

  return {
    registry, storage, log, version: o.version, active, camera, ctx,
    async start() {
      if (started) return;
      started = true;
      const wasmDir = dirname(require.resolve("sql.js/dist/sql-wasm.wasm"));
      ctx.db = await MorphixDb.open(storage, wasmDir);
      printing.init();
      const resumable = ctx.db.recoverInterruptedTasks();
      ctx.db.backup();
      backupTimer = setInterval(() => ctx.db.backup(), 24 * 3600 * 1000);
      backupTimer.unref?.();
      // Fresh chat on every start; the voice recordings that belonged to it go too.
      const cleared = clearConversation();
      if (cleared.messages || cleared.recordings) log.write("info", "chat cleared on start", cleared);
      log.write("info", "Morphix starting", {
        version: o.version, storage: storage.root,
        printer: active.kind === "driver" ? `${active.printer.name} (${active.driver.id})` : `QD330 ${PRINTER_HOST} (${active.reason})`,
        assistant: voice.enabled ? GEMINI_MODEL : "missing", generator: meshy ? MESHY_MODEL : "missing",
        resumable: resumable.length, printControls: PRINT_CONTROLS, gxVerified: GX_VERIFIED,
      });
      // Tells the updater not to restart in the middle of a design, slice or upload.
      stopBusy = startBusyMarker(storage.path("run", "busy"), () => jobs.manager.list({ active: true }));
      printer.start(POLL_SECONDS * 1000);
      // Self-healing: safe automatic fixes (never prints, heats, cancels a print or spends credits). docs/SELF-HEAL.md
      installSelfHealing(appSelfHealDeps({ log, emit: ctx.event, jobs, printer, printing, voice, generation, db: () => ctx.db, storage, pollMs: POLL_SECONDS * 1000 }));
      if (resumable.length && meshy) generation.resume(resumable);
      const latest = ctx.db.get("SELECT id FROM projects ORDER BY updated_at DESC LIMIT 1");
      ctx.currentProjectId = latest ? String(latest.id) : null;
      if (localTts.available) {
        localTts.synthesize("ok").then(
          () => log.write("info", "local voice self-test ok"),
          (e) => log.write("warn", "local voice self-test failed", { error: (e as Error).message }),
        );
      }
    },
    async stop() {
      printer.stop();
      if (backupTimer) clearInterval(backupTimer);
      stopBusy?.();
      voice.close();
      await printing.shutdown().catch(() => {});
      if (active.kind === "driver") await active.connection.close().catch(() => {});
      // Save the progress jobs now (they are debounced), then stop saving.
      await jobs.manager.flush().catch(() => {});
      jobs.manager.dispose();
      try {
        ctx.db?.flush();
        ctx.db?.close();
      } catch (e) {
        log.write("error", "db close failed", { error: (e as Error).message });
      }
    },
  };
}
