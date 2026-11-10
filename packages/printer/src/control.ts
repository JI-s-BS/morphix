// QD330 job control (Phase 5). Separate from the observation-only PrinterObserver.
//
// Safety model (see docs/PHASE5.md):
//  - A controller is inert unless constructed with `enabled: true`; every control
//    method throws ControllerDisabledError otherwise.
//  - Upload, start and resume need a PrintAuthorization bound to the job and file.
//    Start and resume consume it. Pause and cancel need no token but are logged.
//  - A result is `confirmed` only when the printer's own status (M119/M27) shows
//    the expected change. Nothing is reported as done on a reply alone.
//  - One operation at a time; read-only status polls can share the same queue via
//    `controller.transport` so the observer never collides with a control session.
//  - Machine controls (home, light, fan, temperatures, motors, emergency stop) follow
//    the same rules. Commands not verified on the real QD330 additionally need their
//    own `allowUnverified` flag; heating needs an explicit `approvedBy` and arms an
//    idle safety timer; repeated taps are debounced. See machine.ts.
import { Socket } from "node:net";
import type { PrinterInfo, PrinterStatus } from "@morphix/shared";
import type { PrinterTransport } from "./index";
import { defaultPrintAuthorizer, type ApprovalSource, type PrintAuthorization, type PrintAuthorizer } from "./auth";
import { assertStoredFileName, sanitizeFileName } from "./names";
import {
  atPosition,
  bedCommand,
  BED_MAX_C,
  commandSpec,
  DEFAULT_CANCEL_COOLDOWN_WINDOW_MS,
  DEFAULT_HEATER_IDLE_TIMEOUT_MS,
  DEFAULT_HOME_POSITION,
  DEFAULT_MIN_COMMAND_INTERVAL_MS,
  describeCapabilities,
  fanCommand,
  isPrinting,
  lightCommand,
  MACHINE_APPROVAL_SOURCES,
  normalizeFan,
  normalizeLight,
  normalizeTemp,
  NOZZLE_MAX_C,
  nozzleCommand,
  parseLed,
  isBuilding,
  isPausedStatus,
  stateProblem,
  targetIs,
  type CommandCapability,
  type ControllerCommand,
  type FanSetting,
  type LightSetting,
  type MachineApprovalSource,
  type RgbColor,
  type StateRule,
  type UnverifiedCommandFlags,
  type UnverifiedFlag,
} from "./machine";
import {
  assertReadOnly,
  baseName,
  cleanReply,
  commandVerb,
  encodeCommand,
  findReplyEnd,
  isAcknowledged,
  PACKET_DATA_SIZE,
  packetCount,
  parseFileList,
  parseInfo,
  parseStatus,
  REPLY_ERROR,
} from "./protocol";

/** Status-poll commands that may be skipped when the printer is slow to answer (busy printing). */
const OPTIONAL_STATUS = new Set(["M105", "M114", "M27"]);

export class ControllerDisabledError extends Error {}
export class ControlRefusedError extends Error {}
export class PrinterReplyTimeout extends Error {}
export class PrinterConnectionClosed extends Error {}
/** An unverified command whose `allowUnverified` flag is off. Nothing is sent. */
export class CommandDisabledError extends ControllerDisabledError {
  constructor(public readonly command: ControllerCommand, public readonly flag: UnverifiedFlag, message: string) {
    super(message);
  }
}
/** A repeated request inside `minCommandIntervalMs`, or one while the same command is still running. Nothing is sent. */
export class RateLimitedError extends Error {
  constructor(public readonly command: ControllerCommand, public readonly retryAfterMs: number, message: string) {
    super(message);
  }
}
/** Heating without an explicit `approvedBy`. Nothing is sent. */
export class HeaterApprovalError extends Error {}
/** The printer's state does not allow the operation (e.g. not READY). Nothing is sent. */
export class PrinterStateError extends Error {}

/** Why an operation did not complete, for callers that map results to their own error codes. */
export type ControlFailure = "unreachable" | "timeout" | "refused" | "state" | "rejected" | "unconfirmed";

function classifyFailure(e: unknown): ControlFailure {
  if (e instanceof PrinterStateError) return "state";
  if (e instanceof ControlRefusedError) return "refused";
  if (e instanceof PrinterReplyTimeout) return /cannot reach/.test((e as Error).message) ? "unreachable" : "timeout";
  if (e instanceof PrinterConnectionClosed) return "unreachable";
  return "rejected";
}

export const STATUS_READY = "READY";
export const STATUS_BUILDING = "BUILDING_FROM_SD";
/** Unverified on the real printer: what MachineStatus reads after M25. Override via `pausedStatuses`. */
export const DEFAULT_PAUSED_STATUSES = ["PAUSED"];

export type ControlOp =
  | "listFiles"
  | "upload"
  | "start"
  | "pause"
  | "resume"
  | "cancel"
  | "info"
  | "home"
  | "light"
  | "fan"
  | "nozzleTemp"
  | "bedTemp"
  | "coolDown"
  | "motorsOff"
  | "emergencyStop"
  | "recoverControl";
export type RequestedBy = ApprovalSource | "portal" | "guardian" | "system";
export const REQUESTERS: readonly RequestedBy[] = ["touch", "voice", "portal", "guardian", "system"];

export interface ControlResult<T = undefined> {
  op: ControlOp;
  /** The control command reached the socket. */
  sent: boolean;
  /** The printer replied "CMD <X> Received." ... "ok" with no error text. */
  acknowledged: boolean;
  /** The printer's status showed the expected change. The only field that means "done". */
  confirmed: boolean;
  /** false for commands whose behaviour has not been verified on the real QD330 (M24, M25, M146, M106/M107, M104/M140, M18, M112). */
  protocolVerified: boolean;
  /** Last status read during the operation. */
  status?: PrinterStatus;
  /** Raw reply to the control command. */
  reply?: string;
  error?: string;
  /** Set whenever the operation did not complete; "unconfirmed" = acknowledged, but the status never showed the change. */
  failure?: ControlFailure;
  /** Extra context, e.g. why a result cannot be confirmed (the printer has no read-back for fan or motors). */
  note?: string;
  data?: T;
}

export interface ControlLogEntry {
  at: string;
  op: ControlOp;
  outcome: "rejected" | "failed" | "unconfirmed" | "confirmed";
  jobId?: string;
  fileName?: string;
  approvedBy?: MachineApprovalSource;
  requestedBy?: RequestedBy;
  reason?: string;
  /** The command(s) sent or that would have been sent, e.g. "M104 S200 T0". */
  command?: string;
  sent: boolean;
  acknowledged: boolean;
  confirmed: boolean;
  error?: string;
  status?: string;
}

export interface StoredFile {
  /** Basename, e.g. "dance.g" — what M23/startPrint take. */
  name: string;
  /** Path as reported by M661, e.g. "/data/dance.g". */
  path: string;
}

export interface UploadProgress {
  bytesSent: number;
  totalBytes: number;
  packetsSent: number;
  totalPackets: number;
  percent: number;
}

