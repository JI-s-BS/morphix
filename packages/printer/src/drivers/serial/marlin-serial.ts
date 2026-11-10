// Driver "marlin-serial": any Marlin printer plugged in by USB (Creality Ender-3/5/CR-10, Anycubic
// i3 Mega / Kobra Neo, Artillery Sidewinder / Genius, Sovol SV06, Prusa MK3S+ over USB, Elegoo
// Neptune 1-3, ...). The printer has no network storage, so upload() keeps the file in Morphix's data
// dir and start() streams it line by line through GcodeSender. Pause stops streaming (an optional
// user G-code may park; nothing moves by default). Cancel stops streaming and sends heaters off, fan
// off, motors off; no moves unless the user configured them.
// PROTOCOL IMPLEMENTATION: written from the Marlin G-code / serial docs and tested against an
// in-memory fake Marlin. It has NOT been run on a real printer (catalog: verified "protocol").
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  DriverError,
  type DriverCapabilities,
  type DriverConfig,
  type DriverDeps,
  type DriverStatus,
  type PrinterConnection,
  type PrinterDriver,
  type TestResult,
} from "../types";
import { cleanGcodeLine, parseM115, parseSdProgress, userGcode, type FirmwareInfo, type Temps } from "./marlin-gcode";
import {
  isSerialPath,
  listSerialPorts,
  openSerialPort,
  SUPPORTED_BAUDS,
  type ListSerialPorts,
  type OpenSerialPort,
  type SerialPortHandle,
} from "./marlin-port";
import { GcodeSender, type JobSource } from "./marlin-sender";

export interface MarlinSerialOptions {
  openPort?: OpenSerialPort;
  listPorts?: ListSerialPorts;
  /** Where uploaded G-code waits until start(). Default: $MORPHIX_DATA_DIR/jobs/serial (read when used). */
  storeDir?: string;
  /** Wait after opening for the board to reboot (opening the port resets most boards). */
  bootWaitMs?: number;
  handshakeTimeoutMs?: number;
  commandTimeoutMs?: number;
  okTimeoutMs?: number;
  deadAfterMs?: number;
  /** M105 polling interval when the firmware cannot auto-report temperatures. */
  tempPollMs?: number;
  /** After a failed connect, status() waits this long before trying the port again. */
  retryMs?: number;
}

type Opts = Required<Omit<MarlinSerialOptions, "storeDir">> & { storeDir?: string };

const CLEAR_HINT = "Fix the cause shown on the printer's screen, power-cycle the printer, then press Cancel in Morphix to clear the error.";

const HEATING = /^M(?:109|190|191|116)\b/i;

function defaultStoreDir(): string {
  const data = process.env.MORPHIX_DATA_DIR || join(homedir(), ".local", "share", "morphix");
  return join(data, "jobs", "serial");
}

function safeName(name: string): string {
  const b = basename(name).replace(/[^\w.+-]+/g, "_").replace(/^\.+/, "");
  return b || "job.gcode";
}

/** Walks a G-code text one command at a time (no big array of lines in memory). */
class TextJob {
  private pos = 0;
  constructor(private text: string) {}
  next(): string | undefined {
    while (this.pos < this.text.length) {
      let end = this.text.indexOf("\n", this.pos);
      if (end < 0) end = this.text.length;
      const c = cleanGcodeLine(this.text.slice(this.pos, end));
      this.pos = end + 1;
      if (c && !/^M110\b/i.test(c)) return c;
    }
    return undefined;
  }
  static count(text: string): number {
    const t = new TextJob(text);
    let n = 0;
    while (t.next() !== undefined) n++;
    return n;
  }
}

interface Job {
  name: string;
  total: number;
  acked: number;
  startedAt: number;
  paused: boolean;
  sent: boolean;
}

class MarlinConnection implements PrinterConnection {
  readonly driver = "marlin-serial" as const;
  private readonly path: string;
  private readonly baud: number;
  private readonly now: () => number;
  private port?: SerialPortHandle;
  private sender?: GcodeSender;
  private connecting?: Promise<GcodeSender>;
  private lastFail?: { at: number; err: DriverError };
  private info: FirmwareInfo = { autoReportTemp: false };
  private extruders = 1;
  private temps: Temps = {};
  private job?: Job;
  private errorMessage?: string;
  private lastMessage?: string;
  private sd?: { at: number; progress: [number, number] | null };
  private poll?: ReturnType<typeof setInterval>;
  private closedByUser = false;

