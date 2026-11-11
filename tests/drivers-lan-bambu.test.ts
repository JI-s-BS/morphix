// bambu-lan driver against a local MQTT 3.1.1 fake (the real mqtt.js client talks to it over TCP;
// the TLS layer is injected) and an injected FTPS fake. No real printer.
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import {
  bambuFileName,
  bambuToStatus,
  createBambuLanDriver,
  findPlate,
  mapBambuState,
  parseBambuSsdp,
  projectFileUrl,
  trustDecision,
  type BambuFtp,
  type BambuOptions,
  type PeerInfo,
} from "../packages/printer/src/drivers/lan/bambu-lan";
import { DriverError, type DriverConfig } from "@morphix/printer";
import { captureLog, closedPort, FakeMqttBroker, useCleanup } from "./drivers-lan-helpers";

const SERIAL = "01P00A123456789";
const CODE = "12345678";
const FP_A = "AA:".repeat(31) + "AA";
const FP_B = "BB:".repeat(31) + "BB";

interface FakeBambuOpts {
  state?: Record<string, unknown>;
  echo?: "success" | "verify-failed" | "none";
  ignore?: string[];
  connack?: number | null;
}

/** A Bambu printer on top of FakeMqttBroker: answers pushall, project_file, pause, resume, stop. */
async function startPrinter(o: FakeBambuOpts, cleanup: (fn: () => unknown) => void) {
  const broker = new FakeMqttBroker();
  const port = await broker.listen();
  cleanup(() => broker.close());
  const state: Record<string, unknown> = { gcode_state: "IDLE", nozzle_temper: 25, nozzle_target_temper: 0, bed_temper: 24, bed_target_temper: 0, mc_percent: 0, ...o.state };
  broker.onConnect = (c) => (o.connack !== undefined ? o.connack : c.username === "bblp" && c.password === CODE ? 0 : 5);
  const report = (extra: Record<string, unknown>) => broker.publish(`device/${SERIAL}/report`, { print: extra });
  broker.onPublish = (topic, payload) => {
    if (topic !== `device/${SERIAL}/request`) return;
    const msg = JSON.parse(payload) as Record<string, Record<string, unknown>>;
    if (msg.pushing?.command === "pushall") return void setTimeout(() => report({ command: "push_status", ...state }), 5);
    const p = msg.print;
    if (!p) return;
    const cmd = String(p.command);
    if (o.echo === "verify-failed") return void report({ command: cmd, sequence_id: p.sequence_id, result: "failed", reason: "mqtt message verify failed", err_code: 84033543 });
    if (o.echo !== "none") report({ command: cmd, sequence_id: p.sequence_id, result: "success" });
    if (o.ignore?.includes(cmd)) return;
    const next =
      cmd === "project_file"
        ? { gcode_state: "RUNNING", stg_cur: 0, subtask_name: p.subtask_name, mc_percent: 1, layer_num: 1, total_layer_num: 120, mc_remaining_time: 42 }
        : cmd === "pause"
          ? { gcode_state: "PAUSE", stg_cur: 16 }
          : cmd === "resume"
            ? { gcode_state: "RUNNING", stg_cur: 0 }
            : cmd === "stop"
              ? { gcode_state: "FAILED" }
              : {};
    Object.assign(state, next);
    setTimeout(() => report({ command: "push_status", ...next }), 10);
  };
  return { broker, port, state };
}

class FakeFtp implements BambuFtp {
  static uploads: { dir: string; name: string; data: Buffer }[] = [];
  static loggedIn: string[] = [];
  constructor(private peer: PeerInfo, private password = CODE) {}
  async connect() {
    return this.peer;
  }
  async login(user: string, password: string) {
    if (password !== this.password) throw new Error("530 Login incorrect.");
    FakeFtp.loggedIn.push(user);
  }
  async upload(data: Buffer, dir: string, name: string) {
    FakeFtp.uploads.push({ dir, name, data });
  }
  close() {}
}