export interface QD330ControllerOptions {
  /** Must be given explicitly. false = every control method throws. */
  enabled: boolean;
  host: string;
  port?: number;
  connectTimeoutMs?: number;
  replyTimeoutMs?: number;
  /** Reply timeout for M23 (opening a file can be slow). Default 10 000. */
  startReplyTimeoutMs?: number;
  /** Reply timeout for M29 (the printer finishes writing the file). Default 15 000. */
  uploadFinishTimeoutMs?: number;
  /** How long to wait for BUILDING_FROM_SD after M23. */
  startConfirmTimeoutMs?: number;
  /** How long to wait for the expected status after M25/M24/M26. */
  confirmTimeoutMs?: number;
  /** How long to wait for the printer to report paused after M25 (it finishes queued moves first). Default 30 000. */
  pauseConfirmTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Pause between upload chunks. Default 0. */
  packetDelayMs?: number;
  /** Wait after the last byte before sending M29. Default 3000 (as FlashForge senders do). */
  uploadFlushDelayMs?: number;
  maxUploadBytes?: number;
  /** Accept plain .g files (stalled at 0% on the real printer). Default false. */
  allowPlainGcode?: boolean;
  /** MachineStatus values that mean "paused". Unverified; default ["PAUSED"]. */
  pausedStatuses?: string[];
  authorizer?: PrintAuthorizer;
  log?: (entry: ControlLogEntry) => void;
  /** Unverified commands, enabled one by one after the checklist. All default false. */
  allowUnverified?: UnverifiedCommandFlags;
  /** Heaters are turned off this long after the last heating command unless a print is running. Default 15 min. */
  heaterIdleTimeoutMs?: number;
  /** Retry interval when the idle cool-down could not be sent. Default 30 s. */
  heaterRetryMs?: number;
  /** Debounce for repeated machine-control requests (not cancel/cool-down/emergency stop). Default 1000. */
  minCommandIntervalMs?: number;
  /** After a cancel, heaters may be turned off for this long even if the status still shows a print. Default 120 s. */
  cancelCoolDownWindowMs?: number;
  /** Reply + confirmation timeout for G28. Default 60 000. */
  homeConfirmTimeoutMs?: number;
  /** Where G28 leaves the head. Default { x: 110, y: 110, z: 220 } (verified). */
  homePosition?: { x: number; y: number; z: number };
  /** Lower the nozzle limit (hard cap 250 °C). */
  maxNozzleC?: number;
  /** Lower the bed limit (hard cap 100 °C). */
  maxBedC?: number;
}

/** Status plus the LED flag from M119. */
export type MachineSnapshot = PrinterStatus & { led?: boolean };

export interface HeaterSafetyState {
  armed: boolean;
  /** When the idle timer will turn the heaters off. */
  expiresAt?: string;
  remainingMs?: number;
  /** Last targets Morphix set (not read from the printer). */
  targets: { nozzle: number; bed: number };
}

export interface EmergencyStopStep {
  command: string;
  sent: boolean;
  acknowledged: boolean;
  error?: string;
}

export interface EmergencyStopReport {
  /** M112 was sent first (allowUnverified.emergencyStopM112). */
  m112: boolean;
  steps: EmergencyStopStep[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Control sessions this process holds right now (normally 0 or 1: operations run one at a time). */
let openSessions = 0;

/** One M601 S1 … M602 control session over TCP. Binary-safe. */
class ControlSession {
  private buf = Buffer.alloc(0);
  private closed: Error | null = null;
  private waiter: { complete: (b: Buffer) => number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  /** True between M28 and the last data chunk: the printer treats incoming bytes as file data. */
  inDataMode = false;
  /** M601 was refused at first and succeeded after an M602 cleared a stale lock. */
  recoveredStaleLock = false;
  /** Counted in openSessions (from a successful M601 until destroy). */
  counted = false;

  private constructor(private sock: Socket, private replyTimeoutMs: number) {
    sock.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.check();
    });
    sock.on("error", (e) => this.fail(new PrinterConnectionClosed(`printer connection error: ${e.message}`)));
    sock.on("close", () => this.fail(new PrinterConnectionClosed("printer closed the connection")));
  }

  static open(host: string, port: number, connectTimeoutMs: number, replyTimeoutMs: number): Promise<ControlSession> {
    return new Promise((resolve, reject) => {
      const sock = new Socket();
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new PrinterReplyTimeout(`cannot reach printer at ${host}:${port}: connect timeout`));
      }, connectTimeoutMs);
      const onError = (e: Error) => {
        clearTimeout(timer);
        reject(new PrinterConnectionClosed(`cannot reach printer at ${host}:${port}: ${e.message}`));
      };
      sock.once("error", onError);
      sock.connect(port, host, async () => {
        clearTimeout(timer);
        sock.off("error", onError);
        const s = new ControlSession(sock, replyTimeoutMs);
        try {
          let reply = await s.command("M601 S1");
          if (!/Control Success/i.test(reply) && openSessions === 0) {
            // Seen on the real QD330 (2026-11-08): after a print was stopped it answered "Control
            // failed." for 18 minutes with no other client connected, and an M602 from any connection
            // cleared it. Morphix runs one session at a time, so with none of ours open the lock is
            // stale: release it and ask once more instead of reporting the printer offline.
            await s.command("M602", Math.min(replyTimeoutMs, 2000));
            reply = await s.command("M601 S1");
            if (/Control Success/i.test(reply)) s.recoveredStaleLock = true;
          }
          if (!/Control Success/i.test(reply)) throw new ControlRefusedError(`printer refused control: ${cleanReply(reply) || "(no reply text)"}`);
          openSessions++;
          s.counted = true;
          resolve(s);
        } catch (e) {
          s.destroy();
          reject(e);
        }
      });
    });
  }

  private fail(e: Error) {
    if (!this.closed) this.closed = e;
    const w = this.waiter;
    this.waiter = null;
    w?.reject(e);
  }

  private check() {
    const w = this.waiter;
    if (!w) return;
    let n: number;
    try {
      n = w.complete(this.buf);
    } catch (e) {
      this.waiter = null;
      w.reject(e as Error);
      return;
    }
    if (n < 0) return;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    this.waiter = null;
    w.resolve(out);
  }

  private wait(complete: (b: Buffer) => number, timeoutMs: number, what: string): Promise<Buffer> {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        const partial = cleanReply(this.buf.toString("latin1")).slice(0, 200);
        reject(new PrinterReplyTimeout(`no complete reply to ${what} within ${timeoutMs}ms${partial ? ` (got: ${partial})` : ""}`));
      }, timeoutMs);
      this.waiter = {
        complete,
        resolve: (b) => (clearTimeout(timer), resolve(b)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      this.check();
    });
  }

  async write(data: Buffer): Promise<void> {
    if (this.closed) throw this.closed;
    await new Promise<void>((resolve, reject) => this.sock.write(data, (e) => (e ? reject(e) : resolve())));
  }

  /** Data received outside a command/reply exchange (e.g. during upload packets). */
  pendingText(): string {
    return this.buf.toString("latin1");
  }

  async command(cmd: string, timeoutMs = this.replyTimeoutMs): Promise<string> {
    const verb = commandVerb(cmd);
    this.buf = Buffer.alloc(0); // anything still buffered belongs to an earlier exchange
    await this.write(Buffer.from(encodeCommand(cmd), "utf8"));
    const out = await this.wait((b) => findReplyEnd(b.toString("latin1"), verb), timeoutMs, cmd);
    return out.toString("utf8");
  }

  async commandBinary(cmd: string, complete: (b: Buffer) => number, timeoutMs = this.replyTimeoutMs): Promise<Buffer> {
    this.buf = Buffer.alloc(0);
    await this.write(Buffer.from(encodeCommand(cmd), "utf8"));
    return this.wait(complete, timeoutMs, cmd);
  }

  async release(): Promise<void> {
    if (!this.closed && !this.inDataMode) {
      try {
        await this.command("M602", Math.min(this.replyTimeoutMs, 2000));
      } catch {
        // best effort; the socket is closed below either way
      }
    }
    this.destroy();
  }

  destroy() {
    if (this.counted) {
      this.counted = false;
      openSessions--;
    }
    this.closed ??= new PrinterConnectionClosed("session closed");
    this.sock.destroy();
  }
}

