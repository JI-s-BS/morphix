// Driver "elegoo-sdcp": Elegoo Centauri Carbon over SDCP v3 (WebSocket ws://<ip>:3030/websocket,
// UDP 3000 discovery with "M99999", chunked HTTP upload to :3030/uploadFile/upload).
//
// HARDWARE STATUS: implemented from Elegoo's published SDCP v3.0.0 specification
// (github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0) and the Centauri Carbon (FDM)
// status-code table used by the open-source elegoo-homeassistant integration (which mirrors
// Elegoo's elegoo-link adapter). Tested only against a local fake, not on a real printer.
// `verified: "protocol"`.
//
// Safety: start is refused unless the machine status is idle; every command must be acknowledged
// (Ack 0) and start/pause/resume/stop are then confirmed from the pushed status. The Centauri
// Carbon has no password on its LAN API, so anyone on the network can control it.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import {
  DriverError,
  type DriverCapabilities,
  type DriverConfig,
  type DriverDeps,
  type DriverStatus,
  type Discovered,
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
  readJson,
  requireData,
  requireHost,
  safeFileName,
  safeLog,
  str,
  temp,
  toDriverError,
  toNum,
  urlHost,
  withTimeout,
  WsSession,
  type Log,
} from "./common";

export const SDCP_CMD = { status: 0, attributes: 1, start: 128, pause: 129, stop: 130, resume: 131 } as const;

/** Machine-level CurrentStatus (SDCP v3 + Centauri Carbon additions). */
const MACHINE: Record<number, { state: PrintState; message: string }> = {
  0: { state: "idle", message: "Ready" },
  1: { state: "printing", message: "Printing" },
  2: { state: "busy", message: "Receiving a file" },
  3: { state: "busy", message: "Exposure test" },
  4: { state: "busy", message: "Self-check" },
  5: { state: "busy", message: "Levelling" },
  6: { state: "busy", message: "Input-shaping calibration" },
  7: { state: "busy", message: "Stopping" },
  8: { state: "idle", message: "Stopped" },
  9: { state: "busy", message: "Homing" },
  10: { state: "busy", message: "Loading / unloading filament" },
  11: { state: "busy", message: "PID tuning" },
  12: { state: "busy", message: "Recovering a print" },
};

/** PrintInfo.Status on the Centauri Carbon (FDM table), while the machine status is "printing". */
const PRINT: Record<number, { state: PrintState; message: string }> = {
  0: { state: "printing", message: "Printing" },
  1: { state: "busy", message: "Homing" },
  5: { state: "paused", message: "Pausing" },
  6: { state: "paused", message: "Paused" },
  7: { state: "busy", message: "Stopping" },
  8: { state: "idle", message: "Stopped" },
  9: { state: "finishing", message: "Finishing" },
  10: { state: "busy", message: "Checking the file" },
  11: { state: "busy", message: "Printer self-check" },
  12: { state: "printing", message: "Resuming" },
  13: { state: "printing", message: "Printing" },
  14: { state: "error", message: "Print error; check the printer screen" },
  15: { state: "busy", message: "Auto levelling" },
  16: { state: "heating", message: "Preheating" },
  17: { state: "busy", message: "Resonance test" },
  18: { state: "printing", message: "Print started" },
  19: { state: "printing", message: "Printing (levelling done)" },
  20: { state: "printing", message: "Printing (preheat done)" },
  21: { state: "printing", message: "Printing (homing done)" },
  22: { state: "printing", message: "Printing (resonance test done)" },
  23: { state: "busy", message: "Feeding filament" },
  24: { state: "busy", message: "Unloading filament" },
  25: { state: "error", message: "Filament unload problem" },
  26: { state: "paused", message: "Paused while unloading filament" },
};