function io(port: number, peer: Partial<PeerInfo> = {}, ftpPeer?: Partial<PeerInfo>): BambuOptions["io"] {
  const p: PeerInfo = { fingerprint: FP_A, caVerified: false, ...peer };
  return {
    connectMqtt: (_h, _p, _s, timeoutMs) =>
      new Promise((resolve, reject) => {
        const sock = connect(port, "127.0.0.1");
        const t = setTimeout(() => reject(new DriverError("timeout", "connect timeout")), timeoutMs);
        sock.once("connect", () => (clearTimeout(t), resolve({ stream: sock, peer: p })));
        sock.once("error", (e) => (clearTimeout(t), reject(e)));
      }),
    ftp: () => new FakeFtp({ ...p, ...ftpPeer }),
  };
}

const FAST = { connectTimeoutMs: 800, reportTimeoutMs: 400, commandTimeoutMs: 300, confirmTimeoutMs: 800, pollMs: 20 };

function conn(port: number, cfg: Partial<DriverConfig> = {}, extra: BambuOptions = {}, log?: ReturnType<typeof captureLog>) {
  const driver = createBambuLanDriver({ ...FAST, io: io(port), ...extra });
  return driver.connect({ host: "127.0.0.1", serial: SERIAL, accessCode: CODE, model: "P1S", ...cfg }, { log: log?.log });
}

// A minimal .gcode.3mf stand-in: zip file names are stored in clear.
const THREE_MF = Buffer.from("PK\u0003\u0004....Metadata/plate_2.gcode....Metadata/plate_2.gcode.md5....");

describe("bambu-lan: state mapping", () => {
  it("maps gcode_state and stages", () => {
    expect(mapBambuState({ gcode_state: "IDLE" }).state).toBe("idle");
    expect(mapBambuState({ gcode_state: "FINISH" }).state).toBe("idle");
    expect(mapBambuState({ gcode_state: "FAILED", print_error: 0x0300400c }).message).toContain("0300400C");
    expect(mapBambuState({ gcode_state: "PREPARE", stg_cur: 1 })).toEqual({ state: "busy", message: "Auto bed levelling" });
    expect(mapBambuState({ gcode_state: "PREPARE", stg_cur: 2 }).state).toBe("heating");
    expect(mapBambuState({ gcode_state: "RUNNING", stg_cur: 7 }).state).toBe("heating");
    expect(mapBambuState({ gcode_state: "RUNNING", stg_cur: 0 }).state).toBe("printing");
    expect(mapBambuState({ gcode_state: "PAUSE", stg_cur: 6 })).toEqual({ state: "paused", message: "Paused: filament ran out" });
    expect(mapBambuState({ gcode_state: "SLICING" }).state).toBe("busy");
    expect(mapBambuState({}).state).toBe("busy");
    expect(mapBambuState({ gcode_state: "SOMETHING_NEW" }).state).toBe("busy");
  });

  it("builds a status with temps, layers and remaining time", () => {
    const s = bambuToStatus(
      { gcode_state: "RUNNING", subtask_name: "benchy", mc_percent: 37, layer_num: 12, total_layer_num: 200, mc_remaining_time: 15, nozzle_temper: 219.5, nozzle_target_temper: 220, bed_temper: 55, bed_target_temper: 55, chamber_temper: 30, hms: [{ attr: 1 }] },
      "t",
    );
    expect(s.state).toBe("printing");
    expect(s.job).toEqual({ file: "benchy", progress: 0.37, layer: [12, 200], remainingS: 900 });
    expect(s.temps?.nozzle).toEqual({ actual: 219.5, target: 220 });
    expect(s.temps?.chamber).toEqual({ actual: 30 });
    expect(s.message).toContain("HMS");
  });

  it("chooses the project_file URL per model and finds the plate", () => {
    expect(projectFileUrl("P1S", "cache/a.gcode.3mf")).toBe("file:///sdcard/cache/a.gcode.3mf");
    expect(projectFileUrl("A1 mini", "cache/a.gcode.3mf")).toBe("file:///sdcard/cache/a.gcode.3mf");
    expect(projectFileUrl("H2D", "cache/a.gcode.3mf")).toBe("ftp:///cache/a.gcode.3mf");
    expect(findPlate(THREE_MF)).toBe("Metadata/plate_2.gcode");
    expect(findPlate(Buffer.from("nothing"))).toBe("Metadata/plate_1.gcode");
    expect(bambuFileName("My Part (v2).gcode.3mf")).toBe("My_Part_v2.gcode.3mf");
    expect(() => bambuFileName("part.gcode")).toThrow(DriverError);
  });

  it("parses SSDP announcements", () => {
    const d = parseBambuSsdp(
      "NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1990\r\nLocation: 192.168.1.50\r\nNT: urn:bambulab-com:device:3dprinter:1\r\nUSN: 01P00A123456789\r\nDevModel.bambu.com: C12\r\nDevName.bambu.com: Workshop P1S\r\n\r\n",
    );
    expect(d).toEqual({ driver: "bambu-lan", host: "192.168.1.50", serial: "01P00A123456789", model: "C12", name: "Workshop P1S" });
    expect(parseBambuSsdp("NOTIFY * HTTP/1.1\r\nLocation: 1.2.3.4\r\n")).toBeNull();
  });
});