interface OpMeta {
  jobId?: string;
  fileName?: string;
  approvedBy?: MachineApprovalSource;
  requestedBy?: RequestedBy;
  reason?: string;
  command?: string;
}

function fileMatches(current: string | undefined, name: string): boolean {
  if (!current) return false;
  const cf = baseName(current).toLowerCase();
  const n = name.toLowerCase();
  return cf === n || cf === n.replace(/\.(gx|g)$/, "");
}

function describe(st: PrinterStatus | undefined): string {
  if (!st) return "unknown";
  return `${st.machine ?? "?"}${st.currentFile ? ` / ${st.currentFile}` : ""}`;
}

function showPosition(st: PrinterStatus): string {
  const p = st.position ?? {};
  return `X${p.x ?? "?"} Y${p.y ?? "?"} Z${p.z ?? "?"}`;
}

function showTemps(st: PrinterStatus): string {
  const t = (h?: { current: number; target: number }) => (h ? `${h.current}/${h.target} °C` : "?");
  return `nozzle ${t(st.temps?.nozzle)}, bed ${t(st.temps?.bed)}`;
}

export class QD330Controller {
  readonly enabled: boolean;
  /** Frozen at construction; there is no setter. */
  readonly allowUnverified: Readonly<UnverifiedCommandFlags>;
  private o: Required<Omit<QD330ControllerOptions, "log" | "authorizer" | "allowUnverified">>;
  private authorizer: PrintAuthorizer;
  private logFn: (e: ControlLogEntry) => void;
  private chain: Promise<unknown> = Promise.resolve();
  /** Bumped by emergencyStop: queued operations requested earlier are dropped, confirm waits end early. */
  private interruptGen = 0;
  private inflight = new Map<ControllerCommand, { key: string; promise: Promise<ControlResult<unknown>> }>();
  private lastAccepted = new Map<ControllerCommand, number>();
  private lastCancelAt = -Infinity;
  private lastStatus: PrinterStatus | undefined;
  private heaterTargets = { nozzle: 0, bed: 0 };
  private heaterTimer: NodeJS.Timeout | null = null;
  private heaterDeadline = 0;
  private heaterEpoch = 0;
  private disposed = false;

  /** Read-only transport that shares this controller's queue (for PrinterObserver). Works while disabled. */
  readonly transport: PrinterTransport;

  constructor(options: QD330ControllerOptions) {
    if (!options || typeof options.enabled !== "boolean") throw new TypeError("QD330Controller: `enabled` must be given explicitly");
    if (!options.host) throw new TypeError("QD330Controller: host is required");
    this.enabled = options.enabled;
    this.o = {
      enabled: options.enabled,
      host: options.host,
      port: options.port ?? 8899,
      connectTimeoutMs: options.connectTimeoutMs ?? 4000,
      replyTimeoutMs: options.replyTimeoutMs ?? 5000,
      startReplyTimeoutMs: options.startReplyTimeoutMs ?? 10_000,
      uploadFinishTimeoutMs: options.uploadFinishTimeoutMs ?? 15_000,
      startConfirmTimeoutMs: options.startConfirmTimeoutMs ?? 20_000,
      confirmTimeoutMs: options.confirmTimeoutMs ?? 10_000,
      pauseConfirmTimeoutMs: options.pauseConfirmTimeoutMs ?? Math.max(options.confirmTimeoutMs ?? 10_000, 30_000),
      pollIntervalMs: options.pollIntervalMs ?? 1000,
      packetDelayMs: options.packetDelayMs ?? 0,
      uploadFlushDelayMs: options.uploadFlushDelayMs ?? 3000,
      maxUploadBytes: options.maxUploadBytes ?? 64 * 1024 * 1024,
      allowPlainGcode: options.allowPlainGcode ?? false,
      pausedStatuses: options.pausedStatuses ?? DEFAULT_PAUSED_STATUSES,
      heaterIdleTimeoutMs: options.heaterIdleTimeoutMs ?? DEFAULT_HEATER_IDLE_TIMEOUT_MS,
      heaterRetryMs: options.heaterRetryMs ?? 30_000,
      minCommandIntervalMs: options.minCommandIntervalMs ?? DEFAULT_MIN_COMMAND_INTERVAL_MS,
      cancelCoolDownWindowMs: options.cancelCoolDownWindowMs ?? DEFAULT_CANCEL_COOLDOWN_WINDOW_MS,
      homeConfirmTimeoutMs: options.homeConfirmTimeoutMs ?? 60_000,
      homePosition: options.homePosition ?? { ...DEFAULT_HOME_POSITION },
      maxNozzleC: options.maxNozzleC ?? NOZZLE_MAX_C,
      maxBedC: options.maxBedC ?? BED_MAX_C,
    };
    if (!(this.o.maxNozzleC >= 0 && this.o.maxNozzleC <= NOZZLE_MAX_C)) throw new RangeError(`QD330Controller: maxNozzleC must be 0-${NOZZLE_MAX_C}`);
    if (!(this.o.maxBedC >= 0 && this.o.maxBedC <= BED_MAX_C)) throw new RangeError(`QD330Controller: maxBedC must be 0-${BED_MAX_C}`);
    for (const k of ["heaterIdleTimeoutMs", "heaterRetryMs"] as const) {
      if (!Number.isFinite(this.o[k]) || this.o[k] <= 0) throw new RangeError(`QD330Controller: ${k} must be a positive number`);
    }
    this.allowUnverified = Object.freeze({ ...options.allowUnverified });
    this.authorizer = options.authorizer ?? defaultPrintAuthorizer;
    this.logFn = options.log ?? (() => undefined);
    this.transport = {
      query: (cmds) => {
        try {
          cmds.forEach(assertReadOnly);
        } catch (e) {
          return Promise.reject(e);
        }
        return this.exclusive(() =>
          this.withSession(async (s) => {
            const out: Record<string, string> = {};
            for (const c of cmds) {
              if (c === "M601 S1" || c === "M602") continue;
              try {
                // Mid-print the printer can take seconds to answer position/progress; give
                // those a shorter wait so a status poll doesn't stall.
                out[c] = cleanReply(await s.command(c, OPTIONAL_STATUS.has(c) ? Math.min(this.o.replyTimeoutMs, 2500) : undefined));
              } catch (e) {
                // Only M119 decides online/offline. A slow M114/M27/M105 reply just leaves that
                // field out (replies are matched by verb, so a late one can't be mistaken later).
                if (e instanceof PrinterReplyTimeout && OPTIONAL_STATUS.has(c)) continue;
                throw e;
              }
            }
            if (out["M119"]) this.noteStatus(parseStatus(out));
            return out;
          }),
        );
      },
    };
  }

  // ---- read-only -------------------------------------------------------------

  /** Full status snapshot (M119, M105, M114, M27). Allowed while disabled. */
  async readStatus(): Promise<PrinterStatus> {
    return parseStatus(await this.transport.query(["M119", "M105", "M114", "M27"]));
  }

  // ---- control -----------------------------------------------------------------

  async listFiles(): Promise<ControlResult<StoredFile[]>> {
    this.assertEnabled("listFiles", {});
    return this.run<StoredFile[]>("listFiles", {}, true, async (s, r) => {
      r.data = await this.listIn(s);
      r.sent = r.acknowledged = r.confirmed = true;
    });
  }

