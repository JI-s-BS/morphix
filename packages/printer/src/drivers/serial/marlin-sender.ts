// G-code sender for Marlin over a serial port: one numbered, checksummed line in flight at a time
// ("N12 G1 X5*87"), the next line only after "ok"; "Resend: N" replays from a short history;
// "busy:" and heating-wait temperature lines count as keep-alive; "Error:" / "!!" / "Printer halted"
// stop everything. Commands from the API (M105, M115, user G-code, the cancel sequence) go ahead of
// the job stream. Implemented from the Marlin serial protocol docs and tested against an in-memory
// fake Marlin; NOT run on real hardware.
import { DriverError } from "../types";
import type { SerialPortHandle } from "./marlin-port";
import { fatalError, isBusy, isOk, numberedLine, parseResend, parseTemps, type Temps } from "./marlin-gcode";

export interface SenderOptions {
  /** No "ok"/"busy" for this long with a line in flight → send an unnumbered M105 to provoke one. */
  okTimeoutMs: number;
  /** No byte at all from the printer for this long while a line is in flight → error. */
  deadAfterMs: number;
  now: () => number;
}

/** Where the job lines come from; the sender pulls one at a time. */
export interface JobSource {
  next(): string | undefined;
  onAck(): void;
  onDone(): void;
}

interface Entry {
  cmd: string;
  /** Line number on the wire; undefined for an unnumbered (raw) line. */
  n?: number;
  fromJob: boolean;
  lines: string[];
  done: boolean;
  promise: Promise<string[]>;
  resolve(lines: string[]): void;
  reject(err: Error): void;
}

const HISTORY = 64;
const HALT_HINT = "Fix the cause shown on the printer's screen, then power-cycle or reset the printer before printing again.";

export class GcodeSender {
  private buf = "";
  private nextN = 1;
  private history = new Map<number, Entry>();
  private inflight: Entry[] = [];
  private priority: Entry[] = [];
  private resendQueue: Entry[] = [];
  private pendingResend?: number;
  private job?: JobSource;
  private jobExhausted = false;
  private jobPaused = false;
  private halted?: string;
  private closed = false;
  private lastProgress: number;
  private lastByte: number;
  private nudged = false;
  private watchdog: ReturnType<typeof setInterval>;
  private lineListeners: Array<(line: string) => void> = [];

  constructor(
    private port: SerialPortHandle,
    private opts: SenderOptions,
    private events: { onTemps(t: Temps): void; onFatal(reason: string): void },
  ) {
    this.lastProgress = this.lastByte = opts.now();
    port.onData((chunk) => this.onData(chunk));
    this.watchdog = setInterval(() => this.checkAlive(), Math.max(10, Math.min(1000, opts.okTimeoutMs / 4)));
    this.watchdog.unref?.();
  }

  get haltReason(): string | undefined { return this.halted; }
  /** The command waiting for its "ok" (e.g. "M109 S210" while heating). */
  get current(): string | undefined { return this.inflight[0]?.cmd; }

  onLine(l: (line: string) => void): void { this.lineListeners.push(l); }

  /** Sends a command ahead of the job stream; resolves with every line received up to its "ok". */
  command(cmd: string, timeoutMs?: number): Promise<string[]> {
    return this.enqueue(cmd, timeoutMs, (e) => this.priority.push(e));
  }

