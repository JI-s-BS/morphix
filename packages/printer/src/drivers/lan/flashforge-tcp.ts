// Driver "flashforge-tcp": Afinia QD330 and older FlashForge printers (Adventurer 3/4, Finder,
// Guider) over the FlashForge M-code protocol on TCP 8899, with .gx upload (M28/M29).
//
// HARDWARE STATUS: this wraps QD330Controller (packages/printer/src/control.ts), which is
// tested on a real Afinia QD330 (firmware v2.1.3): status, info, upload, start (M23), cancel
// (M26) and homing are verified there. Pause (M25) and resume (M24) are not yet verified on
// hardware. The FlashForge models share the protocol but were not tried with Morphix.
//
// Safety: everything goes through QD330Controller, so its rules stay in force: one session at a
// time, every result is confirmed from the printer's own status, state is re-checked right before
// each command, and unverified machine commands (temperatures, fan, light, motors, M112) stay
// gated behind allowUnverified flags, which this driver never sets. The server is the approval
// gate (the user pressed Start); the driver issues a single-use, file-bound PrintAuthorization
// internally so the controller's token checks still run on every upload/start/resume.
import type { PrinterStatus } from "@morphix/shared";
import { PrintAuthorizer } from "../../auth";
import { DEFAULT_PAUSED_STATUSES, QD330Controller, STATUS_BUILDING, STATUS_READY, type ControlResult, type QD330ControllerOptions } from "../../control";
import { isPausedStatus } from "../../machine";
import { assertStoredFileName, InvalidFileNameError, sanitizeFileName } from "../../names";
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
import { bool, busy, failResult, invalidConnection, offline, requireHost, requirePort, safeLog, temp, toDriverError, wrongState } from "./common";

const HINT_UNREACHABLE = "Check the IP address (printer screen: Settings → Network / WiFi), that the printer is on, and that LAN access on port 8899 is not blocked.";
const HINT_REFUSED = "Another program (FlashPrint, Orca Slicer, another Morphix) holds the printer's control session. Close it, or restart the printer, then try again.";

/** Maps a QD330/FlashForge status (M119/M27/M105) to the driver PrintState. */
export function mapFlashforgeTcpStatus(st: PrinterStatus, pausedStatuses: string[] = DEFAULT_PAUSED_STATUSES): { state: PrintState; message?: string } {
  if (!st.online) return { state: "offline", message: st.error ?? "printer not reachable" };
  const machine = (st.machine ?? "").toUpperCase();
  if (isPausedStatus(st, pausedStatuses)) return { state: "paused", message: st.currentFile ? `Paused: ${st.currentFile}` : "Paused" };
  if (machine === STATUS_READY) {
    if ((st.moveMode ?? "").toUpperCase() === "MOVING") return { state: "busy", message: "Moving" };
    return { state: "idle", message: "Ready" };
  }
  if (machine === STATUS_BUILDING) {
    const n = st.temps?.nozzle;
    const heating = (st.progress ?? 0) === 0 && n !== undefined && n.target > 0 && n.current < n.target - 3;
    return heating ? { state: "heating", message: `Heating for ${st.currentFile ?? "print"}` } : { state: "printing", message: st.currentFile ? `Printing ${st.currentFile}` : "Printing" };
  }
  // Seen on FlashForge firmwares: BUILDING_COMPLETED until the job is cleared at the printer.
  if (machine === "BUILDING_COMPLETED") return { state: "busy", message: "Print finished; confirm it on the printer's screen" };
  if (machine === "BUSY") return { state: "busy", message: "Printer is busy" };
  if (/ERROR/.test(machine)) return { state: "error", message: `Printer reports ${st.machine}` };
  return { state: "busy", message: machine ? `Printer reports ${st.machine}` : "Unknown printer state" };
}

/** Turns a ControlResult that did not complete into a DriverError. */
export function controlError(r: ControlResult<unknown>, what: string): DriverError {
  const msg = `${what}: ${r.error ?? "not completed"}`;
  switch (r.failure) {
    case "unreachable":
      return new DriverError("unreachable", msg, HINT_UNREACHABLE);
    case "timeout":
      return new DriverError("timeout", msg, "The printer did not answer in time. Check it is on and not busy with a menu, then try again.");
    case "refused":
      return new DriverError("busy", msg, HINT_REFUSED);
    case "state":
      return new DriverError("busy", msg, "Wait until the printer shows Ready (or the expected state), then try again.");
    case "unconfirmed":
      return new DriverError("protocol", msg, "The printer accepted the command but its status did not change. Check the printer's screen.");
    default:
      return new DriverError("rejected", msg, "Check the file and the printer's screen, then try again.");
  }
}

