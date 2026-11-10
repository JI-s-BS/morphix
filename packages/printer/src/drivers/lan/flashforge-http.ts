// Driver "flashforge-http": FlashForge Adventurer 5M / 5M Pro / AD5X over the printer's local
// HTTP API on port 8898 (/detail, /uploadGcode, /printGcode, /control), authenticated with the
// printer's serial number and check code. When the HTTP API does not answer at all (connection
// refused, e.g. older firmware), status falls back to the read-only M-code protocol on TCP 8899.
//
// HARDWARE STATUS: implemented from the community protocol documentation (Parallel-7
// flashforge-api-docs, firmware 3.x) and tested only against a local fake. Not run on a real
// Adventurer 5M. `verified: "protocol"`.
//
// Safety: start is refused unless /detail says "ready" (or a finished/cancelled job); /control
// replies do not prove anything happened, so pause/resume/cancel/start are confirmed by polling
// /detail. The serial number and check code are never logged or put in URLs or messages.
import type { PrinterStatus } from "@morphix/shared";
import { QD330Controller } from "../../control";
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
  bool,
  busy,
  clamp01,
  failResult,
  fetchWithTimeout,
  invalidConnection,
  offline,
  pollUntil,
  readJson,
  redact,
  requireData,
  requireHost,
  requirePort,
  requireSecret,
  safeFileName,
  safeLog,
  temp,
  toDriverError,
  toNum,
  urlHost,
  wrongState,
  type Log,
} from "./common";
import { mapFlashforgeTcpStatus } from "./flashforge-tcp";

const AUTH_HINT =
  "Check the serial number and check code. On the printer screen open Settings → Network (WiFi icon) to see the check code; the serial number (SN) is under Settings → About (the 'i' icon).";

/** /detail "status" values (community docs). Anything unknown is treated as busy. */
export function mapFlashforgeHttpState(status: unknown): { state: PrintState; message: string } {
  const s = String(status ?? "").toLowerCase();
  switch (s) {
    case "ready":
      return { state: "idle", message: "Ready" };
    case "completed":
      return { state: "idle", message: "Print finished" };
    case "cancel":
      return { state: "idle", message: "Print cancelled" };
    case "heating":
      return { state: "heating", message: "Heating" };
    case "printing":
      return { state: "printing", message: "Printing" };
    case "pausing":
      return { state: "paused", message: "Pausing" };
    case "pause":
    case "paused":
      return { state: "paused", message: "Paused" };
    case "error":
      return { state: "error", message: "Printer reports an error; check its screen" };
    case "calibrate_doing":
      return { state: "busy", message: "Calibrating" };
    case "canceling":
      return { state: "busy", message: "Cancelling" };
    case "busy":
    case "downloading":
    case "cloud_slicing":
    case "sending":
    case "unzipping":
      return { state: "busy", message: `Busy (${s})` };
    default:
      return { state: "busy", message: s ? `Unknown printer state "${s}"` : "Unknown printer state" };
  }
}

const MODELS: Record<string, string> = { "35": "Adventurer 5M", "36": "Adventurer 5M Pro", "38": "AD5X" };

export function detailToStatus(d: Record<string, unknown>, checkedAt: string): DriverStatus {
  const { state, message } = mapFlashforgeHttpState(d.status);
  const file = typeof d.printFileName === "string" && d.printFileName ? d.printFileName : undefined;
  const cur = toNum(d.printLayer);
  const total = toNum(d.targetPrintLayer);
  const errorCode = typeof d.errorCode === "string" && d.errorCode && d.errorCode !== "0" ? d.errorCode : undefined;
  const active = state === "printing" || state === "paused" || state === "heating";
  return {
    state,
    message: [active && file ? `${message}: ${file}` : message, errorCode ? `error ${errorCode}` : ""].filter(Boolean).join(", "),
    temps: {
      nozzle: temp(d.rightTemp, d.rightTargetTemp),
      bed: temp(d.platTemp, d.platTargetTemp),
      chamber: temp(d.chamberTemp, d.chamberTargetTemp),
    },
    job: active
      ? {
          file,
          progress: clamp01(toNum(d.printProgress)),
          layer: cur !== undefined && total ? [cur, total] : undefined,
          elapsedS: toNum(d.printDuration),
          remainingS: toNum(d.estimatedTime),
        }
      : undefined,
    checkedAt,
  };
}

export interface FlashforgeHttpOptions {
  requestTimeoutMs?: number;
  confirmTimeoutMs?: number;
  pollMs?: number;
  /** TCP 8899 fallback status reader; tests inject a fake. */
  tcpStatus?: (host: string, port: number) => Promise<PrinterStatus>;
}

const CAPS = (camera: DriverCapabilities["camera"]): DriverCapabilities => ({
  fileFormats: ["gcode"],
  upload: true,
  startPrint: true,
  pause: true,
  resume: true,
  cancel: true,
  setTemperature: false,
  gcodeConsole: false,
  camera,
});

