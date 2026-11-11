// Klipper printers through Moonraker's HTTP API (Voron, RatRig, Creality Sonic Pad / rooted K1,
// Elegoo Neptune 4, Sovol SV07/SV08, QIDI X-series, any Klipper conversion).
// IMPLEMENTED FROM THE PROTOCOL DOCS, NOT TESTED ON A REAL PRINTER (catalog: verified "protocol"):
//   https://moonraker.readthedocs.io/en/latest/web_api/        (server, printer, files, webcams, auth)
//   https://www.klipper3d.org/Status_Reference.html             (print_stats, extruder, heater_bed, display_status, virtual_sdcard)
// Tests run against the fake in ./fake/moonraker.ts.
import type {
  ConnectionField,
  Discovered,
  DriverCapabilities,
  DriverConfig,
  DriverDeps,
  DriverStatus,
  FileFormat,
  PrinterConnection,
  PrinterDriver,
  TestResult,
} from "../types";
import {
  absoluteUrl,
  baseUrl,
  checkConsole,
  checkTemperature,
  guardTest,
  heatingNow,
  Http,
  makeEnv,
  nowIso,
  offlineStatus,
  requireFormat,
  requireIdle,
  requireState,
  safeFileName,
  str,
  temp,
  timeoutFrom,
  uploadTimeout,
  type Env,
  type Hints,
} from "./common";
import { browse, type BrowseOptions } from "./mdns";

const FIELDS: ConnectionField[] = [
  {
    key: "host",
    label: "Printer address",
    kind: "host",
    required: true,
    help: "The IP address or name of the printer's Klipper computer, e.g. 192.168.1.50 or voron.local: it is the address you open Mainsail or Fluidd with, or see it in the printer's network settings or your router.",
  },
  {
    key: "port",
    label: "Port",
    kind: "port",
    required: false,
    default: 7125,
    help: "7125 is Moonraker's own port and works on almost every Klipper printer; 80 also works when Mainsail or Fluidd is installed.",
  },
  {
    key: "apiKey",
    label: "API key (optional)",
    kind: "secret",
    required: false,
    help: "Leave empty unless Moonraker asks for a login (most setups trust devices on the home network). The key is printed by ~/moonraker/scripts/fetch-apikey.sh on the printer's computer.",
  },
];

const HINTS: Hints = {
  name: "Moonraker",
  auth: "Enter the Moonraker API key, or add this computer's network to [authorization] trusted_clients in moonraker.conf.",
  unreachable: "Check that the printer is on, the address is right and Moonraker runs on that port (default 7125).",
};

interface ServerInfo {
  klippy_connected?: boolean;
  klippy_state?: "ready" | "startup" | "shutdown" | "error" | "disconnected" | string;
  moonraker_version?: string;
}

interface PrinterInfo {
  state?: string;
  state_message?: string;
  hostname?: string;
  software_version?: string;
}

interface Heater {
  temperature?: number;
  target?: number;
}

interface ObjectsStatus {
  print_stats?: {
    filename?: string;
    total_duration?: number;
    print_duration?: number;
    filament_used?: number;
    state?: "standby" | "printing" | "paused" | "complete" | "cancelled" | "error" | string;
    message?: string;
    info?: { total_layer?: number | null; current_layer?: number | null };
  };
  extruder?: Heater;
  heater_bed?: Heater;
  display_status?: { progress?: number; message?: string | null };
  virtual_sdcard?: { progress?: number; is_active?: boolean; file_position?: number };
}

interface Webcam {
  name?: string;
  enabled?: boolean;
  service?: string;
  stream_url?: string;
  snapshot_url?: string;
}

const QUERY = "/printer/objects/query?print_stats&extruder&heater_bed&display_status&virtual_sdcard";

class MoonrakerConnection implements PrinterConnection {
  readonly driver = "moonraker" as const;
  private readonly env: Env;
  private readonly http?: Http;
  private readonly configError?: unknown;
  private camera: DriverCapabilities["camera"] = false;
  private cameraLoaded = false;

  constructor(config: DriverConfig, deps?: DriverDeps) {
    this.env = makeEnv(deps);
    try {
      const apiKey = str(config.apiKey);
      this.http = new Http(baseUrl(config, 7125), this.env, HINTS, timeoutFrom(config), apiKey ? { headers: () => ({ "X-Api-Key": apiKey }) } : undefined);
    } catch (e) {
      this.configError = e;
    }
  }

