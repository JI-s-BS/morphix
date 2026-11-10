// Driver "snapmaker": Snapmaker 2.0 (A150 / A250 / A350) HTTP API on port 8080, the API Luban uses
// for "connect over Wi-Fi". POST /api/v1/connect returns a token and the touchscreen asks the user to
// accept it; GET /api/v1/status?token=... then answers 204 (still waiting), 401 (refused) or 200 (JSON).
// Printing: POST /api/v1/prepare_print (multipart: token, type=3DP, file) then /api/v1/start_print;
// /api/v1/pause_print, /resume_print, /stop_print. Discovery: UDP "discover" broadcast to port 20054.
// J1 and Artisan: Luban talks to them over a newer protocol too; whether their firmware serves this
// same HTTP API was not checked, so they are listed as "may work".
// PROTOCOL IMPLEMENTATION: written from Luban's open-source client and community API notes, tested
// against a fake; NOT run on a real Snapmaker (catalog: verified "protocol").
// The token travels in the query string because this API requires it there: URLs are never logged.
import { createSocket as dgramCreateSocket } from "node:dgram";
import {
  DriverError,
  type DriverCapabilities,
  type DriverConfig,
  type DriverDeps,
  type DriverStatus,
  type Discovered,
  type FileFormat,
  type PrinterConnection,
  type PrintState,
  type TestResult,
} from "../types";
import { baseUrl, expectOk, readJson, request, type HttpTarget, type Stash } from "./http-util";
import type { PairableDriver, PairingResult } from "./pairing";

/** The bit of node:dgram discovery uses; tests pass a fake. */
export interface UdpSocketLike {
  on(event: "message", l: (msg: Buffer, rinfo: { address: string; port: number }) => void): unknown;
  on(event: "error", l: (err: Error) => void): unknown;
  bind(port: number, cb: () => void): unknown;
  setBroadcast(on: boolean): void;
  send(msg: string, port: number, address: string, cb?: (err: Error | null) => void): void;
  close(): void;
}

export interface SnapmakerOptions {
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  createUdpSocket?: () => UdpSocketLike;
}

export const SNAPMAKER_PORT = 8080;
export const SNAPMAKER_DISCOVERY_PORT = 20054;

interface SmStatus {
  status?: string;
  toolHead?: string;
  nozzleTemperature?: number;
  nozzleTargetTemperature?: number;
  heatedBedTemperature?: number;
  heatedBedTargetTemperature?: number;
  progress?: number;
  elapsedTime?: number;
  remainingTime?: number;
  fileName?: string;
  isFilamentOut?: boolean;
  isEnclosureDoorOpen?: boolean;
}

const NOT_PAIRED_HINT = "Press 'Pair' on the setup page, then tap Yes on the Snapmaker's touchscreen.";

const STATES: Record<string, [PrintState, string]> = {
  IDLE: ["idle", ""],
  FINISHED: ["idle", "Finished"],
  STOPPED: ["idle", "Stopped"],
  RUNNING: ["printing", "Printing"],
  RESUMING: ["printing", "Resuming"],
  PAUSING: ["paused", "Pausing"],
  PAUSED: ["paused", "Paused"],
  STOPPING: ["finishing", "Stopping"],
};

/** Parses a discovery reply: "Snapmaker@192.168.1.20|model:Snapmaker 2 Model A350|status:IDLE". */
export function parseDiscoveryReply(text: string, from: string): Discovered | undefined {
  const parts = text.trim().split("|");
  const head = parts[0] ?? "";
  if (!/@/.test(head) && !parts.some((p) => p.startsWith("model:"))) return undefined;
  const [name, ip] = head.split("@");
  const fields = Object.fromEntries(parts.slice(1).map((p) => [p.slice(0, p.indexOf(":")), p.slice(p.indexOf(":") + 1)]));
  const host = ip && /^[\d.]+$/.test(ip) ? ip : from;
  return { driver: "snapmaker", host, port: SNAPMAKER_PORT, name: name || undefined, model: fields.model || undefined };
}