  /**
   * Resets line numbering ("N0 M110 N0"). Used for the handshake after opening the port: if the
   * firmware does not answer in time, the line is forgotten so a retry can go out.
   */
  async reset(timeoutMs: number): Promise<void> {
    this.history.clear();
    this.resendQueue = [];
    this.pendingResend = undefined;
    const p = this.enqueue("M110 N0", undefined, (e) => this.priority.unshift(e), 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        p,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new DriverError("timeout", "No answer to M110")), timeoutMs);
        }),
      ]);
    } catch (e) {
      // Drop the unanswered line; a late "ok" with nothing in flight is ignored.
      this.inflight = [];
      this.priority = this.priority.filter((x) => x.cmd !== "M110 N0");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Writes an unnumbered line right now, ahead of anything queued (M108 breaks a heating wait). */
  urgent(cmd: string): void {
    if (this.closed || this.halted) return;
    const e = this.entry(cmd, undefined, false);
    // Marlin answers it after the line already in its buffer, so its "ok" comes after the current one.
    this.inflight.push(e);
    void this.port.write(`${cmd}\n`).catch(() => {});
  }

  stream(job: JobSource): void {
    this.job = job;
    this.jobExhausted = false;
    this.jobPaused = false;
    this.pump();
  }

  pauseStream(paused: boolean): void {
    this.jobPaused = paused;
    if (!paused) this.pump();
  }

  /** Stops pulling job lines. Lines already sent may still be replayed if the firmware asks. */
  stopStream(): void {
    this.job = undefined;
    this.jobExhausted = false;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    // An M105 makes the firmware print a line, which releases the blocking read of the fs stream.
    await this.port.write("M105\n").catch(() => {});
    this.failAll(new DriverError("unreachable", "Serial connection closed"));
    await this.port.close().catch(() => {});
  }

  /** The port went away underneath us. */
  portClosed(): void {
    this.closed = true;
    clearInterval(this.watchdog);
    this.failAll(new DriverError("unreachable", "USB connection to the printer was lost",
      "Check the USB cable and the printer's power."));
  }

  private entry(cmd: string, n: number | undefined, fromJob: boolean): Entry {
    let resolve!: (l: string[]) => void;
    let reject!: (e: Error) => void;
    const p = new Promise<string[]>((res, rej) => { resolve = res; reject = rej; });
    p.catch(() => {});
    const e: Entry = {
      cmd, n, fromJob, lines: [], done: false, promise: p,
      resolve: (l) => { if (!e.done) { e.done = true; resolve(l); } },
      reject: (err) => { if (!e.done) { e.done = true; reject(err); } },
    };
    return e;
  }

  private enqueue(cmd: string, timeoutMs: number | undefined, put: (e: Entry) => void, n?: number): Promise<string[]> {
    if (this.halted) return Promise.reject(new DriverError("protocol", `Printer halted: ${this.halted}`, HALT_HINT));
    if (this.closed) return Promise.reject(new DriverError("unreachable", "Serial connection closed"));
    const e = this.entry(cmd, n, false);
    put(e);
    this.pump();
    const p = e.promise;
    if (!timeoutMs) return p;
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      p,
      new Promise<string[]>((_, reject) => {
        // The entry stays queued: its "ok" will still arrive and keep the count right.
        timer = setTimeout(() => reject(new DriverError("timeout", `No reply to ${cmd.split(" ")[0]} yet`,
          "The printer may still be busy with a long move or heating; try again in a moment.")), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  private pump(): void {
    if (this.closed || this.halted || this.inflight.length) return;
    let e = this.resendQueue.shift();
    if (!e) {
      e = this.priority.shift();
      if (e && e.n === undefined) e.n = this.nextN++;
      else if (e && e.n === 0) this.nextN = 1;
    }
    if (!e && this.job && !this.jobPaused && !this.jobExhausted) {
      const cmd = this.job.next();
      if (cmd === undefined) {
        this.jobExhausted = true;
        const job = this.job;
        this.job = undefined;
        job.onDone();
        return;
      }
      e = this.entry(cmd, this.nextN++, true);
    }
    if (!e) return;
    e.lines = [];
    this.history.set(e.n!, e);
    this.history.delete(e.n! - HISTORY);
    this.inflight.push(e);
    this.lastProgress = this.opts.now();
    this.nudged = false;
    void this.port.write(`${numberedLine(e.n!, e.cmd)}\n`).catch(() => {});
  }

  private onData(chunk: string): void {
    this.lastByte = this.opts.now();
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (line.trim()) this.onLineReceived(line);
    }
    if (this.buf.length > 4096) this.buf = "";
  }

  private onLineReceived(line: string): void {
    for (const l of this.lineListeners) l(line);
    if (this.halted) return;
    const fatal = fatalError(line);
    if (fatal) return this.halt(fatal);
    const temps = parseTemps(line);
    if (temps) this.events.onTemps(temps);
    const resend = parseResend(line);
    if (resend !== undefined) {
      this.pendingResend = resend;
      this.lastProgress = this.opts.now();
      return;
    }
    const head = this.inflight[0];
    if (isOk(line)) {
      this.lastProgress = this.opts.now();
      if (!head) return; // a late or extra "ok" (after a timed-out handshake / M105 nudge)
      this.inflight.shift();
      head.lines.push(line);
      if (this.pendingResend !== undefined) return this.replayFrom(this.pendingResend, head);
      head.resolve(head.lines);
      // After stopStream() (cancel) job acks have nothing left to count.
      if (head.fromJob) this.job?.onAck();
      this.pump();
      return;
    }
    // Keep-alive: busy, or temperature lines printed during M109/M190 ("T:190.3 E:0 W:?").
    if (isBusy(line) || (temps && /\bW:/.test(line))) this.lastProgress = this.opts.now();
    head?.lines.push(line);
  }

  private replayFrom(n: number, failed: Entry): void {
    this.pendingResend = undefined;
    const last = Math.max(...this.history.keys());
    const replay: Entry[] = [];
    for (let k = n; k <= last; k++) {
      const e = this.history.get(k);
      if (!e) {
        return this.halt(`Printer asked to resend line ${n}, which is no longer available`);
      }
      replay.push(e);
    }
    if (!replay.includes(failed) && !failed.done) replay.push(failed);
    this.resendQueue = [...replay, ...this.resendQueue.filter((e) => !replay.includes(e))];
    this.pump();
  }

  private checkAlive(): void {
    if (this.closed || this.halted || !this.inflight.length) return;
    const now = this.opts.now();
    if (now - this.lastByte > this.opts.deadAfterMs) {
      return this.halt("The printer stopped answering");
    }
    if (!this.nudged && now - this.lastProgress > this.opts.okTimeoutMs) {
      // A lost "ok" would stall us forever: an unnumbered M105 makes the firmware send another one.
      this.nudged = true;
      void this.port.write("M105\n").catch(() => {});
    }
  }

  private halt(reason: string): void {
    if (this.halted) return;
    this.halted = reason;
    this.job = undefined;
    this.failAll(new DriverError("protocol", `Printer halted: ${reason}`, HALT_HINT));
    this.events.onFatal(reason);
  }

  private failAll(err: Error): void {
    for (const e of [...this.inflight, ...this.priority, ...this.resendQueue]) e.reject(err);
    this.inflight = [];
    this.priority = [];
    this.resendQueue = [];
  }
}
