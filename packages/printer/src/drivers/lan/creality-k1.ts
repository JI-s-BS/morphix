// Driver "creality-k1": Creality K1 / K1C / K1 Max / K2 Plus / Ender-3 V3 on STOCK firmware, using
// the printer's own WebSocket on port 9999 (JSON status frames, {"method":"get"|"set","params"})
// and the stock HTTP upload service on port 80 (POST /upload/<name>, form field "file").
//
// HARDWARE STATUS: implemented from community reverse-engineering, tested only against a local
// fake, not on a real printer. `verified: "protocol"`. Confidence per feature:
//  - status frames, pause {"pause":1}, resume {"pause":0}, stop {"stop":1}: used by the
//    ha_creality_ws Home Assistant integration with recorded K1C traces (firmware 1.3.5.22);
//  - upload (port 80) and start {"opGcodeFile":"printprt:<path>"}: used by the K2Dash project on a
//    K2 Plus; the K1 gcode folder (/usr/data/printer_data/gcodes) is from rooted-K1 docs. These two
//    are the least certain: start is confirmed from the status and fails plainly if nothing happens.
// Rooted printers with Moonraker should use the "moonraker" driver instead (more complete, better
// documented).
//
// Safety: start is refused unless the printer reports idle; the stock API has no password, so
// anyone on the network can control the printer.
import {
  DriverError,
  type DriverCapabilities,
  type DriverConfig,
  type DriverDeps,
  type DriverStatus,
  type FileFormat,
  type PrinterConnection,
  type PrinterDriver,
  type PrintState,
  type TestResult,
} from "../types";
import {
  busy,
  clamp01,
  failResult,
  fetchWithTimeout,
  invalidConnection,
  offline,
  pollUntil,
  requireData,
  requireHost,
  safeFileName,
  safeLog,
  str,
  temp,
  toDriverError,
  toNum,
  urlHost,
  WsSession,
  type Log,
} from "./common";

const K1_GCODES = "/usr/data/printer_data/gcodes";
const K2_GCODES = "/mnt/UDISK/printer_data/gcodes";

/** Maps a merged K-series telemetry snapshot to PrintState. */
export function mapCrealityState(d: Record<string, unknown>): { state: PrintState; message: string } {
  const selfTest = toNum(d.withSelfTest);
  if (selfTest !== undefined && selfTest >= 1 && selfTest <= 99) return { state: "busy", message: `Self-test ${selfTest}%` };
  const state = toNum(d.state);
  const err = d.err && typeof d.err === "object" ? toNum((d.err as Record<string, unknown>).errcode) : toNum(d.err);
  // The printer keeps some error codes after they are resolved, so an error code alone does not
  // block a new print; it is shown in the message.
  const note = err ? ` (printer error code ${err})` : "";
  switch (state) {
    case 0:
      return { state: "idle", message: `Ready${note}` };
    case 1: {
      const n = temp(d.nozzleTemp, d.targetNozzleTemp);
      const heating = (toNum(d.printProgress) ?? 0) === 0 && n?.target !== undefined && n.target > 0 && n.actual < n.target - 3;
      return heating ? { state: "heating", message: `Heating${note}` } : { state: "printing", message: `Printing${note}` };
    }
    case 2:
      return { state: "idle", message: `Print finished${note}` };
    case 4:
      return { state: "idle", message: `Print stopped${note}` };
    case 5:
      return { state: "paused", message: `Paused${note}` };
    case 7:
      return { state: "busy", message: `Stopping${note}` };
    case 9:
      return { state: "busy", message: `Starting a print${note}` };
    default:
      if (err) return { state: "error", message: `Printer reports error code ${err}` };
      return { state: "busy", message: state === undefined ? "Waiting for printer status" : `Unknown printer state ${state}` };
  }
}

export function crealityToStatus(d: Record<string, unknown>, checkedAt: string): DriverStatus {
  const { state, message } = mapCrealityState(d);
  const active = state === "printing" || state === "paused" || state === "heating";
  const fileRaw = typeof d.printFileName === "string" ? d.printFileName : "";
  const file = fileRaw ? fileRaw.split("/").pop() : undefined;
  const layer = toNum(d.layer);
  const total = toNum(d.TotalLayer);
  const progress = toNum(d.printProgress) ?? toNum(d.dProgress);
  return {
    state,
    message: active && file ? `${message}: ${file}` : message,
    temps: { nozzle: temp(d.nozzleTemp, d.targetNozzleTemp), bed: temp(d.bedTemp0, d.targetBedTemp0), chamber: temp(d.boxTemp, d.targetBoxTemp) },
    job: active
      ? {
          file,
          progress: clamp01(progress !== undefined ? progress / 100 : undefined),
          layer: layer !== undefined && total ? [layer, total] : undefined,
          elapsedS: toNum(d.printJobTime),
          remainingS: toNum(d.printLeftTime),
        }
      : undefined,
    checkedAt,
  };
}