class FlashforgeHttpConnection implements PrinterConnection {
  readonly driver = "flashforge-http" as const;
  private host: string;
  private port: number;
  private serial: string;
  private code: string;
  private level: boolean;
  private f: typeof fetch;
  private now: () => number;
  private log: Log;
  private camera: DriverCapabilities["camera"] = false;
  private o: Required<Omit<FlashforgeHttpOptions, "tcpStatus">> & Pick<FlashforgeHttpOptions, "tcpStatus">;

  constructor(config: DriverConfig, deps: DriverDeps, opts: FlashforgeHttpOptions) {
    this.host = requireHost(config);
    this.port = requirePort(config, "port", 8898);
    this.serial = requireSecret(config, "serialNumber", "serial number", AUTH_HINT);
    this.code = requireSecret(config, "checkCode", "check code", AUTH_HINT);
    this.level = bool(config, "levelBeforePrint", false);
    this.f = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.log = safeLog(deps, () => [this.serial, this.code]);
    this.o = { requestTimeoutMs: 5000, confirmTimeoutMs: 20_000, pollMs: 1000, ...opts };
  }

  private get secrets() {
    return [this.serial, this.code];
  }

  private url(path: string) {
    return `http://${urlHost(this.host)}:${this.port}${path}`;
  }

  /** POST JSON with credentials in the body. Returns the parsed reply when code is 0. */
  private async post(path: string, body: Record<string, unknown>, what: string): Promise<Record<string, unknown>> {
    const res = await fetchWithTimeout(
      this.f,
      this.url(path),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ serialNumber: this.serial, checkCode: this.code, ...body }) },
      this.o.requestTimeoutMs,
      what,
      this.secrets,
    );
    if (res.status === 404) throw new DriverError("unsupported", `${what}: the printer has no ${path} endpoint`, "Update the printer's firmware (Settings → About → Update) to get the local HTTP API.");
    const j = await readJson(res, what);
    return this.checkCode(j, what);
  }

  private checkCode(j: Record<string, unknown>, what: string): Record<string, unknown> {
    const code = toNum(j.code);
    if (code === 0) return j;
    const message = redact(String(j.message ?? "error"), this.secrets);
    if (code === 1 || /access code|check ?code|SN is different|serial/i.test(message)) throw new DriverError("auth", `${what}: printer rejected the serial number or check code (${message})`, AUTH_HINT);
    if (code === 2) throw new DriverError("busy", `${what}: printer is busy (${message})`, "Wait for the current job to finish, then try again.");
    if (code === 3) throw new DriverError("rejected", `${what}: file not found on the printer (${message})`, "Upload the file again, then start it.");
    throw new DriverError("rejected", `${what}: printer answered code ${String(j.code)} (${message})`, "Check the printer's screen, then try again.");
  }

  private async detail(): Promise<Record<string, unknown>> {
    const j = await this.post("/detail", {}, "status");
    const d = j.detail;
    if (!d || typeof d !== "object") throw new DriverError("protocol", "status: reply has no detail", "Update the printer's firmware, then try again.");
    const cam = (d as Record<string, unknown>).cameraStreamUrl;
    this.camera = typeof cam === "string" && /^https?:\/\//.test(cam) ? { kind: "mjpeg", url: cam } : false;
    return d as Record<string, unknown>;
  }

  capabilities(): DriverCapabilities {
    return CAPS(this.camera);
  }

  async test(): Promise<TestResult> {
    try {
      const d = await this.detail();
      const pid = String(d.pid ?? "");
      return { ok: true, info: { model: MODELS[pid] ?? (pid ? `FlashForge (pid ${pid})` : "FlashForge"), firmware: d.firmwareVersion as string | undefined, serial: this.serial, name: d.name as string | undefined } };
    } catch (e) {
      return failResult(e, "test", this.secrets);
    }
  }

  async status(): Promise<DriverStatus> {
    const at = () => new Date(this.now()).toISOString();
    try {
      return detailToStatus(await this.detail(), at());
    } catch (e) {
      const d = toDriverError(e, "status", this.secrets);
      if (d.code === "auth") return { state: "error", message: `${d.message}. ${d.hint}`, checkedAt: at() };
      if (d.code === "unreachable" || d.code === "unsupported") {
        const tcp = await this.tcpFallback();
        if (tcp) return tcp;
      }
      return offline(d.message, this.now);
    }
  }

  /** Read-only M119/M105/M27 on TCP 8899 (no control session for printing). */
  private async tcpFallback(): Promise<DriverStatus | null> {
    try {
      const read = this.o.tcpStatus ?? ((host, port) => new QD330Controller({ enabled: false, host, port, connectTimeoutMs: 2000, replyTimeoutMs: 2500 }).readStatus());
      const st = await read(this.host, 8899);
      const { state, message } = mapFlashforgeTcpStatus(st);
      return {
        state,
        message: `${message ?? state} (from TCP 8899; the HTTP API on port ${this.port} did not answer)`,
        temps: { nozzle: st.temps?.nozzle ? temp(st.temps.nozzle.current, st.temps.nozzle.target) : undefined, bed: st.temps?.bed ? temp(st.temps.bed.current, st.temps.bed.target) : undefined },
        checkedAt: new Date(this.now()).toISOString(),
      };
    } catch {
      return null;
    }
  }

  private async state(): Promise<PrintState> {
    try {
      return detailToStatus(await this.detail(), "").state;
    } catch (e) {
      throw toDriverError(e, "status", this.secrets);
    }
  }

  async upload(file: { name: string; data: Buffer; format: FileFormat }): Promise<void> {
    if (file.format !== "gcode") throw new DriverError("unsupported", `${file.format} files are not supported by this printer`, "Slice with an Adventurer 5M / AD5X profile that writes .gcode.");
    const name = safeFileName(file.name, [".gcode", ".gx"]);
    requireData(file.data);
    const s = await this.state();
    if (s !== "idle") throw busy(s, "upload");
    const form = new FormData();
    form.append("gcodeFile", new Blob([new Uint8Array(file.data)], { type: "application/octet-stream" }), name);
    const ms = 30_000 + Math.ceil(file.data.length / 100_000) * 1000;
    const res = await fetchWithTimeout(
      this.f,
      this.url("/uploadGcode"),
      {
        method: "POST",
        headers: { serialNumber: this.serial, checkCode: this.code, fileSize: String(file.data.length), printNow: "false", levelingBeforePrint: this.level ? "true" : "false" },
        body: form,
      },
      ms,
      "upload",
      this.secrets,
    );
    this.checkCode(await readJson(res, "upload"), "upload");
    this.log("info", "flashforge-http upload done", { file: name, bytes: file.data.length });
  }

  private async confirm(ok: (s: PrintState) => boolean, what: string, expected: string): Promise<void> {
    const r = await pollUntil(
      () => this.state().catch(() => "offline" as PrintState),
      ok,
      this.o.confirmTimeoutMs,
      this.o.pollMs,
    );
    if (!r.ok) throw new DriverError("protocol", `${what}: the printer accepted the command but did not become ${expected} within ${this.o.confirmTimeoutMs} ms (now ${r.value})`, "Check the printer's screen.");
  }

  async start(fileName: string): Promise<void> {
    const name = safeFileName(fileName, [".gcode", ".gx"]);
    const s = await this.state();
    if (s !== "idle") throw busy(s, "start");
    await this.post("/printGcode", { fileName: name, levelingBeforePrint: this.level }, "start");
    this.log("info", "flashforge-http start sent", { file: name });
    await this.confirm((x) => x !== "idle" && x !== "offline", "start", "busy, heating or printing");
  }

  private async job(action: "pause" | "continue" | "cancel"): Promise<void> {
    await this.post("/control", { payload: { cmd: "jobCtl_cmd", args: { jobID: "", action } } }, action);
    this.log("info", `flashforge-http ${action} sent`);
  }

  async pause(): Promise<void> {
    const s = await this.state();
    if (s !== "printing" && s !== "heating") throw wrongState("pause", s);
    await this.job("pause");
    await this.confirm((x) => x === "paused", "pause", "paused");
  }

  async resume(): Promise<void> {
    const s = await this.state();
    if (s !== "paused") throw wrongState("resume", s);
    await this.job("continue");
    await this.confirm((x) => x === "printing" || x === "heating", "resume", "printing");
  }

  async cancel(): Promise<void> {
    const s = await this.state();
    if (s === "idle") return;
    await this.job("cancel");
    await this.confirm((x) => x === "idle" || x === "busy", "cancel", "idle");
  }

  async close(): Promise<void> {}
}

