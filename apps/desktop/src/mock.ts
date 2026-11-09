// In-browser stand-in for the Electron bridge, used only when the UI is
// previewed outside Electron (vite preview). It never touches the printer.
import type { AssistantTurn, GenerationProgress, MorphixApi, ModelVersion, PrinterStatus, Project } from "@morphix/shared";

const mockFilaments: import("@morphix/shared").FilamentState = {
  loaded: "pla",
  list: [
    { id: "pla", label: "PLA", blurb: "Easy and colourful — the best one for most toys.", nozzleC: 210, bedC: 60, changeC: 220, maxVolumetricMm3S: 15, notes: [] },
    { id: "petg", label: "PETG", blurb: "Strong and a bit bendy.", nozzleC: 240, bedC: 80, changeC: 240, maxVolumetricMm3S: 8, notes: [] },
    { id: "elegoo-rapid-petg", label: "Elegoo Rapid PETG", blurb: "Elegoo's strong PETG — tough parts that can even go outside.", nozzleC: 245, bedC: 70, changeC: 245, maxVolumetricMm3S: 8, notes: [] },
    { id: "tpu", label: "TPU", blurb: "Squishy and rubbery — prints slowly.", nozzleC: 225, bedC: 50, changeC: 230, maxVolumetricMm3S: 3.5, notes: [] },
  ],
};