class SnapmakerConnection implements PrinterConnection {
  readonly driver = "snapmaker" as const;
  private readonly t: HttpTarget;
  private readonly upload_t: HttpTarget;
  private readonly token: string;
  private stash?: Stash;
  private connected = false;
  private readonly now: () => number;

  constructor(private config: DriverConfig, opts: Required<Omit<SnapmakerOptions, "createUdpSocket">>, private deps: DriverDeps) {
    this.t = { fetch: deps.fetch ?? fetch, timeoutMs: opts.timeoutMs, what: "Snapmaker" };
    this.upload_t = { ...this.t, timeoutMs: opts.uploadTimeoutMs };
    this.token = typeof config.token === "string" ? config.token.trim() : "";
    this.now = deps.now ?? Date.now;
  }

  private url(path: string): string {
    return `${baseUrl(this.config.host, SNAPMAKER_PORT)}${path}`;
  }

  capabilities(): DriverCapabilities {
    return {
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
  }

  async test(): Promise<TestResult> {
    try {
      const s = await this.read();
      if (s.toolHead && !/3DP/i.test(s.toolHead)) {
        return { ok: false, code: "unsupported", message: "A laser or CNC module is attached",
          hint: "Morphix only prints: fit the 3D printing module and test again." };
      }
      return { ok: true, info: { model: s.toolHead ? "Snapmaker 2.0" : undefined } };
    } catch (e) {
      const err = asDriverError(e);
      return { ok: false, code: err.code, message: err.message, hint: err.hint };
    }
  }

  async status(): Promise<DriverStatus> {
    const checkedAt = new Date(this.now()).toISOString();
    let s: SmStatus;
    try {
      s = await this.read();
    } catch (e) {
      const err = asDriverError(e);
      return { state: "offline", message: err.hint ? `${err.message}. ${err.hint}` : err.message, checkedAt };
    }
    const temps = {
      nozzle: typeof s.nozzleTemperature === "number" ? { actual: s.nozzleTemperature, target: s.nozzleTargetTemperature } : undefined,
      bed: typeof s.heatedBedTemperature === "number" ? { actual: s.heatedBedTemperature, target: s.heatedBedTargetTemperature } : undefined,
    };
    if (s.toolHead && !/3DP/i.test(s.toolHead)) {
      return { state: "busy", message: "A laser or CNC module is attached; Morphix only prints", temps, checkedAt };
    }
    const [state, verb] = STATES[String(s.status ?? "").toUpperCase()] ?? ["busy", `Printer state: ${s.status ?? "unknown"}`];
    const notes = [s.isFilamentOut ? "Filament ran out" : "", s.isEnclosureDoorOpen ? "Enclosure door open" : ""].filter(Boolean);
    if (state === "idle") return { state, message: [verb, ...notes].filter(Boolean).join(". ") || undefined, temps, checkedAt };
    // Older firmware reports progress 0..100, newer 0..1.
    const p = typeof s.progress === "number" ? (s.progress > 1 ? s.progress / 100 : s.progress) : undefined;
    return {
      state,
      message: [s.fileName ? `${verb} ${s.fileName}` : verb, ...notes].join(". "),
      temps,
      job: {
        file: s.fileName,
        progress: p === undefined ? undefined : Math.max(0, Math.min(1, p)),
        elapsedS: typeof s.elapsedTime === "number" ? Math.round(s.elapsedTime) : undefined,
        remainingS: typeof s.remainingTime === "number" ? Math.round(s.remainingTime) : undefined,
      },
      checkedAt,
    };
  }

  async upload(file: { name: string; data: Buffer; format: FileFormat }): Promise<void> {
    if (file.format !== "gcode") {
      throw new DriverError("unsupported", `Snapmaker takes plain G-code, not .${file.format}`, "Slice for this printer with G-code output.");
    }
    this.stash = { name: file.name, data: file.data };
  }

  async start(fileName: string): Promise<void> {
    const s = await this.status();
    if (s.state === "offline") throw new DriverError("unreachable", s.message ?? "Cannot reach the Snapmaker");
    if (s.state !== "idle") throw new DriverError("busy", `The printer is not idle (${s.message ?? s.state})`, "Wait until it is idle, then start again.");
    const stash = this.stash;
    if (!stash || stash.name !== fileName) throw new DriverError("rejected", `${fileName} has not been uploaded`, "Upload the sliced file again, then start.");
    const form = new FormData();
    form.append("token", this.token);
    form.append("type", "3DP");
    form.append("file", new Blob([new Uint8Array(stash.data)]), fileName);
    await expectOk(this.t, await request(this.upload_t, this.url("/api/v1/prepare_print"), { method: "POST", body: form }), "the file");
    await this.post("/api/v1/start_print", "the start command");
    this.stash = undefined;
    this.deps.log?.("info", "[snapmaker] print started", { file: fileName });
  }

  async pause(): Promise<void> {
    const s = await this.status();
    if (s.state !== "printing") throw new DriverError("rejected", "Nothing is printing", "Start a print first.");
    await this.post("/api/v1/pause_print", "the pause command");
  }

  async resume(): Promise<void> {
    const s = await this.status();
    if (s.state !== "paused") throw new DriverError("rejected", "The print is not paused", "Pause it first.");
    await this.post("/api/v1/resume_print", "the resume command");
  }

  async cancel(): Promise<void> {
    const s = await this.status();
    if (s.state !== "printing" && s.state !== "paused") throw new DriverError("rejected", "Nothing is printing", "There is no print to cancel.");
    await this.post("/api/v1/stop_print", "the stop command");
  }

  async close(): Promise<void> {
    this.stash = undefined;
  }

  /** Reads /api/v1/status, (re)connecting with the saved token first. */
  private async read(): Promise<SmStatus> {
    if (!this.token) throw new DriverError("auth", "Morphix is not paired with this Snapmaker yet", NOT_PAIRED_HINT);
    if (!this.connected) {
      await this.connect();
      this.connected = true;
    }
    const res = await request(this.t, this.url(`/api/v1/status?token=${encodeURIComponent(this.token)}`));
    if (res.status === 204) {
      throw new DriverError("auth", "Waiting for you to accept Morphix on the Snapmaker", "Tap Yes on the printer's touchscreen, then test again.");
    }
    if (res.status === 401 || res.status === 403) {
      this.connected = false;
      throw new DriverError("auth", "The Snapmaker no longer accepts Morphix's token", NOT_PAIRED_HINT);
    }
    return readJson<SmStatus>(this.t, await expectOk(this.t, res, "reading status"));
  }

  private async connect(): Promise<void> {
    const res = await request(this.t, this.url("/api/v1/connect"), { method: "POST", body: new URLSearchParams({ token: this.token }) });
    if (res.status === 401 || res.status === 403) throw new DriverError("auth", "The Snapmaker refused Morphix's token", NOT_PAIRED_HINT);
    await expectOk(this.t, res, "the connection");
    await res.body?.cancel().catch(() => {});
  }

  private async post(path: string, what: string): Promise<void> {
    if (!this.token) throw new DriverError("auth", "Morphix is not paired with this Snapmaker yet", NOT_PAIRED_HINT);
    const res = await request(this.t, this.url(path), { method: "POST", body: new URLSearchParams({ token: this.token }) });
    await expectOk(this.t, res, what);
  }
}

function asDriverError(e: unknown): DriverError {
  if (e instanceof DriverError) return e;
  return new DriverError("protocol", (e as Error)?.message ?? String(e), "Try again; if it keeps failing, restart the printer.");
}

export function discoverSnapmakers(timeoutMs: number, createUdpSocket: () => UdpSocketLike): Promise<Discovered[]> {
  return new Promise((resolve) => {
    const found = new Map<string, Discovered>();
    let sock: UdpSocketLike;
    try {
      sock = createUdpSocket();
    } catch {
      return resolve([]);
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, Math.max(100, timeoutMs));
    sock.on("error", finish);
    sock.on("message", (msg, rinfo) => {
      const d = parseDiscoveryReply(msg.toString("utf8"), rinfo.address);
      if (d) found.set(d.host, d);
    });
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
        sock.send("discover", SNAPMAKER_DISCOVERY_PORT, "255.255.255.255", (err) => { if (err) finish(); });
      } catch {
        finish();
      }
    });
  });
}

