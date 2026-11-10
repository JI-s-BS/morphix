// Driver "ultimaker": Ultimaker S3 / S5 / S7 (and UM3) local HTTP API, /api/v1 on port 80.
// Reading (/api/v1/printer, /api/v1/print_job, /api/v1/system) needs no auth. Control needs a
// digest-auth id/key pair from the pairing flow: POST /api/v1/auth/request → the printer shows an
// "Allow" prompt → GET /api/v1/auth/check/<id> says "authorized". POST /api/v1/print_job uploads a
// .ufp / .gcode and starts it in one request, so upload() keeps the file in memory and start() sends it.
// PROTOCOL IMPLEMENTATION: written from Ultimaker's published local API docs (http://<printer>/docs/api/)
// and tested against a fake; NOT run on a real Ultimaker (catalog: verified "protocol").
import {
  DriverError,
  type DriverCapabilities,
  type DriverConfig,
  type DriverDeps,
  type DriverStatus,
  type FileFormat,
  type PrinterConnection,
  type PrintState,
  type TestResult,
} from "../types";
import { baseUrl, DigestSession, expectOk, readJson, request, type HttpTarget, type Stash } from "./http-util";
import type { PairableDriver, PairingResult } from "./pairing";

export interface UltimakerOptions {
  timeoutMs?: number;
  /** For start(): sending a large .ufp over Wi-Fi takes a while. */
  uploadTimeoutMs?: number;
}

interface UmTemp { current?: number; target?: number }
interface UmPrinter {
  status?: string;
  bed?: { temperature?: UmTemp };
  heads?: Array<{ extruders?: Array<{ hotend?: { temperature?: UmTemp } }> }>;
}
interface UmJob { name?: string; state?: string; progress?: number; time_elapsed?: number; time_total?: number }
interface UmSystem { name?: string; firmware?: string; variant?: string; guid?: string; hostname?: string }

const NOT_PAIRED_HINT = "Press 'Pair' on the setup page, then tap Allow on the printer's touchscreen.";

const JOB_STATES: Record<string, [PrintState, string]> = {
  pre_print: ["heating", "Preparing"],
  printing: ["printing", "Printing"],
  pausing: ["paused", "Pausing"],
  paused: ["paused", "Paused"],
  resuming: ["printing", "Resuming"],
  post_print: ["finishing", "Finishing"],
  wait_cleanup: ["finishing", "Done: clear the build plate and confirm on the printer"],
  wait_user_action: ["paused", "Waiting for you on the printer's screen"],
};

const PRINTER_STATES: Record<string, [PrintState, string | undefined]> = {
  idle: ["idle", undefined],
  printing: ["printing", undefined],
  error: ["error", "Printer reports an error; see its screen"],
  maintenance: ["busy", "Printer is in maintenance mode"],
  booting: ["busy", "Printer is starting up"],
};

function temp(t?: UmTemp) {
  return typeof t?.current === "number" ? { actual: t.current, target: typeof t.target === "number" ? t.target : undefined } : undefined;
}

class UltimakerConnection implements PrinterConnection {
  readonly driver = "ultimaker" as const;
  private readonly host: string;
  private readonly t: HttpTarget;
  private readonly upload_t: HttpTarget;
  private readonly session?: DigestSession;
  private stash?: Stash & { format: FileFormat };
  private readonly now: () => number;

  constructor(private config: DriverConfig, opts: Required<UltimakerOptions>, private deps: DriverDeps) {
    this.host = String(config.host ?? "").trim();
    const f = deps.fetch ?? fetch;
    this.t = { fetch: f, timeoutMs: opts.timeoutMs, what: "Ultimaker" };
    this.upload_t = { ...this.t, timeoutMs: opts.uploadTimeoutMs };
    const id = typeof config.authId === "string" ? config.authId.trim() : "";
    const key = typeof config.authKey === "string" ? config.authKey.trim() : "";
    if (id && key) this.session = new DigestSession(id, key);
    this.now = deps.now ?? Date.now;
  }

  private url(path: string): string {
    return `${baseUrl(this.host)}${path}`;
  }

  capabilities(): DriverCapabilities {
    let camera: DriverCapabilities["camera"] = false;
    try {
      // The S-series camera is served by mjpg-streamer on port 8080.
      camera = { kind: "snapshot", url: `${baseUrl(this.host.replace(/:\d+$/, ""), 8080)}/?action=snapshot` };
    } catch {
      camera = false;
    }
    return {
      fileFormats: ["ufp", "gcode"],
      upload: true,
      startPrint: true,
      pause: true,
      resume: true,
      cancel: true,
      setTemperature: false,
      gcodeConsole: false,
      camera,
    };
  }

