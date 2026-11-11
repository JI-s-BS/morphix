// Any printer run by OctoPrint (typically a Marlin printer on a Raspberry Pi with OctoPi), via its REST API.
// IMPLEMENTED FROM THE PROTOCOL DOCS, NOT TESTED ON A REAL PRINTER (catalog: verified "protocol"):
//   https://docs.octoprint.org/en/master/api/                  (version, connection, printer, job, files, settings)
//   https://docs.octoprint.org/en/master/api/datamodel.html    (printer state flags, job progress)
// Tests run against the fake in ./fake/octoprint.ts.
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
import { DriverError } from "../types";
import {
  absoluteUrl,
  baseUrl,
  checkConsole,
  checkTemperature,
  guardTest,
  heatingNow,
  Http,
  httpError,
  makeEnv,
  nowIso,
  offlineStatus,
  parseJson,
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
    label: "OctoPrint address",
    kind: "host",
    required: true,
    help: "The address you open OctoPrint with in a browser, e.g. octopi.local or 192.168.1.60.",
  },
  {
    key: "port",
    label: "Port",
    kind: "port",
    required: false,
    default: 80,
    help: "80 on OctoPi; 5000 if OctoPrint was installed by hand without a web proxy.",
  },
  {
    key: "apiKey",
    label: "API key",
    kind: "secret",
    required: true,
    help: "In OctoPrint open the wrench (Settings) → Application Keys, create a key named Morphix and paste it here (Settings → API → Global API Key also works).",
  },
];

const HINTS: Hints = {
  name: "OctoPrint",
  auth: "Check the API key: in OctoPrint, Settings → Application Keys. The key's user needs permission to print and control.",
  unreachable: "Check that the OctoPrint computer is on and the address and port are the ones you use in the browser.",
};

interface PrinterReply {
  temperature?: Record<string, { actual?: number | null; target?: number | null }>;
  state?: {
    text?: string;
    flags?: Partial<Record<"operational" | "paused" | "printing" | "pausing" | "cancelling" | "finishing" | "sdReady" | "error" | "ready" | "closedOrError", boolean>>;
    error?: string;
  };
}

interface JobReply {
  job?: { file?: { name?: string | null; display?: string | null; path?: string | null }; estimatedPrintTime?: number | null };
  progress?: { completion?: number | null; printTime?: number | null; printTimeLeft?: number | null };
  state?: string;
  error?: string;
}

class OctoPrintConnection implements PrinterConnection {
  readonly driver = "octoprint" as const;
  private readonly env: Env;
  private readonly http?: Http;
  private readonly configError?: unknown;
  private camera: DriverCapabilities["camera"] = false;
  private cameraLoaded = false;

