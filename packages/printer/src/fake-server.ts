// A fake Afinia QD330 on 127.0.0.1 for tests and demos. Reproduces the reply
// formats recorded from the real printer (firmware v2.1.3): "CMD X Received."
// … "ok", the binary M661 list, M28 raw-byte uploads (exactly <size> bytes, then M29), and the
// M23/M25/M24/M26 state changes. It can also misbehave on purpose.
// Machine controls are emulated too: G28 homing (MoveMode MOVING, then M114 at
// 110/110/220), M146 light (M119 "LED:"), M106/M107 fan, M104/M140 targets with
// heating over time (M105), M18 motors, M112.
// Strings and behaviours marked UNVERIFIED are guesses; the real printer may differ.
import { createServer, type Server, type Socket } from "node:net";
import { encodeFileList, PACKET_DATA_SIZE } from "./protocol";

export interface FakeQD330Failures {
  /** M601 S1 answers "Control failed." */
  refuseControl?: boolean;
  /** M601 S1 answers "Control failed." until any connection sends M602 (a stale lock, as seen on the real printer). */
  staleControlLock?: boolean;
  /** Verbs (e.g. "M23") that are received but never answered. */
  silent?: string[];
  /** Verbs on which the fake drops the connection instead of answering. */
  dropOn?: string[];
  /** The upload arrives but M29 reports a write error. */
  corruptUpload?: boolean;
  /** Drop the connection once the upload reaches this 4 KB chunk index. */
  dropOnPacket?: number;
  /** M28 answers with an error. */
  rejectUpload?: boolean;
  /** M29 succeeds but the file is not stored (so it never appears in M661). */
  loseUploadedFile?: boolean;
  /** Commands are acknowledged but the machine status never changes. */
  ignoreStart?: boolean;
  ignorePause?: boolean;
  ignoreResume?: boolean;
  ignoreCancel?: boolean;
  /** Machine commands acknowledged but without effect. */
  ignoreHome?: boolean;
  ignoreLight?: boolean;
  ignoreFan?: boolean;
  ignoreTemps?: boolean;
  ignoreMotors?: boolean;
  /** Verbs answered with "Error: ..." (e.g. ["M146"]). */
  rejectVerbs?: string[];
  /** M119 has no "LED:" line. */
  noLedInM119?: boolean;
  /** M112 drops the connection after replying (a halted firmware). */
  dropAfterM112?: boolean;
}

export interface FakeHeater {
  current: number;
  target: number;
}

export interface FakeQD330Options {
  /** Files already on the printer: name -> contents. */
  files?: Record<string, Uint8Array>;
  /** MachineStatus after M25. UNVERIFIED on hardware; default "PAUSED". */
  pausedStatus?: string;
  /** Pause like the real QD330 seems to: MachineStatus stays BUILDING_FROM_SD, MoveMode becomes PAUSED. */
  pauseViaMoveMode?: boolean;
  /** Delay before M23/M25/M24/M26 change the status. Default 0. */
  stateChangeDelayMs?: number;
  /** Send "ok" after the binary M661 payload. Default true. */
  m661Ok?: boolean;
  /** How long G28 keeps MoveMode at MOVING. Default 0. */
  homeDurationMs?: number;
  /** °C per second while heating / cooling. Defaults 20 / 10. */
  heatRatePerSec?: number;
  coolRatePerSec?: number;
  /** Heater targets set by M23 (the .gx would set them). Default nozzle 210, bed 50. */
  printTargets?: { nozzle: number; bed: number };
  /** M26 also sets both targets to 0. UNVERIFIED on hardware; default false. */
  cancelClearsTargets?: boolean;
  failures?: FakeQD330Failures;
}

interface Upload {
  name: string;
  size: number;
  received: number;
  chunks: Buffer[];
  error?: string;
}

interface Conn {
  sock: Socket;
  buf: Buffer;
  upload: Upload | null;
}

export class FakeQD330 {
  machineStatus = "READY";
  moveMode = "READY";
  currentFile = "";
  /** M27 "SD printing byte N/100". */
  progress = 0;
  layer: [number, number] = [0, 0];
  readonly files = new Map<string, Buffer>();
  failures: FakeQD330Failures;
  /** Every command received, in order, without the "~" prefix. */
  readonly received: string[] = [];
  /** Upload outcomes as seen by the fake. */
  readonly uploads: { name: string; ok: boolean; error?: string }[] = [];
  /** Times M601 was refused because another connection held control (should stay 0 for Morphix). */
  controlConflicts = 0;
  /** M119 "LED:" and the last M146 colour. */
  led = true;
  ledColor = { r: 255, g: 255, b: 255 };
  /** Last M106 S value (0-255); M107 sets 0. */
  fanPwm = 0;
  /** Ambient = the starting temperature, so an untouched fake always reports the recorded M105 line. */
  readonly nozzle: FakeHeater = { current: 26.9, target: 0 };
  readonly bed: FakeHeater = { current: 24.4, target: 0 };
  position = { x: 110.037, y: 110.037, z: 220 };
  motorsEnabled = true;
  homeCount = 0;
  /** Set by M112. UNVERIFIED: what the real firmware does afterwards. */
  emergencyHalted = false;