/** Maps an SDCP "Status" object to PrintState. */
export function mapSdcpStatus(status: Record<string, unknown>): { state: PrintState; message: string } {
  const cur = Array.isArray(status.CurrentStatus) ? toNum(status.CurrentStatus[0]) : toNum(status.CurrentStatus);
  const info = (status.PrintInfo ?? {}) as Record<string, unknown>;
  const ps = toNum(info.Status);
  if (cur === undefined) return { state: "busy", message: "Unknown printer state" };
  if (cur === 1) {
    if (ps === undefined) return MACHINE[1];
    return PRINT[ps] ?? { state: "printing", message: `Printing (status ${ps})` };
  }
  if (cur === 0) {
    if (ps === 9) return { state: "idle", message: "Print finished" };
    if (ps === 8) return { state: "idle", message: "Print stopped" };
    // Some firmwares report a paused job with the machine back at 0.
    if (ps === 6 || ps === 5) return PRINT[ps];
    return MACHINE[0];
  }
  return MACHINE[cur] ?? { state: "busy", message: `Unknown machine status ${cur}` };
}

export function sdcpToStatus(status: Record<string, unknown>, checkedAt: string): DriverStatus {
  const { state, message } = mapSdcpStatus(status);
  const info = (status.PrintInfo ?? {}) as Record<string, unknown>;
  const active = state === "printing" || state === "paused" || state === "heating" || state === "finishing";
  const file = typeof info.Filename === "string" && info.Filename ? info.Filename.split("/").pop() : undefined;
  const cur = toNum(info.CurrentLayer);
  const total = toNum(info.TotalLayer);
  const ticks = toNum(info.CurrentTicks);
  const totalTicks = toNum(info.TotalTicks);
  const progress = toNum(info.Progress);
  return {
    state,
    message: active && file ? `${message}: ${file}` : message,
    temps: {
      nozzle: temp(status.TempOfNozzle, status.TempTargetNozzle),
      bed: temp(status.TempOfHotbed, status.TempTargetHotbed),
      chamber: temp(status.TempOfBox, status.TempTargetBox),
    },
    job: active
      ? {
          file,
          progress: clamp01(progress !== undefined ? progress / 100 : cur !== undefined && total ? cur / total : undefined),
          layer: cur !== undefined && total ? [cur, total] : undefined,
          // Centauri Carbon reports ticks in seconds.
          elapsedS: ticks,
          remainingS: ticks !== undefined && totalTicks !== undefined ? Math.max(0, totalTicks - ticks) : undefined,
        }
      : undefined,
    checkedAt,
  };
}

const PRINT_ACK: Record<number, { code: "busy" | "rejected"; text: string }> = {
  1: { code: "busy", text: "printer is busy" },
  2: { code: "rejected", text: "file not found on the printer" },
  3: { code: "rejected", text: "file MD5 check failed" },
  4: { code: "rejected", text: "printer could not read the file" },
  5: { code: "rejected", text: "file resolution does not match this printer" },
  6: { code: "rejected", text: "unknown file format" },
  7: { code: "rejected", text: "file was sliced for a different printer model" },
};

export interface ElegooOptions {
  requestTimeoutMs?: number;
  openTimeoutMs?: number;
  confirmTimeoutMs?: number;
  pollMs?: number;
  /** UDP discovery port (3000; tests use another). */
  discoveryPort?: number;
  /** HTTP port for upload (3030). */
  httpPort?: number;
  wsPort?: number;
  chunkBytes?: number;
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

/** Asks one printer (unicast) or the LAN (broadcast) for its SDCP identity. */
export function sdcpProbe(target: string, port: number, timeoutMs: number, broadcast = false): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const out: Record<string, unknown>[] = [];
    const sock = createSocket({ type: target.includes(":") ? "udp6" : "udp4", reuseAddr: true });
    const done = () => {
      clearTimeout(t);
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(out);
    };
    const t = setTimeout(done, timeoutMs);
    t.unref?.();
    sock.on("error", done);
    sock.on("message", (buf) => {
      try {
        const j = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
        if (j && typeof j === "object" && j.Data) {
          out.push(j);
          if (!broadcast) done();
        }
      } catch {
        /* not ours */
      }
    });
    sock.bind(0, () => {
      try {
        if (broadcast) sock.setBroadcast(true);
        sock.send("M99999", port, target);
      } catch {
        done();
      }
    });
  });
}