const CUBE_STL = (() => {
  const v = [[0,0,0],[40,0,0],[40,40,0],[0,40,0],[0,0,40],[40,0,40],[40,40,40],[0,40,40]];
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const body = f.map((t) => `facet normal 0 0 0\nouter loop\n${t.map((i) => `vertex ${v[i].join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n");
  return URL.createObjectURL(new Blob([`solid cube\n${body}\nendsolid cube\n`], { type: "model/stl" }));
})();

export function createMockApi(): MorphixApi {
  const projects: Project[] = [];
  const versions: ModelVersion[] = [];
  const turns: AssistantTurn[] = [];
  const genSubs = new Set<(p: GenerationProgress) => void>();
  const t = () => new Date().toISOString();
  const id = () => crypto.randomUUID();
  const status: PrinterStatus = {
    online: true, checkedAt: t(), machine: "READY", moveMode: "READY",
    temps: { nozzle: { current: 26, target: 0 }, bed: { current: 25, target: 0 } },
    position: { x: 110, y: 110, z: 220 }, progress: 0, layer: [0, 0],
  };
  const turn = (role: AssistantTurn["role"], text: string): AssistantTurn => {
    const x = { id: id(), role, text, createdAt: t() };
    turns.push(x);
    return x;
  };
  return {
    getSettings: async () => ({
      storageRoot: "(browser preview)",
      ai: { assistant: "missing", geminiModel: "gemini-3.8-live", generator: "missing", meshyModel: "meshy-6", previewCredits: 0, refineCredits: 0, dailyLimit: 15, usedToday: 0 }, printerHost: "192.168.10.51",
      cameraStreamUrl: "http://192.168.10.51:8080/?action=stream", cameraSnapshotUrl: "http://192.168.10.51:8080/?action=snapshot",
      printerPollSeconds: 5, demoMode: true,
      keys: { gemini: false, meshy: false, claude: false, vultr: false, tiger: false, swarms: false, auth0: false },
      printControlsEnabled: false,
    }),
    getSystemInfo: async () => ({ version: "preview", platform: "browser", arch: "-", storageRoot: "-", freeBytes: 48e9, totalBytes: 58e9, logFile: "-", uptimeSeconds: 0 }),
    recentLogs: async () => ['{"level":"info","message":"browser preview"}'],
    log: (l, m) => console.log(`[${l}] ${m}`),
    listProjects: async () => [...projects].reverse(),
    getProject: async (pid) => {
      const project = projects.find((p) => p.id === pid);
      return project ? { project, versions: versions.filter((v) => v.projectId === pid) } : null;
    },
    createProjectFromPrompt: async (prompt) => {
      const p: Project = { id: id(), title: prompt.slice(0, 60), prompt, state: "generating", createdAt: t(), updatedAt: t(), latestVersionId: null, thumbnailUrl: null };
      projects.push(p);
      const taskId = id();
      let n = 0;
      const timer = setInterval(() => {
        n += 25;
        if (n < 100) genSubs.forEach((cb) => cb({ taskId, projectId: p.id, status: "running", progress: n, stage: "Demo: building mesh" }));
        else {
          clearInterval(timer);
          const v: ModelVersion = { id: id(), projectId: p.id, version: 1, source: "demo", kind: "demo", format: "stl", url: CUBE_STL, stlUrl: CUBE_STL, thumbnailUrl: null, bytes: 1, targetHeightMm: null, createdAt: t() };
          versions.push(v);
          p.latestVersionId = v.id;
          p.state = "reviewing";
          genSubs.forEach((cb) => cb({ taskId, projectId: p.id, status: "succeeded", progress: 100, stage: "Model ready", versionId: v.id }));
        }
      }, 400);
      return { project: p, taskId };
    },
    setTargetHeight: async (vid, h: number | null) => {
      const v = versions.find((x) => x.id === vid)!;
      v.targetHeightMm = h;
      return v;
    },
    saveThumbnail: async (vid, png) => {
      const v = versions.find((x) => x.id === vid);
      const p = projects.find((x) => x.id === v?.projectId);
      if (p) p.thumbnailUrl = png;
    },
    onGenerationProgress: (cb) => (genSubs.add(cb), () => genSubs.delete(cb)),
    submitRecording: async (pcm, rate) => ({
      turn: turn("user", `(preview: ${(pcm.byteLength / 2 / rate).toFixed(1)}s recorded)`),
      reply: turn("assistant", "Preview mode: I can hear you, but I can't understand words yet."),
    }),
    sendText: async (text) => ({
      turn: turn("user", text),
      reply: turn("assistant", `Got it! In demo mode I'll make a placeholder model for "${text}".`),
      proposedPrompt: text,
    }),
    conversation: async () => turns,
    smartSearch: async (query) => ({ id: "preview-search", query, status: "ready", results: [] }),
    smartSearchState: async () => null,
    selectSmartModel: async () => { throw new Error("No preview search result"); },
    importSmartModel: async () => { throw new Error("Import is unavailable in preview mode"); },
    downloadSmartModel: async () => { throw new Error("Download is unavailable in preview mode"); },
    libraryManifest: async () => null,
    libraryPlate: async () => { throw new Error("unavailable in preview mode"); },
    printerStatus: async () => status,
    printerInfo: async () => ({ machineType: "Afinia 3D QD330", machineName: "QD330", firmware: "v2.1.3" }),
    onPrinterStatus: () => () => {},
    voiceTurn: async () => {},
    voiceText: async () => {},
    onVoiceEvent: () => () => {},
    onAppEvent: () => () => {},
    pendingAction: async () => null,
    confirmAction: async () => {},
    cancelAction: async () => {},
    requestRefine: async () => {},
    meshyBalance: async () => ({ error: "preview" }),
    testGemini: async () => ({ ok: false, message: "preview" }),
    slicerDefaults: async () => ({ zOffsetMm: -0.05, minZOffsetMm: -0.5, maxZOffsetMm: 1 }),
    preparePrint: async (versionId, settings) => ({
      jobId: "job-1", projectId: "p", versionId, createdAt: t(), settings: settings === "auto" ? { layerHeightMm: 0.2, infillPercent: 15, supports: "auto" } : settings, ok: true,
      advice: { slicer: "prusaslicer", layerHeightMm: 0.2, infillPercent: 15, supports: "buildplate", brim: false, reasons: ["Normal layers: a good mix of speed and detail", "Supports from the plate for the wings"], warnings: [], source: "heuristic" }, size: { x: 42, y: 40, z: 101.6 }, fits: true, upAxis: "y",
      repairs: ["welded vertices: 1204"], issues: [], warnings: ["The .gx layout is unverified against Afinia output."],
      slicer: { ok: false, reason: "slicer-not-installed", message: "PrusaSlicer is not installed (sudo apt install prusa-slicer)" },
      estimates: { printTimeS: 7260, filamentG: 18.4, filamentMm: 6170, layerCount: 508, source: "mesh-heuristic" },
      gx: { ok: false, verified: false, reason: "needs sliced G-code" }, previewUrl: null,
    }),
    latestPrintJob: async () => null,
    machineCommand: async (c) => ({ ok: true, message: `${c.cmd} ✅` }),
    machineCapabilities: async () => ["setLight", "setFan", "home", "setNozzleTemp", "coolDown", "emergencyStop"].map((command) => ({ command, verified: command === "home", enabled: true, allowedNow: true })),
    jobs: async () => [{ id: "j1", kind: "text-to-print", title: "Cute dragon", status: "running", percent: 42, currentStage: "generate", updatedAt: t(),
      stages: [{ key: "understand", label: "Understanding your idea", status: "done", progress: 100 }, { key: "generate", label: "Creating your 3D model", status: "running", progress: 60, detail: "Meshy: building the 3D shape" }, { key: "download", label: "Bringing the model home", status: "pending", progress: 0 }, { key: "prepare.slice", label: "Cutting it into thin layers", status: "pending", progress: 0 }], error: null }],
    portalInfo: async () => ({ running: true, url: "http://192.168.86.38:8443", authConfigured: false, missing: ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID"] }),
    remotePairing: async () => ({ running: true, qrDataUrl: null, expiresAt: null, message: "QR pairing is available on the Pi." }),
    requestPrint: async () => {},
    printStatus: async () => ({ enabled: false, gxVerified: false, job: null, busy: null, lastMessage: null }),
    pausePrint: async () => ({ ok: false, message: "preview" }),
    resumePrint: async () => ({ ok: false, message: "(mock) nothing to resume" }),
    filaments: async () => mockFilaments,
    setLoadedFilament: async (id: string) => ((mockFilaments.loaded = id), mockFilaments),
    filamentJob: async () => ({ ok: true, message: "(mock) filament job started" }),
    uiPage: async () => {},
    cancelPrint: async () => ({ ok: false, message: "preview" }),
    guardian: async () => ({ running: false, state: "idle", label: "Not monitoring", camera: "unknown", worker: "stopped", alert: null, gemini: false, autoPause: false, pauseAvailable: false }),
    guardianCommand: async () => ({ running: true, state: "monitoring", label: "Watching the print", camera: "ok", worker: "running", alert: null, gemini: false, autoPause: false, pauseAvailable: false }),
    guardianAnswer: async () => ({ ok: false, message: "No print warning is waiting for an answer." }),
    guardianSimulate: async () => ({ ok: true, message: "(mock) a test warning would be spoken now" }),
    networkStatus: async () => ({ hostname: "3dAImodel", wifi: { device: "wlan0", state: "connected", ssid: "hatsv2", ip: "192.168.86.38/24", signal: 72 }, ethernet: { device: "eth0", state: "connected", connection: "printer-lan", ip: "192.168.10.1/24" } }),
    wifiScan: async () => [
      { ssid: "hatsv2", signal: 72, security: "WPA2", inUse: true, saved: true },
      { ssid: "Hackathon-Guest", signal: 64, security: "WPA2", inUse: false, saved: false },
      { ssid: "CoffeeShop", signal: 41, security: "", inUse: false, saved: true },
      { ssid: "Neighbour 5G", signal: 22, security: "WPA3", inUse: false, saved: false },
    ],
    wifiConnect: async (ssid) => ({ ok: true, message: `Connected to ${ssid}` }),
    wifiForget: async (ssid) => ({ ok: true, message: `Forgot ${ssid}` }),
  };
}
