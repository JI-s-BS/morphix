// Duet boards with RepRapFirmware 3 over HTTP. Two modes, detected on the first call:
//   standalone (Duet 2 / Duet 3 with WiFi or Ethernet): rr_connect, rr_model, rr_upload, rr_gcode, rr_reply
//   SBC (Duet 3 + Raspberry Pi running DuetSoftwareFramework): /machine/connect, /machine/status, /machine/file, /machine/code
// IMPLEMENTED FROM THE PROTOCOL DOCS, NOT TESTED ON A REAL PRINTER (catalog: verified "protocol"):
//   https://github.com/Duet3D/RepRapFirmware/wiki/HTTP-requests          (standalone rr_* API)
//   https://github.com/Duet3D/DuetSoftwareFramework/wiki/REST-API         (SBC /machine/* API)
//   https://github.com/Duet3D/RepRapFirmware/wiki/Object-Model-Documentation (state.status, job, heat, tools)
// Tests run against the fake in ./fake/duet.ts.
// Note: RepRapFirmware's protocol sends the board password as a query parameter of rr_connect /
// machine/connect (there is no other login). It only goes to the printer; Morphix never logs it.
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
  type Reply,
  type RequestOpts,
} from "./common";

const FIELDS: ConnectionField[] = [
  {
    key: "host",
    label: "Duet address",
    kind: "host",
    required: true,
    help: "The address you open Duet Web Control with, e.g. 192.168.1.70 or myprinter.local (M552 in the console or the PanelDue shows the IP).",
  },
  { key: "port", label: "Port", kind: "port", required: false, default: 80, help: "80 unless you changed it with M586 in config.g." },
  {
    key: "password",
    label: "Board password (optional)",
    kind: "secret",
    required: false,
    help: "Only needed if your config.g has an M551 line (that line sets it); leave empty otherwise.",
  },
];

const HINTS: Hints = {
  name: "Duet",
  auth: "Check the board password: it is the one set by M551 in config.g (sys/config.g in Duet Web Control).",
  unreachable: "Check that the Duet is powered, on the network and that Duet Web Control opens at this address.",
};

type Mode = "standalone" | "dsf";

interface Heater {
  current?: number;
  active?: number;
  standby?: number;
  state?: string;
}

export interface DuetModel {
  state?: { status?: string; currentTool?: number };
  job?: {
    file?: { fileName?: string | null; size?: number; numLayers?: number } | null;
    filePosition?: number | null;
    duration?: number | null;
    layer?: number | null;
    timesLeft?: { file?: number | null; filament?: number | null; slicer?: number | null };
  };
  heat?: { heaters?: (Heater | null)[]; bedHeaters?: number[]; chamberHeaters?: number[] };
  tools?: ({ heaters?: number[] } | null)[];
  boards?: { firmwareName?: string; firmwareVersion?: string; name?: string; shortName?: string; uniqueId?: string }[];
  network?: { name?: string };
}