class FlashforgeTcpConnection implements PrinterConnection {
  readonly driver = "flashforge-tcp" as const;
  private controller: QD330Controller;
  private authorizer = new PrintAuthorizer();
  private allowPlain: boolean;
  /** upload name the caller used -> name stored on the printer */
  private stored = new Map<string, string>();
  private now: () => number;

  constructor(config: DriverConfig, deps: DriverDeps, overrides: Partial<QD330ControllerOptions>) {
    const host = requireHost(config);
    const port = requirePort(config, "port", 8899);
    this.allowPlain = bool(config, "allowPlainGcode", false);
    this.now = deps.now ?? Date.now;
    const log = safeLog(deps, () => []);
    this.controller = new QD330Controller({
      enabled: true,
      host,
      port,
      allowPlainGcode: this.allowPlain,
      authorizer: this.authorizer,
      log: (e) =>
        log(e.outcome === "confirmed" ? "info" : "warn", `flashforge-tcp ${e.op} ${e.outcome}`, { file: e.fileName, error: e.error, status: e.status, sent: e.sent }),
      ...overrides,
    });
  }

  capabilities(): DriverCapabilities {
    const fileFormats: FileFormat[] = this.allowPlain ? ["gx", "gcode"] : ["gx"];
    return { fileFormats, upload: true, startPrint: true, pause: true, resume: true, cancel: true, setTemperature: false, gcodeConsole: false, camera: false };
  }

  async test(): Promise<TestResult> {
    try {
      const r = await this.controller.readInfo({ requestedBy: "system" });
      if (!r.confirmed || !r.data) return failResult(controlError(r, "reading printer info"), "test");
      return { ok: true, info: { model: r.data.machineType, firmware: r.data.firmware, serial: r.data.serial, name: r.data.machineName } };
    } catch (e) {
      return failResult(e, "test");
    }
  }