class ElegooConnection implements PrinterConnection {
  readonly driver = "elegoo-sdcp" as const;
  private host: string;
  private mainboardId: string;
  private ws: WsSession;
  private last: Record<string, unknown> | null = null;
  private attributes: Record<string, unknown> | null = null;
  private now: () => number;
  private log: Log;
  private f: typeof fetch;
  private o: Required<ElegooOptions>;

  constructor(config: DriverConfig, deps: DriverDeps, opts: ElegooOptions) {
    this.host = requireHost(config);
    this.mainboardId = str(config, "mainboardId");
    this.now = deps.now ?? Date.now;
    this.log = safeLog(deps, () => []);
    this.f = deps.fetch ?? fetch;
    this.o = { requestTimeoutMs: 5000, openTimeoutMs: 5000, confirmTimeoutMs: 30_000, pollMs: 1000, discoveryPort: 3000, httpPort: 3030, wsPort: 3030, chunkBytes: 1024 * 1024, ...opts };
    const Ctor = deps.WebSocket ?? WebSocket;
    this.ws = new WsSession(`ws://${urlHost(this.host)}:${this.o.wsPort}/websocket`, Ctor, {
      openTimeoutMs: this.o.openTimeoutMs,
      what: "Elegoo printer",
      onText: (text) => text === "pong",
    });
    this.ws.onMessage((m) => this.absorb(m));
  }

  private absorb(m: unknown) {
    if (!m || typeof m !== "object") return;
    const msg = m as Record<string, unknown>;
    const topic = typeof msg.Topic === "string" ? msg.Topic : "";
    if (!this.mainboardId && typeof msg.MainboardID === "string" && msg.MainboardID) this.mainboardId = msg.MainboardID;
    if (topic.startsWith("sdcp/status/") && msg.Status && typeof msg.Status === "object") {
      this.last = { ...(this.last ?? {}), ...(msg.Status as Record<string, unknown>) };
    }
    if (topic.startsWith("sdcp/attributes/") && msg.Attributes && typeof msg.Attributes === "object") {
      this.attributes = msg.Attributes as Record<string, unknown>;
      if (!this.mainboardId && typeof this.attributes.MainboardID === "string") this.mainboardId = this.attributes.MainboardID;
    }
  }

  /** The MainboardID is needed for every request topic: from settings, UDP, or the first push. */
  private async ensureId(): Promise<string> {
    if (this.mainboardId) return this.mainboardId;
    const replies = await sdcpProbe(this.host, this.o.discoveryPort, 2000);
    const id = (replies[0]?.Data as Record<string, unknown> | undefined)?.MainboardID;
    if (typeof id === "string" && id) {
      this.mainboardId = id;
      return id;
    }
    await this.ws.open();
    const r = await pollUntil(async () => this.mainboardId, (v) => !!v, this.o.requestTimeoutMs, 100);
    if (!r.ok) {
      throw new DriverError("protocol", "the printer did not report its mainboard ID", "Make sure this is an Elegoo printer with SDCP v3 (Centauri Carbon) on current firmware; or enter the mainboard ID from Settings → About.");
    }
    return this.mainboardId;
  }

  /** Sends one SDCP request and returns the response's inner Data (with Ack). */
  private async request(cmd: number, data: Record<string, unknown>, what: string): Promise<Record<string, unknown>> {
    await this.ws.open();
    const id = await this.ensureId();
    const requestId = randomBytes(16).toString("hex");
    const frame = {
      Id: randomUUID().replace(/-/g, ""),
      Data: { Cmd: cmd, Data: data, RequestID: requestId, MainboardID: id, TimeStamp: Math.floor(this.now() / 1000), From: 0 },
      Topic: `sdcp/request/${id}`,
    };
    const reply = await this.ws.request<Record<string, unknown>>(
      (ws) => ws.send(JSON.stringify(frame)),
      (m) => {
        const d = (m as Record<string, unknown>)?.Data as Record<string, unknown> | undefined;
        return !!d && d.RequestID === requestId;
      },
      this.o.requestTimeoutMs,
      what,
    );
    const inner = ((reply.Data as Record<string, unknown>).Data ?? {}) as Record<string, unknown>;
    return inner;
  }

