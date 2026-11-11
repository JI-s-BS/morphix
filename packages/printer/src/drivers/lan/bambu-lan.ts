// Driver "bambu-lan": Bambu Lab X1C / X1E / P1S / P1P / A1 / A1 mini / H2D in LAN mode.
//  - MQTT 3.1.1 over TLS on port 8883, user "bblp", password = the printer's LAN access code;
//    reports on device/<serial>/report, commands on device/<serial>/request ("pushall",
//    "project_file", "pause", "resume", "stop").
//  - FTPS (implicit TLS) on port 990, same user/password, to put the .gcode.3mf on the SD card.
//
// HARDWARE STATUS: implemented from the community protocol documentation (OpenBambuAPI) and the
// ha-bambulab integration's command formats; tested only against a local MQTT 3.1.1 fake and an
// injected FTPS fake. Not run on a real Bambu printer. `verified: "protocol"`.
//
// TLS trust (never silently disabled):
//  1. The printer certificate is checked against Bambu's public CAs (bambu-ca.ts) and its common
//     name must equal the serial number. That passes -> trusted ("ca").
//  2. Otherwise the certificate's SHA-256 fingerprint must be one of `certFingerprint` (comma
//     separated; the caller stores what test() returns) -> trusted ("pinned").
//  3. With no stored fingerprint the first certificate seen is accepted and its fingerprint is
//     returned (TestResult info.certFingerprint and connection.certFingerprints()) for the caller
//     to store: trust on first use ("first-use"). A different certificate later is refused.
// The handshake and this check finish before the access code is sent (MQTT CONNECT / FTP PASS).
//
// Firmware from 2025 on ("Authorization Control"): third-party LAN control needs LAN Only Mode
// AND Developer Mode turned on at the printer; without them status may work but print/pause/stop
// are refused. The field help below gives the steps.
//
// Safety: start is refused unless gcode_state is IDLE / FINISH / FAILED; every command is
// confirmed from the reported state; the access code is never logged or put in messages.
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { Readable, type Duplex } from "node:stream";
import { connect as tlsConnect, type ConnectionOptions, type PeerCertificate, type TLSSocket } from "node:tls";
import { Client as FtpClient } from "basic-ftp";
import { MqttClient } from "mqtt";
import {
  DriverError,
  type DriverCapabilities,
  type DriverConfig,
  type DriverDeps,
  type DriverStatus,
  type Discovered,
  type FileFormat,
  type PrinterConnection,
  type PrinterDriver,
  type PrintState,
  type TestResult,
} from "../types";
import { BAMBU_CA_PEMS } from "./bambu-ca";
import {
  bool,
  busy,
  clamp01,
  failResult,
  invalidConnection,
  offline,
  pollUntil,
  redact,
  requireHost,
  requireSecret,
  safeLog,
  str,
  temp,
  toDriverError,
  toNum,
  withTimeout,
  type Log,
} from "./common";

export const DEV_MODE_HELP =
  "On the printer screen open Settings → Network (on X1/P1: the WLAN page; on A1/H2D: Settings → Network / LAN), turn on 'LAN Only Mode', then turn on 'Developer Mode' (firmware from 2025 needs it for apps other than Bambu Studio/Handy). The 8-character Access Code is shown on the same page.";
const AUTH_HINT = `The printer refused the access code. ${DEV_MODE_HELP} If you changed the code on the printer, enter the new one here.`;
const SERIAL_HINT = "Check the serial number: printer screen Settings → Device (or 'Printer info'), the label on the back, or Bambu Studio → Device → the printer's details. Letters and digits only.";

/** What the TLS layer saw, reduced to what the trust decision needs. */
export interface PeerInfo {
  /** SHA-256 fingerprint "AB:CD:…" (Node's fingerprint256). */
  fingerprint: string;
  /** Chains to a Bambu CA and the common name equals the serial. */
  caVerified: boolean;
  reason?: string;
}

export type TrustVia = "ca" | "pinned" | "first-use";

