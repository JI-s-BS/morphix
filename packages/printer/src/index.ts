// QD330 adapter — OBSERVATION ONLY (Phase 1).
// Talks to TCP 8899 ("~CMD\r\n" ... "ok"). Only the read-only commands in
// READ_ONLY_COMMANDS can be sent; everything else is rejected before it reaches
// the socket. Phase 5 job and machine control (upload/start/pause/resume/cancel,
// home/light/fan/temperatures/motors/emergency stop) lives in control.ts behind
// QD330Controller, which is disabled by default.
import { Socket } from "node:net";
import type { PrinterInfo, PrinterStatus } from "@morphix/shared";
import { assertReadOnly, cleanReply, parseInfo, parseStatus } from "./protocol";

export { READ_ONLY_COMMANDS, PrinterCommandRejected, assertReadOnly, cleanReply, parseStatus, parseInfo } from "./protocol";

export interface PrinterTransport {
  query(cmds: string[]): Promise<Record<string, string>>;
}

/** Raw TCP transport. Opens a session per query batch and always releases it. */
export class TcpTransport implements PrinterTransport {
  constructor(private host: string, private port = 8899, private timeoutMs = 4000) {}

  query(cmds: string[]): Promise<Record<string, string>> {
    try {
      cmds.forEach(assertReadOnly);
    } catch (e) {
      return Promise.reject(e);
    }
    const all = ["M601 S1", ...cmds, "M602"];
    return new Promise((resolvePromise, reject) => {
      const sock = new Socket();
      const out: Record<string, string> = {};
      let i = 0;
      let buf = "";
      const timer = setTimeout(() => fail(new Error(`printer timeout at ${all[i]}`)), this.timeoutMs * all.length);
      const fail = (e: Error) => {
        clearTimeout(timer);
        sock.destroy();
        reject(e);
      };
      const sendNext = () => {
        if (i >= all.length) {
          clearTimeout(timer);
          sock.end();
          resolvePromise(out);
          return;
        }
        sock.write(`~${all[i]}\r\n`);
      };
      sock.setEncoding("latin1");
      sock.on("data", (d: string) => {
        buf += d;
        if (/(^|\n)ok\s*$/.test(buf.replace(/\r/g, ""))) {
          out[all[i]] = cleanReply(buf);
          buf = "";
          i++;
          sendNext();
        }
      });
      sock.on("error", (e) => fail(new Error(`cannot reach printer at ${this.host}:${this.port}: ${e.message}`)));
      sock.connect(this.port, this.host, sendNext);
    });
  }
}

/** Polls the printer and reports status changes. Never sends control commands. */
export class PrinterObserver {
  private timer: NodeJS.Timeout | null = null;
  private last: PrinterStatus = { online: false, checkedAt: new Date(0).toISOString(), error: "not checked yet" };

  constructor(
    private transport: PrinterTransport,
    private onStatus: (s: PrinterStatus, previous: PrinterStatus) => void,
  ) {}

  get status(): PrinterStatus {
    return this.last;
  }

  async poll(): Promise<PrinterStatus> {
    const previous = this.last;
    try {
      this.last = parseStatus(await this.transport.query(["M119", "M105", "M114", "M27"]));
    } catch (e) {
      this.last = { online: false, checkedAt: new Date().toISOString(), error: (e as Error).message };
    }
    this.onStatus(this.last, previous);
    return this.last;
  }

  async info(): Promise<PrinterInfo> {
    const r = await this.transport.query(["M115"]);
    return parseInfo(r["M115"] ?? "");
  }

  start(intervalMs: number): void {
    this.stop();
    const tick = async () => {
      await this.poll();
      this.timer = setTimeout(tick, intervalMs);
    };
    void tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

// Phase 5: printer control (disabled by default), machine controls, approval tokens, job tracking, fake printer.
export * from "./protocol";
export * from "./names";
export * from "./auth";
export * from "./control";
export * from "./machine";
export * from "./tracker";
export * from "./fake-server";