  async test(): Promise<TestResult> {
    try {
      const sys = await readJson<UmSystem>(this.t, await expectOk(this.t, await request(this.t, this.url("/api/v1/system")), "reading system info"));
      const info = { name: sys.name, firmware: sys.firmware, model: sys.variant, serial: sys.guid };
      if (!this.session) return { ok: false, code: "auth", message: "Morphix is not paired with this Ultimaker yet", hint: NOT_PAIRED_HINT };
      await this.verify();
      return { ok: true, info };
    } catch (e) {
      const err = asDriverError(e);
      return { ok: false, code: err.code, message: err.message, hint: err.hint };
    }
  }

  async status(): Promise<DriverStatus> {
    const checkedAt = new Date(this.now()).toISOString();
    try {
      const printer = await readJson<UmPrinter>(this.t, await expectOk(this.t, await request(this.t, this.url("/api/v1/printer")), "reading status"));
      const job = await this.job();
      const temps = {
        nozzle: temp(printer.heads?.[0]?.extruders?.[0]?.hotend?.temperature),
        bed: temp(printer.bed?.temperature),
      };
      const mapped = job?.state ? JOB_STATES[job.state] : undefined;
      if (mapped && printer.status !== "error") {
        const [state, verb] = mapped;
        const progress = typeof job!.progress === "number" ? Math.max(0, Math.min(1, job!.progress)) : undefined;
        const elapsedS = typeof job!.time_elapsed === "number" ? Math.round(job!.time_elapsed) : undefined;
        const remainingS = typeof job!.time_total === "number" && elapsedS !== undefined ? Math.max(0, Math.round(job!.time_total - elapsedS)) : undefined;
        return { state, message: job!.name ? `${verb} ${job!.name}` : verb, temps, job: { file: job!.name, progress, elapsedS, remainingS }, checkedAt };
      }
      const [state, message] = PRINTER_STATES[printer.status ?? ""] ?? ["busy", `Printer state: ${printer.status ?? "unknown"}`];
      return { state, message, temps, checkedAt };
    } catch (e) {
      const err = asDriverError(e);
      return { state: "offline", message: err.hint ? `${err.message}. ${err.hint}` : err.message, checkedAt };
    }
  }

  async upload(file: { name: string; data: Buffer; format: FileFormat }): Promise<void> {
    if (file.format !== "ufp" && file.format !== "gcode") {
      throw new DriverError("unsupported", `Ultimaker printers take .ufp or G-code, not .${file.format}`, "Slice for Ultimaker (UFP output).");
    }
    this.stash = { name: file.name, data: file.data, format: file.format };
  }

  async start(fileName: string): Promise<void> {
    const session = this.requireSession();
    const s = await this.status();
    if (s.state === "offline") throw new DriverError("unreachable", s.message ?? "Cannot reach the Ultimaker");
    if (s.state !== "idle") throw new DriverError("busy", `The printer is not idle (${s.message ?? s.state})`, "Wait until it is idle, then start again.");
    const stash = this.stash;
    if (!stash || stash.name !== fileName) throw new DriverError("rejected", `${fileName} has not been uploaded`, "Upload the sliced file again, then start.");
    // A signed GET first: the large upload then goes out once, already authorized.
    await this.verify();
    const form = new FormData();
    form.append("jobname", fileName.replace(/\.(ufp|gcode)$/i, ""));
    form.append("file", new Blob([new Uint8Array(stash.data)]), fileName);
    const res = await session.fetch(this.upload_t, this.url("/api/v1/print_job"), { method: "POST", body: form });
    await expectOk(this.t, res, "the print job");
    this.stash = undefined;
    this.deps.log?.("info", "[ultimaker] print started", { file: fileName });
  }

  async pause(): Promise<void> {
    const job = await this.job();
    if (job?.state !== "printing" && job?.state !== "pre_print") throw new DriverError("rejected", "Nothing is printing", "Start a print first.");
    await this.setJobState("pause");
  }

  async resume(): Promise<void> {
    const job = await this.job();
    if (job?.state !== "paused") throw new DriverError("rejected", "The print is not paused", "Pause it first.");
    await this.setJobState("print");
  }

  async cancel(): Promise<void> {
    const job = await this.job();
    if (!job?.state || job.state === "none") throw new DriverError("rejected", "Nothing is printing", "There is no print to cancel.");
    await this.setJobState("abort");
  }

  async close(): Promise<void> {
    this.stash = undefined;
  }