describe("bambu-lan: TLS trust", () => {
  it("trusts Bambu-CA certificates, then pins, and refuses a changed certificate", () => {
    expect(trustDecision({ fingerprint: FP_B, caVerified: true }, ["A".repeat(64)])).toEqual({ ok: true, via: "ca" });
    expect(trustDecision({ fingerprint: FP_A, caVerified: false }, [])).toEqual({ ok: true, via: "first-use" });
    expect(trustDecision({ fingerprint: FP_A, caVerified: false }, ["A".repeat(64)])).toEqual({ ok: true, via: "pinned" });
    const r = trustDecision({ fingerprint: FP_B, caVerified: false }, ["A".repeat(64)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("auth");
  });
});

describe("bambu-lan: against a fake printer", () => {
  const cleanup = useCleanup();

  it("does not send the access code to a printer whose certificate changed", async () => {
    const p = await startPrinter({}, cleanup);
    const c = createBambuLanDriver({ ...FAST, io: io(p.port, { fingerprint: FP_B }) }).connect({ host: "127.0.0.1", serial: SERIAL, accessCode: CODE, certFingerprint: `sha256:${FP_A}` });
    const r = await c.test();
    expect(r).toMatchObject({ ok: false, code: "auth" });
    expect(p.broker.connects).toHaveLength(0);
    await c.close();
  });

  it("test() logs in, reads a report, checks FTPS and returns the fingerprint to store", async () => {
    const p = await startPrinter({}, cleanup);
    const log = captureLog();
    const c = conn(p.port, {}, {}, log);
    cleanup(() => c.close());
    const r = await c.test();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info.serial).toBe(SERIAL);
      expect((r.info as Record<string, unknown>).certFingerprint).toBe("A".repeat(64));
      expect((r.info as Record<string, unknown>).trust).toBe("first-use");
    }
    expect(p.broker.connects[0]).toMatchObject({ username: "bblp", password: CODE });
    expect(log.text()).not.toContain(CODE);
    expect(log.text()).not.toContain(SERIAL);
  });

  it("reports a wrong access code as auth with the Developer Mode steps", async () => {
    const p = await startPrinter({}, cleanup);
    const c = conn(p.port, { accessCode: "00000000" });
    cleanup(() => c.close());
    const r = await c.test();
    expect(r).toMatchObject({ ok: false, code: "auth" });
    if (!r.ok) {
      expect(r.hint).toContain("Developer Mode");
      expect(r.message).not.toContain("00000000");
    }
    const s = await c.status();
    expect(s.state).toBe("error");
  });

  it("a wrong serial gives a timeout that points at the serial number", async () => {
    const p = await startPrinter({}, cleanup);
    const c = conn(p.port, { serial: "00M00A999999999" });
    cleanup(() => c.close());
    const r = await c.test();
    expect(r).toMatchObject({ ok: false, code: "timeout" });
    if (!r.ok) expect(r.hint).toMatch(/serial/i);
  });

  it("times out when the printer never accepts the MQTT login", async () => {
    const p = await startPrinter({ connack: null }, cleanup);
    const c = conn(p.port);
    cleanup(() => c.close());
    const r = await c.test();
    expect(r).toMatchObject({ ok: false, code: "timeout" });
  });

  it("unreachable printer: test() and status() do not throw (real TLS connect)", async () => {
    const port = await closedPort();
    const c = createBambuLanDriver({ ...FAST, mqttPort: port }).connect({ host: "127.0.0.1", serial: SERIAL, accessCode: CODE });
    const r = await c.test();
    expect(r).toMatchObject({ ok: false, code: "unreachable" });
    const s = await c.status();
    expect(s.state).toBe("offline");
    await c.close();
  });

  it("status() reads temps and state; a missing access code is reported, not thrown", async () => {
    const p = await startPrinter({ state: { gcode_state: "RUNNING", mc_percent: 50, layer_num: 3, total_layer_num: 10, nozzle_temper: 220, nozzle_target_temper: 220 } }, cleanup);
    const c = conn(p.port);
    cleanup(() => c.close());
    const s = await c.status();
    expect(s.state).toBe("printing");
    expect(s.job?.progress).toBe(0.5);
    const bad = createBambuLanDriver().connect({ host: "127.0.0.1", serial: SERIAL });
    expect(await bad.test()).toMatchObject({ ok: false, code: "auth" });
    expect((await bad.status()).state).toBe("offline");
  });

  it("uploads over FTPS and starts the uploaded plate", async () => {
    FakeFtp.uploads = [];
    const p = await startPrinter({}, cleanup);
    const c = conn(p.port);
    cleanup(() => c.close());
    await c.upload({ name: "benchy.gcode.3mf", data: THREE_MF, format: "gcode.3mf" });
    expect(FakeFtp.uploads).toEqual([{ dir: "/cache", name: "benchy.gcode.3mf", data: THREE_MF }]);
    await c.start("benchy.gcode.3mf");
    const cmd = p.broker.published.map((x) => JSON.parse(x.payload)).find((m) => m.print?.command === "project_file");
    expect(cmd.print).toMatchObject({ param: "Metadata/plate_2.gcode", url: "file:///sdcard/cache/benchy.gcode.3mf", subtask_name: "benchy", use_ams: false });
    expect((await c.status()).state).toBe("printing");
  });

  it("refuses upload and start while the printer is busy", async () => {
    const p = await startPrinter({ state: { gcode_state: "RUNNING" } }, cleanup);
    const c = conn(p.port);
    cleanup(() => c.close());
    await expect(c.start("x.gcode.3mf")).rejects.toMatchObject({ code: "busy" });
    await expect(c.upload({ name: "x.gcode.3mf", data: THREE_MF, format: "gcode.3mf" })).rejects.toMatchObject({ code: "busy" });
    expect(p.broker.published.some((x) => x.payload.includes("project_file"))).toBe(false);
  });

  it("pause, resume and cancel are confirmed from the reports", async () => {
    const p = await startPrinter({ state: { gcode_state: "RUNNING" } }, cleanup);
    const c = conn(p.port);
    cleanup(() => c.close());
    await c.pause();
    expect((await c.status()).state).toBe("paused");
    await expect(c.pause()).rejects.toMatchObject({ code: "rejected" });
    await c.resume();
    expect((await c.status()).state).toBe("printing");
    await c.cancel();
    expect((await c.status()).state).toBe("idle");
    await c.cancel(); // idle: nothing sent
    expect(p.broker.published.filter((x) => x.payload.includes('"stop"'))).toHaveLength(1);
  });

  it("a refused command (no Developer Mode) is an auth error with the steps", async () => {
    const p = await startPrinter({ state: { gcode_state: "RUNNING" }, echo: "verify-failed" }, cleanup);
    const c = conn(p.port);
    cleanup(() => c.close());
    const e = (await c.pause().catch((x) => x)) as DriverError;
    expect(e.code).toBe("auth");
    expect(e.hint).toContain("Developer Mode");
  });

  it("a command the printer ignores ends in a protocol error, not success", async () => {
    const p = await startPrinter({ state: { gcode_state: "RUNNING" }, ignore: ["pause"], echo: "none" }, cleanup);
    const c = conn(p.port);
    cleanup(() => c.close());
    await expect(c.pause()).rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects wrong file formats", async () => {
    const p = await startPrinter({}, cleanup);
    const c = conn(p.port);
    cleanup(() => c.close());
    await expect(c.upload({ name: "a.gcode", data: Buffer.from("G28"), format: "gcode" })).rejects.toMatchObject({ code: "unsupported" });
  });
});