  constructor(config: DriverConfig, deps?: DriverDeps) {
    this.env = makeEnv(deps);
    try {
      const apiKey = str(config.apiKey);
      this.http = new Http(baseUrl(config, 80), this.env, HINTS, timeoutFrom(config), { headers: (): Record<string, string> => (apiKey ? { "X-Api-Key": apiKey } : {}) });
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
      const v = await this.h.json<{ api?: string; server?: string; text?: string }>("/api/version", { what: "read OctoPrint's version" });
      let name: string | undefined;
      try {
        const s = await this.settings();
        name = s.appearance?.name || undefined;
      } catch {
        // the key may lack the settings permission: not needed to print
      }
      return { ok: true, info: { firmware: v.text ?? (v.server ? `OctoPrint ${v.server}` : undefined), name } };
    });
  }

  private settings(): Promise<SettingsReply> {
    this.cameraLoaded = true;
    return this.h.json<SettingsReply>("/api/settings", { what: "read OctoPrint's settings" }).then((s) => {
      this.camera = cameraFromSettings(s, this.h.base);
      return s;
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
    const checkedAt = nowIso(this.env);
    const pr = await this.h.send("/api/printer?exclude=sd", { what: "read the printer status" });
    if (pr.status === 409) return await this.notConnected(checkedAt);
    if (pr.status < 200 || pr.status >= 300) throw httpError(pr, "read the printer status", HINTS);
    const printer = parseJson<PrinterReply>(pr.text, "read the printer status", "OctoPrint");
    const job = await this.h.json<JobReply>("/api/job", { what: "read the print job" });
    if (!this.cameraLoaded) await this.settings().catch(() => undefined);
    return mapStatus(printer, job, checkedAt);
  }

  /** OctoPrint answers 409 on /api/printer when it is not connected to the printer's serial port. */
  private async notConnected(checkedAt: string): Promise<DriverStatus> {
    let state = "";
    try {
      state = (await this.h.json<{ current?: { state?: string } }>("/api/connection", { what: "read the connection state" })).current?.state ?? "";
    } catch {
      // keep the generic message
    }
    if (/^error/i.test(state)) return { state: "error", message: `OctoPrint lost the printer: ${state}. Check the USB cable, then click Connect in OctoPrint.`, checkedAt };
    return {
      state: "offline",
      message: `OctoPrint is running but not connected to the printer${state ? ` (${state})` : ""}. Turn the printer on and click Connect in OctoPrint's Connection panel.`,
      checkedAt,
    };
  }

  async upload(file: { name: string; data: Buffer; format: FileFormat }): Promise<void> {
    requireFormat(file.format, ["gcode"]);
    const form = new FormData();
    form.append("file", new Blob([file.data]), octoName(file.name));
    // No "select"/"print" fields: uploading never starts a print.
    await this.h.call("/api/files/local", { method: "POST", body: form, timeoutMs: uploadTimeout(file.data.length, 60_000), what: "upload the file" });
  }

  async start(fileName: string): Promise<void> {
    requireIdle(await this.read());
    await this.command(`/api/files/local/${encodeURIComponent(octoName(fileName))}`, { command: "select", print: true }, "start the print");
  }

  async pause(): Promise<void> {
    requireState(await this.read(), ["printing", "heating"], "pause");
    await this.command("/api/job", { command: "pause", action: "pause" }, "pause the print");
  }

  async resume(): Promise<void> {
    requireState(await this.read(), ["paused"], "resume");
    await this.command("/api/job", { command: "pause", action: "resume" }, "resume the print");
  }

  async cancel(): Promise<void> {
    requireState(await this.read(), ["printing", "heating", "paused"], "cancel");
    await this.command("/api/job", { command: "cancel" }, "cancel the print");
  }

  async setTemperature(heater: "nozzle" | "bed", celsius: number): Promise<void> {
    const c = checkTemperature(heater, celsius);
    requireState(await this.read(), ["idle", "heating", "printing", "paused"], "set a temperature");
    if (heater === "nozzle") await this.command("/api/printer/tool", { command: "target", targets: { tool0: c } }, "set the nozzle temperature");
    else await this.command("/api/printer/bed", { command: "target", target: c }, "set the bed temperature");
  }

  async sendGcode(line: string): Promise<string> {
    const cmd = checkConsole(await this.read(), line);
    await this.command("/api/printer/command", { commands: [cmd] }, "send the G-code");
    // The REST API does not return the printer's answer (it shows in OctoPrint's terminal tab).
    return "sent";
  }

  private async command(path: string, body: unknown, what: string): Promise<void> {
    try {
      await this.h.call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), what });
    } catch (e) {
      // 409 on a job command means the printer's state doesn't allow it right now.
      if (e instanceof DriverError && e.code === "busy" && !path.startsWith("/api/files/")) {
        throw new DriverError("rejected", `OctoPrint did not accept the request to ${what} in the printer's current state`, "Refresh the status and try again.");
      }
      throw e;
    }
  }

  async close(): Promise<void> {
    // HTTP only: nothing to close.
  }
}

/** OctoPrint stores uploads with spaces turned into "_" (its sanitize_name), so start() must use the same name. */
function octoName(name: string): string {
  return safeFileName(name).replace(/ /g, "_");
}

interface SettingsReply {
  appearance?: { name?: string };
  webcam?: { webcamEnabled?: boolean; streamUrl?: string; snapshotUrl?: string };
  plugins?: { classicwebcam?: { stream?: string; snapshot?: string } };
}

