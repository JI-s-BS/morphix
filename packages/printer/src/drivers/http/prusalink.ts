// Prusa printers through PrusaLink's v1 API: MK4 / MK4S / MK3.9 / MINI+ / XL / CORE One (PrusaLink is built
// into the Buddy firmware) and MK3S+ / MK2.5S with Prusa Link on a Raspberry Pi Zero (version 0.7 or newer).
// IMPLEMENTED FROM THE PROTOCOL DOCS, NOT TESTED ON A REAL PRINTER (catalog: verified "protocol"):
//   https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml   (v1: status, job, files, info)
//   https://github.com/prusa3d/Prusa-Firmware-Buddy (lib/WUI: HTTP Digest login, user "maker")
//   RFC 7616 (HTTP Digest), implemented in ./digest.ts
// Tests run against the fake in ./fake/prusalink.ts.
// MK3S+ differences (Prusa Link on a Pi): the user name and password are the ones chosen in its setup
// wizard (not "maker" + a generated password), files go to storage "local" (the Pi) instead of "usb", and
// Prusa Link older than 0.7 has no /api/v1 at all (test() then says to update it).
import type {
  ConnectionField,
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
  baseUrl,
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
import { DigestAuth } from "./digest";

const FIELDS: ConnectionField[] = [
  {
    key: "host",
    label: "Printer address",
    kind: "host",
    required: true,
    help: "The printer's IP address: on the printer open Settings → Network (MK4/XL/MINI/CORE One show it there; on an MK3S+ it is the Prusa Link Raspberry Pi's address).",
  },
  {
    key: "username",
    label: "User name",
    kind: "text",
    required: false,
    default: "maker",
    help: "Always \"maker\" on MK4, MK3.9, MINI+, XL and CORE One; on an MK3S+ with Prusa Link it is the user you chose in its setup wizard.",
  },
  {
    key: "password",
    label: "PrusaLink password",
    kind: "secret",
    required: false,
    help: "On the printer: Settings → Network → PrusaLink shows the password (MK3S+: the password from the Prusa Link setup wizard).",
  },
  {
    key: "apiKey",
    label: "API key (older firmware only)",
    kind: "secret",
    required: false,
    help: "Only for older firmware that shows an \"API key\" instead of a password under Settings → Network → PrusaLink; leave empty otherwise.",
  },
];

const HINTS: Hints = {
  name: "PrusaLink",
  auth: "Check the password: on the printer open Settings → Network → PrusaLink (user name \"maker\"). Older firmware uses the API key shown there instead.",
  unreachable: "Check that the printer is on, connected to the network (Settings → Network) and that PrusaLink is enabled.",
};

type PrusaState = "IDLE" | "BUSY" | "PRINTING" | "PAUSED" | "FINISHED" | "STOPPED" | "ERROR" | "ATTENTION" | "READY";

interface StatusReply {
  storage?: { path?: string; name?: string; read_only?: boolean };
  printer?: {
    state?: PrusaState | string;
    temp_nozzle?: number;
    target_nozzle?: number;
    temp_bed?: number;
    target_bed?: number;
  };
  job?: { id?: number; progress?: number; time_remaining?: number; time_printing?: number };
}

interface JobReply {
  id?: number;
  state?: string;
  progress?: number;
  time_remaining?: number;
  time_printing?: number;
  file?: { name?: string; display_name?: string; path?: string };
}

class PrusaLinkConnection implements PrinterConnection {
  readonly driver = "prusalink" as const;
  private readonly env: Env;
  private readonly http?: Http;
  private readonly digest?: DigestAuth;
  private readonly configError?: unknown;
  private storage = "usb";
  private jobId?: number;

  constructor(config: DriverConfig, deps?: DriverDeps) {
    this.env = makeEnv(deps);
    try {
      const base = baseUrl(config, 80);
      const apiKey = str(config.apiKey);
      const password = str(config.password);
      if (apiKey) {
        this.http = new Http(base, this.env, HINTS, timeoutFrom(config), { headers: () => ({ "X-Api-Key": apiKey }) });
      } else {
        if (!password) throw new DriverError("auth", "No PrusaLink password was entered", HINTS.auth);
        this.digest = new DigestAuth(str(config.username) || "maker", password);
        this.http = new Http(base, this.env, HINTS, timeoutFrom(config), this.digest);
      }
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
      // PrusaLink v1 has no temperature or G-code endpoint.
      setTemperature: false,
      gcodeConsole: false,
      camera: false,
    };
  }

  test(): Promise<TestResult> {
    return guardTest(async () => {
      const v = await this.h.json<{ api?: string; server?: string; text?: string; hostname?: string; firmware?: string }>("/api/version", {
        what: "read PrusaLink's version",
      });
      await this.readStatus(); // checks that the v1 API exists
      let info: { name?: string; hostname?: string; serial?: string } = {};
      try {
        info = await this.h.json("/api/v1/info", { what: "read the printer's info" });
      } catch {
        // optional
      }
      return {
        ok: true,
        info: {
          name: info.name || info.hostname || v.hostname || undefined,
          serial: info.serial || undefined,
          firmware: v.firmware ?? (v.server ? `${v.text ?? "PrusaLink"} ${v.server}` : v.text),
        },
      };
    });
  }

  private async readStatus(): Promise<StatusReply> {
    const r = await this.h.send("/api/v1/status", { what: "read the printer status" });
    if (r.status === 404) {
      throw new DriverError("unsupported", "This PrusaLink is too old (no v1 API)", "Update the printer firmware (MK4/MINI/XL: 5.0 or newer; MK3S+: Prusa Link 0.7 or newer).");
    }
    if (r.status < 200 || r.status >= 300) throw httpError(r, "read the printer status", HINTS);
    const st = parseJson<StatusReply>(r.text, "read the printer status", "PrusaLink");
    const storage = (st.storage?.path ?? st.storage?.name ?? "").replace(/^\/+|\/+$/g, "");
    if (storage && /^[A-Za-z0-9_-]+$/.test(storage)) this.storage = storage;
    this.jobId = typeof st.job?.id === "number" ? st.job.id : undefined;
    return st;
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
    const st = await this.readStatus();
    let job: JobReply | undefined;
    if (this.jobId !== undefined) {
      const r = await this.h.send("/api/v1/job", { what: "read the print job" });
      if (r.status === 200) job = parseJson<JobReply>(r.text, "read the print job", "PrusaLink");
    }
    return mapStatus(st, job, nowIso(this.env));
  }

  async upload(file: { name: string; data: Buffer; format: FileFormat }): Promise<void> {
    requireFormat(file.format, ["gcode"]);
    const st = await this.read(); // also gets the Digest challenge before sending a large body
    const name = safeFileName(file.name);
    const r = await this.h.send(`/api/v1/files/${this.storage}/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        // Uploading never starts a print; start() does, after checking the printer is idle.
        "Print-After-Upload": "?0",
        // Replace an older copy only while nothing prints (the running file must not change under it).
        Overwrite: st.state === "idle" ? "?1" : "?0",
      },
      body: file.data,
      timeoutMs: uploadTimeout(file.data.length, 60_000),
      what: "upload the file",
    });
    if (r.status === 409) throw new DriverError("rejected", `A file named ${name} is already on the printer`, "Wait until the printer is idle, or rename the file.");
    if (r.status < 200 || r.status >= 300) throw httpError(r, "upload the file (is a USB stick with free space in the printer?)", HINTS);
  }

  async start(fileName: string): Promise<void> {
    requireIdle(await this.read());
    await this.h.call(`/api/v1/files/${this.storage}/${encodeURIComponent(safeFileName(fileName))}`, { method: "POST", what: "start the print" });
  }

  async pause(): Promise<void> {
    requireState(await this.read(), ["printing", "heating"], "pause");
    await this.jobCommand("PUT", "/pause", "pause the print");
  }

  async resume(): Promise<void> {
    requireState(await this.read(), ["paused"], "resume");
    await this.jobCommand("PUT", "/resume", "resume the print");
  }

  async cancel(): Promise<void> {
    requireState(await this.read(), ["printing", "heating", "paused", "busy"], "cancel");
    await this.jobCommand("DELETE", "", "cancel the print");
  }

  private async jobCommand(method: string, suffix: string, what: string): Promise<void> {
    if (this.jobId === undefined) throw new DriverError("rejected", `Can't ${what}: the printer reports no job`);
    try {
      await this.h.call(`/api/v1/job/${this.jobId}${suffix}`, { method, what });
    } catch (e) {
      if (e instanceof DriverError && e.code === "busy") throw new DriverError("rejected", `The printer did not accept the request to ${what} in its current state`, "Refresh the status and try again.");
      throw e;
    }
  }

  async close(): Promise<void> {
    // HTTP only: nothing to close.
  }
}

export function mapStatus(st: StatusReply, job: JobReply | undefined, checkedAt: string): DriverStatus {
  const p = st.printer ?? {};
  const temps: DriverStatus["temps"] = {};
  const nozzle = temp(p.temp_nozzle, p.target_nozzle);
  const bed = temp(p.temp_bed, p.target_bed);
  if (nozzle) temps.nozzle = nozzle;
  if (bed) temps.bed = bed;
  const j = st.job;
  const file = job?.file?.display_name || job?.file?.name || undefined;
  const pct = j?.progress ?? job?.progress;
  const jobInfo: NonNullable<DriverStatus["job"]> = { file, progress: typeof pct === "number" ? Math.min(1, Math.max(0, pct / 100)) : undefined };
  const elapsed = j?.time_printing ?? job?.time_printing;
  const remaining = j?.time_remaining ?? job?.time_remaining;
  if (typeof elapsed === "number") jobInfo.elapsedS = elapsed;
  if (typeof remaining === "number" && remaining >= 0) jobInfo.remainingS = remaining;
  const base = { temps, checkedAt };
  const hasJob = j?.id !== undefined;

  switch (String(p.state ?? "").toUpperCase()) {
    case "PRINTING": {
      const heating = (pct ?? 0) < 1 && heatingNow(temps);
      return { ...base, state: heating ? "heating" : "printing", message: heating ? `Heating for ${file ?? "the print"}` : `Printing ${file ?? ""}`.trim(), job: jobInfo };
    }
    case "PAUSED":
      return { ...base, state: "paused", message: `Paused ${file ?? ""}`.trim(), job: jobInfo };
    case "ATTENTION":
      // The printer waits for someone at its screen (filament runout, crash detection, a question).
      return { ...base, state: "busy", message: "The printer needs attention: check its screen", ...(hasJob ? { job: jobInfo } : {}) };
    case "BUSY":
      return { ...base, state: "busy", message: "Busy (calibrating, loading filament or using its menu)", ...(hasJob ? { job: jobInfo } : {}) };
    case "ERROR":
      return { ...base, state: "error", message: "The printer reports an error: check its screen" };
    case "FINISHED":
      return { ...base, state: "idle", message: file ? `Finished ${file}` : "Finished" };
    case "STOPPED":
      return { ...base, state: "idle", message: file ? `Stopped ${file}` : "Stopped" };
    case "IDLE":
    case "READY":
      return { ...base, state: "idle", message: "Ready" };
    default:
      return { ...base, state: "busy", message: p.state ? `Unknown state ${String(p.state).slice(0, 20)}` : "Unknown state" };
  }
}

export const prusalinkDriver: PrinterDriver = {
  id: "prusalink",
  name: "Prusa (PrusaLink)",
  description: "Prusa MK4, MK4S, MK3.9, MINI+, XL and CORE One through the PrusaLink built into their firmware, and the MK3S+ with Prusa Link on a Raspberry Pi.",
  fields: FIELDS,
  connect: (config, deps) => new PrusaLinkConnection(config, deps),
};