  /**
   * Stores `data` on the printer as `name` (sanitised; must be .gx, or .g when
   * allowPlainGcode). Needs a PrintAuthorization for this job and the sanitised
   * name; it is checked but not consumed, so the same approval can then start it.
   * Confirmed when the file appears in M661.
   */
  async uploadFile(
    name: string,
    data: Uint8Array,
    opts: { jobId: string; authorization: PrintAuthorization | undefined; onProgress?: (p: UploadProgress) => void; overwrite?: boolean },
  ): Promise<ControlResult<{ fileName: string; bytes: number; packets: number }>> {
    const meta: OpMeta = { jobId: opts?.jobId };
    this.assertEnabled("upload", meta);
    const fileName = this.guard("upload", meta, () => sanitizeFileName(name, { allowPlainGcode: this.o.allowPlainGcode }));
    meta.fileName = fileName;
    this.guard("upload", meta, () => {
      if (!(data instanceof Uint8Array) || data.length === 0) throw new RangeError("upload data is empty");
      if (data.length > this.o.maxUploadBytes) throw new RangeError(`upload is ${data.length} bytes; limit is ${this.o.maxUploadBytes}`);
      meta.approvedBy = this.authorizer.verify(opts?.authorization, { jobId: opts?.jobId, fileName }, false).approvedBy;
    });
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.length);
    const total = packetCount(bytes.length);