/** OctoPrint ≤ 1.8 keeps the camera in settings.webcam; 1.9+ in the bundled "classicwebcam" plugin. */
export function cameraFromSettings(s: SettingsReply, base: string): DriverCapabilities["camera"] {
  if (s.webcam?.webcamEnabled === false) return false;
  const stream = absoluteUrl(s.plugins?.classicwebcam?.stream || s.webcam?.streamUrl || "", base);
  if (stream) return { kind: "mjpeg", url: stream };
  const snap = absoluteUrl(s.plugins?.classicwebcam?.snapshot || s.webcam?.snapshotUrl || "", base);
  return snap ? { kind: "snapshot", url: snap } : false;
}

export function mapStatus(printer: PrinterReply, job: JobReply, checkedAt: string): DriverStatus {
  const t = printer.temperature ?? {};
  const temps: DriverStatus["temps"] = {};
  const nozzle = temp(t.tool0?.actual, t.tool0?.target);
  const bed = temp(t.bed?.actual, t.bed?.target);
  const chamber = temp(t.chamber?.actual, t.chamber?.target);
  if (nozzle) temps.nozzle = nozzle;
  if (bed) temps.bed = bed;
  if (chamber) temps.chamber = chamber;

  const f = printer.state?.flags ?? {};
  const text = printer.state?.text ?? job.state ?? "";
  const file = job.job?.file?.display || job.job?.file?.name || undefined;
  const pct = job.progress?.completion;
  const progress = typeof pct === "number" ? Math.min(1, Math.max(0, pct / 100)) : undefined;
  const jobInfo: NonNullable<DriverStatus["job"]> = { file, progress };
  if (typeof job.progress?.printTime === "number") jobInfo.elapsedS = Math.round(job.progress.printTime);
  if (typeof job.progress?.printTimeLeft === "number") jobInfo.remainingS = Math.round(job.progress.printTimeLeft);
  const base = { temps, checkedAt };

  if (f.error || (f.closedOrError && !/offline|closed/i.test(text))) {
    return { ...base, state: "error", message: printer.state?.error || job.error || text || "OctoPrint reports a printer error" };
  }
  if (f.closedOrError || f.operational === false) return { ...base, state: "offline", message: text || "Not connected" };
  if (f.cancelling) return { ...base, state: "busy", message: "Cancelling", job: jobInfo };
  if (f.pausing) return { ...base, state: "busy", message: "Pausing", job: jobInfo };
  if (f.paused) return { ...base, state: "paused", message: `Paused ${file ?? ""}`.trim(), job: jobInfo };
  if (f.finishing) return { ...base, state: "finishing", message: "Finishing", job: jobInfo };
  if (f.printing) {
    const heating = (pct ?? 0) < 1 && heatingNow(temps);
    return { ...base, state: heating ? "heating" : "printing", message: heating ? `Heating for ${file ?? "the print"}` : `Printing ${file ?? ""}`.trim(), job: jobInfo };
  }
  if (f.ready || f.operational) return { ...base, state: "idle", message: "Ready" };
  return { ...base, state: "busy", message: text || "Busy" };
}

/** Finds OctoPrint instances that announce `_octoprint._tcp` (OctoPrint's bundled Discovery plugin). */
export async function discoverOctoPrint(timeoutMs: number, opts?: BrowseOptions): Promise<Discovered[]> {
  const found = await browse("_octoprint._tcp.local", timeoutMs, opts);
  return found
    .filter((s) => s.address || s.host)
    .map((s) => ({ driver: "octoprint" as const, host: s.address ?? s.host!.replace(/\.$/, ""), port: s.port, name: s.instance }));
}

export const octoprintDriver: PrinterDriver = {
  id: "octoprint",
  name: "OctoPrint",
  description: "Any printer controlled by OctoPrint (usually a Marlin printer on a Raspberry Pi with OctoPi), using an OctoPrint application key.",
  fields: FIELDS,
  discover: (timeoutMs) => discoverOctoPrint(timeoutMs),
  connect: (config, deps) => new OctoPrintConnection(config, deps),
};