  private server: Server | null = null;
  private socks = new Set<Socket>();
  private controlHolder: Socket | null = null;
  private pausedStatus: string;
  /** QD330-style pause: MachineStatus stays BUILDING_FROM_SD and MoveMode becomes PAUSED. */
  private pauseViaMoveMode: boolean;
  private movePaused = false;
  private delayMs: number;
  private m661Ok: boolean;
  private pending = new Set<NodeJS.Timeout>();
  private homeMs: number;
  private heatRate: number;
  private coolRate: number;
  private printTargets: { nozzle: number; bed: number };
  private cancelClearsTargets: boolean;
  private ambient = { nozzle: 26.9, bed: 24.4 };
  private simAt = Date.now();

  constructor(opts: FakeQD330Options = {}) {
    for (const [k, v] of Object.entries(opts.files ?? {})) this.files.set(k, Buffer.from(v));
    this.pausedStatus = opts.pausedStatus ?? "PAUSED";
    this.pauseViaMoveMode = opts.pauseViaMoveMode ?? false;
    this.delayMs = opts.stateChangeDelayMs ?? 0;
    this.m661Ok = opts.m661Ok ?? true;
    this.homeMs = opts.homeDurationMs ?? 0;
    this.heatRate = opts.heatRatePerSec ?? 20;
    this.coolRate = opts.coolRatePerSec ?? 10;
    this.printTargets = opts.printTargets ?? { nozzle: 210, bed: 50 };
    this.cancelClearsTargets = opts.cancelClearsTargets ?? false;
    this.failures = opts.failures ?? {};
  }

  /** Fan speed in percent (from the last M106/M107). */
  get fanPercent(): number {
    return Math.round((this.fanPwm * 100) / 255);
  }

  /** Test helper: set a heater's temperature (and optionally its target). */
  setTemp(heater: "nozzle" | "bed", current: number, target?: number): void {
    this.simulate();
    this[heater].current = current;
    if (target !== undefined) this[heater].target = target;
  }

  /** Moves both heaters toward their targets (or ambient) for the time since the last call. */
  private simulate() {
    const now = Date.now();
    const dt = (now - this.simAt) / 1000;
    this.simAt = now;
    for (const k of ["nozzle", "bed"] as const) {
      const h = this[k];
      const goal = h.target > 0 ? h.target : this.ambient[k];
      const rate = goal > h.current ? this.heatRate : this.coolRate;
      const step = rate * dt;
      h.current = Math.abs(goal - h.current) <= step ? goal : h.current + Math.sign(goal - h.current) * step;
    }
  }