  private get h(): Http {
    if (!this.http) throw this.configError;
    return this.http;
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
      camera: this.camera,
    };
  }

  test(): Promise<TestResult> {
    return guardTest(async () => {
      const server = (await this.h.json<{ result: ServerInfo }>("/server/info", { what: "read Moonraker's info" })).result ?? {};
      let printer: PrinterInfo = {};
      try {
        printer = (await this.h.json<{ result: PrinterInfo }>("/printer/info", { what: "read Klipper's info" })).result ?? {};
      } catch {
        // Klipper not connected yet: Moonraker itself answered, so the connection and login are fine.
      }
      await this.loadCamera();
      return {
        ok: true,
        info: {
          name: printer.hostname,
          firmware: printer.software_version ? `Klipper ${printer.software_version}` : server.moonraker_version ? `Moonraker ${server.moonraker_version}` : undefined,
        },
      };
    });
  }

  /** Never throws: an unreachable printer, a refused login or a bad reply is state "offline" with a message. */
  async status(): Promise<DriverStatus> {
    try {
      return await this.read();
    } catch (e) {
      return offlineStatus(e, this.env.now);
    }
  }

  /** Like status(), but throws the DriverError (control commands report the real reason). */
  private async read(): Promise<DriverStatus> {
    const server = (await this.h.json<{ result: ServerInfo }>("/server/info", { what: "read Moonraker's info" })).result ?? {};
    const klippy = server.klippy_state ?? (server.klippy_connected === false ? "disconnected" : "ready");
    if (klippy !== "ready") return await this.klippyNotReady(klippy);
    const st = (await this.h.json<{ result: { status: ObjectsStatus } }>(QUERY, { what: "read the printer status" })).result?.status ?? {};
    if (!this.cameraLoaded) await this.loadCamera();
    return mapStatus(st, nowIso(this.env));
  }

  private async klippyNotReady(klippy: string): Promise<DriverStatus> {
    const checkedAt = nowIso(this.env);
    let detail = "";
    try {
      detail = (await this.h.json<{ result: PrinterInfo }>("/printer/info", { what: "read Klipper's info" })).result?.state_message ?? "";
    } catch {
      // no detail available
    }
    detail = detail.split("\n")[0].trim();
    if (klippy === "startup") return { state: "busy", message: "Klipper is starting", checkedAt };
    if (klippy === "shutdown" || klippy === "error") {
      return { state: "error", message: `Klipper ${klippy === "shutdown" ? "is shut down" : "reports an error"}${detail ? `: ${detail}` : ""}. Fix it, then FIRMWARE_RESTART in Mainsail/Fluidd.`, checkedAt };
    }
    return { state: "offline", message: "Moonraker is running but Klipper is not connected. Check that Klipper runs and the printer board is connected.", checkedAt };
  }

  private async loadCamera(): Promise<void> {
    this.cameraLoaded = true;
    try {
      const cams = (await this.h.json<{ result: { webcams?: Webcam[] } }>("/server/webcams/list", { what: "list the cameras" })).result?.webcams ?? [];
      const cam = cams.find((c) => c.enabled !== false && (c.stream_url || c.snapshot_url));
      this.camera = cam ? webcamToCamera(cam, this.h.base) : false;
    } catch {
      this.camera = false; // older Moonraker (no webcam API) or no permission: no camera
    }
  }

  async upload(file: { name: string; data: Buffer; format: FileFormat }): Promise<void> {
    requireFormat(file.format, ["gcode"]);
    const name = safeFileName(file.name);
    const form = new FormData();
    form.append("root", "gcodes");
    form.append("file", new Blob([file.data]), name);
    await this.h.call("/server/files/upload", { method: "POST", body: form, timeoutMs: uploadTimeout(file.data.length, 60_000), what: "upload the file" });
  }

  async start(fileName: string): Promise<void> {
    requireIdle(await this.read());
    await this.post("/printer/print/start", { filename: safeFileName(fileName) }, "start the print");
  }

  async pause(): Promise<void> {
    requireState(await this.read(), ["printing", "heating"], "pause");
    await this.post("/printer/print/pause", undefined, "pause the print");
  }

  async resume(): Promise<void> {
    requireState(await this.read(), ["paused"], "resume");
    await this.post("/printer/print/resume", undefined, "resume the print");
  }

  async cancel(): Promise<void> {
    requireState(await this.read(), ["printing", "heating", "paused"], "cancel");
    await this.post("/printer/print/cancel", undefined, "cancel the print", 30_000);
  }

  async setTemperature(heater: "nozzle" | "bed", celsius: number): Promise<void> {
    const c = checkTemperature(heater, celsius);
    requireState(await this.read(), ["idle", "heating", "printing", "paused"], "set a temperature");
    await this.post("/printer/gcode/script", { script: `SET_HEATER_TEMPERATURE HEATER=${heater === "nozzle" ? "extruder" : "heater_bed"} TARGET=${c}` }, "set the temperature");
  }

  async sendGcode(line: string): Promise<string> {
    const cmd = checkConsole(await this.read(), line);
    // Moonraker answers when the command has finished (G28 can take a minute).
    const reply = await this.h.json<{ result?: unknown }>("/printer/gcode/script", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: cmd }),
      timeoutMs: 120_000,
      what: "run the G-code",
    });
    return String(reply.result ?? "ok");
  }

  private async post(path: string, body: unknown, what: string, timeoutMs?: number): Promise<void> {
    await this.h.call(path, {
      method: "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
      what,
    });
  }

  async close(): Promise<void> {
    // HTTP only: nothing to close.
  }
}

