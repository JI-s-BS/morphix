// Morphix — Electron main process (Phases 1–5).
import { app, BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { arch, platform } from "node:os";

import { IPC, type AppEvent, type AppSettings, type AssistantTurn, type PrinterStatus } from "@morphix/shared";
import { Logger, Storage, safeId } from "@morphix/storage";
import { MorphixDb } from "@morphix/database";
import { PrinterObserver } from "@morphix/printer";
import { MeshyClient, MeshyGenerator, MESHY_PREVIEW_CREDITS, MESHY_REFINE_CREDITS, type ModelGenerator } from "@morphix/meshy";
import { DEFAULT_LIVE_MODEL } from "@morphix/gemini";
import { NetworkManager } from "@morphix/network";
import { levelingPlan, type LevelingPlan } from "@morphix/slicing";
import { type Ctx, latestVersion, moveProject, now, toProject, toVersion } from "./context";
import { Generation, type FinishedInfo } from "./generation";
import { Actions, PolicyError } from "./actions";
import { VoiceController } from "./voice";
import { Printing } from "./printing";
import { Jobs } from "./jobs";
import { PhotoPipeline } from "./photo";
import { createPortalBackend } from "./portal-backend";
import { GuardianVoice } from "./guardian-voice";
import { LocalTts } from "./tts";
import { createPortal, loadPortalAuthConfig, type Portal } from "@morphix/portal";
import { MorphixRemote } from "@morphix/remote";
import { DEFAULT_SEARCH_MODEL, SmartModelSearch } from "@morphix/model-search";
import { importLibraryModel, libraryManifest, useLibraryPlate } from "./library-import";
import { cadGeneratorFromEnv } from "./cad";
import { startBusyMarker } from "./busy";
import { toMorphixError, getErrorEntry } from "@morphix/errors";
import type { MachineCommand } from "@morphix/shared";
import QRCode from "qrcode";
import { appSelfHealDeps, installSelfHealing } from "./self-heal"; // self-healing (docs/SELF-HEAL.md)

const APP_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(APP_DIR, "..", "..");
const RENDERER_DIR = join(APP_DIR, "dist", "renderer");
const WINDOWED = process.env.MORPHIX_WINDOWED === "1";
const SMOKE = process.env.MORPHIX_SMOKE === "1";

// Prefer native Wayland on the Pi's labwc session (falls back to X11 elsewhere).
app.commandLine.appendSwitch("ozone-platform-hint", "auto");

const storage = new Storage();
storage.init();
loadEnvFile(storage.path("config", "morphix.env"));
const log = new Logger(storage);

const env = (k: string) => (process.env[k] ?? "").trim();
const has = (k: string) => env(k).length > 0;
const PRINTER_HOST = env("MORPHIX_PRINTER_HOST") || "192.168.10.51";
const CAMERA_BASE = `http://${PRINTER_HOST}:8080`;
const POLL_SECONDS = Number(env("MORPHIX_PRINTER_POLL_SECONDS") || 5);
const GEMINI_MODEL = env("MORPHIX_GEMINI_MODEL") || DEFAULT_LIVE_MODEL;
const MESHY_MODEL = env("MORPHIX_MESHY_MODEL") || "meshy-6";
const DAILY_LIMIT = Number(env("MORPHIX_MESHY_DAILY_LIMIT") || 15);

let win: BrowserWindow | null = null;
let origin = "";
const meshy = has("MESHY_API_KEY") ? new MeshyClient(env("MESHY_API_KEY"), MESHY_MODEL) : null;
const generator: ModelGenerator | null = meshy ? new MeshyGenerator(meshy) : null;
const network = new NetworkManager();
const PRINT_CONTROLS = env("MORPHIX_PRINT_CONTROLS") === "1";
const GX_VERIFIED = env("MORPHIX_GX_VERIFIED") === "1";

const ctx: Ctx = {
  db: null as unknown as MorphixDb, // set in whenReady
  storage,
  log,
  send,
  event: (e: AppEvent) => send(IPC.appEvent, e),
  url: (rel) => (rel ? `${origin}/library/${rel}` : null),
  currentProjectId: null,
};
const ALLOW_UNVERIFIED = new Set((env("MORPHIX_ALLOW_UNVERIFIED") || "").split(",").map((x) => x.trim()).filter(Boolean));
function levelingFromEnv(): LevelingPlan {
  try {
    const leave = (env("MORPHIX_LEVELING") || "").trim().toLowerCase();
    return levelingPlan({ printerOnly: leave === "printer" || leave === "off", commandsText: env("MORPHIX_LEVEL_GCODE") });
  } catch (e) {
    log.write("error", "MORPHIX_LEVEL_GCODE refused; G29 levels the bed instead", { error: (e as Error).message });
    return levelingPlan();
  }
}
const PORTAL_PORT = Number(env("PORTAL_PORT") || 8443);
let portal: Portal | null = null;
let portalUrl: string | null = null;
let remote: MorphixRemote | null = null;
const printing = new Printing(ctx, {
  repoRoot: REPO_ROOT,
  printerHost: PRINTER_HOST,
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
// Tells deploy.sh not to restart the app in the middle of a design, slice or upload.
startBusyMarker(storage.path("run", "busy"), () => jobs.manager.list({ active: true }));
printing.jobs = jobs;
// All printer traffic (polls + control) goes through the controller's queue so sessions never collide.
const printer = new PrinterObserver(printing.controller.transport, onPrinterStatus);
const generation = new Generation(
  ctx,
  () => {
    if (!generator) throw new Error("Meshy is not configured. Add MESHY_API_KEY to ~/Morphix/config/morphix.env and restart Morphix.");
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
const searchImages = new Map<string, string>(); // result id -> picture kept on the Pi (relative path)
const smartSearch = new SmartModelSearch({
  apiKey: has("GEMINI_API_KEY") ? env("GEMINI_API_KEY") : undefined,
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
function importSearchResult(resultId: string, files: { name: string; bytes: Buffer }[]) {
  const result = smartSearch.find(resultId);
  if (!result) throw new Error("That search result is no longer available — search again, then import.");
  smartSearch.select(resultId);
  const r = importLibraryModel(ctx, result, files, { thumbnailRel: searchImages.get(resultId) ?? null });
  ctx.currentProjectId = r.projectId;
  ctx.event({ type: "navigate", page: "viewer", projectId: r.projectId });
  return { projectId: r.projectId, versionId: r.versionId, parts: r.parts, warnings: r.warnings };
}
/** "Choose this one": download every model file through the site's supported route and import it. */
async function downloadSearchResult(resultId: string) {
  smartSearch.select(resultId);
  return importSearchResult(resultId, await smartSearch.download(resultId));
}
actions.printer = { proposal: (jobId) => printing.printProposal(jobId), start: (jobId, by) => printing.startApprovedPrint(jobId, by) };
const voice = new VoiceController(ctx, actions, {
  apiKey: has("GEMINI_API_KEY") ? env("GEMINI_API_KEY") : undefined,
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
    ctx.send(IPC.voiceEvent, { type: "audio", pcm: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength), sampleRate });
    voice.localSpeechContext(text);
    return true;
  },
  cancelPrint: () => printing.cancel(),
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
if (localTts.available) {
  localTts.synthesize("ok").then(
    () => log.write("info", "local voice self-test ok"),
    (e) => log.write("warn", "local voice self-test failed", { error: (e as Error).message }),
  );
}

process.on("uncaughtException", (e) => log.write("error", "uncaughtException", { message: e.message, stack: e.stack }));
process.on("unhandledRejection", (e) => log.write("error", "unhandledRejection", { reason: String(e) }));

// ---------------------------------------------------------------------------
function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

function settings(): AppSettings {
  const gemini = voice.enabled;
  return {
    storageRoot: storage.root,
    ai: {
      assistant: gemini ? "gemini-live" : "missing",
      geminiModel: GEMINI_MODEL,
      generator: meshy ? "meshy" : "missing",
      meshyModel: MESHY_MODEL,
      previewCredits: meshy ? (MESHY_PREVIEW_CREDITS[MESHY_MODEL] ?? 20) : 0,
      refineCredits: meshy ? MESHY_REFINE_CREDITS : 0,
      dailyLimit: DAILY_LIMIT,
      usedToday: ctx.db ? ctx.db.meshyTasksToday() : 0,
    },
    printerHost: PRINTER_HOST,
    cameraStreamUrl: `${CAMERA_BASE}/?action=stream`,
    cameraSnapshotUrl: `${CAMERA_BASE}/?action=snapshot`,
    printerPollSeconds: POLL_SECONDS,
    demoMode: false,
    keys: {
      gemini: has("GEMINI_API_KEY"),
      meshy: has("MESHY_API_KEY"),
      claude: has("ANTHROPIC_API_KEY"),
      vultr: has("VULTR_INFERENCE_API_KEY") || has("VULTR_API_KEY"),
      tiger: has("TIGER_DATABASE_URL"),
      swarms: has("SWARMS_API_KEY"),
      auth0: has("AUTH0_DOMAIN") && has("AUTH0_CLIENT_ID"),
    },
    printControlsEnabled: false,
  };
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function onPrinterStatus(s: PrinterStatus, prev: PrinterStatus): void {
  send(IPC.printerStatusEvent, s);
  try {
    printing.onPrinterStatus(s);
  } catch (e) {
    log.write("warn", "print tracking error", { error: (e as Error).message });
  }
  if (!ctx.db) return;
  if (s.online !== prev.online || s.machine !== prev.machine) {
    const kind = s.online ? `status:${s.machine ?? "unknown"}` : "offline";
    ctx.db.run("INSERT INTO printer_events(at, kind, detail) VALUES (?, ?, ?)", [now(), kind, s.error ?? s.currentFile ?? null]);
    log.write("info", `printer ${kind}`, s.error ? { error: s.error } : undefined);
  }
}

function onGenerationFinished(info: FinishedInfo): void {
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

function saveRecording(pcm: Buffer, rate: number): string {
  if (pcm.length > 16000 * 2 * 120) throw new Error("recording too long (2 minute limit)");
  const file = storage.path("cache", "recordings", `${randomUUID()}.wav`);
  storage.writeAtomic(file, wav(pcm, rate));
  return storage.relative(file);
}

function addTurn(role: "user" | "assistant", text: string, audioRel?: string): AssistantTurn {
  const turn = { id: randomUUID(), role, text, createdAt: now() };
  ctx.db.run("INSERT INTO conversation(id, role, text, audio_rel_path, created_at) VALUES (?,?,?,?,?)", [
    turn.id, role, text, audioRel ?? null, turn.createdAt,
  ]);
  return { ...turn, audioUrl: ctx.url(audioRel) ?? undefined };
}

const friendly = (e: unknown) => (e instanceof PolicyError ? e.message : (e as Error).message);

// ---------------------------------------------------------------------------
// IPC — every handler checks the sender is our own window.

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!event.senderFrame || !event.senderFrame.url.startsWith(origin + "/")) {
      throw new Error("IPC from untrusted frame");
    }
    try {
      const r = fn(...(args as A));
      return r instanceof Promise ? r.catch((e) => Promise.reject(coded(e))) : r;
    } catch (e) {
      throw coded(e);
    }
  });
}

/** Errors cross IPC as "MX-CODE|title|hint|detail" so the screen can show a friendly card. */
function coded(e: unknown): Error {
  const me = toMorphixError(e);
  const entry = getErrorEntry(me.code);
  return new Error(`${me.code}|${entry?.title ?? me.title}|${entry?.hint ?? me.hint}|${(e as Error)?.message ?? ""}`);
}

function registerIpc(): void {
  const { db } = ctx;
  handle(IPC.getSettings, () => settings());
  handle(IPC.getSystemInfo, () => ({
    version: app.getVersion(),
    platform: platform(),
    arch: arch(),
    storageRoot: storage.root,
    ...storage.disk(),
    logFile: log.file(),
    uptimeSeconds: Math.round(process.uptime()),
  }));
  handle(IPC.recentLogs, (lines?: number) => log.tail(Math.min(Number(lines) || 100, 500)));
  ipcMain.on(IPC.log, (event, level: "info" | "warn" | "error", message: string) => {
    if (event.senderFrame?.url.startsWith(origin + "/")) log.write(level, `[renderer] ${String(message).slice(0, 2000)}`);
  });

  handle(IPC.listProjects, () => db.all("SELECT * FROM projects ORDER BY updated_at DESC").map((r) => toProject(ctx, r)));
  handle(IPC.getProject, (id: string) => {
    const r = db.get("SELECT * FROM projects WHERE id = ?", [safeId(id)]);
    if (!r) return null;
    ctx.currentProjectId = id;
    return {
      project: toProject(ctx, r),
      versions: db.all("SELECT * FROM model_versions WHERE project_id = ? ORDER BY version DESC", [id]).map((v) => toVersion(ctx, v)),
    };
  });
  handle(IPC.createProjectFromPrompt, (prompt: string) => {
    const text = String(prompt ?? "").trim().slice(0, 500);
    if (!text) throw new Error("describe what to make first");
    try {
      if (!meshy) throw new Error("Meshy is not configured. Add MESHY_API_KEY to ~/Morphix/config/morphix.env and restart Morphix.");
      return { pending: actions.proposeGenerate(text, text.slice(0, 60)) };
    } catch (e) {
      throw new Error(friendly(e));
    }
  });
  handle(IPC.setTargetHeight, (versionId: string, heightMm: number | null) => {
    // null / 0 = original size
    const h = heightMm == null || Number(heightMm) === 0 ? null : Number(heightMm);
    if (h !== null && !(h > 0 && h <= 1000)) throw new Error("height must be between 0 and 1000 mm");
    db.run("UPDATE model_versions SET target_height_mm = ? WHERE id = ?", [h, safeId(versionId)]);
    const r = db.get("SELECT * FROM model_versions WHERE id = ?", [versionId]);
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
    const existing = db.get("SELECT thumbnail_rel_path FROM model_versions WHERE id = ?", [safeId(versionId)]);
    if (existing?.thumbnail_rel_path) return; // keep Meshy's own thumbnail
    const file = storage.path("previews", `${versionId}.png`);
    storage.writeAtomic(file, png);
    db.run("UPDATE model_versions SET thumbnail_rel_path = ? WHERE id = ?", [storage.relative(file), versionId]);
  });

  // Without a Gemini key there is no assistant (demo mode removed).
  const noGemini = () => {
    throw new Error("Gemini is not configured. Add GEMINI_API_KEY to ~/Morphix/config/morphix.env and restart Morphix.");
  };
  handle(IPC.submitRecording, noGemini);
  handle(IPC.sendText, noGemini);
  handle(IPC.conversation, () =>
    db
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
  handle(IPC.importSmartModel, (resultId: string, files: { name: string; bytes: ArrayBuffer }[]) => importSearchResult(String(resultId), files.map((f) => ({ name: String(f.name), bytes: Buffer.from(f.bytes) }))));
  handle(IPC.downloadSmartModel, (resultId: string) => downloadSearchResult(String(resultId)));
  handle(IPC.libraryManifest, (versionId: string) => libraryManifest(ctx, safeId(String(versionId))));
  handle(IPC.libraryPlate, (projectId: string, plate: number) => {
    const r = useLibraryPlate(ctx, safeId(String(projectId)), Number(plate));
    ctx.event({ type: "navigate", page: "viewer", projectId: String(projectId) });
    return r;
  });

  // Gemini Live voice
  handle(IPC.voiceTurn, async (pcm: ArrayBuffer, sampleRate: number) => {
    const buf = Buffer.from(pcm);
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

  // Phase 3–5: print preparation, printing, guardian
  handle(IPC.preparePrint, (versionId: string, settings: Record<string, unknown> | "auto", opts?: { speedMmS?: unknown; zOffsetMm?: unknown }) =>
    printing.prepare(safeId(String(versionId)), settings === "auto" || !settings ? "auto" : settings, null, "touchscreen", {
      speedMmS: Number(opts?.speedMmS) || undefined,
      zOffsetMm: opts?.zOffsetMm === undefined || opts?.zOffsetMm === null || !Number.isFinite(Number(opts.zOffsetMm)) ? undefined : Number(opts.zOffsetMm),
    }),
  );
  handle(IPC.slicerDefaults, () => printing.slicerDefaults());
  handle(IPC.machineCommand, (c: MachineCommand) => printing.machine(c, "touch"));
  handle(IPC.machineCapabilities, () => printing.capabilities());
  handle(IPC.jobs, () => jobs.list());
  handle(IPC.portalInfo, () => {
    const a = loadPortalAuthConfig(process.env);
    return { running: portal !== null, url: portalUrl, authConfigured: a.ok, missing: a.ok ? [] : [...a.missing, ...a.problems] };
  });
  handle(IPC.remotePairing, async () => {
    if (!remote) return { running: false, qrDataUrl: null, expiresAt: null, message: "Morphix Remote is not running." };
    try {
      const pair = remote.pairingLink(env("MORPHIX_REMOTE_SITE_URL"));
      return { running: true, qrDataUrl: await QRCode.toDataURL(pair.url, { width: 300, margin: 2, color: { dark: "#071018", light: "#ffffff" } }), expiresAt: pair.expiresAt };
    } catch (e) {
      return { running: true, qrDataUrl: null, expiresAt: null, message: (e as Error).message };
    }
  });
  handle(IPC.latestPrintJob, (projectId: string) => printing.latest(safeId(String(projectId))));
  handle(IPC.requestPrint, (jobId: string) => {
    try {
      actions.proposePrint(safeId(String(jobId)));
    } catch (e) {
      throw new Error(friendly(e));
    }
  });
  handle(IPC.printStatus, () => printing.status());
  handle(IPC.pausePrint, () => printing.pause());
  handle(IPC.resumePrint, () => printing.resume("touch"));
  handle(IPC.uiPage, (page: string) => voice.setPage(String(page)));
  handle(IPC.filaments, () => printing.filaments());
  handle(IPC.setLoadedFilament, (id: string) => printing.setLoadedFilament(String(id)));
  handle(IPC.filamentJob, (kind: string, filament?: string) => {
    if (kind !== "load" && kind !== "unload") throw new Error("unknown filament action");
    return printing.filamentJob(kind, filament ? String(filament) : undefined);
  });
  handle(IPC.cancelPrint, () => printing.cancel());
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
  handle(IPC.printerInfo, () => printer.info());

  // Network (Wi-Fi only; the printer's Ethernet link is read-only)
  handle(IPC.networkStatus, () => network.status());
  handle(IPC.wifiScan, () => network.scan());
  handle(IPC.wifiConnect, async (ssid: string, password: string | null) => {
    try {
      const message = await network.connect(String(ssid), password === null ? null : String(password));
      log.write("info", "wifi connected", { ssid });
      return { ok: true, message };
    } catch (e) {
      log.write("warn", "wifi connect failed", { ssid, error: (e as Error).message });
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
}

// ---------------------------------------------------------------------------
// Local server (127.0.0.1 only): the renderer UI plus read-only model assets.
// Serving from http://127.0.0.1 gives the page a secure context (microphone)
// while still allowing the printer's plain-HTTP camera stream.

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".wav": "audio/wav", ".woff2": "font/woff2",
  ".stl": "model/stl", ".glb": "model/gltf-binary", ".wasm": "application/wasm",
};
/** Deletes the chat history and its voice recordings (run at start-up). */
function clearConversation(): { messages: number; recordings: number } {
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
}

const LIBRARY_DIRS = ["models", "previews", "cache/recordings", "snapshots"];

function startServer(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let file: string | null = null;
    if (url.pathname.startsWith("/library/")) {
      const rel = decodeURIComponent(url.pathname.slice("/library/".length));
      try {
        const p = storage.path(rel);
        if (LIBRARY_DIRS.some((d) => p.startsWith(storage.path(d) + sep))) file = p;
      } catch {
        file = null;
      }
    } else {
      const p = resolve(RENDERER_DIR, "." + (url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)));
      if (p.startsWith(RENDERER_DIR + sep)) file = p;
    }
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

// ---------------------------------------------------------------------------

function createWindow(): void {
  win = new BrowserWindow({
    width: 1024,
    height: 600,
    fullscreen: !WINDOWED,
    autoHideMenuBar: true,
    backgroundColor: "#0e1117",
    show: !SMOKE,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(origin + "/")) {
      e.preventDefault();
      log.write("warn", "blocked navigation", { url });
    }
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    log.write("error", "renderer crashed, reloading", details);
    setTimeout(() => win?.loadURL(origin + "/"), 1000);
  });
  win.webContents.on("console-message", (...args: unknown[]) => {
    // Newer Electron passes one event object; older versions pass (event, level, message).
    const ev = args[0] as { level?: unknown; message?: unknown };
    const level = String(ev.level ?? args[1]);
    const message = String(ev.message ?? args[2]);
    if (level === "error" || level === "3") log.write("error", `[console] ${message}`);
    else if (level === "warning" || level === "2") log.write("warn", `[console] ${message}`);
  });
  if (SMOKE) {
    win.webContents.once("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, 2500));
      const text = await win!.webContents.executeJavaScript("document.body.innerText");
      const flow = await win!.webContents.executeJavaScript(`(async () => {
        const m = window.morphix;
        const settings = await m.getSettings();
        const guardian = await m.guardian();
        const print = await m.printStatus();
        const net = await m.networkStatus().catch((e) => ({ error: String(e) }));
        return { ai: settings.ai, guardian: { state: guardian.state, running: guardian.running }, print: { enabled: print.enabled }, net: Boolean(net) };
      })()`);
      let live: unknown = "skipped";
      if (process.env.MORPHIX_SMOKE_LIVE === "1") {
        // Live check: Gemini should PROPOSE a model (pending action) — then we cancel. No credits spent.
        live = await win!.webContents.executeJavaScript(`(async () => {
          const m = window.morphix; const seen = [];
          const offV = m.onVoiceEvent((e) => { if (e.type !== "audio") seen.push(e.type === "turn-complete" ? "turn:" + (e.assistant && e.assistant.text) : e.type + (e.state ? ":" + e.state : "")); });
          const pending = new Promise((res) => { const off = m.onAppEvent((e) => { if (e.type === "pending" && e.action) { off(); res(e.action); } }); setTimeout(() => res(null), 30000); });
          await m.voiceText("Please make me a small dragon figurine about the size of my palm.");
          const action = await pending;
          if (action) await m.cancelAction(action.id);
          await new Promise((r) => setTimeout(r, 6000));
          offV();
          return { proposed: action ? { title: action.title, credits: action.credits, prompt: action.prompt.slice(0, 160) } : null, events: seen.slice(-8) };
        })()`);
      }
      log.write("info", "smoke test", { ok: /Morphix/.test(text), chars: text.length, flow, live });
      app.quit();
    });
  }
  void win.loadURL(origin + "/");
}

// One Morphix per Pi: a second launch just brings the existing window forward.
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  const wasmDir = dirname(require.resolve("sql.js/dist/sql-wasm.wasm"));
  ctx.db = await MorphixDb.open(storage, wasmDir);
  printing.init();
  const resumable = ctx.db.recoverInterruptedTasks();
  ctx.db.backup();
  setInterval(() => ctx.db.backup(), 24 * 3600 * 1000);
  // Fresh chat on every start: the Make page (and the phone) begin empty, and the voice
  // recordings that belonged to the old messages are removed with them.
  const cleared = clearConversation();
  if (cleared.messages || cleared.recordings) log.write("info", "chat cleared on start", cleared);
  log.write("info", "Morphix starting", {
    storage: storage.root, printer: PRINTER_HOST, assistant: voice.enabled ? GEMINI_MODEL : "missing",
    generator: meshy ? MESHY_MODEL : "missing", resumable: resumable.length,
    printControls: PRINT_CONTROLS, gxVerified: GX_VERIFIED,
  });

  const server = await startServer();
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  // Microphone only, only for our own page. Everything else is denied.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    const ok =
      permission === "media" &&
      details.requestingUrl.startsWith(origin + "/") &&
      (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === "audio") !== false;
    cb(ok);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    permission === "media" && requestingOrigin === origin,
  );

  registerIpc();
  createWindow();
  void startPortal();
  void startRemote();
  printer.start(POLL_SECONDS * 1000);
  // Self-healing: safe automatic fixes (never prints, heats, cancels a print or spends credits). docs/SELF-HEAL.md
  installSelfHealing(appSelfHealDeps({ log, emit: ctx.event, jobs, printer, printing, voice, generation, db: () => ctx.db, storage, pollMs: POLL_SECONDS * 1000 }));
  if (resumable.length && meshy) generation.resume(resumable);
  const latest = ctx.db.get("SELECT id FROM projects ORDER BY updated_at DESC LIMIT 1");
  ctx.currentProjectId = latest ? String(latest.id) : null;
  void latestVersion; // (used by modules)
});

async function startPortal(): Promise<void> {
  try {
    const backend = sharedWebBackend();
    portal = createPortal({
      backend,
      auth: loadPortalAuthConfig(process.env),
      host: env("PORTAL_HOST") || "0.0.0.0",
      port: PORTAL_PORT,
      storageRoot: storage.root,
      webRoot: join(REPO_ROOT, "packages", "portal", "web"),
      threeRoot: join(REPO_ROOT, "node_modules", "three"),
      log: (line) => log.write("info", `[portal] ${line}`),
    });
    const r = await portal.start();
    portalUrl = env("PORTAL_BASE_URL") || r.url;
    log.write("info", "web portal started", { url: portalUrl });
  } catch (e) {
    portal = null;
    log.write("error", "web portal failed to start", { error: (e as Error).message });
  }
}

function sharedWebBackend() {
  return createPortalBackend({
      ctx, jobs, actions, photo, printing,
      printerStatus: () => printer.status,
      cameraUrl: `${CAMERA_BASE}/?action=stream`,
      meshyReady: () => meshy !== null,
      dailyLimit: DAILY_LIMIT,
      startText: (prompt, owner, jobId) => {
        const text = prompt.trim().slice(0, 500);
        actions.proposeCustom(
          { kind: "generate", title: text.slice(0, 60), prompt: text, projectId: null, versionId: null, credits: actions.previewCredits(), details: [`Uses ${actions.previewCredits()} Meshy credits`, text.slice(0, 160)] },
          () => generation.start({ prompt: text, title: text.slice(0, 60), kind: "preview", owner, jobId }),
          () => jobs.cancel(jobId, "cancelled"),
        );
      },
    });
}


async function startRemote(): Promise<void> {
  if (env("MORPHIX_REMOTE") === "0") return;
  try {
    const origins = (env("MORPHIX_REMOTE_ORIGINS") || "http://localhost:4173,http://localhost:5174").split(",").map((x) => x.trim().replace(/\/$/, "")).filter(Boolean);
    remote = new MorphixRemote({
      storage,
      backend: sharedWebBackend(),
      conversation: () => ctx.db.all("SELECT * FROM conversation ORDER BY created_at DESC LIMIT 50").reverse().map((r) => ({ id: String(r.id), role: r.role as "user" | "assistant", text: String(r.text), createdAt: String(r.created_at) })),
      jobs: () => jobs.list(),
      assistantText: (text) => voice.text(text),
      assistantVoice: (pcm, rate) => voice.utterance(pcm, saveRecording(pcm, rate)),
      setHeight: (versionId, heightMm) => {
        const h = heightMm == null || heightMm === 0 ? null : Number(heightMm);
        if (h !== null && !(h >= 10 && h <= 220)) throw new Error("height must be between 10 and 220 mm");
        const v = ctx.db.get("SELECT * FROM model_versions WHERE id = ?", [safeId(versionId)]);
        if (!v) throw new Error("model not found");
        ctx.db.run("UPDATE model_versions SET target_height_mm = ? WHERE id = ?", [h, versionId]);
        moveProject(ctx, String(v.project_id), "sizing");
        return toVersion(ctx, { ...v, target_height_mm: h });
      },
      proposeRefine: (versionId) => actions.proposeRefine(safeId(versionId)),
      prepare: (versionId, set) => printing.prepare(safeId(versionId), set, null, "morphix-remote"),
      latestPrint: (projectId) => printing.latest(safeId(projectId)),
      proposePrint: (jobId) => actions.proposePrint(safeId(jobId)),
      printStatus: () => printing.status(),
      pause: () => printing.pause(), resume: () => printing.resume(), cancel: () => printing.cancel(),
      guardian: () => printing.view(),
      guardianAnswer: (decision) => guardianVoice.answer(decision, "touch"),
      smartSearch: () => smartSearch.state,
      engineChoice: () => voice.engineChoice,
      searchModels: (query) => smartSearch.search(query),
      selectModel: (id) => smartSearch.select(id),
      importModels: async (input) => importSearchResult(input.resultId, input.files),
      downloadModel: (id) => downloadSearchResult(id),
      log: (line) => log.write("info", `[remote] ${line}`),
      // Phone "Photo to 3D" (photo.ts). Claude CAD shows "not available yet" until photo.generateCad is set.
      photoAnalyze: (input) => photo.analyzeForRemote(input),
      photoClean: (planId) => photo.cleanForRemote(planId),
      photoPreview: (planId, index) => photo.planPreview(planId, index),
      photoCreate: (input) => photo.createFromPlan(input),
    }, {
      host: env("MORPHIX_REMOTE_HOST") || "127.0.0.1", port: Number(env("MORPHIX_REMOTE_PORT") || 8787), allowedOrigins: origins,
      // Phone "Sign in with Auth0" (docs/REMOTE.md). The phone is its own Auth0 SPA app, separate from the portal's.
      // Portal admins may sign in too, as in the portal.
      auth0: { domain: env("AUTH0_DOMAIN"), clientId: env("MORPHIX_REMOTE_AUTH0_CLIENT_ID"), allowedEmails: `${env("AUTH0_ALLOWED_EMAILS")},${env("AUTH0_ADMIN_EMAILS")}` },
    });
    const r = await remote.start();
    log.write("info", "Morphix Remote API started", r);
  } catch (e) {
    remote = null;
    log.write("error", "Morphix Remote failed to start", { error: (e as Error).message });
  }
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  printer.stop();
  voice.close();
  void printing.shutdown();
  void portal?.stop();
  void remote?.stop();
  try {
    ctx.db?.close();
  } catch (e) {
    log.write("error", "db close failed", { error: (e as Error).message });
  }
});
