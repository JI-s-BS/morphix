// marlin-serial driver against an in-memory fake Marlin (no hardware).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checksum,
  fatalError,
  gcodeCommands,
  numberedLine,
  parseM115,
  parseResend,
  parseTemps,
  userGcode,
} from "../packages/printer/src/drivers/serial/marlin-gcode";
import { DIALOUT_HINT, isSerialPath, readablePortName, serialOpenError } from "../packages/printer/src/drivers/serial/marlin-port";
import { createMarlinSerialDriver } from "../packages/printer/src/drivers/serial/marlin-serial";
import { SERIAL_DRIVERS } from "../packages/printer/src/drivers/serial";
import { getDriver } from "../packages/printer/src/drivers/registry";
import type { DriverConfig, PrinterConnection } from "../packages/printer/src/drivers/types";
import { FakeMarlin, type FakeMarlinOptions } from "./drivers-serial-fake-marlin";

// Generous protocol timeouts so a loaded machine (the full suite runs in parallel) cannot trip them;
// the tests below wait on conditions (fake.hold / until), never on fixed sleeps.
const fast = { bootWaitMs: 20, handshakeTimeoutMs: 2000, commandTimeoutMs: 5000, okTimeoutMs: 10_000, tempPollMs: 50, retryMs: 0 };
const PORT = "/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0";