  constructor(private config: DriverConfig, private opts: Opts, private deps: DriverDeps) {
    this.path = String(config.port ?? "").trim();
    const baud = Number(config.baud ?? 115200);
    this.baud = (SUPPORTED_BAUDS as readonly number[]).includes(baud) ? baud : 115200;
    this.now = deps.now ?? Date.now;
  }

  capabilities(): DriverCapabilities {
    return {
      fileFormats: ["gcode"],
      upload: true,
      startPrint: true,
      pause: true,
      resume: true,
      cancel: true,
      setTemperature: true,
      gcodeConsole: true,
      camera: false,
    };
  }

  async test(): Promise<TestResult> {
    try {
      await this.connected();
      if (this.errorMessage) {
        return { ok: false, code: "protocol", message: this.errorMessage,
          hint: CLEAR_HINT };
      }
      return { ok: true, info: { firmware: this.info.firmware, model: this.info.machine, serial: this.info.uuid, name: this.info.machine } };
    } catch (e) {
      const err = asDriverError(e);
      return { ok: false, code: err.code, message: err.message, hint: err.hint };
    }
  }

  async status(): Promise<DriverStatus> {
    const checkedAt = new Date(this.now()).toISOString();
    try {
      await this.connected();
    } catch (e) {
      const err = asDriverError(e);
      return { state: "offline", message: err.hint ? `${err.message}. ${err.hint}` : err.message, checkedAt };
    }
    const temps = this.tempsCopy();
    if (this.errorMessage) return { state: "error", message: this.errorMessage, temps, checkedAt };
    const job = this.job;
    if (job) {
      const progress = job.total ? job.acked / job.total : 0;
      const elapsedS = Math.round((this.now() - job.startedAt) / 1000);
      const remainingS = progress > 0.02 && progress < 1 ? Math.round((elapsedS / progress) * (1 - progress)) : undefined;
      const state = job.paused ? "paused" : job.sent ? "finishing" : HEATING.test(this.sender?.current ?? "") ? "heating" : "printing";
      const verb = { paused: "Paused", finishing: "Finishing", heating: "Heating for", printing: "Printing" }[state];
      return { state, message: `${verb} ${job.name}`, temps, job: { file: job.name, progress, elapsedS, remainingS }, checkedAt };
    }
    // Nothing streamed by us: the printer may be running a print from its own SD card / USB stick.
    if (!this.sd || this.now() - this.sd.at > 10_000) await this.checkSd().catch(() => {});
    if (this.sd?.progress) {
      const [done, total] = this.sd.progress;
      return { state: "printing", message: "Printing from the printer's own SD card", temps,
        job: { progress: total ? done / total : undefined }, checkedAt };
    }
    return { state: "idle", message: this.lastMessage, temps, checkedAt };
  }

