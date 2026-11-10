// Morphix touchscreen kiosk (optional). Nothing in Morphix needs Electron: the app itself is the
// core in apps/server. Two ways to run the kiosk:
//   MORPHIX_SERVER_URL=http://localhost:8080  → just a full-screen window on a running server
//   (unset)                                   → the core runs in this process (as on the original
//                                               Pi), served to the window over IPC + a loopback server
import { app, BrowserWindow, ipcMain, session, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { IPC } from "@morphix/shared";
import { createCore, readVersion, type Core } from "../../server/src/core";
import { ReadOnlyConfigStore, loadSetupModule } from "../../server/src/setup-module";
import { cleanPath, libraryFile, notFound, sendFile, serveRenderer } from "../../server/src/static";
import { proxyCamera } from "../../server/src/camera";

const APP_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(APP_DIR, "..", "..");
const RENDERER_DIR = join(APP_DIR, "dist", "renderer");
const WINDOWED = process.env.MORPHIX_WINDOWED === "1";
const SMOKE = process.env.MORPHIX_SMOKE === "1";
const SERVER_URL = (process.env.MORPHIX_SERVER_URL ?? "").trim().replace(/\/$/, "");

// Prefer native Wayland on the Pi's labwc session (falls back to X11 elsewhere).
app.commandLine.appendSwitch("ozone-platform-hint", "auto");

let win: BrowserWindow | null = null;
let origin = SERVER_URL;
let core: Core | null = null;
let server: Server | null = null;
const kioskLog = (level: "info" | "warn" | "error", message: string, extra?: unknown) =>
  core ? core.log.write(level, message, extra as Record<string, unknown> | undefined) : console[level === "info" ? "log" : level](message, extra ?? "");

// ---------------------------------------------------------------------------
// In-process core: IPC handlers straight from the core's registry.

const fromOurPage = (e: IpcMainInvokeEvent | IpcMainEvent) => !!e.senderFrame && e.senderFrame.url.startsWith(origin + "/");

function registerIpc(c: Core): void {
  for (const channel of c.registry.channels()) {
    if (channel === IPC.log) continue;
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!fromOurPage(event)) throw new Error("IPC from untrusted frame");
      return c.registry.call(channel, args);
    });
  }
  ipcMain.on(IPC.log, (event, level: unknown, message: unknown) => {
    if (fromOurPage(event)) void c.registry.call(IPC.log, [level, message]).catch(() => {});
  });
  c.registry.subscribe((channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  });
}

/** 127.0.0.1 only: the UI, the model library and the camera proxy. A loopback page is a secure context (microphone). */
function startLocalServer(c: Core): Promise<Server> {
  const s = createServer((req, res) => {
    const path = cleanPath(req.url);
    if (!path || (req.method !== "GET" && req.method !== "HEAD")) return notFound(res);
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (path === "/api/camera/stream") return void proxyCamera(c.camera().stream, res);
    if (path === "/api/camera/snapshot") return void proxyCamera(c.camera().snapshot, res);
    if (path.startsWith("/library/")) {
      const file = libraryFile(c.storage.root, path);
      return file ? sendFile(req, res, file) : notFound(res);
    }
    if (!serveRenderer(req, res, RENDERER_DIR, path)) notFound(res);
  });
  return new Promise((ok) => s.listen(0, "127.0.0.1", () => ok(s)));
}

async function startInProcess(): Promise<void> {
  const dataDir = resolve(process.env.MORPHIX_DATA_DIR?.trim() || process.env.MORPHIX_ROOT?.trim() || join(homedir(), "Morphix"));
  const setup = loadSetupModule();
  const store = setup.createConfigStore?.(dataDir) ?? new ReadOnlyConfigStore(dataDir);
  core = await createCore({ dataDir, repoRoot: REPO_ROOT, version: app.getVersion() || readVersion(REPO_ROOT), store });
  process.on("uncaughtException", (e) => core?.log.write("error", "uncaughtException", { message: e.message, stack: e.stack }));
  process.on("unhandledRejection", (e) => core?.log.write("error", "unhandledRejection", { reason: String(e) }));
  await core.start();
  server = await startLocalServer(core);
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  registerIpc(core);
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
      // Only the in-process kiosk gets window.morphix; against a server the page uses HTTP.
      ...(SERVER_URL ? {} : { preload: join(__dirname, "preload.cjs") }),
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
      kioskLog("warn", "blocked navigation", { url });
    }
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    kioskLog("error", "renderer crashed, reloading", details);
    setTimeout(() => win?.loadURL(origin + "/"), 1000);
  });
  win.webContents.on("did-fail-load", (_e, code, description) => {
    kioskLog("warn", "page failed to load, retrying", { code, description });
    setTimeout(() => win?.loadURL(origin + "/"), 3000);
  });
  win.webContents.on("console-message", (...args: unknown[]) => {
    // Newer Electron passes one event object; older versions pass (event, level, message).
    const ev = args[0] as { level?: unknown; message?: unknown };
    const level = String(ev.level ?? args[1]);
    const message = String(ev.message ?? args[2]);
    if (level === "error" || level === "3") kioskLog("error", `[console] ${message}`);
    else if (level === "warning" || level === "2") kioskLog("warn", `[console] ${message}`);
  });
  if (SMOKE) {
    win.webContents.once("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, 2500));
      const text = await win!.webContents.executeJavaScript("document.body.innerText");
      const flow = SERVER_URL ? "server" : await win!.webContents.executeJavaScript(`(async () => {
        const m = window.morphix;
        const settings = await m.getSettings();
        const guardian = await m.guardian();
        const print = await m.printStatus();
        return { ai: settings.ai, guardian: { state: guardian.state, running: guardian.running }, print: { enabled: print.enabled } };
      })()`);
      kioskLog("info", "smoke test", { ok: /Morphix/.test(text), chars: text.length, flow });
      app.quit();
    });
  }
  void win.loadURL(origin + "/");
}

// One Morphix kiosk per machine: a second launch just brings the existing window forward.
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
  if (!SERVER_URL) await startInProcess();
  // Microphone only, only for our own page. Everything else is denied.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    const ok =
      permission === "media" &&
      details.requestingUrl.startsWith(origin + "/") &&
      (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === "audio") !== false;
    cb(ok);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => permission === "media" && requestingOrigin === origin);
  createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  server?.close();
  void core?.stop();
});