  private requireSession(): DigestSession {
    if (!this.session) throw new DriverError("auth", "Morphix is not paired with this Ultimaker yet", NOT_PAIRED_HINT);
    return this.session;
  }

  private async verify(): Promise<void> {
    const res = await this.requireSession().fetch(this.t, this.url("/api/v1/auth/verify"));
    if (res.status === 401 || res.status === 403) {
      throw new DriverError("auth", "The Ultimaker does not accept Morphix's pairing", "The pairing was removed or never confirmed. " + NOT_PAIRED_HINT);
    }
    await expectOk(this.t, res, "the pairing check");
  }

  private async job(): Promise<UmJob | undefined> {
    const res = await request(this.t, this.url("/api/v1/print_job"));
    if (res.status === 404) return undefined;
    return readJson<UmJob>(this.t, await expectOk(this.t, res, "reading the print job"));
  }

  private async setJobState(target: "pause" | "print" | "abort"): Promise<void> {
    const res = await this.requireSession().fetch(this.t, this.url("/api/v1/print_job/state"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    });
    await expectOk(this.t, res, `the ${target} command`);
  }
}

function asDriverError(e: unknown): DriverError {
  if (e instanceof DriverError) return e;
  return new DriverError("protocol", (e as Error)?.message ?? String(e), "Try again; if it keeps failing, restart the printer.");
}

function target(deps: DriverDeps | undefined, timeoutMs: number): HttpTarget {
  return { fetch: deps?.fetch ?? fetch, timeoutMs, what: "Ultimaker" };
}

export function createUltimakerDriver(options: UltimakerOptions = {}): PairableDriver {
  const opts: Required<UltimakerOptions> = { timeoutMs: options.timeoutMs ?? 8000, uploadTimeoutMs: options.uploadTimeoutMs ?? 180_000 };
  const fail = (e: unknown): PairingResult => {
    const err = asDriverError(e);
    return { state: "failed", message: err.message, hint: err.hint };
  };
  return {
    id: "ultimaker",
    name: "Ultimaker (S3 / S5 / S7)",
    description: "Ultimaker S-series printers on your network, through the printer's own local API.",
    fields: [
      { key: "host", label: "Printer IP address", kind: "host", required: true,
        help: "On the printer's touchscreen: Preferences → Network shows the IP address." },
      { key: "authId", label: "Pairing id", kind: "text", required: false,
        help: "Filled in by 'Pair': Morphix asks the printer, and you tap Allow on its touchscreen." },
      { key: "authKey", label: "Pairing key", kind: "secret", required: false,
        help: "Filled in by 'Pair' together with the id; to revoke it, remove 'Morphix' on the printer's screen." },
    ],
    pairing: {
      async start(config, deps) {
        try {
          const t = target(deps, opts.timeoutMs);
          const res = await request(t, `${baseUrl(config.host)}/api/v1/auth/request`, {
            method: "POST",
            body: new URLSearchParams({ application: "Morphix", user: "Morphix" }),
          });
          const body = await readJson<{ id?: string; key?: string }>(t, await expectOk(t, res, "the pairing request"));
          if (!body.id || !body.key) throw new DriverError("protocol", "The Ultimaker did not return pairing credentials", "Update the printer's firmware, then try again.");
          return { state: "waiting", save: { authId: body.id, authKey: body.key }, message: "Tap Allow on the printer's touchscreen",
            hint: "The prompt asks whether 'Morphix' may control the printer." };
        } catch (e) {
          return fail(e);
        }
      },
      async check(config, deps) {
        try {
          const id = String(config.authId ?? "").trim();
          if (!/^[\w-]+$/.test(id)) return { state: "failed", message: "No pairing in progress", hint: "Press 'Pair' to start." };
          const t = target(deps, opts.timeoutMs);
          const res = await request(t, `${baseUrl(config.host)}/api/v1/auth/check/${encodeURIComponent(id)}`);
          const body = await readJson<{ message?: string }>(t, await expectOk(t, res, "the pairing check"));
          if (body.message === "authorized") return { state: "paired", message: "Paired with the Ultimaker" };
          if (body.message === "unauthorized") return { state: "denied", message: "Pairing was declined on the printer", hint: "Press 'Pair' again and tap Allow." };
          return { state: "waiting", message: "Waiting for you to tap Allow on the printer's touchscreen" };
        } catch (e) {
          return fail(e);
        }
      },
    },
    connect: (config, deps = {}) => new UltimakerConnection(config, opts, deps),
  };
}

export const ultimakerDriver = createUltimakerDriver();