export function webcamToCamera(cam: Webcam, base: string): DriverCapabilities["camera"] {
  // Webcam URLs are usually relative to the web UI (nginx on port 80), not to Moonraker's port.
  const service = (cam.service ?? "").toLowerCase();
  const stream = absoluteUrl(cam.stream_url ?? "", base, true);
  const snapshot = absoluteUrl(cam.snapshot_url ?? "", base, true);
  if (stream && (service.startsWith("mjpeg") || service === "" || /action=stream/.test(stream))) return { kind: "mjpeg", url: stream };
  if (snapshot) return { kind: "snapshot", url: snapshot };
  return false;
}

export function mapStatus(st: ObjectsStatus, checkedAt: string): DriverStatus {
  const ps = st.print_stats ?? {};
  const temps: DriverStatus["temps"] = {};
  const nozzle = temp(st.extruder?.temperature, st.extruder?.target);
  const bed = temp(st.heater_bed?.temperature, st.heater_bed?.target);
  if (nozzle) temps.nozzle = nozzle;
  if (bed) temps.bed = bed;
  const progress = clamp01(st.display_status?.progress ?? st.virtual_sdcard?.progress);
  const elapsed = ps.print_duration ?? 0;
  const file = ps.filename || undefined;
  const job: NonNullable<DriverStatus["job"]> = { file, progress, elapsedS: Math.round(elapsed) };
  if (progress !== undefined && progress > 0.01 && progress < 1 && elapsed > 0) job.remainingS = Math.round((elapsed * (1 - progress)) / progress);
  const cur = ps.info?.current_layer;
  const total = ps.info?.total_layer;
  if (typeof cur === "number" && typeof total === "number" && total > 0) job.layer = [cur, total];

  const base = { temps, checkedAt };
  switch (ps.state) {
    case "printing": {
      const heating = (ps.filament_used ?? 0) <= 0 && heatingNow(temps);
      return { ...base, state: heating ? "heating" : "printing", message: heating ? `Heating for ${file ?? "the print"}` : `Printing ${file ?? ""}`.trim(), job };
    }
    case "paused":
      return { ...base, state: "paused", message: `Paused ${file ?? ""}`.trim(), job };
    case "error":
      return { ...base, state: "error", message: ps.message || "The print stopped with an error", job };
    case "complete":
      return { ...base, state: "idle", message: file ? `Finished ${file}` : "Finished", job: { ...job, progress: 1, remainingS: 0 } };
    case "cancelled":
      return { ...base, state: "idle", message: file ? `Cancelled ${file}` : "Cancelled" };
    default:
      return { ...base, state: "idle", message: "Ready" };
  }
}

function clamp01(n: unknown): number | undefined {
  const v = Number(n);
  if (n === undefined || n === null || !Number.isFinite(v)) return undefined;
  return Math.min(1, Math.max(0, v));
}

/** Finds Moonraker instances that announce `_moonraker._tcp` (Moonraker's [zeroconf] component). */
export async function discoverMoonraker(timeoutMs: number, opts?: BrowseOptions): Promise<Discovered[]> {
  const found = await browse("_moonraker._tcp.local", timeoutMs, opts);
  return found
    .filter((s) => s.address || s.host)
    .map((s) => ({ driver: "moonraker" as const, host: s.address ?? s.host!.replace(/\.$/, ""), port: s.port, name: s.instance }));
}

export const moonrakerDriver: PrinterDriver = {
  id: "moonraker",
  name: "Klipper (Moonraker)",
  description: "Any Klipper printer with Moonraker (the API behind Mainsail and Fluidd): Voron, RatRig, Sovol SV07/SV08, Elegoo Neptune 4, QIDI, Creality Sonic Pad and rooted K1.",
  fields: FIELDS,
  discover: (timeoutMs) => discoverMoonraker(timeoutMs),
  connect: (config, deps) => new MoonrakerConnection(config, deps),
};