export function createSnapmakerDriver(options: SnapmakerOptions = {}): PairableDriver {
  const opts = { timeoutMs: options.timeoutMs ?? 8000, uploadTimeoutMs: options.uploadTimeoutMs ?? 180_000 };
  const createUdpSocket = options.createUdpSocket ?? (() => dgramCreateSocket({ type: "udp4", reuseAddr: true }) as unknown as UdpSocketLike);
  const fail = (e: unknown): PairingResult => {
    const err = asDriverError(e);
    return { state: "failed", message: err.message, hint: err.hint };
  };
  const target = (deps?: DriverDeps): HttpTarget => ({ fetch: deps?.fetch ?? fetch, timeoutMs: opts.timeoutMs, what: "Snapmaker" });
  return {
    id: "snapmaker",
    name: "Snapmaker 2.0",
    description: "Snapmaker 2.0 A150 / A250 / A350 (J1 and Artisan may work) over Wi-Fi, through the API Luban uses.",
    fields: [
      { key: "host", label: "Printer IP address", kind: "host", required: true,
        help: "On the touchscreen: Settings → Wi-Fi shows the IP address once the printer is on your network." },
      { key: "token", label: "Access token", kind: "secret", required: false,
        help: "Filled in by 'Pair': Morphix asks the printer, and you tap Yes on its touchscreen." },
    ],
    discover: (timeoutMs) => discoverSnapmakers(timeoutMs, createUdpSocket),
    pairing: {
      async start(config, deps) {
        try {
          const t = target(deps);
          const res = await request(t, `${baseUrl(config.host, SNAPMAKER_PORT)}/api/v1/connect`, {
            method: "POST",
            body: new URLSearchParams({ token: "" }),
          });
          const body = await readJson<{ token?: string }>(t, await expectOk(t, res, "the pairing request"));
          if (!body.token) throw new DriverError("protocol", "The Snapmaker did not return a token", "Update the printer's firmware, then try again.");
          return { state: "waiting", save: { token: body.token }, message: "Tap Yes on the Snapmaker's touchscreen",
            hint: "The screen asks whether to accept a connection from Morphix." };
        } catch (e) {
          return fail(e);
        }
      },
      async check(config, deps) {
        try {
          const token = String(config.token ?? "").trim();
          if (!token) return { state: "failed", message: "No pairing in progress", hint: "Press 'Pair' to start." };
          const t = target(deps);
          const res = await request(t, `${baseUrl(config.host, SNAPMAKER_PORT)}/api/v1/status?token=${encodeURIComponent(token)}`);
          await res.body?.cancel().catch(() => {});
          if (res.status === 204) return { state: "waiting", message: "Waiting for you to tap Yes on the touchscreen" };
          if (res.status === 401 || res.status === 403) return { state: "denied", message: "The Snapmaker declined the connection", hint: "Press 'Pair' again and tap Yes." };
          if (res.ok) return { state: "paired", message: "Paired with the Snapmaker" };
          return { state: "failed", message: `The Snapmaker answered HTTP ${res.status}`, hint: "Press 'Pair' to try again." };
        } catch (e) {
          return fail(e);
        }
      },
    },
    connect: (config, deps = {}) => new SnapmakerConnection(config, opts, deps),
  };
}

export const snapmakerDriver = createSnapmakerDriver();