const GCODES = "0:/gcodes/";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class DuetConnection implements PrinterConnection {
  readonly driver = "duet" as const;
  private readonly env: Env;
  private readonly http?: Http;
  private readonly configError?: unknown;
  private readonly password: string;
  private mode?: Mode;
  private sessionKey?: string;
  private boardType?: string;

  constructor(config: DriverConfig, deps?: DriverDeps) {
    this.env = makeEnv(deps);
    this.password = str(config.password);
    try {
      this.http = new Http(baseUrl(config, 80), this.env, HINTS, timeoutFrom(config), {
        headers: (): Record<string, string> => (this.sessionKey ? { "X-Session-Key": this.sessionKey } : {}),
      });
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
      camera: false,
    };
  }

  /** Logs in and finds out which API the board speaks. */
  private async login(): Promise<void> {
    this.mode = undefined;
    this.sessionKey = undefined;
    // No M551 password means RepRapFirmware accepts any password; "reprap" is its documented default.
    const pw = encodeURIComponent(this.password || "reprap");
    const r = await this.h.send(`/rr_connect?password=${pw}`, { what: "log in to the Duet" });
    const j = tryJson<{ err?: number; sessionKey?: number | string; boardType?: string }>(r);
    if (r.status === 200 && j && typeof j.err === "number") {
      if (j.err === 1) throw new DriverError("auth", "The Duet refused the password", HINTS.auth);
      if (j.err === 2) throw new DriverError("busy", "The Duet has no free connection slots", "Close some Duet Web Control browser tabs, then try again.");
      if (j.err !== 0) throw new DriverError("protocol", `The Duet refused the login (error ${j.err})`, HINTS.unreachable);
      this.mode = "standalone";
      if (j.sessionKey !== undefined && j.sessionKey !== null) this.sessionKey = String(j.sessionKey);
      this.boardType = j.boardType;
      return;
    }
    if (r.status === 401 || r.status === 403) throw new DriverError("auth", "The Duet refused the password", HINTS.auth);
    // Not a standalone board: try DuetSoftwareFramework (SBC mode).
    const d = await this.h.send(`/machine/connect?password=${encodeURIComponent(this.password)}`, { what: "log in to the Duet" });
    if (d.status === 401 || d.status === 403) throw new DriverError("auth", "The Duet refused the password", HINTS.auth);
    const dj = tryJson<{ sessionKey?: string | number }>(d);
    if (d.status === 200 && dj) {
      this.mode = "dsf";
      if (dj.sessionKey !== undefined && dj.sessionKey !== null) this.sessionKey = String(dj.sessionKey);
      return;
    }
    // Older DSF without /machine/connect (no password support).
    const s = await this.h.send("/machine/status", { what: "read the Duet status" });
    if (s.status === 200 && tryJson(s)) {
      this.mode = "dsf";
      return;
    }
    throw new DriverError("protocol", "No Duet / RepRapFirmware API answered at this address", "Check the address, and that this is a Duet board (not OctoPrint or Klipper).");
  }

  /** One request with an active session; logs in again once if the session expired (401). */
  private async req(path: string, opts: RequestOpts): Promise<Reply> {
    if (!this.mode) await this.login();
    let r = await this.h.send(path, opts);
    if (r.status === 401) {
      await this.login();
      r = await this.h.send(path, opts);
    }
    if (r.status < 200 || r.status >= 300) throw httpError(r, opts.what, HINTS);
    return r;
  }

  private async model(): Promise<DuetModel> {
    if (!this.mode) await this.login();
    if (this.mode === "dsf") {
      try {
        return parseJson<DuetModel>((await this.req("/machine/status", { what: "read the Duet status" })).text, "read the Duet status", "Duet");
      } catch (e) {
        if (e instanceof DriverError && e.code === "unsupported") {
          return parseJson<DuetModel>((await this.req("/machine/model", { what: "read the Duet status" })).text, "read the Duet status", "Duet");
        }
        throw e;
      }
    }
    const model: DuetModel = {};
    for (const key of ["state", "job", "heat", "tools"] as const) {
      const r = await this.req(`/rr_model?key=${key}&flags=d99v`, { what: "read the Duet status" });
      (model as Record<string, unknown>)[key] = parseJson<{ result?: unknown }>(r.text, "read the Duet status", "Duet").result;
    }
    return model;
  }

  test(): Promise<TestResult> {
    return guardTest(async () => {
      await this.login();
      let boards: DuetModel["boards"];
      let network: DuetModel["network"];
      if (this.mode === "dsf") {
        const m = await this.model();
        boards = m.boards;
        network = m.network;
      } else {
        const b = tryJson<{ result?: DuetModel["boards"] }>(await this.req("/rr_model?key=boards&flags=d99v", { what: "read the board info" }));
        const n = tryJson<{ result?: DuetModel["network"] }>(await this.req("/rr_model?key=network&flags=d99v", { what: "read the board info" }));
        boards = b?.result;
        network = n?.result;
      }
      const board = boards?.[0];
      return {
        ok: true,
        info: {
          model: board?.name ?? this.boardType,
          firmware: board?.firmwareVersion ? `${board.firmwareName ?? "RepRapFirmware"} ${board.firmwareVersion}${this.mode === "dsf" ? " (SBC)" : ""}` : undefined,
          serial: board?.uniqueId,
          name: network?.name,
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
    return mapStatus(await this.model(), nowIso(this.env));
  }

  private async gcode(cmd: string, timeoutMs?: number): Promise<string> {
    if (!this.mode) await this.login();
    if (this.mode === "dsf") {
      return (await this.req("/machine/code", { method: "POST", headers: { "Content-Type": "text/plain" }, body: cmd, timeoutMs, what: "send the G-code" })).text;
    }
    await this.req(`/rr_gcode?gcode=${encodeURIComponent(cmd)}`, { timeoutMs, what: "send the G-code" });
    return "";
  }

  async upload(file: { name: string; data: Buffer; format: FileFormat }): Promise<void> {
    requireFormat(file.format, ["gcode"]);
    if (!this.mode) await this.login();
    const target = GCODES + safeFileName(file.name);
    const timeoutMs = uploadTimeout(file.data.length, 60_000);
    if (this.mode === "dsf") {
      await this.req(`/machine/file/${encodeURIComponent(target)}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.data, timeoutMs, what: "upload the file" });
      return;
    }
    const r = await this.req(`/rr_upload?name=${encodeURIComponent(target)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file.data, timeoutMs, what: "upload the file" });
    const j = tryJson<{ err?: number }>(r);
    if (!j || j.err !== 0) throw new DriverError("rejected", "The Duet could not store the file", "Check that the SD card is in and has free space.");
  }

  async start(fileName: string): Promise<void> {
    requireIdle(await this.read());
    await this.gcode(`M32 "${GCODES}${safeFileName(fileName)}"`);
  }

  async pause(): Promise<void> {
    requireState(await this.read(), ["printing", "heating"], "pause");
    await this.gcode("M25");
  }

  async resume(): Promise<void> {
    requireState(await this.read(), ["paused"], "resume");
    await this.gcode("M24");
  }

  /** RepRapFirmware cancels a print by pausing it (M25) and then M0 (runs cancel.g); waits up to ~20 s for the pause. */
  async cancel(): Promise<void> {
    let st = await this.read();
    requireState(st, ["printing", "heating", "paused", "busy"], "cancel");
    if (st.state !== "paused") {
      await this.gcode("M25");
      for (let tries = 0; st.state !== "paused"; tries++) {
        if (tries >= 80) throw new DriverError("timeout", "The Duet did not pause, so the print could not be cancelled", "Cancel it on the printer's screen or in Duet Web Control.");
        await sleep(250);
        st = await this.status();
        if (st.state === "idle") return; // finished or cancelled meanwhile
        if (st.state === "offline") throw new DriverError("unreachable", st.message ?? "The Duet stopped answering", HINTS.unreachable);
      }
    }
    await this.gcode("M0");
  }

  async setTemperature(heater: "nozzle" | "bed", celsius: number): Promise<void> {
    const c = checkTemperature(heater, celsius);
    requireState(await this.read(), ["idle", "heating", "printing", "paused"], "set a temperature");
    await this.gcode(heater === "nozzle" ? `M104 S${c}` : `M140 S${c}`);
  }

  async sendGcode(line: string): Promise<string> {
    const cmd = checkConsole(await this.read(), line);
    const out = await this.gcode(cmd, 120_000);
    if (this.mode === "dsf") return out.trim() || "ok";
    await sleep(300);
    const reply = await this.req("/rr_reply", { what: "read the G-code reply" });
    return reply.text.trim() || "ok";
  }

  async close(): Promise<void> {
    if (!this.mode || !this.http) return;
    try {
      await this.http.send(this.mode === "dsf" ? "/machine/disconnect" : "/rr_disconnect", { timeoutMs: 2000, what: "log out" });
    } catch {
      // the session times out by itself
    }
    this.mode = undefined;
    this.sessionKey = undefined;
  }
}

function tryJson<T = unknown>(r: Reply): T | undefined {
  try {
    return JSON.parse(r.text) as T;
  } catch {
    return undefined;
  }
}

function heaterTemp(h: Heater | null | undefined): ReturnType<typeof temp> {
  if (!h) return undefined;
  const target = h.state === "active" ? h.active : h.state === "standby" ? h.standby : 0;
  return temp(h.current, target);
}

export function mapStatus(m: DuetModel, checkedAt: string): DriverStatus {
  const heaters = m.heat?.heaters ?? [];
  const temps: DriverStatus["temps"] = {};
  const toolIdx = (m.state?.currentTool ?? -1) >= 0 ? m.state!.currentTool! : 0;
  const nozzleIdx = m.tools?.[toolIdx]?.heaters?.[0] ?? m.tools?.[0]?.heaters?.[0];
  const bedIdx = (m.heat?.bedHeaters ?? []).find((i) => i >= 0);
  const chamberIdx = (m.heat?.chamberHeaters ?? []).find((i) => i >= 0);
  const nozzle = nozzleIdx !== undefined ? heaterTemp(heaters[nozzleIdx]) : undefined;
  const bed = bedIdx !== undefined ? heaterTemp(heaters[bedIdx]) : undefined;
  const chamber = chamberIdx !== undefined ? heaterTemp(heaters[chamberIdx]) : undefined;
  if (nozzle) temps.nozzle = nozzle;
  if (bed) temps.bed = bed;
  if (chamber) temps.chamber = chamber;

  const j = m.job ?? {};
  const fullName = j.file?.fileName ?? undefined;
  const file = fullName ? fullName.split("/").pop() : undefined;
  const size = j.file?.size ?? 0;
  const progress = size > 0 && typeof j.filePosition === "number" ? Math.min(1, Math.max(0, j.filePosition / size)) : undefined;
  const job: NonNullable<DriverStatus["job"]> = { file, progress };
  if (typeof j.duration === "number") job.elapsedS = Math.round(j.duration);
  const left = j.timesLeft?.slicer ?? j.timesLeft?.file ?? j.timesLeft?.filament;
  if (typeof left === "number") job.remainingS = Math.round(left);
  if (typeof j.layer === "number" && (j.file?.numLayers ?? 0) > 0) job.layer = [j.layer, j.file!.numLayers!];
  const base = { temps, checkedAt };
  const fault = heaters.some((h) => h?.state === "fault");

  switch (m.state?.status) {
    case "processing":
    case "printing": {
      const heating = (progress ?? 0) < 0.01 && heatingNow(temps);
      return { ...base, state: heating ? "heating" : "printing", message: heating ? `Heating for ${file ?? "the print"}` : `Printing ${file ?? ""}`.trim(), job };
    }
    case "paused":
      return { ...base, state: "paused", message: `Paused ${file ?? ""}`.trim(), job };
    case "pausing":
      return { ...base, state: "busy", message: "Pausing", job };
    case "resuming":
      return { ...base, state: "busy", message: "Resuming", job };
    case "cancelling":
      return { ...base, state: "busy", message: "Cancelling", job };
    case "simulating":
      return { ...base, state: "busy", message: "Simulating a file", job };
    case "halted":
      return { ...base, state: "error", message: "The Duet is halted (emergency stop). Send M999 or reset the board." };
    case "off":
      return { ...base, state: "offline", message: "The Duet's main power is off (or it is in low-power mode)" };
    case "disconnected":
      return { ...base, state: "offline", message: "The Duet SBC lost the connection to the board" };
    case "idle":
      return fault ? { ...base, state: "error", message: "A heater reports a fault: check the Duet Web Control console" } : { ...base, state: "idle", message: "Ready" };
    default:
      return { ...base, state: "busy", message: m.state?.status ? `Busy (${m.state.status})` : "Busy" };
  }
}

export const duetDriver: PrinterDriver = {
  id: "duet",
  name: "Duet (RepRapFirmware)",
  description: "Printers with a Duet 2 or Duet 3 board running RepRapFirmware 3, standalone or with a Raspberry Pi (SBC mode).",
  fields: FIELDS,
  connect: (config, deps) => new DuetConnection(config, deps),
};