  /** Listens on 127.0.0.1 only. Returns the port. */
  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((sock) => this.accept(sock));
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        this.server = server;
        resolve(this.port);
      });
    });
  }

  get port(): number {
    const a = this.server?.address();
    return a && typeof a === "object" ? a.port : 0;
  }

  close(): Promise<void> {
    for (const t of this.pending) clearTimeout(t);
    for (const s of this.socks) s.destroy();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Test helper: move an active print along. */
  setProgress(percent: number, layer?: [number, number]): void {
    this.progress = percent;
    if (layer) this.layer = layer;
  }

  /** Test helper: the print finishes normally. */
  finishPrint(): void {
    this.progress = 100;
    this.layer = [this.layer[1], this.layer[1]];
    this.machineStatus = "READY";
    this.simulate();
    this.nozzle.target = this.bed.target = 0;
  }

  /** Test helper: the print stops on its own (e.g. a printer-side fault or someone cancels at the printer). */
  abortPrint(): void {
    this.machineStatus = "READY";
  }

  // ---- connection handling -------------------------------------------------------

  private accept(sock: Socket) {
    this.socks.add(sock);
    const conn: Conn = { sock, buf: Buffer.alloc(0), upload: null };
    sock.on("data", (d: Buffer) => {
      conn.buf = Buffer.concat([conn.buf, d]);
      this.process(conn);
    });
    const done = () => {
      this.socks.delete(sock);
      if (this.controlHolder === sock) this.controlHolder = null;
    };
    sock.on("close", done);
    sock.on("error", done);
  }

  private process(c: Conn) {
    for (;;) {
      if (c.sock.destroyed) return;
      if (c.upload && c.upload.received < c.upload.size) {
        // Like the real printer: the next <size> bytes are file data, whatever they contain.
        if (c.buf.length === 0) return;
        const u = c.upload;
        const take = Math.min(c.buf.length, u.size - u.received);
        const drop = this.failures.dropOnPacket;
        if (drop !== undefined && u.received + take > drop * PACKET_DATA_SIZE) return void c.sock.destroy();
        u.chunks.push(Buffer.from(c.buf.subarray(0, take)));
        u.received += take;
        c.buf = c.buf.subarray(take);
        continue;
      }
      const nl = c.buf.indexOf("\n");
      if (nl < 0) return;
      const line = c.buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      c.buf = c.buf.subarray(nl + 1);
      if (line.startsWith("~")) this.command(c, line.slice(1));
    }
  }

  private send(c: Conn, data: string | Buffer) {
    if (!c.sock.destroyed) c.sock.write(data);
  }

  private reply(c: Conn, verb: string, lines: string[] = []) {
    this.send(c, `CMD ${verb} Received.\r\n${lines.map((l) => l + "\r\n").join("")}ok\r\n`);
  }

  private later(fn: () => void) {
    if (this.delayMs <= 0) return fn();
    const t = setTimeout(() => {
      this.pending.delete(t);
      fn();
    }, this.delayMs);
    this.pending.add(t);
  }

  private command(c: Conn, cmd: string) {
    this.received.push(cmd);
    const verb = cmd.split(/\s+/)[0].toUpperCase();
    const f = this.failures;
    if (f.dropOn?.includes(verb)) return void c.sock.destroy();
    if (f.silent?.includes(verb)) return;
    if (f.rejectVerbs?.includes(verb)) return this.reply(c, verb, ["Error: command rejected"]); // UNVERIFIED wording

    switch (verb) {
      case "M601": {
        if (this.controlHolder && this.controlHolder !== c.sock) {
          this.controlConflicts++;
          return this.reply(c, verb, ["Control failed."]); // UNVERIFIED wording
        }
        if (f.refuseControl || f.staleControlLock) return this.reply(c, verb, ["Control failed."]);
        this.controlHolder = c.sock;
        return this.reply(c, verb, ["Control Success V2.1."]);
      }
      case "M602":
        if (this.controlHolder === c.sock) this.controlHolder = null;
        f.staleControlLock = false;
        return this.reply(c, verb, ["Control Release."]);
      case "M115":
        return this.reply(c, verb, ["Machine Type: Afinia 3D QD330", "Machine Name: QD330", "Firmware: v2.1.3", "SN: SNFAKE0000001", "X: 220 Y: 220 Z: 220", "Tool Count: 1"]);
      case "M119":
        return this.reply(c, verb, [
          "Endstop: X-max: 110 Y-max: 110 Z-min: 0",
          `MachineStatus: ${this.machineStatus}`,
          `MoveMode: ${this.movePaused ? "PAUSED" : this.machineStatus === "BUILDING_FROM_SD" ? "MOVING" : this.moveMode}`,
          "Status: S:1 L:0 J:0 F:0",
          ...(f.noLedInM119 ? [] : [`LED: ${this.led ? 1 : 0}`]),
          `CurrentFile: ${this.currentFile}`,
        ]);
      case "M105": {
        this.simulate();
        const t = (h: FakeHeater) => `${h.current.toFixed(1)}/${h.target.toFixed(1)}`;
        return this.reply(c, verb, [`T0:${t(this.nozzle)} T1:0.0/0.0 B:${t(this.bed)}`]);
      }
      case "M114": {
        const p = this.position;
        return this.reply(c, verb, [`X:${p.x.toFixed(3)} Y:${p.y.toFixed(3)} Z:${p.z.toFixed(3)} A:0.000 B:0`]);
      }
      case "G28": {
        // UNVERIFIED: whether the real printer answers before or after the move, and what it does mid-print.
        if (this.machineStatus === "READY" && !f.ignoreHome) {
          this.moveMode = "MOVING";
          const done = () => {
            this.position = { x: 110, y: 110, z: 220 };
            this.moveMode = "READY";
            this.motorsEnabled = true;
            this.homeCount++;
          };
          if (this.homeMs <= 0) done();
          else {
            const t = setTimeout(() => (this.pending.delete(t), done()), this.homeMs);
            this.pending.add(t);
          }
        }
        return this.reply(c, verb);
      }
      case "M146": {
        // UNVERIFIED (FlashForge Adventurer syntax): "M146 r255 g255 b255 F0".
        const m = /r(\d+)\s+g(\d+)\s+b(\d+)/i.exec(cmd);
        if (!m) return this.reply(c, verb, ["Error: bad parameters"]);
        if (!f.ignoreLight) {
          this.ledColor = { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
          this.led = this.ledColor.r + this.ledColor.g + this.ledColor.b > 0;
        }
        return this.reply(c, verb);
      }
      case "M106": {
        const m = /S(\d+)/i.exec(cmd);
        if (!f.ignoreFan) this.fanPwm = Math.min(255, Number(m?.[1] ?? 255));
        return this.reply(c, verb);
      }
      case "M107":
        if (!f.ignoreFan) this.fanPwm = 0;
        return this.reply(c, verb);
      case "M104":
      case "M140": {
        const m = /S(\d+(?:\.\d+)?)/i.exec(cmd);
        if (!m) return this.reply(c, verb, ["Error: bad parameters"]);
        if (!f.ignoreTemps) {
          this.simulate();
          (verb === "M104" ? this.nozzle : this.bed).target = Number(m[1]);
        }
        return this.reply(c, verb);
      }
      case "M18":
        if (!f.ignoreMotors) this.motorsEnabled = false;
        return this.reply(c, verb);
      case "M112":
        this.emergencyHalted = true;
        this.simulate();
        this.nozzle.target = this.bed.target = 0;
        this.reply(c, verb);
        if (f.dropAfterM112) c.sock.destroy();
        return;
      case "M27":
        return this.reply(c, verb, [`SD printing byte ${this.progress}/100`, `Layer: ${this.layer[0]}/${this.layer[1]}`]);
      case "M661": {
        const list = encodeFileList([...this.files.keys()].map((n) => `/data/${n}`));
        this.send(c, Buffer.concat([Buffer.from(`CMD M661 Received.\r\n`), list, Buffer.from(this.m661Ok ? "\r\nok\r\n" : "")]));
        return;
      }
      case "M28": {
        const m = /^M28\s+(\d+)\s+0:\/user\/(.+)$/.exec(cmd);
        if (f.rejectUpload || !m) return this.reply(c, verb, ["Error: cannot open file for writing"]); // UNVERIFIED wording
        const size = Number(m[1]);
        c.upload = { name: m[2], size, received: 0, chunks: [], error: f.corruptUpload ? "write error" : undefined };
        return this.reply(c, verb, [`Writing to file: /data/${m[2]}`]);
      }
      case "M29": {
        const u = c.upload;
        c.upload = null;
        if (!u) return this.reply(c, verb, ["Error: no file open"]);
        const data = Buffer.concat(u.chunks);
        const error = u.error ?? (data.length !== u.size ? `size mismatch ${data.length}/${u.size}` : undefined);
        this.uploads.push({ name: u.name, ok: !error, error });
        if (error) return this.reply(c, verb, [`Error: file transfer failed (${error})`]); // UNVERIFIED wording
        if (!f.loseUploadedFile) this.files.set(u.name, data);
        return this.reply(c, verb, ["Done saving file."]);
      }
      case "M23": {
        const name = cmd.replace(/^M23\s+/, "").replace(/^0:\/user\//, "");
        const file = this.files.get(name);
        if (!file) return this.reply(c, verb, [`Error: open failed, File: 0:/user/${name}`]); // UNVERIFIED wording
        if (this.machineStatus !== "READY") return this.reply(c, verb, ["Error: printer busy"]); // UNVERIFIED wording
        if (!f.ignoreStart) {
          this.later(() => {
            this.machineStatus = "BUILDING_FROM_SD";
            this.currentFile = name;
            this.progress = 0;
            this.layer = [0, 100];
            this.simulate();
            this.nozzle.target = this.printTargets.nozzle;
            this.bed.target = this.printTargets.bed;
          });
        }
        return this.reply(c, verb, [`File opened: ${name} Size: ${file.length}`, "File selected"]);
      }
      case "M25":
        if (this.machineStatus === "BUILDING_FROM_SD" && !this.movePaused && !f.ignorePause) {
          this.later(() => {
            if (this.pauseViaMoveMode) this.movePaused = true;
            else this.machineStatus = this.pausedStatus;
          });
        }
        return this.reply(c, verb);
      case "M24":
        if ((this.machineStatus === this.pausedStatus || this.movePaused) && !f.ignoreResume) {
          this.later(() => {
            this.movePaused = false;
            this.machineStatus = "BUILDING_FROM_SD";
          });
        }
        return this.reply(c, verb);
      case "M26":
        if (!f.ignoreCancel) {
          this.later(() => {
            this.machineStatus = "READY";
            this.movePaused = false;
            this.currentFile = "";
            this.progress = 0;
            this.layer = [0, 0];
            if (this.cancelClearsTargets) {
              this.simulate();
              this.nozzle.target = this.bed.target = 0;
            }
          });
        }
        return this.reply(c, verb);
      default:
        return this.reply(c, verb);
    }
  }
}
