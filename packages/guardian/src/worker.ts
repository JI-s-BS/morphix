// Spawns and supervises the Python vision worker (services/vision). Main
// process only (uses child_process). Restarts on crash with exponential
// backoff; forwards printer status to the worker's stdin as JSON lines.
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { LineSplitter, parseVisionLine } from "./events";
import type { VisionEvent } from "./events";

export interface VisionWorkerConfig {
  /** Python interpreter. Default "python3" (env MORPHIX_PYTHON). */
  pythonPath?: string;
  /** Directory containing the morphix_vision package (services/vision). */
  cwd: string;
  /** Full argv after the interpreter; overrides the generated arguments. */
  args?: string[];
  snapshotUrl?: string;
  intervalSeconds?: number;
  evidenceDir?: string;
  session?: string;
  /** "x,y,w,h" fractions of the frame. */
  roi?: string;
  /** "N/M" confirmation window. */
  confirm?: string;
  stallSeconds?: number;
  heartbeatSeconds?: number;
  /** Extra flags appended to the generated arguments. */
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /** Backoff: first restart delay, cap, and how long a run must last to reset it. */
  restartBaseMs?: number;
  restartMaxMs?: number;
  stableAfterMs?: number;
  /** Give up after this many consecutive crashes (default: never). */
  maxRestarts?: number;
  /** Grace period between SIGTERM and SIGKILL on stop(). */
  killTimeoutMs?: number;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface VisionWorkerDeps {
  spawn?: SpawnFn;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export type WorkerStatus =
  | { state: "stopped" }
  | { state: "running"; pid?: number; since: number }
  | { state: "restarting"; inMs: number; attempt: number; lastExit: ExitInfo }
  | { state: "failed"; lastExit: ExitInfo; attempts: number };

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface VisionWorkerHandlers {
  onEvent?: (e: VisionEvent) => void;
  onStatus?: (s: WorkerStatus) => void;
  /** Non-JSON stdout lines and all stderr lines (for the app log). */
  onLog?: (line: string, stream: "stdout" | "stderr") => void;
}

export function buildWorkerArgs(c: VisionWorkerConfig): string[] {
  if (c.args) return [...c.args];
  const a = ["-m", "morphix_vision", "--exit-on-stdin-eof"];
  if (c.snapshotUrl) a.push("--snapshot-url", c.snapshotUrl);
  if (c.intervalSeconds !== undefined) a.push("--interval", String(c.intervalSeconds));
  if (c.evidenceDir) a.push("--evidence-dir", c.evidenceDir);
  if (c.session) a.push("--session", c.session);
  if (c.roi) a.push("--roi", c.roi);
  if (c.confirm) a.push("--confirm", c.confirm);
  if (c.stallSeconds !== undefined) a.push("--stall-seconds", String(c.stallSeconds));
  if (c.heartbeatSeconds !== undefined) a.push("--heartbeat", String(c.heartbeatSeconds));
  return a.concat(c.extraArgs ?? []);
}

export class VisionWorker {
  private child: ChildProcess | null = null;
  private wanted = false;
  private attempts = 0;
  private startedAt = 0;
  private restartTimer: unknown = null;
  private killTimer: unknown = null;
  private pendingStdin: string[] = [];
  private lastPrinterState: string | null = null;
  private _status: WorkerStatus = { state: "stopped" };
  private readonly spawnFn: SpawnFn;
  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;

  constructor(
    private readonly config: VisionWorkerConfig,
    private readonly handlers: VisionWorkerHandlers = {},
    deps: VisionWorkerDeps = {},
  ) {
    this.spawnFn = deps.spawn ?? (nodeSpawn as SpawnFn);
    this.now = deps.now ?? Date.now;
    this.setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  get status(): WorkerStatus {
    return this._status;
  }

  get running(): boolean {
    return this.child !== null;
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.attempts = 0;
    this.launch();
  }

  /** Stop and do not restart. Resolves once the process has exited. */
  stop(): Promise<void> {
    this.wanted = false;
    if (this.restartTimer) this.clearT(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) {
      this.setStatus({ state: "stopped" });
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      child.once("exit", () => resolve());
      try {
        child.stdin?.write(JSON.stringify({ type: "shutdown" }) + "\n");
        child.stdin?.end();
      } catch {
        /* stdin already closed */
      }
      child.kill("SIGTERM");
      this.killTimer = this.setT(() => {
        if (this.child === child) child.kill("SIGKILL");
      }, this.config.killTimeoutMs ?? 5000);
    });
  }

  /** Forward a printer status (e.g. PrinterStatus from @morphix/printer) to the worker. */
  sendPrinterState(status: { machine?: string; moveMode?: string; online?: boolean; progress?: number; printing?: boolean }): void {
    const line = JSON.stringify({ type: "printer_state", ...status }) + "\n";
    this.lastPrinterState = line; // replayed to every restarted worker
    this.write(line);
  }

  resetBaseline(): void {
    this.send({ type: "reset_baseline" });
  }

  private send(msg: object): void {
    this.write(JSON.stringify(msg) + "\n");
  }

  private write(line: string): void {
    const stdin = this.child?.stdin;
    if (stdin && stdin.writable) {
      stdin.write(line);
    } else if (line !== this.lastPrinterState) {
      // keep only the latest few messages for the next (re)start
      this.pendingStdin = [...this.pendingStdin, line].slice(-5);
    }
  }

  private setStatus(s: WorkerStatus): void {
    this._status = s;
    this.handlers.onStatus?.(s);
  }

  private launch(): void {
    this.restartTimer = null;
    if (!this.wanted) return;
    const cmd = this.config.pythonPath ?? process.env.MORPHIX_PYTHON ?? "python3";
    let child: ChildProcess;
    try {
      child = this.spawnFn(cmd, buildWorkerArgs(this.config), {
        cwd: this.config.cwd,
        env: { ...process.env, PYTHONUNBUFFERED: "1", ...this.config.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      this.onExit(null, { code: null, signal: null, error: (e as Error).message });
      return;
    }
    this.child = child;
    this.startedAt = this.now();
    this.setStatus({ state: "running", pid: child.pid, since: this.startedAt });

    const out = new LineSplitter();
    const err = new LineSplitter();
    const handleOut = (line: string) => {
      if (!line.trim()) return;
      const ev = parseVisionLine(line);
      if (ev) this.handlers.onEvent?.(ev);
      else this.handlers.onLog?.(line, "stdout");
    };
    child.stdout?.on("data", (c: Buffer | string) => out.push(c).forEach(handleOut));
    child.stdout?.on("end", () => out.end().forEach(handleOut));
    child.stderr?.on("data", (c: Buffer | string) => err.push(c).forEach((l) => this.handlers.onLog?.(l, "stderr")));
    child.stdin?.on("error", () => {
      /* EPIPE when the worker dies; handled by exit */
    });

    let exited = false;
    const finish = (info: ExitInfo) => {
      if (exited) return;
      exited = true;
      this.onExit(child, info);
    };
    child.once("error", (e) => finish({ code: null, signal: null, error: e.message }));
    child.once("exit", (code, signal) => finish({ code, signal }));

    if (this.lastPrinterState) child.stdin?.write(this.lastPrinterState);
    for (const line of this.pendingStdin.splice(0)) child.stdin?.write(line);
  }

  private onExit(child: ChildProcess | null, info: ExitInfo): void {
    if (child && this.child !== child) return;
    this.child = null;
    if (this.killTimer) this.clearT(this.killTimer);
    this.killTimer = null;
    if (!this.wanted) {
      this.setStatus({ state: "stopped" });
      return;
    }
    const ranFor = child ? this.now() - this.startedAt : 0;
    if (ranFor >= (this.config.stableAfterMs ?? 60_000)) this.attempts = 0;
    this.attempts += 1;
    if (this.config.maxRestarts !== undefined && this.attempts > this.config.maxRestarts) {
      this.wanted = false;
      this.setStatus({ state: "failed", lastExit: info, attempts: this.attempts - 1 });
      return;
    }
    const base = this.config.restartBaseMs ?? 1000;
    const delay = Math.min(base * 2 ** (this.attempts - 1), this.config.restartMaxMs ?? 60_000);
    this.setStatus({ state: "restarting", inMs: delay, attempt: this.attempts, lastExit: info });
    this.restartTimer = this.setT(() => this.launch(), delay);
  }
}