export function normalizeFingerprint(fp: string): string {
  return fp.replace(/^sha256:/i, "").replace(/[^0-9a-f]/gi, "").toUpperCase();
}

export function parsePins(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map(normalizeFingerprint)
    .filter((x) => x.length === 64);
}

/** Decides whether to talk to this printer. See the header comment. */
export function trustDecision(peer: PeerInfo, pins: string[]): { ok: true; via: TrustVia } | { ok: false; error: DriverError } {
  const fp = normalizeFingerprint(peer.fingerprint);
  if (peer.caVerified) return { ok: true, via: "ca" };
  if (pins.length === 0) return { ok: true, via: "first-use" };
  if (pins.includes(fp)) return { ok: true, via: "pinned" };
  return {
    ok: false,
    error: new DriverError(
      "auth",
      "the printer's TLS certificate is not the one stored for it; nothing was sent",
      "If you reset or replaced this printer, clear its stored certificate fingerprint in the printer settings and run Test again. Otherwise another device may be answering at this address.",
    ),
  };
}

function peerInfo(sock: TLSSocket): PeerInfo {
  const cert = sock.getPeerCertificate() as PeerCertificate | undefined;
  return { fingerprint: cert?.fingerprint256 ?? "", caVerified: sock.authorized === true, reason: sock.authorized ? undefined : String(sock.authorizationError ?? "") };
}

function tlsOptions(serial: string): ConnectionOptions {
  return {
    ca: [...BAMBU_CA_PEMS],
    // Verification is decided by trustDecision() (CA or pin), not by Node's default, because the
    // printer is reached by IP and its certificate names the serial number instead.
    rejectUnauthorized: false,
    checkServerIdentity: (_host, cert) => (String(cert.subject?.CN ?? "").toUpperCase() === serial.toUpperCase() ? undefined : new Error("certificate common name is not the printer serial")),
    maxVersion: "TLSv1.2",
  };
}

/** I/O seams. The defaults use node:tls and basic-ftp; tests inject fakes. */
export interface BambuIO {
  /** Opens the MQTT transport and finishes the TLS handshake (no application data sent yet). */
  connectMqtt(host: string, port: number, serial: string, timeoutMs: number): Promise<{ stream: Duplex; peer: PeerInfo }>;
  ftp(): BambuFtp;
}

export interface BambuFtp {
  /** Connects with implicit TLS and returns the control channel's certificate (before login). */
  connect(host: string, port: number, serial: string): Promise<PeerInfo>;
  login(user: string, password: string): Promise<void>;
  upload(data: Buffer, remoteDir: string, name: string): Promise<void>;
  close(): void;
}

function defaultConnectMqtt(host: string, port: number, serial: string, timeoutMs: number): Promise<{ stream: Duplex; peer: PeerInfo }> {
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({ host, port, ...tlsOptions(serial) });
    const t = setTimeout(() => {
      sock.destroy();
      reject(new DriverError("timeout", `MQTT: no TLS connection to port ${port} within ${timeoutMs} ms`, "Check the IP address, that the printer is on, and that LAN Only Mode is on."));
    }, timeoutMs);
    sock.once("secureConnect", () => {
      clearTimeout(t);
      resolve({ stream: sock, peer: peerInfo(sock) });
    });
    sock.once("error", (e) => {
      clearTimeout(t);
      reject(toDriverError(e, "MQTT connection"));
    });
  });
}

class BasicFtp implements BambuFtp {
  private c: FtpClient;
  constructor(timeoutMs: number) {
    this.c = new FtpClient(timeoutMs);
  }
  async connect(host: string, port: number, serial: string): Promise<PeerInfo> {
    await this.c.connectImplicitTLS(host, port, tlsOptions(serial));
    return peerInfo(this.c.ftp.socket as TLSSocket);
  }
  async login(user: string, password: string): Promise<void> {
    await this.c.login(user, password);
    await this.c.useDefaultSettings();
  }
  async upload(data: Buffer, remoteDir: string, name: string): Promise<void> {
    await this.c.ensureDir(remoteDir);
    await this.c.uploadFrom(Readable.from(data), name);
  }
  close(): void {
    this.c.close();
  }
}