  async upload(file: { name: string; data: Buffer; format: string }): Promise<void> {
    if (file.format !== "gcode") {
      throw new DriverError("unsupported", `Marlin printers take plain G-code, not .${file.format}`,
        "Slice for this printer with G-code output.");
    }
    const dir = this.storeDir();
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(join(dir, safeName(file.name)), file.data);
      await this.pruneStore(dir, safeName(file.name));
    } catch (e) {
      throw new DriverError("rejected", `Could not store ${safeName(file.name)}: ${(e as Error).message}`,
        "Check that Morphix's data directory is writable and has free space.");
    }
  }

  async start(fileName: string): Promise<void> {
    const sender = await this.connected();
    if (this.errorMessage) {
      throw new DriverError("busy", `Printer is in an error state: ${this.errorMessage}`,
        CLEAR_HINT);
    }
    if (this.job) throw new DriverError("busy", `Already printing ${this.job.name}`, "Wait for it to finish or cancel it first.");
    await this.checkSd();
    if (this.sd?.progress) {
      throw new DriverError("busy", "The printer is running a print from its own SD card",
        "Wait for it to finish or stop it on the printer's screen.");
    }
    let text: string;
    try {
      text = await fsp.readFile(join(this.storeDir(), safeName(fileName)), "latin1");
    } catch {
      throw new DriverError("rejected", `${safeName(fileName)} has not been uploaded`, "Upload the sliced file again, then start.");
    }
    const total = TextJob.count(text);
    if (!total) throw new DriverError("rejected", `${safeName(fileName)} contains no G-code commands`, "Slice the model again.");
    const job: Job = { name: safeName(fileName), total, acked: 0, startedAt: this.now(), paused: false, sent: false };
    const lines = new TextJob(text);
    this.job = job;
    this.lastMessage = undefined;
    const source: JobSource = {
      next: () => {
        const c = lines.next();
        if (c === undefined) job.sent = true;
        return c;
      },
      onAck: () => { job.acked++; },
      onDone: () => {
        if (this.job !== job) return;
        this.job = undefined;
        this.lastMessage = `Finished ${job.name}`;
        this.log("info", "print finished", { file: job.name });
      },
    };
    sender.stream(source);
    this.log("info", "print started", { file: job.name, lines: total });
  }

  async pause(): Promise<void> {
    const sender = await this.connected();
    const job = this.job;
    if (!job || job.sent) throw new DriverError("rejected", "Nothing is printing", "Start a print first.");
    if (job.paused) return;
    sender.pauseStream(true);
    job.paused = true;
    for (const cmd of userGcode(this.config.pauseGcode)) await sender.command(cmd, this.opts.commandTimeoutMs).catch(() => {});
  }

  async resume(): Promise<void> {
    const sender = await this.connected();
    const job = this.job;
    if (!job?.paused) throw new DriverError("rejected", "The print is not paused", "Pause it first.");
    for (const cmd of userGcode(this.config.resumeGcode)) await sender.command(cmd, this.opts.commandTimeoutMs);
    job.paused = false;
    sender.pauseStream(false);
  }

  async cancel(): Promise<void> {
    if (this.errorMessage && !this.job) {
      // Halted firmware ignores everything until reset; reopening the port resets most boards.
      this.errorMessage = undefined;
      await this.disconnect();
      return;
    }
    const sender = await this.connected();
    const job = this.job;
    if (!job && !this.sd?.progress) throw new DriverError("rejected", "Nothing is printing", "There is no print to cancel.");
    sender.stopStream();
    this.job = undefined;
    // Break out of an M109/M190 heating wait (Marlin's emergency parser handles M108 at once).
    sender.urgent("M108");
    const end: string[] = [];
    if (!job && this.sd?.progress) end.push("M524");
    end.push(...userGcode(this.config.cancelGcode));
    for (let t = 0; t < this.extruders; t++) end.push(this.extruders > 1 ? `M104 T${t} S0` : "M104 S0");
    end.push("M140 S0", "M107", "M84");
    for (const cmd of end) await sender.command(cmd, this.opts.commandTimeoutMs).catch(() => {});
    this.sd = undefined;
    this.lastMessage = job ? `Cancelled ${job.name}` : "Cancelled the SD card print";
    this.log("info", "print cancelled", { file: job?.name });
  }

  async setTemperature(heater: "nozzle" | "bed", celsius: number): Promise<void> {
    if (!Number.isFinite(celsius) || celsius < 0 || celsius > 450) {
      throw new DriverError("rejected", `${celsius} °C is not a valid temperature`, "Use a value between 0 and the printer's maximum.");
    }
    const sender = await this.connected();
    await sender.command(`${heater === "nozzle" ? "M104" : "M140"} S${Math.round(celsius)}`, this.opts.commandTimeoutMs);
  }

  async sendGcode(line: string): Promise<string> {
    const cmd = cleanGcodeLine(String(line ?? "").split(/\r?\n/)[0]);
    if (!cmd) throw new DriverError("rejected", "Empty G-code line", "Type one G-code command, e.g. M105.");
    if (/^M110\b/i.test(cmd)) throw new DriverError("rejected", "M110 is managed by Morphix", "Line numbers are handled automatically.");
    const sender = await this.connected();
    const lines = await sender.command(cmd, Math.max(this.opts.commandTimeoutMs, 30_000));
    return lines.join("\n");
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    await this.disconnect();
  }

  // -- connection ---------------------------------------------------------------------------------

  private async connected(): Promise<GcodeSender> {
    if (this.sender && this.port) return this.sender;
    if (this.connecting) return this.connecting;
    if (this.lastFail && this.now() - this.lastFail.at < this.opts.retryMs) throw this.lastFail.err;
    this.closedByUser = false;
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    try {
      const s = await this.connecting;
      this.lastFail = undefined;
      return s;
    } catch (e) {
      const err = asDriverError(e);
      this.lastFail = { at: this.now(), err };
      throw err;
    }
  }

  private async open(): Promise<GcodeSender> {
    if (!this.path) throw new DriverError("rejected", "No serial port chosen", "Pick the printer's USB port on the setup page.");
    if (!isSerialPath(this.path) && this.opts.openPort === openSerialPort) {
      throw new DriverError("rejected", `${this.path} is not a serial port`, "Pick the printer's port from the list.");
    }
    const port = await this.opts.openPort(this.path, this.baud);
    // Opening the port resets most boards: wait for the "start" banner or a quiet moment.
    let booted: () => void = () => {};
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const bootDone = new Promise<void>((resolve) => { booted = resolve; });
    const hardStop = setTimeout(() => booted(), this.opts.bootWaitMs);
    let started = false;
    port.onData((chunk) => {
      if (started) return;
      clearTimeout(quiet);
      quiet = setTimeout(() => booted(), Math.min(500, this.opts.bootWaitMs));
      if (/(^|\n)start\b/.test(chunk)) quiet = setTimeout(() => booted(), Math.min(300, this.opts.bootWaitMs));
    });
    const sender = new GcodeSender(port, { okTimeoutMs: this.opts.okTimeoutMs, deadAfterMs: this.opts.deadAfterMs, now: this.now }, {
      onTemps: (t) => { this.temps = { ...this.temps, ...t }; },
      onFatal: (reason) => {
        this.errorMessage = reason;
        if (this.job) this.log("error", "print stopped by firmware error", { file: this.job.name, reason });
        this.job = undefined;
      },
    });
    port.onClose(() => {
      if (this.port !== port) return;
      sender.portClosed();
      this.port = undefined;
      this.sender = undefined;
      clearInterval(this.poll);
      if (this.job && !this.closedByUser) this.errorMessage = `USB connection lost while printing ${this.job.name}`;
      this.job = undefined;
    });
    await bootDone;
    started = true;
    clearTimeout(hardStop);
    clearTimeout(quiet);

    let shook = false;
    for (let attempt = 0; attempt < 3 && !shook; attempt++) {
      try {
        await sender.reset(this.opts.handshakeTimeoutMs);
        shook = true;
      } catch (e) {
        if (sender.haltReason) break;
      }
    }
    if (!shook) {
      await sender.close();
      if (sender.haltReason) {
        throw new DriverError("protocol", `Printer halted: ${sender.haltReason}`,
          "Fix the cause shown on the printer's screen, then power-cycle it and try again.");
      }
      throw new DriverError("timeout", `The printer on ${this.path} did not answer at ${this.baud} baud`,
        "Check the baud rate (115200 for most printers, 250000 for some older ones) and that no other program is connected to it.");
    }
    try {
      this.info = parseM115(await sender.command("M115", this.opts.commandTimeoutMs));
    } catch {
      this.info = { autoReportTemp: false };
    }
    const m115 = this.info;
    this.extruders = m115.extruders ?? 1;
    this.port = port;
    this.sender = sender;
    if (m115.autoReportTemp) {
      await sender.command("M155 S2", this.opts.commandTimeoutMs).catch(() => {});
    } else {
      this.poll = setInterval(() => { void this.sender?.command("M105", this.opts.commandTimeoutMs).catch(() => {}); }, this.opts.tempPollMs);
      this.poll.unref?.();
    }
    await sender.command("M105", this.opts.commandTimeoutMs).catch(() => {});
    this.log("info", "serial printer connected", { port: this.path, baud: this.baud, firmware: m115.firmware });
    return sender;
  }

  private async disconnect(): Promise<void> {
    clearInterval(this.poll);
    const sender = this.sender;
    this.sender = undefined;
    this.port = undefined;
    this.job = undefined;
    await sender?.close();
  }

  private async checkSd(): Promise<void> {
    const sender = this.sender;
    if (!sender) return;
    const lines = await sender.command("M27", 3000);
    let progress: [number, number] | null = null;
    for (const l of lines) {
      const p = parseSdProgress(l);
      if (p) progress = p;
    }
    this.sd = { at: this.now(), progress };
  }

  private tempsCopy(): DriverStatus["temps"] {
    return Object.keys(this.temps).length ? { ...this.temps } : undefined;
  }

  private storeDir(): string {
    return join(this.opts.storeDir ?? defaultStoreDir(), safeName(this.path.replace(/^\/dev\//, "")));
  }

  // Old uploads are removed after a week so a small SD card does not fill up.
  private async pruneStore(dir: string, keep: string): Promise<void> {
    const cutoff = this.now() - 7 * 24 * 3600_000;
    for (const f of await fsp.readdir(dir)) {
      if (f === keep) continue;
      const st = await fsp.stat(join(dir, f)).catch(() => undefined);
      if (st?.isFile() && st.mtimeMs < cutoff) await fsp.rm(join(dir, f), { force: true });
    }
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
    this.deps.log?.(level, `[marlin-serial] ${message}`, data);
  }
}

function asDriverError(e: unknown): DriverError {
  if (e instanceof DriverError) return e;
  return new DriverError("protocol", (e as Error)?.message ?? String(e), "Unplug and replug the USB cable, then try again.");
}

export function createMarlinSerialDriver(options: MarlinSerialOptions = {}): PrinterDriver {
  const opts: Opts = {
    openPort: options.openPort ?? openSerialPort,
    listPorts: options.listPorts ?? listSerialPorts,
    storeDir: options.storeDir,
    bootWaitMs: options.bootWaitMs ?? 4000,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 3000,
    commandTimeoutMs: options.commandTimeoutMs ?? 10_000,
    okTimeoutMs: options.okTimeoutMs ?? 30_000,
    deadAfterMs: options.deadAfterMs ?? 5 * 60_000,
    tempPollMs: options.tempPollMs ?? 3000,
    retryMs: options.retryMs ?? 5000,
  };
  return {
    id: "marlin-serial",
    name: "Marlin over USB",
    description: "Any Marlin printer plugged into this computer by USB (Creality Ender, Anycubic, Artillery, Sovol, Elegoo Neptune, Prusa MK3S+ ...).",
    fields: [
      { key: "port", label: "USB port", kind: "serial-port", required: true,
        help: "Plug the printer into this computer with its USB cable and switch it on; it shows up here as /dev/serial/by-id/usb-... (or /dev/ttyUSB0, /dev/ttyACM0)." },
      { key: "baud", label: "Baud rate", kind: "number", required: false, default: 115200,
        help: "115200 for almost every printer; some older Marlin and Prusa boards use 250000 (see the printer's manual or firmware Configuration.h)." },
      { key: "pauseGcode", label: "G-code after pause (optional)", kind: "text", required: false, default: "",
        help: "Runs after the print pauses, e.g. a park move like 'G91\\nG1 Z10\\nG90'; leave empty and nothing moves." },
      { key: "resumeGcode", label: "G-code before resume (optional)", kind: "text", required: false, default: "",
        help: "Runs before the print continues; it must undo any park move above. Leave empty if you set no pause G-code." },
      { key: "cancelGcode", label: "G-code on cancel (optional)", kind: "text", required: false, default: "",
        help: "Runs on cancel before heaters, fan and motors are switched off; leave empty and nothing moves." },
    ],
    discover: async () => (await opts.listPorts()).map((p) => ({ driver: "marlin-serial" as const, host: p.path, name: p.name })),
    connect: (config, deps = {}) => new MarlinConnection(config, opts, deps),
  };
}

export const marlinSerialDriver = createMarlinSerialDriver();