  private async fresh(): Promise<Record<string, unknown>> {
    const before = this.last;
    await this.request(SDCP_CMD.status, {}, "status");
    // The status arrives on the status topic right after the response; wait briefly for it.
    const r = await pollUntil(async () => this.last, (v) => v !== null && v !== before, 1500, 50);
    if (!r.value) throw new DriverError("protocol", "status: the printer sent no status", "Update the printer firmware, then try again.");
    return r.value;
  }

  capabilities(): DriverCapabilities {
    return CAPS;
  }

  async test(): Promise<TestResult> {
    try {
      await this.fresh();
      await this.request(SDCP_CMD.attributes, {}, "attributes").catch(() => undefined);
      // The attributes arrive on their own topic right after the response.
      await pollUntil(async () => this.attributes, (a) => a !== null, 1500, 20);
      const a = this.attributes ?? {};
      return {
        ok: true,
        info: { model: (a.MachineName as string) ?? "Elegoo", firmware: a.FirmwareVersion as string | undefined, serial: this.mainboardId || undefined, name: a.Name as string | undefined },
      };
    } catch (e) {
      return failResult(e, "test");
    }
  }

  async status(): Promise<DriverStatus> {
    try {
      return sdcpToStatus(await this.fresh(), new Date(this.now()).toISOString());
    } catch (e) {
      this.ws.close();
      return offline(toDriverError(e, "status").message, this.now);
    }
  }

  private async state(): Promise<PrintState> {
    try {
      return mapSdcpStatus(await this.fresh()).state;
    } catch (e) {
      throw toDriverError(e, "status");
    }
  }

  async upload(file: { name: string; data: Buffer; format: FileFormat }): Promise<void> {
    if (file.format !== "gcode") throw new DriverError("unsupported", `${file.format} files are not supported by this printer`, "Slice with a Centauri Carbon profile that writes .gcode.");
    const name = safeFileName(file.name, [".gcode"]);
    requireData(file.data);
    const s = await this.state();
    if (s !== "idle") throw busy(s, "upload");
    const md5 = createHash("md5").update(file.data).digest("hex");
    const uuid = randomUUID().replace(/-/g, "");
    const url = `http://${urlHost(this.host)}:${this.o.httpPort}/uploadFile/upload`;
    for (let off = 0; off < file.data.length; off += this.o.chunkBytes) {
      const chunk = file.data.subarray(off, off + this.o.chunkBytes);
      const form = new FormData();
      form.append("S-File-MD5", md5);
      form.append("Check", "1");
      form.append("Offset", String(off));
      form.append("Uuid", uuid);
      form.append("TotalSize", String(file.data.length));
      form.append("File", new Blob([new Uint8Array(chunk)], { type: "application/octet-stream" }), name);
      const res = await fetchWithTimeout(this.f, url, { method: "POST", body: form }, 30_000, `upload (bytes ${off}-${off + chunk.length})`);
      const j = await readJson(res, "upload");
      if (j.success !== true && j.code !== "000000") {
        const msgs = Array.isArray(j.messages) ? (j.messages as { field?: string; message?: unknown }[]).map((m) => `${m.field}: ${String(m.message)}`).join("; ") : "";
        throw new DriverError("rejected", `upload: printer refused the file (${msgs || `code ${String(j.code)}`})`, "Check there is free space on the printer, then try again.");
      }
    }
    this.log("info", "elegoo-sdcp upload done", { file: name, bytes: file.data.length });
  }

  private ack(inner: Record<string, unknown>, what: string): void {
    const ack = toNum(inner.Ack);
    if (ack === 0) return;
    const known = ack !== undefined ? PRINT_ACK[ack] : undefined;
    if (known) throw new DriverError(known.code, `${what}: ${known.text}`, known.code === "busy" ? "Wait for the printer to be idle, then try again." : "Slice the file again for this printer and upload it.");
    throw new DriverError("rejected", `${what}: printer answered Ack ${String(inner.Ack)}`, "Check the printer's screen, then try again.");
  }