/** Models whose firmware wants ftp:/// URLs in project_file (per ha-bambulab); the rest use file:///sdcard/. */
const FTP_URL_MODELS = /^(H2D|H2DPRO|H2S|H2C|P2S|X2D|H3C|A2L)$/;

export function projectFileUrl(model: string, path: string): string {
  const m = model.toUpperCase().replace(/[\s_-]/g, "");
  return FTP_URL_MODELS.test(m) ? `ftp:///${path}` : `file:///sdcard/${path}`;
}

/** First "Metadata/plate_N.gcode" inside a .gcode.3mf (zip file names are stored in clear). */
export function findPlate(data: Buffer): string {
  const m = /Metadata\/plate_(\d+)\.gcode(?!\.\w)/.exec(data.toString("latin1"));
  return m ? `Metadata/plate_${m[1]}.gcode` : "Metadata/plate_1.gcode";
}

const STAGES: Record<number, string> = {
  1: "Auto bed levelling",
  2: "Heatbed preheating",
  3: "Vibration compensation",
  4: "Changing filament",
  5: "Paused (M400)",
  6: "Paused: filament ran out",
  7: "Heating hotend",
  8: "Calibrating extrusion",
  9: "Scanning bed surface",
  10: "Inspecting first layer",
  11: "Identifying build plate",
  12: "Calibrating Micro Lidar",
  13: "Homing toolhead",
  14: "Cleaning nozzle tip",
  16: "Paused by user",
  17: "Paused: front cover fell off",
  20: "Paused: nozzle temperature problem",
  21: "Paused: heatbed temperature problem",
};

/** Maps the merged "print" report to PrintState. */
export function mapBambuState(p: Record<string, unknown>): { state: PrintState; message: string } {
  const gs = String(p.gcode_state ?? "").toUpperCase();
  const stage = toNum(p.stg_cur);
  const stageText = stage !== undefined && STAGES[stage] ? STAGES[stage] : undefined;
  const err = toNum(p.print_error);
  const errText = err ? ` (error 0x${err.toString(16).toUpperCase().padStart(8, "0")})` : "";
  switch (gs) {
    case "IDLE":
      return { state: "idle", message: "Ready" };
    case "FINISH":
      return { state: "idle", message: "Print finished" };
    case "FAILED":
      return { state: "idle", message: `Last print failed or was stopped${errText}` };
    case "PREPARE":
      return { state: stage === 2 || stage === 7 ? "heating" : "busy", message: stageText ?? "Preparing" };
    case "RUNNING":
      if (stage === 2 || stage === 7) return { state: "heating", message: stageText! };
      return { state: "printing", message: stageText && stage !== 0 ? stageText : "Printing" };
    case "PAUSE":
      return { state: "paused", message: `${stageText ?? "Paused"}${errText}` };
    case "SLICING":
      return { state: "busy", message: "Slicing" };
    case "":
      return { state: "busy", message: "Waiting for printer status" };
    default:
      return { state: "busy", message: `Printer reports ${gs}` };
  }
}

export function bambuToStatus(p: Record<string, unknown>, checkedAt: string): DriverStatus {
  const { state, message } = mapBambuState(p);
  const active = state === "printing" || state === "paused" || state === "heating" || state === "busy";
  const file = (typeof p.subtask_name === "string" && p.subtask_name) || (typeof p.gcode_file === "string" && p.gcode_file) || undefined;
  const layer = toNum(p.layer_num);
  const total = toNum(p.total_layer_num);
  const pct = toNum(p.mc_percent);
  const left = toNum(p.mc_remaining_time);
  const hms = Array.isArray(p.hms) ? p.hms.length : 0;
  const showJob = active && gs(p) !== "IDLE";
  return {
    state,
    message: [showJob && file ? `${message}: ${file}` : message, hms ? `${hms} printer notice${hms > 1 ? "s" : ""} (HMS) on screen` : ""].filter(Boolean).join("; "),
    temps: {
      nozzle: temp(p.nozzle_temper, p.nozzle_target_temper),
      bed: temp(p.bed_temper, p.bed_target_temper),
      chamber: temp(p.chamber_temper),
    },
    job: showJob
      ? {
          file,
          progress: clamp01(pct !== undefined ? pct / 100 : undefined),
          layer: layer !== undefined && total ? [layer, total] : undefined,
          remainingS: left !== undefined ? left * 60 : undefined,
        }
      : undefined,
    checkedAt,
  };
}