export function createFlashforgeHttpDriver(opts: FlashforgeHttpOptions = {}): PrinterDriver {
  return {
    id: "flashforge-http",
    name: "FlashForge Adventurer 5M / AD5X (HTTP)",
    description: "FlashForge Adventurer 5M, 5M Pro and AD5X over their local network API (port 8898).",
    fields: [
      { key: "host", label: "Printer IP address", kind: "host", required: true, help: "On the printer screen open Settings → Network (WiFi icon); the IP address is shown there." },
      { key: "serialNumber", label: "Serial number", kind: "text", required: true, help: "On the printer screen open Settings → About (the 'i' icon); copy the SN (it starts with SN…). It is also on the label on the back." },
      {
        key: "checkCode",
        label: "Check code",
        kind: "secret",
        required: true,
        help: "On the printer screen open Settings → Network (WiFi icon); the 8-character check code is shown there (turn on 'LAN only' mode if it is hidden).",
      },
      { key: "levelBeforePrint", label: "Auto-level before each print", kind: "boolean", required: false, default: false, help: "Runs the printer's bed levelling before starting; adds a few minutes." },
      { key: "port", label: "Port", kind: "port", required: false, default: 8898, help: "Leave at 8898." },
    ],
    connect(config: DriverConfig, deps: DriverDeps = {}) {
      try {
        return new FlashforgeHttpConnection(config, deps, opts);
      } catch (e) {
        return invalidConnection("flashforge-http", toDriverError(e, "settings"), CAPS(false), deps.now ?? Date.now);
      }
    },
  };
}

export const flashforgeHttpDriver = createFlashforgeHttpDriver();