export interface CrealityOptions {
  openTimeoutMs?: number;
  requestTimeoutMs?: number;
  confirmTimeoutMs?: number;
  pollMs?: number;
  wsPort?: number;
  httpPort?: number;
}

const CAPS: DriverCapabilities = {
  fileFormats: ["gcode"],
  upload: true,
  startPrint: true,
  pause: true,
  resume: true,
  cancel: true,
  setTemperature: false,
  gcodeConsole: false,
  camera: false,
};

class CrealityConnection implements PrinterConnection {
  readonly driver = "creality-k1" as const;
  private host: string;
  private folder: string;
  private ws: WsSession;
  private merged: Record<string, unknown> = {};
  private frames = 0;
  private now: () => number;
  private f: typeof fetch;
  private log: Log;
  private o: Required<CrealityOptions>;

  constructor(config: DriverConfig, deps: DriverDeps, opts: CrealityOptions) {
    this.host = requireHost(config);
    this.folder = str(config, "gcodeFolder").replace(/\/+$/, "");
    this.now = deps.now ?? Date.now;
    this.f = deps.fetch ?? fetch;
    this.log = safeLog(deps, () => []);
    this.o = { openTimeoutMs: 5000, requestTimeoutMs: 5000, confirmTimeoutMs: 30_000, pollMs: 1000, wsPort: 9999, httpPort: 80, ...opts };
    this.ws = new WsSession(`ws://${urlHost(this.host)}:${this.o.wsPort}`, deps.WebSocket ?? WebSocket, {
      protocols: ["wsslicer"],
      openTimeoutMs: this.o.openTimeoutMs,
      what: "Creality printer",
      onText: (text, ws) => {
        // Heartbeat: {"ModeCode":"heart_beat",...} must be answered with the bare text "ok".
        if (text.includes('"heart_beat"')) {
          try {
            ws.send("ok");
          } catch {
            /* closed */
          }
          return true;
        }
        return text === "ok";
      },
    });
    this.ws.onMessage((m) => {
      if (m && typeof m === "object" && !Array.isArray(m)) {
        this.merged = { ...this.merged, ...(m as Record<string, unknown>) };
        this.frames++;
      }
    });
  }

  private gcodeFolder(): string {
    if (this.folder) return this.folder;
    const model = String(this.merged.model ?? this.merged.modelVersion ?? "");
    return /K2/i.test(model) ? K2_GCODES : K1_GCODES;
  }

  /** Asks for the full state and waits for a frame with the print state in it. */
  private async fresh(): Promise<Record<string, unknown>> {
    const before = this.frames;
    await this.ws.send(JSON.stringify({ method: "get", params: { ReqPrinterPara: 1 } }));
    const r = await pollUntil(async () => this.frames, (n) => n > before && this.merged.state !== undefined, this.o.requestTimeoutMs, 50);
    if (!r.ok) {
      if (this.merged.state !== undefined) return this.merged; // printer slow to answer; use the last frames
      throw new DriverError("timeout", `status: the printer sent no status within ${this.o.requestTimeoutMs} ms`, "Check that this is a Creality K-series printer on stock firmware (port 9999).");
    }
    return this.merged;
  }

  capabilities(): DriverCapabilities {
    return CAPS;
  }

  async test(): Promise<TestResult> {
    try {
      const d = await this.fresh();
      return { ok: true, info: { model: d.model as string | undefined, firmware: d.modelVersion as string | undefined, name: d.hostname as string | undefined } };
    } catch (e) {
      return failResult(e, "test");
    }
  }

  async status(): Promise<DriverStatus> {
    try {
      return crealityToStatus(await this.fresh(), new Date(this.now()).toISOString());
    } catch (e) {
      this.ws.close();
      return offline(toDriverError(e, "status").message, this.now);
    }
  }

  private async state(): Promise<PrintState> {
    try {
      return mapCrealityState(await this.fresh()).state;
    } catch (e) {
      throw toDriverError(e, "status");
    }
  }

  private async set(params: Record<string, unknown>, what: string): Promise<void> {
    try {
      await this.ws.send(JSON.stringify({ method: "set", params }));
    } catch (e) {
      throw toDriverError(e, what);
    }
    this.log("info", `creality-k1 ${what} sent`);
  }