    return this.run("upload", meta, true, async (s, r) => {
      r.data = { fileName, bytes: bytes.length, packets: total };
      const before = await this.statusIn(s);
      r.status = before;
      if (before.machine !== STATUS_READY) throw new PrinterStateError(`printer is ${describe(before)}; uploads are only allowed when READY`);
      const existing = await this.listIn(s);
      if (!opts.overwrite && existing.some((f) => f.name === fileName)) throw new Error(`${fileName} already exists on the printer`);

      r.sent = true;
      const m28 = await s.command(`M28 ${bytes.length} 0:/user/${fileName}`);
      r.reply = m28;
      if (!isAcknowledged(m28, "M28", fileName) || !/Writing to file/i.test(m28)) throw new Error(`printer did not accept the upload: ${cleanReply(m28)}`);

      // The printer stores exactly the announced number of raw bytes, then expects M29.
      // (An earlier version wrapped each 4 KB in a 16-byte header + zero padding; the printer
      // saved that header as the start of the file, so the job opened but never ran — it sat at
      // 0% without heating — and the trailing bytes swallowed M29, which is why it was "silent".)
      s.inDataMode = true;
      for (let i = 0; i < total; i++) {
        await s.write(bytes.subarray(i * PACKET_DATA_SIZE, (i + 1) * PACKET_DATA_SIZE));
        if (this.o.packetDelayMs > 0) await sleep(this.o.packetDelayMs);
        const pending = cleanReply(s.pendingText());
        if (REPLY_ERROR.test(pending)) throw new Error(`printer reported an error during upload (chunk ${i}): ${pending}`);
        const sent = Math.min((i + 1) * PACKET_DATA_SIZE, bytes.length);
        opts.onProgress?.({ bytesSent: sent, totalBytes: bytes.length, packetsSent: i + 1, totalPackets: total, percent: Math.floor((sent * 100) / bytes.length) });
      }
      s.inDataMode = false;
      // Give the printer time to write the last bytes before M29 (FlashForge senders wait 3 s).
      await sleep(this.o.uploadFlushDelayMs);
      const late = cleanReply(s.pendingText());
      if (REPLY_ERROR.test(late)) throw new Error(`printer reported an error during upload: ${late}`);

      let m29: string;
      try {
        m29 = await s.command("M29", this.o.uploadFinishTimeoutMs);
      } catch (e) {
        if (e instanceof PrinterReplyTimeout) throw new Error("the printer did not confirm it saved the file (no reply to M29)");
        throw e;
      }
      r.reply = m28 + m29;
      if (!/(?:^|\n)ok\r?\n?$/.test(m29) || REPLY_ERROR.test(cleanReply(m29))) throw new Error(`printer did not finish the upload: ${cleanReply(m29)}`);
      r.acknowledged = true;

      const after = await this.listIn(s);
      r.status = await this.statusIn(s);
      r.confirmed = after.some((f) => f.name === fileName);
      if (!r.confirmed) r.error = `upload acknowledged but ${fileName} is not in the printer's file list`;
    });
  }

  /** Starts a file already on the printer (M23). Consumes the authorization. Confirmed on BUILDING_FROM_SD + matching CurrentFile. */
  async startPrint(opts: { jobId: string; fileName: string; authorization: PrintAuthorization | undefined; expectedBytes?: number }): Promise<ControlResult> {
    const meta: OpMeta = { jobId: opts?.jobId, fileName: opts?.fileName };
    this.assertEnabled("start", meta);
    const fileName = opts.fileName;
    this.guard("start", meta, () => {
      assertStoredFileName(fileName, { allowPlainGcode: this.o.allowPlainGcode });
      meta.approvedBy = this.authorizer.verify(opts.authorization, { jobId: opts.jobId, fileName }, false).approvedBy;
    });

    return this.run("start", meta, true, async (s, r) => {
      const before = await this.statusIn(s);
      r.status = before;
      if (before.machine !== STATUS_READY) throw new PrinterStateError(`printer is ${describe(before)}; a print can only start from READY`);
      const files = await this.listIn(s);
      if (!files.some((f) => f.name === fileName)) throw new Error(`${fileName} is not stored on the printer`);
      // Consume right before sending, so a busy printer or missing file doesn't burn the approval.
      this.authorizer.verify(opts.authorization, { jobId: opts.jobId, fileName }, true);

      r.sent = true;
      r.reply = await s.command(`M23 0:/user/${fileName}`, this.o.startReplyTimeoutMs);
      r.acknowledged = isAcknowledged(r.reply, "M23", fileName);
      if (!r.acknowledged) throw new Error(`printer did not accept M23: ${cleanReply(r.reply)}`);
      // M23 replies "File opened: <name> Size: <bytes>" — refuse to print a partly written file.
      const size = /Size:\s*(\d+)/i.exec(r.reply);
      if (opts.expectedBytes !== undefined && size && Number(size[1]) !== opts.expectedBytes) {
        try {
          await s.command("M26");
        } catch {
          /* best effort */
        }
        throw new Error(`stored file is ${size[1]} bytes but ${opts.expectedBytes} were sent; print cancelled`);
      }
      await this.confirm(s, r, (st) => st.machine === STATUS_BUILDING && fileMatches(st.currentFile, fileName), this.o.startConfirmTimeoutMs, `${STATUS_BUILDING} with ${fileName}`);
    });
  }

  /** M25. No token needed; always logged. UNVERIFIED on hardware: confirmed only on one of `pausedStatuses`. */
  async pause(opts: { requestedBy: RequestedBy; reason?: string }): Promise<ControlResult> {
    const meta: OpMeta = { requestedBy: opts?.requestedBy, reason: opts?.reason };
    this.assertEnabled("pause", meta);
    return this.run("pause", meta, false, async (s, r) => {
      const before = await this.statusIn(s);
      r.status = before;
      meta.fileName = before.currentFile;
      if (isPausedStatus(before, this.o.pausedStatuses)) throw new PrinterStateError("the print is already paused");
      if (before.machine !== STATUS_BUILDING) throw new PrinterStateError(`printer is ${describe(before)}; nothing to pause`);
      r.sent = true;
      r.reply = await s.command("M25");
      r.acknowledged = isAcknowledged(r.reply, "M25");
      if (!r.acknowledged) throw new Error(`printer did not accept M25: ${cleanReply(r.reply)}`);
      await this.confirm(s, r, (st) => isPausedStatus(st, this.o.pausedStatuses), this.o.pauseConfirmTimeoutMs, `one of ${this.o.pausedStatuses.join("/")} or MoveMode PAUSED`);
    });
  }

  /** M24. Needs a fresh authorization for the paused job's file (consumed). UNVERIFIED on hardware. */
  async resume(opts: { jobId: string; fileName: string; authorization: PrintAuthorization | undefined }): Promise<ControlResult> {
    const meta: OpMeta = { jobId: opts?.jobId, fileName: opts?.fileName };
    this.assertEnabled("resume", meta);
    const fileName = opts.fileName;
    this.guard("resume", meta, () => {
      assertStoredFileName(fileName, { allowPlainGcode: this.o.allowPlainGcode });
      meta.approvedBy = this.authorizer.verify(opts.authorization, { jobId: opts.jobId, fileName }, false).approvedBy;
    });
    return this.run("resume", meta, false, async (s, r) => {
      const before = await this.statusIn(s);
      r.status = before;
      if (!isPausedStatus(before, this.o.pausedStatuses)) throw new PrinterStateError(`printer is ${describe(before)}; nothing to resume`);
      if (before.currentFile && !fileMatches(before.currentFile, fileName)) {
        throw new Error(`paused file is ${before.currentFile}, not ${fileName}`);
      }
      this.authorizer.verify(opts.authorization, { jobId: opts.jobId, fileName }, true);
      r.sent = true;
      r.reply = await s.command("M24");
      r.acknowledged = isAcknowledged(r.reply, "M24");
      if (!r.acknowledged) throw new Error(`printer did not accept M24: ${cleanReply(r.reply)}`);
      await this.confirm(s, r, (st) => isBuilding(st, this.o.pausedStatuses), this.o.confirmTimeoutMs, `${STATUS_BUILDING} and not paused`);
    });
  }

  /** M26. No token needed; always logged; sent whatever the current state. Confirmed on READY. */
  async cancel(opts: { requestedBy: RequestedBy; reason?: string }): Promise<ControlResult> {
    const meta: OpMeta = { requestedBy: opts?.requestedBy, reason: opts?.reason };
    this.assertEnabled("cancel", meta);
    return this.run("cancel", meta, true, async (s, r) => {
      try {
        r.status = await this.statusIn(s);
        meta.fileName = r.status.currentFile;
      } catch {
        // a failed status read must not stop a cancel
      }
      r.sent = true;
      this.lastCancelAt = Date.now();
      r.reply = await s.command("M26");
      r.acknowledged = isAcknowledged(r.reply, "M26");
      if (!r.acknowledged) throw new Error(`printer did not accept M26: ${cleanReply(r.reply)}`);
      await this.confirm(s, r, (st) => st.machine === STATUS_READY, this.o.confirmTimeoutMs, STATUS_READY);
    });
  }

  // ---- machine controls --------------------------------------------------------

  /** M115 machine info. Read-only: allowed while disabled, never rate-limited. */
  async readInfo(opts: { requestedBy?: RequestedBy } = {}): Promise<ControlResult<PrinterInfo & { raw: string }>> {
    const meta: OpMeta = { requestedBy: opts?.requestedBy, command: "M115" };
    return this.run<PrinterInfo & { raw: string }>("info", meta, true, async (s, r) => {
      r.sent = true;
      r.reply = await s.command("M115");
      r.acknowledged = isAcknowledged(r.reply, "M115");
      if (!r.acknowledged) throw new Error(`printer did not accept M115: ${cleanReply(r.reply)}`);
      const raw = cleanReply(r.reply);
      r.data = { ...parseInfo(raw), raw };
      r.confirmed = Boolean(r.data.machineType || r.data.firmware);
      if (!r.confirmed) r.error = "M115 reply had no machine type or firmware";
    });
  }

  /**
   * Every command with its G-code, verified status, flag and whether it may be
   * sent right now. Uses `status` or the last status this controller saw (its own
   * reads and observer polls through `transport`). The methods re-check the
   * printer before sending, so this is for showing/hiding buttons and tools.
   */
  capabilities(status: PrinterStatus | undefined = this.lastStatus): CommandCapability[] {
    return describeCapabilities({
      controllerEnabled: this.enabled === true,
      flags: this.allowUnverified,
      status,
      pausedStatuses: this.o.pausedStatuses,
      recentCancel: this.recentCancel(),
      wait: (c) => (this.inflight.has(c) ? "busy" : commandSpec(c).rateLimited ? this.waitFor(c) : 0),
    });
  }

  /** The heater idle timer, for a countdown in the UI. */
  heaterSafety(): HeaterSafetyState {
    const armed = this.heaterTimer !== null;
    return {
      armed,
      expiresAt: armed ? new Date(this.heaterDeadline).toISOString() : undefined,
      remainingMs: armed ? Math.max(0, this.heaterDeadline - Date.now()) : undefined,
      targets: { ...this.heaterTargets },
    };
  }

  /** Stops the heater timer. Call when shutting the app down (after coolDown if heaters may be on). */
  dispose(): void {
    this.disposed = true;
    this.disarmHeaterTimer();
  }

  /** G28 (verified). Refused unless READY and not moving. Confirmed when M114 shows the home position and MoveMode is not MOVING. */
  async home(opts: { requestedBy: RequestedBy; reason?: string }): Promise<ControlResult<{ alreadyHome: boolean }>> {
    const meta: OpMeta = { requestedBy: opts?.requestedBy, reason: opts?.reason, command: "G28" };
    return this.machine<{ alreadyHome: boolean }>("home", "home", meta, () => (this.requireRequester(opts), "G28"), async (s, r) => {
      const before = await this.fullStatusIn(s);
      r.status = before;
      this.requireState("idle", before);
      r.data = { alreadyHome: atPosition(before, this.o.homePosition) };
      await this.send(s, r, "G28", this.o.homeConfirmTimeoutMs);
      r.acknowledged = true;
      const p = this.o.homePosition;
      await this.confirm(s, r, (st: MachineSnapshot) => st.moveMode !== "MOVING" && atPosition(st, p), this.o.homeConfirmTimeoutMs, `homed at X${p.x} Y${p.y} Z${p.z}`, {
        read: (x) => this.fullStatusIn(x),
        show: (st) => `${st.moveMode ?? "?"} at ${showPosition(st)}`,
      });
      if (r.confirmed && r.data.alreadyHome) r.note = "the head was already at the home position, so the move itself could not be observed";
    });
  }

  /** M146 (UNVERIFIED; needs allowUnverified.light). Allowed in any state. Confirmed from M119 "LED:" (on/off only; the colour cannot be read back). */
  async setLight(setting: LightSetting, opts: { requestedBy: RequestedBy; reason?: string }): Promise<ControlResult<{ color: RgbColor; on: boolean; led?: boolean }>> {
    const meta: OpMeta = { requestedBy: opts?.requestedBy, reason: opts?.reason };
    let color: RgbColor = { r: 0, g: 0, b: 0 };
    return this.machine<{ color: RgbColor; on: boolean; led?: boolean }>(
      "setLight",
      "light",
      meta,
      () => {
        this.requireRequester(opts);
        color = normalizeLight(setting);
        meta.command = lightCommand(color);
        return meta.command;
      },
      async (s, r) => {
        const on = color.r + color.g + color.b > 0;
        r.data = { color, on };
        await this.send(s, r, meta.command!);
        r.acknowledged = true;
        const probe = await this.fullStatusIn(s);
        r.status = probe;
        r.data.led = probe.led;
        if (probe.led === undefined) {
          r.error = 'printer acknowledged but its M119 reply has no "LED:" line, so the light cannot be confirmed';
          return;
        }
        await this.confirm(s, r, (st: MachineSnapshot) => (r.data!.led = st.led) === on, this.o.confirmTimeoutMs, `LED: ${on ? 1 : 0}`, {
          read: (x) => this.fullStatusIn(x),
          show: (st) => `LED: ${st.led === undefined ? "?" : st.led ? 1 : 0}`,
        });
      },
    );
  }

  /** M106 S0-255 / M107 (UNVERIFIED; needs allowUnverified.fan). The QD330 reports no fan speed, so the result is acknowledged but never confirmed. */
  async setFan(setting: FanSetting, opts: { requestedBy: RequestedBy; reason?: string }): Promise<ControlResult<{ percent: number }>> {
    const meta: OpMeta = { requestedBy: opts?.requestedBy, reason: opts?.reason };
    let percent = 0;
    return this.machine<{ percent: number }>(
      "setFan",
      "fan",
      meta,
      () => {
        this.requireRequester(opts);
        percent = normalizeFan(setting);
        meta.command = fanCommand(percent);
        return meta.command;
      },
      async (s, r) => {
        r.data = { percent };
        await this.send(s, r, meta.command!);
        r.acknowledged = true;
        r.status = await this.statusIn(s);
        r.note = "the printer does not report fan speed; acknowledged only, not confirmed";
      },
    );
  }

  /**
   * M104 S<c> T0 (UNVERIFIED; needs allowUnverified.temperatures). 0-250 °C (or maxNozzleC).
   * Heating needs `approvedBy` and READY; it (re)arms the heater idle timer.
   * Refused during a print, except 0 °C within the cancel window. Confirmed from the M105 target.
   */
  async setNozzleTemp(celsius: number, opts: { requestedBy: RequestedBy; approvedBy?: MachineApprovalSource; reason?: string }) {
    return this.setHeater("nozzle", celsius, opts);
  }

  /** M140 S<c> (UNVERIFIED; needs allowUnverified.temperatures). 0-100 °C (or maxBedC). Same rules as setNozzleTemp. */
  async setBedTemp(celsius: number, opts: { requestedBy: RequestedBy; approvedBy?: MachineApprovalSource; reason?: string }) {
    return this.setHeater("bed", celsius, opts);
  }

  /** M104 S0 T0 + M140 S0 (UNVERIFIED; needs allowUnverified.temperatures). No approval needed; not debounced. Refused during a print unless it was just cancelled. */
  async coolDown(opts: { requestedBy: RequestedBy; reason?: string }): Promise<ControlResult> {
    const meta: OpMeta = { requestedBy: opts?.requestedBy, reason: opts?.reason, command: `${nozzleCommand(0)}; ${bedCommand(0)}` };
    return this.machine("coolDown", "coolDown", meta, () => (this.requireRequester(opts), "coolDown"), (s, r) => this.coolDownIn(s, r));
  }

  /** M18 (UNVERIFIED; needs allowUnverified.motors). Refused unless READY and not moving. No read-back: acknowledged only. */
  async motorsOff(opts: { requestedBy: RequestedBy; reason?: string }): Promise<ControlResult> {
    const meta: OpMeta = { requestedBy: opts?.requestedBy, reason: opts?.reason, command: "M18" };
    return this.machine("motorsOff", "motorsOff", meta, () => (this.requireRequester(opts), "M18"), async (s, r) => {
      const before = await this.statusIn(s);
      r.status = before;
      this.requireState("idle", before);
      await this.send(s, r, "M18");
      r.acknowledged = true;
      r.status = await this.statusIn(s);
      r.note = "the printer does not report motor state; acknowledged only, not confirmed. Home (G28) before moving again";
    });
  }

  /**
   * Emergency stop = cancel (M26, verified) + heaters off (M104 S0 T0, M140 S0),
   * sent whatever the state and whatever allowUnverified.temperatures says (a 0 °C
   * target can only remove heat). M112 is sent first only with
   * allowUnverified.emergencyStopM112 (it may halt the firmware until a power cycle).
   * Never debounced; duplicate taps share one run. Operations queued before it are
   * dropped and any confirmation wait in progress ends at its next poll.
   * Confirmed on READY with both targets 0.
   */
  async emergencyStop(opts: { requestedBy: RequestedBy; reason?: string }): Promise<ControlResult<EmergencyStopReport>> {
    const useM112 = this.allowUnverified.emergencyStopM112 === true;
    const cmds = [...(useM112 ? ["M112"] : []), "M26", nozzleCommand(0), bedCommand(0)];
    const meta: OpMeta = { requestedBy: opts?.requestedBy, reason: opts?.reason, command: cmds.join("; ") };
    this.assertEnabled("emergencyStop", meta);
    this.guard("emergencyStop", meta, () => this.requireRequester(opts));
    const running = this.inflight.get("emergencyStop");
    if (running) return running.promise as Promise<ControlResult<EmergencyStopReport>>;
    this.interruptGen++;

    const promise = this.exclusive(async () => {
      const r: ControlResult<EmergencyStopReport> = { op: "emergencyStop", sent: false, acknowledged: false, confirmed: false, protocolVerified: false, data: { m112: useM112, steps: [] } };
      let session: ControlSession | null = null;
      try {
        for (const cmd of cmds) {
          const step: EmergencyStopStep = { command: cmd, sent: false, acknowledged: false };
          r.data!.steps.push(step);
          // A dropped link gets one retry on a fresh session; the printer never saw the lost command.
          for (let attempt = 0; attempt < 2 && !step.acknowledged; attempt++) {
            try {
              session ??= await ControlSession.open(this.o.host, this.o.port, this.o.connectTimeoutMs, this.o.replyTimeoutMs);
              step.sent = r.sent = true;
              if (cmd === "M26") this.lastCancelAt = Date.now();
              const reply = await session.command(cmd);
              r.reply = (r.reply ?? "") + reply;
              step.acknowledged = isAcknowledged(reply, commandVerb(cmd));
              step.error = step.acknowledged ? undefined : `not accepted: ${cleanReply(reply)}`;
              if (!step.acknowledged) break;
            } catch (e) {
              step.error = (e as Error).message;
              session?.destroy();
              session = null;
              if (!(e instanceof PrinterConnectionClosed)) break;
            }
          }
          if (cmd === "M112") {
            // M112 may halt the firmware: drop this session without waiting for an M602 reply and continue on a fresh one.
            session?.destroy();
            session = null;
          }
        }
      } finally {
        await session?.release();
      }
      const steps = r.data!.steps;
      const heatersOff = steps.filter((x) => x.command !== "M112" && x.command !== "M26").every((x) => x.acknowledged);
      if (heatersOff) this.clearHeaters();
      r.acknowledged = steps.every((x) => x.acknowledged);
      try {
        await this.withSession((s) =>
          this.confirm(s, r, (st: MachineSnapshot) => st.machine === STATUS_READY && targetIs(st, "nozzle", 0) && targetIs(st, "bed", 0), this.o.confirmTimeoutMs, "READY with heater targets 0", {
            read: (x) => this.fullStatusIn(x),
            show: (st) => `${describe(st)}, ${showTemps(st)}`,
            interruptible: false,
          }),
        );
      } catch (e) {
        r.error = `could not read status after the emergency stop: ${(e as Error).message}`;
      }
      const failed = steps.filter((x) => !x.acknowledged).map((x) => `${x.command}: ${x.error ?? "not acknowledged"}`);
      if (failed.length) r.error = [`not acknowledged: ${failed.join("; ")}`, r.error].filter(Boolean).join(". ");
      if (!r.confirmed) r.note = "use the printer's own screen or power switch if it is still moving or hot";
      this.emitLog("emergencyStop", meta, r);
      return r;
    });
    this.track("emergencyStop", "emergencyStop", promise);
    return promise;
  }

  private async setHeater(
    heater: "nozzle" | "bed",
    celsius: number,
    opts: { requestedBy: RequestedBy; approvedBy?: MachineApprovalSource; reason?: string },
  ): Promise<ControlResult<{ heater: "nozzle" | "bed"; target: number; current?: number }>> {
    const command: ControllerCommand = heater === "nozzle" ? "setNozzleTemp" : "setBedTemp";
    const op: ControlOp = heater === "nozzle" ? "nozzleTemp" : "bedTemp";
    const meta: OpMeta = { requestedBy: opts?.requestedBy, approvedBy: opts?.approvedBy, reason: opts?.reason };
    let target = 0;
    return this.machine<{ heater: "nozzle" | "bed"; target: number; current?: number }>(
      command,
      op,
      meta,
      () => {
        this.requireRequester(opts);
        target = normalizeTemp(celsius, heater === "nozzle" ? this.o.maxNozzleC : this.o.maxBedC, heater);
        meta.command = heater === "nozzle" ? nozzleCommand(target) : bedCommand(target);
        if (target > 0 && !MACHINE_APPROVAL_SOURCES.includes(opts.approvedBy as MachineApprovalSource)) {
          throw new HeaterApprovalError(`heating the ${heater} needs approvedBy "touch", "voice" or "portal" (an explicit user confirmation)`);
        }
        return meta.command;
      },
      async (s, r) => {
        r.data = { heater, target };
        const before = await this.fullStatusIn(s);
        r.status = before;
        if (target > 0) {
          if (isPrinting(before, this.o.pausedStatuses)) throw new PrinterStateError(`printer is ${describe(before)}; temperatures are not changed during a print`);
          this.requireState("ready", before);
          // Armed before sending: if the reply is lost the heater may still be on.
          this.heaterTargets[heater] = target;
          this.armHeaterTimer(this.o.heaterIdleTimeoutMs);
        } else {
          this.requireCooling(before);
        }
        await this.send(s, r, meta.command!);
        r.acknowledged = true;
        if (target === 0) {
          this.heaterTargets[heater] = 0;
          if (this.heaterTargets.nozzle === 0 && this.heaterTargets.bed === 0) this.disarmHeaterTimer();
        }
        await this.confirm(s, r, (st: MachineSnapshot) => targetIs(st, heater, target), this.o.confirmTimeoutMs, `${heater} target ${target} °C`, {
          read: (x) => this.fullStatusIn(x),
          show: showTemps,
        });
        r.data.current = r.status?.temps?.[heater]?.current;
      },
    );
  }

  private async coolDownIn(s: ControlSession, r: ControlResult<unknown>): Promise<void> {
    const before = await this.fullStatusIn(s);
    r.status = before;
    this.requireCooling(before);
    await this.send(s, r, nozzleCommand(0));
    await this.send(s, r, bedCommand(0));
    r.acknowledged = true;
    this.clearHeaters();
    await this.confirm(s, r, (st: MachineSnapshot) => targetIs(st, "nozzle", 0) && targetIs(st, "bed", 0), this.o.confirmTimeoutMs, "heater targets 0", {
      read: (x) => this.fullStatusIn(x),
      show: showTemps,
    });
  }

  // ---- heater idle timer -------------------------------------------------------

  private armHeaterTimer(ms: number) {
    if (this.disposed) return;
    this.disarmHeaterTimer();
    const epoch = ++this.heaterEpoch;
    this.heaterDeadline = Date.now() + ms;
    this.heaterTimer = setTimeout(() => void this.heaterTimeout(epoch), ms);
  }

  private disarmHeaterTimer() {
    if (this.heaterTimer) clearTimeout(this.heaterTimer);
    this.heaterTimer = null;
    this.heaterEpoch++;
  }

  private clearHeaters() {
    this.heaterTargets = { nozzle: 0, bed: 0 };
    this.disarmHeaterTimer();
  }

  /** Idle timeout: heaters off unless a print is running (then wait another period). */
  private async heaterTimeout(epoch: number): Promise<void> {
    if (epoch !== this.heaterEpoch || this.disposed) return;
    this.heaterTimer = null;
    let printing: boolean;
    try {
      printing = isPrinting(await this.readStatus(), this.o.pausedStatuses);
    } catch {
      if (epoch === this.heaterEpoch) this.armHeaterTimer(this.o.heaterRetryMs);
      return;
    }
    if (epoch !== this.heaterEpoch) return; // heaters were set again meanwhile
    if (printing) return this.armHeaterTimer(this.o.heaterIdleTimeoutMs);
    const meta: OpMeta = { requestedBy: "system", reason: "heater idle timeout", command: `${nozzleCommand(0)}; ${bedCommand(0)}` };
    const r = await this.run("coolDown", meta, false, async (s, res) => {
      if (epoch !== this.heaterEpoch) throw new Error("skipped: a heater was set again before the idle timeout ran");
      await this.coolDownIn(s, res);
    });
    if (!r.acknowledged && epoch === this.heaterEpoch) this.armHeaterTimer(this.o.heaterRetryMs);
  }

  // ---- machine-control plumbing --------------------------------------------------

  /**
   * Common path for machine controls: enabled → allowUnverified flag → validation
   * (`prepare` returns a key identifying the request) → debounce → queue.
   * An identical request while one is running shares its result.
   */
  private machine<T>(
    command: ControllerCommand,
    op: ControlOp,
    meta: OpMeta,
    prepare: () => string,
    body: (s: ControlSession, r: ControlResult<T>) => Promise<void>,
  ): Promise<ControlResult<T>> {
    const spec = commandSpec(command);
    this.assertEnabled(op, meta);
    const key = this.guard(op, meta, () => {
      if (spec.flag && this.allowUnverified[spec.flag] !== true) {
        throw new CommandDisabledError(
          command,
          spec.flag,
          `${command} (${spec.gcode.join("/")}) is disabled: it has not been verified on this printer. ` +
            `After checking it at the printer (docs/PHASE5.md), enable it with allowUnverified.${spec.flag} = true.`,
        );
      }
      return prepare();
    });
    const running = this.inflight.get(command);
    if (running?.key === key) return running.promise as Promise<ControlResult<T>>;
    this.guard(op, meta, () => {
      if (running) throw new RateLimitedError(command, 0, `${spec.label} is already in progress; wait for it to finish`);
      const wait = spec.rateLimited ? this.waitFor(command) : 0;
      if (wait > 0) throw new RateLimitedError(command, wait, `${spec.label} was requested ${this.o.minCommandIntervalMs - wait} ms ago; try again in ${wait} ms`);
    });
    this.lastAccepted.set(command, Date.now());
    const promise = this.run<T>(op, meta, spec.protocolVerified, body);
    this.track(command, key, promise);
    return promise;
  }

  private track(command: ControllerCommand, key: string, promise: Promise<ControlResult<unknown>>) {
    this.inflight.set(command, { key, promise });
    const done = () => {
      if (this.inflight.get(command)?.promise === promise) this.inflight.delete(command);
    };
    promise.then(done, done);
  }

  private waitFor(command: ControllerCommand): number {
    const last = this.lastAccepted.get(command);
    return last === undefined ? 0 : Math.max(0, last + this.o.minCommandIntervalMs - Date.now());
  }

  private recentCancel(): boolean {
    return Date.now() - this.lastCancelAt < this.o.cancelCoolDownWindowMs;
  }

  private requireRequester(opts: { requestedBy?: RequestedBy } | undefined) {
    if (!opts || !REQUESTERS.includes(opts.requestedBy as RequestedBy)) {
      throw new TypeError(`requestedBy must be one of ${REQUESTERS.join(", ")}`);
    }
  }

  private requireState(rule: StateRule, st: PrinterStatus) {
    const problem = stateProblem(rule, st, this.o.pausedStatuses, false);
    if (problem) throw new PrinterStateError(problem);
  }

  /** Heaters may be turned down unless a print is running, or during one that was cancelled moments ago. */
  private requireCooling(st: PrinterStatus) {
    if (isPrinting(st, this.o.pausedStatuses) && !this.recentCancel()) {
      throw new PrinterStateError(`printer is ${describe(st)}; temperatures are not changed during a print (cancel it first)`);
    }
  }

  /** Sends one command and throws unless it is acknowledged. Sets `sent`, appends to `reply`. */
  private async send(s: ControlSession, r: ControlResult<unknown>, cmd: string, timeoutMs?: number): Promise<void> {
    r.sent = true;
    const reply = await s.command(cmd, timeoutMs);
    r.reply = (r.reply ?? "") + reply;
    if (!isAcknowledged(reply, commandVerb(cmd))) throw new Error(`printer did not accept ${cmd}: ${cleanReply(reply)}`);
  }

  private async fullStatusIn(s: ControlSession): Promise<MachineSnapshot> {
    const raw: Record<string, string> = {};
    for (const c of ["M119", "M105", "M114", "M27"]) raw[c] = cleanReply(await s.command(c));
    const st: MachineSnapshot = { ...parseStatus(raw), led: parseLed(raw["M119"]) };
    this.noteStatus(st);
    return st;
  }

  /** Remembers the latest status for capabilities(). Partial reads keep earlier temps/position. */
  private noteStatus(st: PrinterStatus) {
    const prev = this.lastStatus;
    const keep = <K extends "temps" | "position">(k: K) => (st[k] && Object.keys(st[k]!).length ? st[k] : prev?.[k]);
    this.lastStatus = { ...prev, ...st, temps: keep("temps"), position: keep("position") };
  }

  // ---- internals -------------------------------------------------------------

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async withSession<T>(fn: (s: ControlSession) => Promise<T>): Promise<T> {
    const s = await ControlSession.open(this.o.host, this.o.port, this.o.connectTimeoutMs, this.o.replyTimeoutMs);
    if (s.recoveredStaleLock) this.emitLog("recoverControl", { reason: "printer said Control failed with no Morphix session open; M602 cleared it" }, { sent: true, acknowledged: true, confirmed: true });
    try {
      return await fn(s);
    } finally {
      await s.release();
    }
  }

  private async statusIn(s: ControlSession): Promise<PrinterStatus> {
    const m119 = cleanReply(await s.command("M119"));
    const m27 = cleanReply(await s.command("M27"));
    const st = parseStatus({ M119: m119, M27: m27 });
    this.noteStatus(st);
    return st;
  }

  private async listIn(s: ControlSession): Promise<StoredFile[]> {
    const raw = await s.commandBinary("M661", (b) => {
      const p = parseFileList(b);
      return p.complete ? p.end : -1;
    });
    return parseFileList(raw).paths.map((path) => ({ path, name: baseName(path) }));
  }

  private async confirm<S extends PrinterStatus = PrinterStatus>(
    s: ControlSession,
    r: ControlResult<unknown>,
    ok: (st: S) => boolean,
    timeoutMs: number,
    expected: string,
    extra: { read?: (s: ControlSession) => Promise<S>; show?: (st: S) => string; interruptible?: boolean } = {},
  ) {
    const deadline = Date.now() + timeoutMs;
    const gen = this.interruptGen;
    for (;;) {
      const st = extra.read ? await extra.read(s) : ((await this.statusIn(s)) as S);
      r.status = st;
      if (ok(st)) {
        r.confirmed = true;
        return;
      }
      const last = extra.show ? extra.show(st) : describe(st);
      if (extra.interruptible !== false && gen !== this.interruptGen) {
        r.error = `stopped waiting for ${expected}: emergency stop requested (last: ${last})`;
        return;
      }
      if (Date.now() >= deadline) {
        r.error = `printer acknowledged but status did not become ${expected} within ${timeoutMs}ms (last: ${last})`;
        return;
      }
      await sleep(this.o.pollIntervalMs);
    }
  }

  private run<T>(
    op: ControlOp,
    meta: OpMeta,
    protocolVerified: boolean,
    body: (s: ControlSession, r: ControlResult<T>) => Promise<void>,
  ): Promise<ControlResult<T>> {
    // Operations requested before an emergency stop are dropped, except cancel and read-only info.
    const gen = this.interruptGen;
    const droppable = op !== "cancel" && op !== "info";
    return this.exclusive(async () => {
      const r: ControlResult<T> = { op, sent: false, acknowledged: false, confirmed: false, protocolVerified };
      try {
        if (droppable && gen !== this.interruptGen) throw new Error(`not sent: an emergency stop was requested before ${op} could run`);
        await this.withSession((s) => body(s, r));
        if (!r.confirmed && r.error) r.failure = r.acknowledged ? "unconfirmed" : "rejected";
      } catch (e) {
        r.confirmed = false;
        r.error = (e as Error).message;
        r.failure = classifyFailure(e);
      }
      this.emitLog(op, meta, r);
      return r;
    });
  }

  private emitLog(op: ControlOp, meta: OpMeta, r: Pick<ControlResult<unknown>, "sent" | "acknowledged" | "confirmed" | "error" | "status">, rejected = false) {
    const outcome: ControlLogEntry["outcome"] = rejected ? "rejected" : r.confirmed ? "confirmed" : r.acknowledged ? "unconfirmed" : "failed";
    try {
      this.logFn({
        at: new Date().toISOString(),
        op,
        outcome,
        ...meta,
        sent: r.sent,
        acknowledged: r.acknowledged,
        confirmed: r.confirmed,
        error: r.error,
        status: r.status ? describe(r.status) : undefined,
      });
    } catch {
      // logging must never break printer control
    }
  }

  /** Runs a pre-flight check; on failure logs a "rejected" entry and rethrows. Nothing is sent. */
  private guard<T>(op: ControlOp, meta: OpMeta, check: () => T): T {
    try {
      return check();
    } catch (e) {
      this.emitLog(op, meta, { sent: false, acknowledged: false, confirmed: false, error: (e as Error).message }, true);
      throw e;
    }
  }

  private assertEnabled(op: ControlOp, meta: OpMeta) {
    if (this.enabled !== true) {
      this.guard(op, meta, () => {
        throw new ControllerDisabledError(`printer control is disabled (${op} refused)`);
      });
    }
  }
}
