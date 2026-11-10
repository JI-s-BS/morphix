// In-memory fake Marlin for the marlin-serial driver tests: checks line numbers and checksums like
// the firmware does, answers ok / Resend / busy / temperature reports, and can be told to halt.
import type { SerialPortHandle } from "../packages/printer/src/drivers/serial/marlin-port";
import { checksum } from "../packages/printer/src/drivers/serial/marlin-gcode";

export interface FakeMarlinOptions {
  /** Delay before each "ok" (ms). */
  okDelayMs?: number;
  /** Line numbers whose first transmission arrives corrupted (bad checksum). */
  corrupt?: number[];
  /** Commands (prefix match) answered with N "busy" lines before "ok". */
  busy?: Record<string, number>;
  /** First command (prefix match) that makes the firmware halt. */
  haltOn?: string;
  autoReportTemp?: boolean;
  /** Never answer anything (wrong baud rate / dead board). */
  silent?: boolean;
  /** M27 reply. */
  sdPrinting?: [number, number];
  extruders?: number;
}

export class FakeMarlin implements SerialPortHandle {
  /** Every command the firmware executed, in order (without N / checksum). */
  executed: string[] = [];
  /** Raw lines received. */
  received: string[] = [];
  nozzle = { actual: 21.5, target: 0 };
  bed = { actual: 20.8, target: 0 };
  halted = false;
  private lastN = 0;
  private buf = "";
  private data: Array<(c: string) => void> = [];
  private closeL: Array<(e?: Error) => void> = [];
  private corrupted = new Set<number>();
  private queue: Promise<void> = Promise.resolve();
  closed = false;

  constructor(private o: FakeMarlinOptions = {}) {
    setTimeout(() => this.emit("start"), 1);
  }

  async write(data: string): Promise<void> {
    if (this.closed) throw new Error("closed");
    this.buf += data;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this.received.push(line);
      // Lines are processed one after another, like the firmware's command buffer.
      this.queue = this.queue.then(() => this.handle(line));
    }
  }

  onData(l: (c: string) => void): void { this.data.push(l); }
  onClose(l: (e?: Error) => void): void { this.closeL.push(l); }
  async close(): Promise<void> {
    this.closed = true;
  }

  /** Simulates the USB cable being pulled. */
  unplug(): void {
    this.closed = true;
    for (const l of this.closeL) l(new Error("unplugged"));
  }

  emit(line: string): void {
    if (this.o.silent || this.closed) return;
    for (const l of this.data) l(`${line}\n`);
  }

  autoReport(): void {
    this.emit(` T:${this.nozzle.actual.toFixed(2)} /${this.nozzle.target.toFixed(2)} B:${this.bed.actual.toFixed(2)} /${this.bed.target.toFixed(2)} @:0 B@:0`);
  }

  private wait(ms = this.o.okDelayMs ?? 0): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async handle(raw: string): Promise<void> {
    if (this.halted || this.o.silent) return;
    let cmd = raw.trim();
    const m = /^N(\d+)\s+(.*)\*(\d+)$/.exec(cmd);
    if (m) {
      const n = Number(m[1]);
      const body = `N${m[1]} ${m[2]}`;
      let cs = Number(m[3]);
      if (this.o.corrupt?.includes(n) && !this.corrupted.has(n)) {
        this.corrupted.add(n);
        cs = (cs + 1) & 0xff;
      }
      if (checksum(body) !== cs) {
        this.emit(`Error:checksum mismatch, Last Line: ${this.lastN}`);
        this.emit(`Resend: ${this.lastN + 1}`);
        this.emit("ok");
        return;
      }
      cmd = m[2].trim();
      if (!/^M110\b/.test(cmd) && n !== this.lastN + 1) {
        this.emit(`Error:Line Number is not Last Line Number+1, Last Line: ${this.lastN}`);
        this.emit(`Resend: ${this.lastN + 1}`);
        this.emit("ok");
        return;
      }
      this.lastN = n;
    }
    this.executed.push(cmd);
    if (this.o.haltOn && cmd.startsWith(this.o.haltOn)) {
      this.halted = true;
      this.emit("Error:Thermal Runaway, system stopped! Heater_ID: 0");
      this.emit("Error:Printer halted. kill() called!");
      return;
    }
    const busy = Object.entries(this.o.busy ?? {}).find(([k]) => cmd.startsWith(k));
    if (busy) {
      for (let i = 0; i < busy[1]; i++) {
        await this.wait(5);
        this.emit("echo:busy: processing");
      }
    }
    await this.wait();
    const word = cmd.split(/\s+/)[0].toUpperCase();
    const s = /S(-?\d+(?:\.\d+)?)/.exec(cmd);
    switch (word) {
      case "M110": {
        const nm = /N(\d+)/.exec(cmd.slice(4));
        this.lastN = nm ? Number(nm[1]) : 0;
        break;
      }
      case "M115":
        this.emit(`FIRMWARE_NAME:Marlin 2.1.2.1 (Jul 10 2024 12:00:00) SOURCE_CODE_URL:github.com/MarlinFirmware/Marlin PROTOCOL_VERSION:1.0 MACHINE_TYPE:Ender-3 V2 EXTRUDER_COUNT:${this.o.extruders ?? 1} UUID:cede2a2f-41a2-4748-9b12-c55c62f367ff`);
        this.emit(`Cap:AUTOREPORT_TEMP:${this.o.autoReportTemp ? 1 : 0}`);
        this.emit("Cap:EMERGENCY_PARSER:1");
        break;
      case "M105":
        this.emit(`ok T:${this.nozzle.actual.toFixed(2)} /${this.nozzle.target.toFixed(2)} B:${this.bed.actual.toFixed(2)} /${this.bed.target.toFixed(2)} @:0 B@:0`);
        return;
      case "M104":
        if (s) this.nozzle.target = Number(s[1]);
        break;
      case "M140":
        if (s) this.bed.target = Number(s[1]);
        break;
      case "M27":
        this.emit(this.o.sdPrinting ? `SD printing byte ${this.o.sdPrinting[0]}/${this.o.sdPrinting[1]}` : "Not SD printing");
        break;
    }
    this.emit("ok");
  }
}