  private async confirm(ok: (s: PrintState) => boolean, what: string, expected: string): Promise<void> {
    const r = await pollUntil(() => this.state().catch(() => "offline" as PrintState), ok, this.o.confirmTimeoutMs, this.o.pollMs);
    if (!r.ok) throw new DriverError("protocol", `${what}: sent, but the printer did not become ${expected} within ${this.o.confirmTimeoutMs} ms (now ${r.value})`, "Check the printer's screen. On rooted printers the Moonraker driver is more reliable.");
  }

  async upload(file: { name: string; data: Buffer; format: FileFormat }): Promise<void> {
    if (file.format !== "gcode") throw new DriverError("unsupported", `${file.format} files are not supported by this printer`, "Slice with a Creality K-series profile that writes .gcode.");
    const name = safeFileName(file.name, [".gcode"]);
    requireData(file.data);
    const s = await this.state();
    if (s !== "idle") throw busy(s, "upload");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file.data)], { type: "application/octet-stream" }), name);
    const ms = 30_000 + Math.ceil(file.data.length / 100_000) * 1000;
    const res = await fetchWithTimeout(this.f, `http://${urlHost(this.host)}:${this.o.httpPort}/upload/${encodeURIComponent(name)}`, { method: "POST", body: form }, ms, "upload");
    if (res.status === 404) throw new DriverError("unsupported", "upload: this printer has no stock upload service on port 80", "Upload from Creality Print, or root the printer and use the Moonraker driver.");
    if (res.status < 200 || res.status >= 300) throw new DriverError("rejected", `upload: printer answered HTTP ${res.status}`, "Check there is free space on the printer, then try again.");
    this.log("info", "creality-k1 upload done", { file: name, bytes: file.data.length });
  }

  async start(fileName: string): Promise<void> {
    const name = safeFileName(fileName, [".gcode"]);
    const s = await this.state();
    if (s !== "idle") throw busy(s, "start");
    const params: Record<string, unknown> = { opGcodeFile: `printprt:${this.gcodeFolder()}/${name}` };
    if (/K2/i.test(String(this.merged.model ?? ""))) params.enableSelfTest = 0;
    await this.set(params, "start");
    await this.confirm((x) => x !== "idle" && x !== "offline", "start", "busy or printing");
  }

  async pause(): Promise<void> {
    const s = await this.state();
    if (s !== "printing" && s !== "heating") throw new DriverError("rejected", `nothing to pause: printer is ${s}`, "Refresh the printer status; the job may already have changed.");
    await this.set({ pause: 1 }, "pause");
    await this.confirm((x) => x === "paused", "pause", "paused");
  }

  async resume(): Promise<void> {
    const s = await this.state();
    if (s !== "paused") throw new DriverError("rejected", `nothing to resume: printer is ${s}`, "Refresh the printer status; the job may already have changed.");
    await this.set({ pause: 0 }, "resume");
    await this.confirm((x) => x === "printing" || x === "heating", "resume", "printing");
  }

  async cancel(): Promise<void> {
    const s = await this.state();
    if (s === "idle") return;
    await this.set({ stop: 1 }, "cancel");
    await this.confirm((x) => x === "idle" || x === "busy", "cancel", "stopped");
  }

  async close(): Promise<void> {
    this.ws.close();
  }
}

export function createCrealityK1Driver(opts: CrealityOptions = {}): PrinterDriver {
  return {
    id: "creality-k1",
    name: "Creality K1 / K2 (stock firmware)",
    description: "Creality K1, K1C, K1 Max, K2 Plus and Ender-3 V3 on stock firmware, over their local WebSocket (port 9999). Rooted printers: use Moonraker.",
    fields: [
      {
        key: "host",
        label: "Printer IP address",
        kind: "host",
        required: true,
        help: "On the printer screen open Settings → Network; the IP address is shown under the connected WiFi. If you rooted the printer and installed Moonraker, pick the Klipper (Moonraker) driver instead.",
      },
      {
        key: "gcodeFolder",
        label: "G-code folder on the printer (optional)",
        kind: "text",
        required: false,
        help: "Leave empty: /usr/data/printer_data/gcodes is used for K1 / Ender-3 V3 and /mnt/UDISK/printer_data/gcodes for the K2 Plus.",
      },
    ],
    connect(config: DriverConfig, deps: DriverDeps = {}) {
      try {
        return new CrealityConnection(config, deps, opts);
      } catch (e) {
        return invalidConnection("creality-k1", toDriverError(e, "settings"), CAPS, deps.now ?? Date.now);
      }
    },
  };
}

export const crealityK1Driver = createCrealityK1Driver();