let dir: string;
let conns: PrinterConnection[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morphix-serial-")); });
afterEach(async () => {
  for (const c of conns) await c.close();
  conns = [];
  rmSync(dir, { recursive: true, force: true });
});

function setup(fakeOpts: FakeMarlinOptions = {}, config: DriverConfig = {}) {
  const fakes: FakeMarlin[] = [];
  const driver = createMarlinSerialDriver({
    ...fast,
    storeDir: dir,
    openPort: async () => {
      // Auto-report by default: no M105 polling interleaved with the commands the tests look at.
      const f = new FakeMarlin({ autoReportTemp: true, ...fakeOpts });
      fakes.push(f);
      return f;
    },
    listPorts: async () => [{ path: PORT, name: "1a86 USB Serial (ttyUSB0)" }],
  });
  const conn = driver.connect({ port: PORT, ...config });
  conns.push(conn);
  return { driver, conn, fake: () => fakes[fakes.length - 1] };
}

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const gcode = (n: number) => Buffer.from(["; sliced by test", "G28 ; home", "M109 S200", ...Array.from({ length: n }, (_, i) => `G1 X${i} Y${i} E${i / 10}`), "M104 S0", ""].join("\n"));

describe("marlin wire format", () => {
  it("computes RepRap checksums and numbers lines", () => {
    expect(checksum("N0 M110 N0")).toBe(125);
    expect(numberedLine(0, "M110 N0")).toBe("N0 M110 N0*125");
    expect(numberedLine(1, "G28")).toBe(`N1 G28*${checksum("N1 G28")}`);
  });

  it("strips comments, blank lines and M110 from files", () => {
    expect(gcodeCommands("; hi\nG28 ; home\n\n  G1 X1  \nM110 N5\n")).toEqual(["G28", "G1 X1"]);
    expect(userGcode("G91\\nG1 Z10 ; lift\nG90")).toEqual(["G91", "G1 Z10", "G90"]);
    expect(userGcode(undefined)).toEqual([]);
  });

  it("parses temperatures from M105, auto-report and heating waits", () => {
    expect(parseTemps("ok T:210.0 /210.0 B:60.0 /60.0 @:127 B@:0")).toEqual({ nozzle: { actual: 210, target: 210 }, bed: { actual: 60, target: 60 } });
    expect(parseTemps(" T:21.40 /0.00 B:20.90 /0.00 @:0 B@:0")).toEqual({ nozzle: { actual: 21.4, target: 0 }, bed: { actual: 20.9, target: 0 } });
    expect(parseTemps(" T:190.3 E:0 W:?")).toEqual({ nozzle: { actual: 190.3 } });
    expect(parseTemps("ok T0:200.0 /200.0 T1:25.0 /0.0 B:55.0 /55.0 C:30.0 /0.0")?.chamber).toEqual({ actual: 30, target: 0 });
    expect(parseTemps("Cap:AUTOREPORT_TEMP:1")).toBeUndefined();
    expect(parseTemps("ok")).toBeUndefined();
  });

  it("recognises resend requests and fatal errors", () => {
    expect(parseResend("Resend: 12")).toBe(12);
    expect(parseResend("rs N7")).toBe(7);
    expect(parseResend("ok")).toBeUndefined();
    expect(fatalError("Error:checksum mismatch, Last Line: 4")).toBeUndefined();
    expect(fatalError("Error:Line Number is not Last Line Number+1, Last Line: 4")).toBeUndefined();
    expect(fatalError("Error:Printer halted. kill() called!")).toBe("Printer halted. kill() called!");
    expect(fatalError("Error:Thermal Runaway, system stopped! Heater_ID: 0")).toMatch(/Thermal Runaway/);
    expect(fatalError("Error: MINTEMP triggered, system stopped! Heater_ID: bed")).toMatch(/MINTEMP/);
    expect(fatalError("!! heater failure")).toBe("heater failure");
  });

  it("parses M115", () => {
    const info = parseM115([
      "FIRMWARE_NAME:Marlin 2.1.2 (Jan 1 2024) SOURCE_CODE_URL:github.com/MarlinFirmware/Marlin PROTOCOL_VERSION:1.0 MACHINE_TYPE:Ender-3 V2 EXTRUDER_COUNT:2 UUID:abc-123",
      "Cap:AUTOREPORT_TEMP:1",
      "ok",
    ]);
    expect(info).toEqual({ firmware: "Marlin 2.1.2 (Jan 1 2024)", machine: "Ender-3 V2", extruders: 2, uuid: "abc-123", autoReportTemp: true });
  });

  it("only accepts serial device paths and names them readably", () => {
    expect(isSerialPath(PORT)).toBe(true);
    expect(isSerialPath("/dev/ttyACM0")).toBe(true);
    expect(isSerialPath("/etc/passwd")).toBe(false);
    expect(isSerialPath("/dev/serial/by-id/../../etc/passwd")).toBe(false);
    expect(readablePortName("usb-1a86_USB_Serial-if00-port0")).toBe("1a86 USB Serial");
    expect(readablePortName("usb-Prusa_Research__prusa3d.com__Original_Prusa_i3_MK3_CZPX1234-if00"))
      .toBe("Prusa Research (prusa3d.com) Original Prusa i3 MK3 CZPX1234");
  });
});

describe("marlin-serial driver", { timeout: 30_000 }, () => {
  it("is registered with fields and help text", () => {
    expect(SERIAL_DRIVERS.map((d) => d.id)).toEqual(["marlin-serial", "ultimaker", "snapmaker"]);
    const d = getDriver("marlin-serial")!;
    expect(d.fields.find((f) => f.key === "port")?.kind).toBe("serial-port");
    for (const f of d.fields) expect(f.help).toBeTruthy();
  });

  it("discovers serial ports with readable names", async () => {
    const { driver } = setup();
    expect(await driver.discover!(100)).toEqual([{ driver: "marlin-serial", host: PORT, name: "1a86 USB Serial (ttyUSB0)" }]);
  });

  it("tests the connection: handshake, M115 firmware detection, M155 auto-report", async () => {
    const { conn, fake } = setup({ autoReportTemp: true });
    const r = await conn.test();
    expect(r).toEqual({ ok: true, info: { firmware: "Marlin 2.1.2.1 (Jul 10 2024 12:00:00)", model: "Ender-3 V2", name: "Ender-3 V2", serial: "cede2a2f-41a2-4748-9b12-c55c62f367ff" } });
    expect(fake().received[0]).toBe("N0 M110 N0*125");
    expect(fake().executed).toContain("M155 S2");
    fake().nozzle = { actual: 180.5, target: 200 };
    fake().autoReport();
    const s = await conn.status();
    expect(s.state).toBe("idle");
    expect(s.temps?.nozzle).toEqual({ actual: 180.5, target: 200 });
  });

  it("polls M105 when the firmware cannot auto-report", async () => {
    const { conn, fake } = setup({ autoReportTemp: false });
    await conn.test();
    expect(fake().executed).not.toContain("M155 S2");
    fake().bed = { actual: 59.9, target: 60 };
    await until(async () => (await conn.status()).temps?.bed?.actual === 59.9);
  });

  it("maps a missing device to 'unreachable' and EACCES to 'auth' with the dialout hint", async () => {
    const driver = createMarlinSerialDriver({ ...fast, storeDir: dir });
    const conn = driver.connect({ port: "/dev/ttyUSB99" });
    conns.push(conn);
    expect(await conn.test()).toMatchObject({ ok: false, code: "unreachable" });
    const denied = serialOpenError(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }), "/dev/ttyUSB0");
    expect(denied).toMatchObject({ code: "auth", message: "No permission to open /dev/ttyUSB0", hint: DIALOUT_HINT });
    expect(serialOpenError(Object.assign(new Error("busy"), { code: "EBUSY" }), "/dev/ttyUSB0").code).toBe("busy");
  });

  it("maps EACCES from the real port opener to DriverError('auth') with the dialout hint", async () => {
    // /dev/serial/by-id paths that exist but cannot be opened are hard to fake; use the opener's mapping directly.
    const { DriverError } = await import("../packages/printer/src/drivers/types");
    const driver = createMarlinSerialDriver({
      ...fast,
      storeDir: dir,
      openPort: async () => { throw new DriverError("auth", "No permission to open /dev/ttyUSB0", DIALOUT_HINT); },
    });
    const conn = driver.connect({ port: "/dev/ttyUSB0" });
    conns.push(conn);
    expect(await conn.test()).toEqual({ ok: false, code: "auth", message: "No permission to open /dev/ttyUSB0", hint: DIALOUT_HINT });
    const s = await conn.status();
    expect(s.state).toBe("offline");
    expect(s.message).toContain("dialout");
    expect(DIALOUT_HINT).toContain("sudo usermod -aG dialout $USER");
  });

  it("status() and test() never throw when the printer does not answer", async () => {
    const driver = createMarlinSerialDriver({ ...fast, handshakeTimeoutMs: 50, storeDir: dir, openPort: async () => new FakeMarlin({ silent: true }) });
    const conn = driver.connect({ port: PORT });
    conns.push(conn);
    const r = await conn.test();
    expect(r).toMatchObject({ ok: false, code: "timeout" });
    expect((r as { hint?: string }).hint).toMatch(/baud/);
    expect((await conn.status()).state).toBe("offline");
  });

  it("streams a job with numbered lines, reports progress, and finishes idle", async () => {
    const { conn, fake } = setup();
    await conn.test();
    fake().hold("G1 X20 ");
    await conn.upload({ name: "cube.gcode", data: gcode(40), format: "gcode" });
    await conn.start("cube.gcode");
    await until(() => fake().holding);
    const mid = await conn.status();
    expect(mid.state).toBe("printing");
    expect(mid.job?.file).toBe("cube.gcode");
    // G28, M109, G1 X0..X19 (+ M104 S0 at the end): 22 of 43 commands acknowledged.
    expect(mid.job?.progress).toBeCloseTo(22 / 43);
    fake().release();
    await until(async () => (await conn.status()).state === "idle");
    expect((await conn.status()).message).toBe("Finished cube.gcode");
    const ex = fake().executed;
    expect(ex.filter((c) => c.startsWith("G1 X")).length).toBe(40);
    expect(ex.indexOf("G28")).toBeLessThan(ex.indexOf("G1 X0 Y0 E0"));
    // Every streamed line carried a valid checksum (the fake rejects bad ones).
    for (const l of fake().received.filter((x) => x.startsWith("N"))) {
      const [body, cs] = l.split("*");
      expect(checksum(body)).toBe(Number(cs));
    }
  });

  it("shows 'heating' while an M109 wait is in flight", async () => {
    const { conn, fake } = setup();
    await conn.test();
    fake().hold("M109");
    await conn.upload({ name: "h.gcode", data: gcode(3), format: "gcode" });
    await conn.start("h.gcode");
    await until(() => fake().holding);
    expect((await conn.status()).state).toBe("heating");
    fake().release();
    await until(async () => (await conn.status()).state === "idle");
  });

  it("replays lines on Resend after a checksum error", async () => {
    const { conn, fake } = setup();
    await conn.test();
    // Numbered lines so far are N0..N(k-1); start() sends M27 as Nk, then the job: G28, M109, G1 X0, G1 X1 ...
    const k = fake().received.filter((l) => l.startsWith("N")).length;
    const corrupt = k + 4;
    fake().setOptions({ corrupt: [corrupt] });
    await conn.upload({ name: "a.gcode", data: gcode(10), format: "gcode" });
    await conn.start("a.gcode");
    await until(async () => (await conn.status()).state === "idle");
    const ex = fake().executed.filter((c) => c.startsWith("G1 X"));
    expect(ex).toEqual(Array.from({ length: 10 }, (_, i) => `G1 X${i} Y${i} E${i / 10}`));
    const copies = fake().received.filter((l) => l.startsWith(`N${corrupt} `));
    expect(copies).toEqual([copies[0], copies[0]]);
    expect(copies[0]).toMatch(/^N\d+ G1 X1 /);
  });

  it("recovers from a forced checksum error on a numbered line", async () => {
    const { conn, fake } = setup({ corrupt: [3] });
    await conn.test();
    await conn.sendGcode!("M114");
    await conn.sendGcode!("M114");
    // N3 is rejected once ("Resend: 3"), sent again with the same number, and then accepted.
    const n3 = fake().received.filter((l) => l.startsWith("N3 "));
    expect(n3.length).toBe(2);
    expect(n3[0]).toBe(n3[1]);
    expect(fake().received.filter((l) => l.startsWith("N4 ")).length).toBe(1);
  });

  it("treats busy: as keep-alive during long commands (no lost-ok nudge)", async () => {
    // A test clock: each "busy" line advances it 20 ms, the ok timeout is 50 ms, the whole G28 takes 300 ms.
    let clock = 0;
    const fake = new FakeMarlin({ busy: { G28: 15 }, autoReportTemp: true, onBusy: () => { clock += 20; } });
    const driver = createMarlinSerialDriver({ ...fast, okTimeoutMs: 50, storeDir: dir, openPort: async () => fake });
    const conn = driver.connect({ port: PORT }, { now: () => clock });
    conns.push(conn);
    await conn.test();
    expect(await conn.sendGcode!("G28")).toMatch(/busy: processing[\s\S]*ok/);
    expect(clock).toBe(300);
    expect(fake.executed.filter((c) => c === "G28").length).toBe(1);
    expect(fake.received.filter((l) => l === "M105")).toEqual([]);
  });

  it("nudges with an unnumbered M105 when an ok goes missing", async () => {
    let clock = 0;
    const fake = new FakeMarlin({ autoReportTemp: true });
    const driver = createMarlinSerialDriver({ ...fast, okTimeoutMs: 50, storeDir: dir, openPort: async () => fake });
    const conn = driver.connect({ port: PORT }, { now: () => clock });
    conns.push(conn);
    await conn.test();
    fake.setOptions({ silent: true });
    const reply = conn.sendGcode!("M400");
    await until(() => fake.received.some((l) => l.startsWith("N") && l.includes("M400")));
    clock += 100;
    await until(() => fake.received.includes("M105"));
    fake.setOptions({ silent: false });
    fake.emit("ok");
    await expect(reply).resolves.toBe("ok");
  });

  it("refuses to start unless idle", async () => {
    const { conn, fake } = setup();
    await conn.test();
    fake().hold("G1 X1 ");
    await conn.upload({ name: "a.gcode", data: gcode(20), format: "gcode" });
    await conn.start("a.gcode");
    await expect(conn.start("a.gcode")).rejects.toMatchObject({ code: "busy" });
    await until(() => fake().holding);
    const c = conn.cancel();
    fake().release();
    await c;
  });

  it("refuses to start while the printer runs its own SD card print", async () => {
    const { conn } = setup({ sdPrinting: [100, 1000] });
    await conn.upload({ name: "a.gcode", data: gcode(5), format: "gcode" });
    const s = await conn.status();
    expect(s.state).toBe("printing");
    expect(s.job?.progress).toBeCloseTo(0.1);
    await expect(conn.start("a.gcode")).rejects.toMatchObject({ code: "busy" });
  });

  it("refuses a file that was not uploaded and non-gcode formats", async () => {
    const { conn } = setup();
    await expect(conn.start("nope.gcode")).rejects.toMatchObject({ code: "rejected" });
    await expect(conn.upload({ name: "a.3mf", data: Buffer.from("x"), format: "gcode.3mf" })).rejects.toMatchObject({ code: "unsupported" });
  });

  const jobLines = (f: FakeMarlin) => f.executed.filter((c) => c.startsWith("G1 X")).length;

  it("pauses by stopping the stream (no moves by default) and resumes", async () => {
    const { conn, fake } = setup();
    await conn.test();
    fake().hold("G1 X10 ");
    await conn.upload({ name: "a.gcode", data: gcode(100), format: "gcode" });
    await conn.start("a.gcode");
    await until(() => fake().holding);
    await conn.pause();
    expect((await conn.status()).state).toBe("paused");
    // The line already in flight (G1 X10) completes; nothing after it is sent while paused.
    const sentBefore = fake().received.length;
    fake().release();
    await conn.sendGcode!("M114"); // a full round trip after the held line's ok
    expect(jobLines(fake())).toBe(11);
    expect(fake().received.length).toBe(sentBefore + 1);
    expect((await conn.status()).state).toBe("paused");
    expect(fake().executed.filter((c) => /^G1 Z|^G91/.test(c))).toEqual([]);
    await conn.resume();
    await until(async () => (await conn.status()).state === "idle");
    expect(jobLines(fake())).toBe(100);
  });

  it("runs the user's park G-code on pause when configured", async () => {
    const { conn, fake } = setup({}, { pauseGcode: "G91\\nG1 Z10\\nG90", resumeGcode: "G91\\nG1 Z-10\\nG90" });
    await conn.test();
    fake().hold("G1 X3 ");
    await conn.upload({ name: "a.gcode", data: gcode(100), format: "gcode" });
    await conn.start("a.gcode");
    await until(() => fake().holding);
    const paused = conn.pause();
    fake().release();
    await paused;
    expect(fake().executed.slice(-4)).toEqual(["G1 X3 Y3 E0.3", "G91", "G1 Z10", "G90"]);
    fake().hold("G1 X4 ");
    await conn.resume();
    await until(() => fake().holding);
    expect(fake().executed.slice(-4)).toEqual(["G91", "G1 Z-10", "G90", "G1 X4 Y4 E0.4"]);
    const c = conn.cancel();
    fake().release();
    await c;
  });

  it("cancel stops streaming, then heaters off, fan off, motors off, with no moves", async () => {
    const { conn, fake } = setup({ extruders: 2 });
    await conn.test();
    fake().hold("G1 X10 ");
    await conn.upload({ name: "a.gcode", data: gcode(300), format: "gcode" });
    await conn.start("a.gcode");
    await until(() => fake().holding);
    const c = conn.cancel();
    fake().release();
    await c;
    const ex = fake().executed;
    const at = ex.indexOf("G1 X10 Y10 E1");
    expect(ex.slice(at)).toEqual(["G1 X10 Y10 E1", "M108", "M104 T0 S0", "M104 T1 S0", "M140 S0", "M107", "M84"]);
    expect(jobLines(fake())).toBe(11);
    const s = await conn.status();
    expect(s.state).toBe("idle");
    expect(s.message).toBe("Cancelled a.gcode");
    await conn.sendGcode!("M114");
    expect(jobLines(fake())).toBe(11);
  });

  it("a firmware halt stops streaming and reports an error", async () => {
    const { conn, fake } = setup({ haltOn: "G1 X5 " });
    await conn.upload({ name: "a.gcode", data: gcode(50), format: "gcode" });
    await conn.start("a.gcode");
    await until(async () => (await conn.status()).state === "error");
    const s = await conn.status();
    expect(s.message).toMatch(/Thermal Runaway/);
    // One line at a time: nothing was sent after the line that halted it.
    expect(fake().received[fake().received.length - 1]).toMatch(/^N\d+ G1 X5 /);
    expect(jobLines(fake())).toBe(6);
    await expect(conn.start("a.gcode")).rejects.toMatchObject({ code: "busy" });
    expect(await conn.test()).toMatchObject({ ok: false, code: "protocol" });
    expect(fake().received[fake().received.length - 1]).toMatch(/^N\d+ G1 X5 /);
  });

  it("reports a lost USB connection during a print as an error", async () => {
    const { conn, fake } = setup();
    await conn.test();
    fake().hold("G1 X10 ");
    await conn.upload({ name: "a.gcode", data: gcode(200), format: "gcode" });
    await conn.start("a.gcode");
    await until(() => fake().holding);
    const lost = fake();
    lost.unplug();
    // status() reconnects to a fresh (rebooted) fake; the lost print stays reported until cleared.
    const s = await conn.status();
    expect(fake()).not.toBe(lost);
    expect(s.state).toBe("error");
    expect(s.message).toMatch(/USB connection lost/);
    await conn.cancel();
    expect((await conn.status()).state).toBe("idle");
  });

  it("sets temperatures and sends console G-code", async () => {
    const { conn, fake } = setup();
    await conn.setTemperature!("nozzle", 205);
    await conn.setTemperature!("bed", 60);
    expect(fake().executed).toEqual(expect.arrayContaining(["M104 S205", "M140 S60"]));
    expect(await conn.sendGcode!("M105")).toMatch(/^ok T:/);
    await expect(conn.sendGcode!("M110 N5")).rejects.toMatchObject({ code: "rejected" });
    await expect(conn.setTemperature!("nozzle", 9999)).rejects.toMatchObject({ code: "rejected" });
  });
});