  private async confirm(ok: (s: PrintState) => boolean, what: string, expected: string): Promise<void> {
    const r = await pollUntil(() => this.state().catch(() => "offline" as PrintState), ok, this.o.confirmTimeoutMs, this.o.pollMs);
    if (!r.ok) throw new DriverError("protocol", `${what}: acknowledged but the printer did not become ${expected} within ${this.o.confirmTimeoutMs} ms (now ${r.value})`, "Check the printer's screen.");
  }

  async start(fileName: string): Promise<void> {
    const name = safeFileName(fileName, [".gcode"]);
    const s = await this.state();
    if (s !== "idle") throw busy(s, "start");
    // Calibration, platform type and time-lapse switches as Elegoo's slicer sends them (all off).
    this.ack(await this.request(SDCP_CMD.start, { Filename: `/local/${name}`, StartLayer: 0, Calibration_switch: 0, PrintPlatformType: 0, Tlp_Switch: 0 }, "start"), "start");
    this.log("info", "elegoo-sdcp start acknowledged", { file: name });
    await this.confirm((x) => x !== "idle" && x !== "offline", "start", "busy or printing");
  }

  async pause(): Promise<void> {
    const s = await this.state();
    if (s !== "printing" && s !== "heating") throw new DriverError("rejected", `nothing to pause: printer is ${s}`, "Refresh the printer status; the job may already have changed.");
    this.ack(await this.request(SDCP_CMD.pause, {}, "pause"), "pause");
    await this.confirm((x) => x === "paused", "pause", "paused");
  }

  async resume(): Promise<void> {
    const s = await this.state();
    if (s !== "paused") throw new DriverError("rejected", `nothing to resume: printer is ${s}`, "Refresh the printer status; the job may already have changed.");
    this.ack(await this.request(SDCP_CMD.resume, {}, "resume"), "resume");
    await this.confirm((x) => x === "printing" || x === "heating", "resume", "printing");
  }

  async cancel(): Promise<void> {
    const s = await this.state();
    if (s === "idle") return;
    this.ack(await this.request(SDCP_CMD.stop, {}, "cancel"), "cancel");
    await this.confirm((x) => x === "idle" || x === "busy", "cancel", "stopped");
  }

  async close(): Promise<void> {
    this.ws.close();
  }
}

export function createElegooSdcpDriver(opts: ElegooOptions = {}): PrinterDriver {
  return {
    id: "elegoo-sdcp",
    name: "Elegoo Centauri Carbon (SDCP)",
    description: "Elegoo Centauri Carbon over its local SDCP v3 network protocol.",
    fields: [
      { key: "host", label: "Printer IP address", kind: "host", required: true, help: "On the printer screen open Settings → Network; the IP address is shown under the connected WiFi/Ethernet." },
      {
        key: "mainboardId",
        label: "Mainboard ID (optional)",
        kind: "text",
        required: false,
        help: "Usually found automatically. If not, it is the 16-character ID under Settings → About on the printer screen.",
      },
    ],
    async discover(timeoutMs: number): Promise<Discovered[]> {
      const replies = await withTimeout(sdcpProbe("255.255.255.255", opts.discoveryPort ?? 3000, timeoutMs, true), timeoutMs + 500, "discovery").catch(() => []);
      return replies.flatMap((r) => {
        const d = r.Data as Record<string, unknown>;
        const host = typeof d?.MainboardIP === "string" ? d.MainboardIP : "";
        if (!host) return [];
        return [{ driver: "elegoo-sdcp" as const, host, name: d.Name as string | undefined, model: d.MachineName as string | undefined, serial: d.MainboardID as string | undefined }];
      });
    },
    connect(config: DriverConfig, deps: DriverDeps = {}) {
      try {
        return new ElegooConnection(config, deps, opts);
      } catch (e) {
        return invalidConnection("elegoo-sdcp", toDriverError(e, "settings"), CAPS, deps.now ?? Date.now);
      }
    },
  };
}

export const elegooSdcpDriver = createElegooSdcpDriver();