function gs(p: Record<string, unknown>): string {
  return String(p.gcode_state ?? "").toUpperCase();
}

export interface BambuOptions {
  io?: Partial<BambuIO>;
  connectTimeoutMs?: number;
  reportTimeoutMs?: number;
  commandTimeoutMs?: number;
  confirmTimeoutMs?: number;
  pollMs?: number;
  ftpTimeoutMs?: number;
  /** Reports older than this trigger a new pushall on status(). */
  staleMs?: number;
  /** 8883 and 990 on every Bambu printer; tests use other ports. */
  mqttPort?: number;
  ftpPort?: number;
}

const CAPS: DriverCapabilities = {
  fileFormats: ["gcode.3mf"],
  upload: true,
  startPrint: true,
  pause: true,
  resume: true,
  cancel: true,
  setTemperature: false,
  gcodeConsole: false,
  camera: false,
};

interface Echo {
  command: string;
  result?: string;
  reason?: string;
  errCode?: number;
}

class BambuConnection implements PrinterConnection {
  readonly driver = "bambu-lan" as const;
  private host: string;
  private serial: string;
  private code: string;
  private model: string;
  private useAms: boolean;
  private pins: string[];
  /** fingerprint -> how it was trusted and on which service */
  private seen = new Map<string, { via: TrustVia; service: "MQTT" | "FTPS" }>();
  private client: MqttClient | null = null;
  private connecting: Promise<MqttClient> | null = null;
  private report: Record<string, unknown> = {};
  private lastReportAt = 0;
  private reports = 0;
  private echoes = new Map<string, Echo>();
  private seq = Math.floor(Math.random() * 1000);
  private plates = new Map<string, string>();
  private now: () => number;
  private log: Log;
  private io: BambuIO;
  private o: Required<Omit<BambuOptions, "io">>;

  constructor(config: DriverConfig, deps: DriverDeps, opts: BambuOptions) {
    this.host = requireHost(config);
    this.serial = requireSecret(config, "serial", "serial number", SERIAL_HINT).toUpperCase();
    if (!/^[A-Z0-9]{6,32}$/.test(this.serial)) throw new DriverError("rejected", "the serial number has characters that are not allowed", SERIAL_HINT);
    this.code = requireSecret(config, "accessCode", "access code", AUTH_HINT);
    this.model = str(config, "model");
    this.useAms = bool(config, "useAms", false);
    this.pins = parsePins(str(config, "certFingerprint"));
    this.now = deps.now ?? Date.now;
    this.log = safeLog(deps, () => [this.code, this.serial]);
    this.io = {
      connectMqtt: opts.io?.connectMqtt ?? defaultConnectMqtt,
      ftp: opts.io?.ftp ?? (() => new BasicFtp(this.o.ftpTimeoutMs)),
    };
    this.o = { connectTimeoutMs: 8000, reportTimeoutMs: 8000, commandTimeoutMs: 8000, confirmTimeoutMs: 45_000, pollMs: 1000, ftpTimeoutMs: 30_000, staleMs: 60_000, mqttPort: 8883, ftpPort: 990, ...opts };
  }

  private get secrets() {
    return [this.code, this.serial];
  }

  /** Fingerprints this connection has trusted (store them as `certFingerprint`). */
  certFingerprints(): { fingerprint: string; via: TrustVia }[] {
    return [...this.seen].map(([fingerprint, s]) => ({ fingerprint, via: s.via }));
  }

