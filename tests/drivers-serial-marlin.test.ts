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

const fast = { bootWaitMs: 20, handshakeTimeoutMs: 200, commandTimeoutMs: 1000, okTimeoutMs: 2000, tempPollMs: 50, retryMs: 0 };
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
      const f = new FakeMarlin(fakeOpts);
      fakes.push(f);
      return f;
    },
    listPorts: async () => [{ path: PORT, name: "1a86 USB Serial (ttyUSB0)" }],
  });
  const conn = driver.connect({ port: PORT, ...config });
  conns.push(conn);
  return { driver, conn, fake: () => fakes[fakes.length - 1] };
}

async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
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

describe("marlin-serial driver", () => {
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
    const { conn } = setup({ silent: true });
    const r = await conn.test();
    expect(r).toMatchObject({ ok: false, code: "timeout" });
    expect((r as { hint?: string }).hint).toMatch(/baud/);
    expect((await conn.status()).state).toBe("offline");
  });

  it("streams a job with numbered lines, reports progress, and finishes idle", async () => {
    const { conn, fake } = setup({ okDelayMs: 1 });
    await conn.upload({ name: "cube.gcode", data: gcode(40), format: "gcode" });
    await conn.start("cube.gcode");
    await until(async () => {
      const s = await conn.status();
      return s.state === "printing" && (s.job?.progress ?? 0) > 0.2;
    });
    const mid = await conn.status();
    expect(mid.job?.file).toBe("cube.gcode");
    expect(mid.job!.progress!).toBeLessThan(1);
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

  it("replays lines on Resend after a checksum error", async () => {
    const { conn, fake } = setup();
    await conn.test();
    const firstJobN = fake().received.filter((l) => l.startsWith("N")).length; // lines used by handshake etc.
    await conn.upload({ name: "a.gcode", data: gcode(10), format: "gcode" });
    await conn.start("a.gcode");
    const corrupt = firstJobN + 3;
    // Corrupt one of the job lines: set after start so the fake rejects its first copy.
    (fake() as unknown as { o: FakeMarlinOptions }).o.corrupt = [corrupt];
    await until(async () => (await conn.status()).state === "idle");
    const ex = fake().executed.filter((c) => c.startsWith("G1 X"));
    expect(ex).toEqual(Array.from({ length: 10 }, (_, i) => `G1 X${i} Y${i} E${i / 10}`));
    expect(fake().received.filter((l) => l.startsWith(`N${corrupt} `)).length).toBe(2);
  });

  it("recovers from a forced checksum error on a numbered line", async () => {
    const { conn, fake } = setup({ corrupt: [3], autoReportTemp: true });
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
    const fake = new FakeMarlin({ busy: { G28: 10 }, autoReportTemp: true });
    const driver = createMarlinSerialDriver({ ...fast, okTimeoutMs: 25, storeDir: dir, openPort: async () => fake });
    const conn = driver.connect({ port: PORT });
    conns.push(conn);
    await conn.test();
    expect(await conn.sendGcode!("G28")).toMatch(/busy: processing[\s\S]*ok/);
    expect(fake.executed.filter((c) => c === "G28").length).toBe(1);
    expect(fake.received.filter((l) => l === "M105")).toEqual([]);
  });

  it("nudges with an unnumbered M105 when an ok goes missing", async () => {
    const fake = new FakeMarlin({ autoReportTemp: true });
    const driver = createMarlinSerialDriver({ ...fast, okTimeoutMs: 30, storeDir: dir, openPort: async () => fake });
    const conn = driver.connect({ port: PORT });
    conns.push(conn);
    await conn.test();
    (fake as unknown as { o: FakeMarlinOptions }).o.silent = true;
    const reply = conn.sendGcode!("M400");
    await new Promise((r) => setTimeout(r, 80));
    (fake as unknown as { o: FakeMarlinOptions }).o.silent = false;
    expect(fake.received).toContain("M105");
    fake.emit("ok");
    await expect(reply).resolves.toBe("ok");
  });

  it("refuses to start unless idle", async () => {
    const { conn } = setup({ okDelayMs: 2 });
    await conn.upload({ name: "a.gcode", data: gcode(200), format: "gcode" });
    await conn.start("a.gcode");
    await expect(conn.start("a.gcode")).rejects.toMatchObject({ code: "busy" });
    await conn.cancel();
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

  it("pauses by stopping the stream (no moves by default) and resumes", async () => {
    const { conn, fake } = setup({ okDelayMs: 2 });
    await conn.upload({ name: "a.gcode", data: gcode(100), format: "gcode" });
    await conn.start("a.gcode");
    await until(() => fake().executed.filter((c) => c.startsWith("G1 X")).length > 5);
    await conn.pause();
    expect((await conn.status()).state).toBe("paused");
    await new Promise((r) => setTimeout(r, 30));
    const count = fake().executed.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(fake().executed.length).toBe(count);
    expect(fake().executed.filter((c) => /^G1 Z|^G91/.test(c))).toEqual([]);
    await conn.resume();
    await until(async () => (await conn.status()).state === "idle", 5000);
    expect(fake().executed.filter((c) => c.startsWith("G1 X")).length).toBe(100);
  });

  it("runs the user's park G-code on pause when configured", async () => {
    const { conn, fake } = setup({ okDelayMs: 2 }, { pauseGcode: "G91\\nG1 Z10\\nG90", resumeGcode: "G91\\nG1 Z-10\\nG90" });
    await conn.upload({ name: "a.gcode", data: gcode(100), format: "gcode" });
    await conn.start("a.gcode");
    await until(() => fake().executed.filter((c) => c.startsWith("G1 X")).length > 3);
    await conn.pause();
    expect(fake().executed.slice(-3)).toEqual(["G91", "G1 Z10", "G90"]);
    await conn.resume();
    await conn.cancel();
  });

  it("cancel stops streaming, then heaters off, fan off, motors off, with no moves", async () => {
    const { conn, fake } = setup({ okDelayMs: 2, extruders: 2 });
    await conn.upload({ name: "a.gcode", data: gcode(300), format: "gcode" });
    await conn.start("a.gcode");
    await until(() => fake().executed.filter((c) => c.startsWith("G1 X")).length > 5);
    await conn.cancel();
    const ex = fake().executed;
    const at = ex.indexOf("M108");
    expect(at).toBeGreaterThan(0);
    const after = ex.slice(at);
    expect(after).toEqual(["M108", "M104 T0 S0", "M104 T1 S0", "M140 S0", "M107", "M84"]);
    expect(ex.filter((c) => c.startsWith("G1 X")).length).toBeLessThan(300);
    const s = await conn.status();
    expect(s.state).toBe("idle");
    expect(s.message).toBe("Cancelled a.gcode");
    await new Promise((r) => setTimeout(r, 30));
    expect(fake().executed.slice(at + after.length).filter((c) => /^G/.test(c))).toEqual([]);
  });

  it("a firmware halt stops streaming and reports an error", async () => {
    const { conn, fake } = setup({ okDelayMs: 1, haltOn: "G1 X5 " });
    await conn.upload({ name: "a.gcode", data: gcode(50), format: "gcode" });
    await conn.start("a.gcode");
    await until(async () => (await conn.status()).state === "error");
    const s = await conn.status();
    expect(s.message).toMatch(/Thermal Runaway/);
    const n = fake().received.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(fake().received.length).toBe(n);
    expect(fake().executed.filter((c) => c.startsWith("G1 X")).length).toBe(6);
    await expect(conn.start("a.gcode")).rejects.toMatchObject({ code: "busy" });
    expect(await conn.test()).toMatchObject({ ok: false, code: "protocol" });
  });

  it("reports a lost USB connection during a print as an error", async () => {
    const { conn, fake } = setup({ okDelayMs: 2 });
    await conn.upload({ name: "a.gcode", data: gcode(200), format: "gcode" });
    await conn.start("a.gcode");
    await until(() => fake().executed.length > 10);
    fake().unplug();
    // status() reconnects to a fresh (rebooted) fake; the lost print stays reported until cleared.
    const s = await conn.status();
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