  async status(): Promise<DriverStatus> {
    let st: PrinterStatus;
    try {
      st = await this.controller.readStatus();
    } catch (e) {
      return offline(toDriverError(e, "status").message, this.now);
    }
    const { state, message } = mapFlashforgeTcpStatus(st);
    const layer = st.layer && st.layer[1] > 0 ? st.layer : undefined;
    return {
      state,
      message,
      temps: {
        nozzle: st.temps?.nozzle ? temp(st.temps.nozzle.current, st.temps.nozzle.target) : undefined,
        bed: st.temps?.bed ? temp(st.temps.bed.current, st.temps.bed.target) : undefined,
      },
      job:
        state === "printing" || state === "paused" || state === "heating"
          ? { file: st.currentFile, progress: st.progress !== undefined ? st.progress / 100 : undefined, layer }
          : undefined,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  /** "benchy.gcode" -> "benchy.g" when plain G-code is allowed; then the controller's sanitiser. */
  private storedName(name: string, format: FileFormat): string {
    let n = name;
    if (format === "gcode") {
      if (!this.allowPlain) throw new DriverError("unsupported", "this printer is set up for .gx files only", "Slice with a FlashForge/Afinia profile that writes .gx, or turn on plain G-code in the printer settings.");
      n = n.replace(/\.(gcode|gco|g)$/i, "") + ".g";
    } else if (format !== "gx") {
      throw new DriverError("unsupported", `${format} files are not supported by this printer`, "Slice with a FlashForge/Afinia profile that writes .gx.");
    }
    try {
      return sanitizeFileName(n, { allowPlainGcode: this.allowPlain });
    } catch (e) {
      throw new DriverError("rejected", (e as Error).message, "Rename the file using letters, numbers, - and _.");
    }
  }

  private grant(fileName: string) {
    return this.authorizer.authorize({ jobId: `driver:${fileName}`, fileName, approvedBy: "touch" });
  }

  private async requireState(allowed: PrintState[], action: string): Promise<void> {
    const s = await this.status();
    if (s.state === "offline") throw new DriverError("unreachable", s.message ?? "printer not reachable", HINT_UNREACHABLE);
    if (!allowed.includes(s.state)) throw allowed.includes("idle") ? busy(s.state, action) : wrongState(action, s.state);
  }

  async upload(file: { name: string; data: Buffer; format: FileFormat }): Promise<void> {
    const fileName = this.storedName(file.name, file.format);
    await this.requireState(["idle"], "upload");
    const r = await this.controller.uploadFile(fileName, file.data, { jobId: `driver:${fileName}`, authorization: this.grant(fileName), overwrite: true });
    if (!r.confirmed) throw controlError(r, "upload");
    this.stored.set(file.name, fileName);
  }

  async start(fileName: string): Promise<void> {
    let name = this.stored.get(fileName) ?? fileName;
    try {
      assertStoredFileName(name, { allowPlainGcode: this.allowPlain });
    } catch (e) {
      if (!(e instanceof InvalidFileNameError)) throw e;
      name = this.storedName(fileName, /\.gx$/i.test(fileName) ? "gx" : "gcode");
    }
    await this.requireState(["idle"], "start");
    const r = await this.controller.startPrint({ jobId: `driver:${name}`, fileName: name, authorization: this.grant(name) });
    if (!r.confirmed) throw controlError(r, "start");
  }

  async pause(): Promise<void> {
    await this.requireState(["printing", "heating"], "pause");
    const r = await this.controller.pause({ requestedBy: "portal" });
    if (!r.confirmed) throw controlError(r, "pause");
  }

  async resume(): Promise<void> {
    const s = await this.controller.readStatus().catch((e: unknown) => {
      throw toDriverError(e, "resume");
    });
    if (!isPausedStatus(s, DEFAULT_PAUSED_STATUSES)) throw wrongState("resume", mapFlashforgeTcpStatus(s).state);
    const file = s.currentFile?.split(/[\\/]/).pop();
    if (!file) throw new DriverError("protocol", "the printer does not report which file is paused", "Resume from the printer's screen.");
    const name = /\.(gx|g)$/i.test(file) ? file : `${file}.gx`;
    const r = await this.controller.resume({ jobId: `driver:${name}`, fileName: name, authorization: this.grant(name) });
    if (!r.confirmed) throw controlError(r, "resume");
  }

  async cancel(): Promise<void> {
    const s = await this.status();
    if (s.state === "idle") return; // nothing running
    if (s.state === "offline") throw new DriverError("unreachable", s.message ?? "printer not reachable", HINT_UNREACHABLE);
    const r = await this.controller.cancel({ requestedBy: "portal" });
    if (!r.confirmed) throw controlError(r, "cancel");
  }

  async close(): Promise<void> {
    this.controller.dispose();
  }
}

/** `overrides` lets tests shorten the controller's timeouts. */
export function createFlashforgeTcpDriver(overrides: Partial<QD330ControllerOptions> = {}): PrinterDriver {
  return {
    id: "flashforge-tcp",
    name: "FlashForge / Afinia (TCP 8899)",
    description: "Afinia QD330 and older FlashForge printers (Adventurer 3/4, Finder, Guider) over the network, with .gx files.",
    fields: [
      { key: "host", label: "Printer IP address", kind: "host", required: true, help: "On the printer's touch screen open Settings (gear) → Network or WiFi; the IP address is listed there." },
      { key: "port", label: "Port", kind: "port", required: false, default: 8899, help: "Leave at 8899; FlashForge printers always use it for network control." },
      {
        key: "allowPlainGcode",
        label: "Also send plain G-code (.g)",
        kind: "boolean",
        required: false,
        default: false,
        help: "Leave off for the Afinia QD330 and Adventurer 3/4 (they need .gx; plain .g stalled at 0% on the QD330). Finder/Guider owners may turn it on.",
      },
    ],
    connect(config: DriverConfig, deps: DriverDeps = {}) {
      try {
        return new FlashforgeTcpConnection(config, deps, overrides);
      } catch (e) {
        const caps: DriverCapabilities = { fileFormats: ["gx"], upload: true, startPrint: true, pause: true, resume: true, cancel: true, setTemperature: false, gcodeConsole: false, camera: false };
        return invalidConnection("flashforge-tcp", toDriverError(e, "settings"), caps, deps.now ?? Date.now);
      }
    },
  };
}

export const flashforgeTcpDriver = createFlashforgeTcpDriver();