  /** Stored pins win; without them each service is pinned to the first certificate it showed this session. */
  private trust(peer: PeerInfo, what: "MQTT" | "FTPS"): void {
    const pins = this.pins.length ? this.pins : [...this.seen].filter(([, s]) => s.service === what).map(([fp]) => fp);
    const d = trustDecision(peer, pins);
    if (!d.ok) {
      this.log("warn", `bambu-lan ${what}: certificate refused`, { reason: peer.reason });
      throw d.error;
    }
    const fp = normalizeFingerprint(peer.fingerprint);
    if (fp && !this.seen.has(fp)) this.seen.set(fp, { via: d.via, service: what });
    if (d.via === "first-use") this.log("warn", `bambu-lan ${what}: certificate accepted on first use; store its fingerprint`, { fingerprint: fp });
  }

  private topic(kind: "report" | "request") {
    return `device/${this.serial}/${kind}`;
  }

  private onMessage = (_topic: string, payload: Buffer) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    for (const key of ["print", "system", "info"]) {
      const part = msg[key];
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      const seqId = p.sequence_id !== undefined ? String(p.sequence_id) : undefined;
      if (seqId && typeof p.command === "string" && (p.result !== undefined || p.reason !== undefined)) {
        this.echoes.set(seqId, { command: p.command, result: p.result as string | undefined, reason: p.reason as string | undefined, errCode: toNum(p.err_code) });
      }
      if (key === "print") {
        const { command: _c, sequence_id: _s, result: _r, reason: _x, ...rest } = p;
        if (p.command === "push_status" || p.gcode_state !== undefined || p.nozzle_temper !== undefined || !p.command) {
          this.report = { ...this.report, ...rest };
          this.lastReportAt = this.now();
          this.reports++;
        }
      }
    }
  };

  private async mqtt(): Promise<MqttClient> {
    if (this.client?.connected) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this.openMqtt().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async openMqtt(): Promise<MqttClient> {
    const { stream, peer } = await withTimeout(this.io.connectMqtt(this.host, this.o.mqttPort, this.serial, this.o.connectTimeoutMs), this.o.connectTimeoutMs + 500, "MQTT connection");
    try {
      this.trust(peer, "MQTT");
    } catch (e) {
      stream.destroy();
      throw e;
    }
    const client = new MqttClient(() => stream, {
      username: "bblp",
      password: this.code,
      clientId: `morphix_${randomBytes(4).toString("hex")}`,
      protocolVersion: 4,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 0,
      connectTimeout: this.o.connectTimeoutMs,
    });
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          client.once("connect", () => resolve());
          client.once("error", (e: Error & { code?: number }) => {
            if (e.code === 4 || e.code === 5 || /not authori[sz]ed|bad user ?name or password/i.test(e.message)) reject(new DriverError("auth", "MQTT: printer refused the access code", AUTH_HINT));
            else reject(toDriverError(e, "MQTT", this.secrets));
          });
          client.once("close", () => reject(new DriverError("unreachable", "MQTT: printer closed the connection before accepting it", `Check the access code and that LAN Only Mode is on. ${DEV_MODE_HELP}`)));
        }),
        this.o.connectTimeoutMs,
        "MQTT login",
      );
      await withTimeout(client.subscribeAsync(this.topic("report"), { qos: 0 }), this.o.commandTimeoutMs, "MQTT subscribe");
    } catch (e) {
      client.end(true);
      throw e;
    }
    client.on("error", () => undefined); // later errors surface as a closed connection
    client.on("message", this.onMessage);
    client.on("close", () => {
      if (this.client === client) this.client = null;
    });
    this.client = client;
    this.log("info", "bambu-lan MQTT connected");
    return client;
  }

  private nextSeq(): string {
    this.seq = (this.seq + 1) % 1_000_000;
    return String(this.seq);
  }

  private async publish(body: Record<string, unknown>, what: string): Promise<string> {
    const client = await this.mqtt();
    const seq = this.nextSeq();
    const [key] = Object.keys(body);
    const payload = { [key]: { sequence_id: seq, ...(body[key] as Record<string, unknown>) } };
    await withTimeout(client.publishAsync(this.topic("request"), JSON.stringify(payload), { qos: 0 }), this.o.commandTimeoutMs, `MQTT ${what}`);
    return seq;
  }

  /** pushall and wait for a report with gcode_state. */
  private async refresh(): Promise<Record<string, unknown>> {
    const before = this.reports;
    await this.publish({ pushing: { command: "pushall", version: 1, push_target: 1 } }, "pushall");
    const r = await pollUntil(async () => this.reports, (n) => n > before && this.report.gcode_state !== undefined, this.o.reportTimeoutMs, 50);
    if (!r.ok) {
      throw new DriverError("timeout", `no status report from the printer within ${this.o.reportTimeoutMs} ms`, `Logged in, but no reports arrived for this serial number. ${SERIAL_HINT}`);
    }
    return this.report;
  }

  private async current(): Promise<Record<string, unknown>> {
    const fresh = this.client?.connected && this.report.gcode_state !== undefined && this.now() - this.lastReportAt < this.o.staleMs;
    return fresh ? this.report : this.refresh();
  }

  capabilities(): DriverCapabilities {
    return CAPS;
  }

  async test(): Promise<TestResult> {
    try {
      await this.refresh();
      await this.ftpSession(async () => undefined);
      const fps = this.certFingerprints();
      const info = {
        model: this.model || "Bambu Lab",
        serial: this.serial,
        // Not in the TestResult contract yet (docs/goal-notes/drivers-lan.md): the caller stores
        // these as `certFingerprint` so later connections are pinned.
        certFingerprint: fps.map((x) => x.fingerprint).join(","),
        trust: fps.map((x) => x.via).join(","),
      };
      return { ok: true, info };
    } catch (e) {
      return failResult(e, "test", this.secrets);
    }
  }

  async status(): Promise<DriverStatus> {
    try {
      return bambuToStatus(await this.current(), new Date(this.now()).toISOString());
    } catch (e) {
      const d = toDriverError(e, "status", this.secrets);
      this.drop();
      if (d.code === "auth") return { state: "error", message: `${d.message}. ${d.hint ?? ""}`.trim(), checkedAt: new Date(this.now()).toISOString() };
      return offline(d.message, this.now);
    }
  }

  private async state(): Promise<PrintState> {
    try {
      return mapBambuState(await this.current()).state;
    } catch (e) {
      throw toDriverError(e, "status", this.secrets);
    }
  }

  async upload(file: { name: string; data: Buffer; format: FileFormat }): Promise<void> {
    if (file.format !== "gcode.3mf") throw new DriverError("unsupported", `${file.format} files are not supported by this driver`, "Slice with Bambu Studio / Orca and export the plate as a .gcode.3mf.");
    const name = bambuFileName(file.name);
    if (file.data.length === 0) throw new DriverError("rejected", "upload: the file is empty", "Slice again and retry.");
    const s = await this.state();
    if (s !== "idle") throw busy(s, "upload");
    const ms = this.o.ftpTimeoutMs + Math.ceil(file.data.length / 200_000) * 1000;
    await this.ftpSession((ftp) => withTimeout(ftp.upload(file.data, "/cache", name), ms, "FTPS upload"));
    this.plates.set(name, findPlate(file.data));
    this.log("info", "bambu-lan upload done", { file: name, bytes: file.data.length });
  }

  /** Connect (TLS check before the password is sent), log in, run `fn`, always close. */
  private async ftpSession(fn: (ftp: BambuFtp) => Promise<void>): Promise<void> {
    const ftp = this.io.ftp();
    try {
      const peer = await withTimeout(ftp.connect(this.host, this.o.ftpPort, this.serial), this.o.connectTimeoutMs, "FTPS connection");
      this.trust(peer, "FTPS");
      await withTimeout(ftp.login("bblp", this.code), this.o.connectTimeoutMs, "FTPS login").catch((e: unknown) => {
        const msg = (e as Error)?.message ?? "";
        if (/530|login|auth/i.test(msg)) throw new DriverError("auth", "FTPS: printer refused the access code", AUTH_HINT);
        throw e;
      });
      await fn(ftp);
    } catch (e) {
      throw toDriverError(e, "FTPS", this.secrets);
    } finally {
      try {
        ftp.close();
      } catch {
        /* already closed */
      }
    }
  }

  /** Waits for the printer's echo of `seq`. null = no echo (some firmwares don't send one). */
  private async echo(seq: string): Promise<Echo | null> {
    const r = await pollUntil(async () => this.echoes.get(seq), (v) => v !== undefined, this.o.commandTimeoutMs, 50);
    this.echoes.delete(seq);
    return r.value ?? null;
  }

  private checkEcho(e: Echo | null, what: string): void {
    if (!e || e.result === undefined || /^success$/i.test(e.result)) return;
    const reason = redact(String(e.reason ?? e.result), this.secrets);
    if (/verify|auth|permission|denied|developer/i.test(reason) || e.errCode === 84033543) {
      throw new DriverError("auth", `${what}: the printer refused the command (${reason})`, DEV_MODE_HELP);
    }
    throw new DriverError("rejected", `${what}: the printer refused the command (${reason})`, "Check the printer's screen for a message, then try again.");
  }

  private async confirm(ok: (s: PrintState) => boolean, what: string, expected: string): Promise<void> {
    const r = await pollUntil(() => this.state().catch(() => "offline" as PrintState), ok, this.o.confirmTimeoutMs, this.o.pollMs);
    if (!r.ok) {
      throw new DriverError("protocol", `${what}: sent, but the printer did not become ${expected} within ${this.o.confirmTimeoutMs} ms (now ${r.value})`, `Check the printer's screen. If nothing happened: ${DEV_MODE_HELP}`);
    }
  }

  private async command(body: Record<string, unknown>, what: string): Promise<void> {
    const seq = await this.publish(body, what);
    this.checkEcho(await this.echo(seq), what);
    this.log("info", `bambu-lan ${what} sent`);
  }

  async start(fileName: string): Promise<void> {
    const name = bambuFileName(fileName);
    const s = await this.state();
    if (s !== "idle") throw busy(s, "start");
    const path = `cache/${name}`;
    await this.command(
      {
        print: {
          command: "project_file",
          param: this.plates.get(name) ?? "Metadata/plate_1.gcode",
          url: projectFileUrl(this.model, path),
          file: name,
          subtask_name: name.replace(/\.gcode\.3mf$/i, "").replace(/\.3mf$/i, ""),
          project_id: "0",
          profile_id: "0",
          task_id: "0",
          subtask_id: "0",
          bed_type: "auto",
          timelapse: false,
          bed_leveling: true,
          flow_cali: false,
          vibration_cali: false,
          layer_inspect: false,
          use_ams: this.useAms,
          ams_mapping: this.useAms ? [0] : [],
        },
      },
      "start",
    );
    await this.confirm((x) => x !== "idle" && x !== "offline", "start", "preparing or printing");
  }

  async pause(): Promise<void> {
    const s = await this.state();
    if (s !== "printing" && s !== "heating" && s !== "busy") throw new DriverError("rejected", `nothing to pause: printer is ${s}`, "Refresh the printer status; the job may already have changed.");
    await this.command({ print: { command: "pause", param: "" } }, "pause");
    await this.confirm((x) => x === "paused", "pause", "paused");
  }

  async resume(): Promise<void> {
    const s = await this.state();
    if (s !== "paused") throw new DriverError("rejected", `nothing to resume: printer is ${s}`, "Refresh the printer status; the job may already have changed.");
    await this.command({ print: { command: "resume", param: "" } }, "resume");
    await this.confirm((x) => x === "printing" || x === "heating" || x === "busy", "resume", "printing");
  }

  async cancel(): Promise<void> {
    const s = await this.state();
    if (s === "idle") return;
    await this.command({ print: { command: "stop", param: "" } }, "cancel");
    await this.confirm((x) => x === "idle", "cancel", "stopped");
  }

  private drop() {
    const c = this.client;
    this.client = null;
    c?.end(true);
  }

  async close(): Promise<void> {
    this.drop();
  }
}

/** Safe .gcode.3mf name (Bambu needs the .3mf container; ".gcode.3mf" is what Bambu Studio writes). */
export function bambuFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").trim();
  if (!/\.3mf$/i.test(base)) throw new DriverError("unsupported", `file ${JSON.stringify(base)} is not a .gcode.3mf`, "Slice with Bambu Studio / Orca and export the plate as a .gcode.3mf.");
  const stem = base
    .replace(/\.gcode\.3mf$/i, "")
    .replace(/\.3mf$/i, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^[._-]+/, "")
    .slice(0, 80);
  if (!stem) throw new DriverError("rejected", `file name ${JSON.stringify(base)} has no usable characters`, "Rename the file using letters and numbers.");
  return `${stem}.gcode.3mf`;
}

/** Listens for the printers' SSDP NOTIFY broadcasts on UDP 2021. */
export function parseBambuSsdp(text: string): Discovered | null {
  if (!/bambulab|bambu\.com/i.test(text)) return null;
  const h = (k: string) => new RegExp(`^${k}:\\s*(.+?)\\s*$`, "im").exec(text)?.[1];
  const host = h("Location");
  if (!host) return null;
  return { driver: "bambu-lan", host, serial: h("USN"), model: h("DevModel\\.bambu\\.com"), name: h("DevName\\.bambu\\.com") };
}

function discoverSsdp(timeoutMs: number): Promise<Discovered[]> {
  return new Promise((resolve) => {
    const found = new Map<string, Discovered>();
    const sock = createSocket({ type: "udp4", reuseAddr: true });
    const done = () => {
      clearTimeout(t);
      try {
        sock.close();
      } catch {
        /* closed */
      }
      resolve([...found.values()]);
    };
    const t = setTimeout(done, timeoutMs);
    t.unref?.();
    sock.on("error", done);
    sock.on("message", (b) => {
      const d = parseBambuSsdp(b.toString("utf8"));
      if (d) found.set(d.host, d);
    });
    sock.bind(2021);
  });
}

export function createBambuLanDriver(opts: BambuOptions = {}): PrinterDriver {
  return {
    id: "bambu-lan",
    name: "Bambu Lab (LAN mode)",
    description: "Bambu Lab X1C, X1E, P1S, P1P, A1, A1 mini and H2D on your local network, without the Bambu cloud.",
    fields: [
      { key: "host", label: "Printer IP address", kind: "host", required: true, help: "On the printer screen open Settings → Network (WLAN); the IP address is shown there." },
      { key: "serial", label: "Serial number", kind: "text", required: true, help: "Printer screen: Settings → Device (or 'Printer info'); also on the label on the back and in Bambu Studio → Device." },
      { key: "accessCode", label: "LAN access code", kind: "secret", required: true, help: DEV_MODE_HELP },
      { key: "model", label: "Model", kind: "text", required: false, default: "", help: "X1C, X1E, P1S, P1P, A1, A1 mini or H2D (as printed on the printer). Used to send the print command in the format that model expects." },
      { key: "useAms", label: "Use the AMS", kind: "boolean", required: false, default: false, help: "On: print from AMS slot mapping in the file. Off: print from the external spool." },
      {
        key: "certFingerprint",
        label: "Printer certificate fingerprint",
        kind: "text",
        required: false,
        help: "Filled in automatically after the first successful Test (it protects the access code from look-alike devices). Clear it only after resetting or replacing the printer.",
      },
    ],
    discover: (timeoutMs: number) => discoverSsdp(timeoutMs),
    connect(config: DriverConfig, deps: DriverDeps = {}) {
      try {
        return new BambuConnection(config, deps, opts);
      } catch (e) {
        return invalidConnection("bambu-lan", toDriverError(e, "settings"), CAPS, deps.now ?? Date.now);
      }
    },
  };
}

export const bambuLanDriver = createBambuLanDriver();
