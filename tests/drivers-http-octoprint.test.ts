// OctoPrint driver against the fake OctoPrint (packages/printer/src/drivers/http/fake/octoprint.ts).
import { afterEach, describe, expect, it } from "vitest";
import { octoprintDriver } from "../packages/printer/src/drivers/http/octoprint";
import { startFakeOctoPrint, type FakeOctoPrint } from "../packages/printer/src/drivers/http/fake/octoprint";
import { startPrinting } from "../packages/printer/src/drivers/http/fake/common";
import type { PrinterConnection } from "../packages/printer/src/drivers/types";
import { captureLog, closedPort, gcode } from "./drivers-http-helpers";

const KEY = "A1B2C3D4E5F6-test-key";
let fake: FakeOctoPrint | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const connect = (f: FakeOctoPrint, extra: Record<string, string | number> = {}): PrinterConnection =>
  octoprintDriver.connect({ host: `http://127.0.0.1:${f.port}`, apiKey: KEY, timeoutMs: 500, ...extra });

describe("octoprint driver", () => {
  it("tests the connection and reads the camera (OctoPrint 1.9+ classicwebcam)", async () => {
    fake = await startFakeOctoPrint({ apiKey: KEY, webcamStyle: "plugin" });
    const c = connect(fake);
    expect(await c.test()).toEqual({ ok: true, info: { firmware: "OctoPrint 1.10.2", name: "Fake Ender" } });
    expect(c.capabilities().camera).toEqual({ kind: "mjpeg", url: `http://127.0.0.1:${fake.port}/webcam/?action=stream` });
  });

  it("reads the camera from ≤1.8 settings and honours a disabled webcam", async () => {
    fake = await startFakeOctoPrint({ apiKey: KEY, webcamStyle: "legacy" });
    const c = connect(fake);
    await c.status();
    expect(c.capabilities().camera).toMatchObject({ kind: "mjpeg" });
    await fake.close();
    fake = await startFakeOctoPrint({ apiKey: KEY, webcamStyle: "none" });
    const c2 = connect(fake);
    await c2.test();
    expect(c2.capabilities().camera).toBe(false);
  });

  it("maps state flags", async () => {
    fake = await startFakeOctoPrint({ apiKey: KEY });
    const c = connect(fake);
    let s = await c.status();
    expect(s.state).toBe("idle");
    expect(s.temps?.nozzle).toEqual({ actual: 25, target: 0 });

    startPrinting(fake.printer, "benchy.gcode");
    expect((await c.status()).state).toBe("heating");
    fake.printer.nozzle.actual = 214;
    fake.printer.bed.actual = 60;
    fake.printer.progress = 0.5;
    fake.printer.elapsedS = 1800;
    s = await c.status();
    expect(s.state).toBe("printing");
    expect(s.job).toEqual({ file: "benchy.gcode", progress: 0.5, elapsedS: 1800, remainingS: 1800 });

    fake.transitional = "pausing";
    expect((await c.status()).state).toBe("busy");
    fake.transitional = "finishing";
    expect((await c.status()).state).toBe("finishing");
    fake.transitional = "cancelling";
    expect((await c.status()).state).toBe("busy");
    fake.transitional = undefined;
    fake.printer.state = "paused";
    expect((await c.status()).state).toBe("paused");
    fake.printer.state = "error";
    s = await c.status();
    expect(s.state).toBe("error");
    expect(s.message).toBe("Thermal runaway");
  });

  it("says when OctoPrint is not connected to the printer (409)", async () => {
    fake = await startFakeOctoPrint({ apiKey: KEY });
    fake.connected = false;
    const c = connect(fake);
    const s = await c.status();
    expect(s.state).toBe("offline");
    expect(s.message).toContain("click Connect");
    await expect(c.start("a.gcode")).rejects.toMatchObject({ code: "unreachable" });
    expect((await c.test()).ok).toBe(true); // OctoPrint itself answers and the key works
  });

  it("uploads, then starts only when idle", async () => {
    fake = await startFakeOctoPrint({ apiKey: KEY });
    const c = connect(fake);
    await c.upload({ name: "My Part.gcode", data: gcode(), format: "gcode" });
    expect([...fake.printer.files.keys()]).toEqual(["My_Part.gcode"]);
    expect(fake.printer.state).toBe("idle");
    await c.start("My Part.gcode");
    expect(fake.printer.state).toBe("printing");
    expect(fake.printer.file).toBe("My_Part.gcode");
    await expect(c.start("My Part.gcode")).rejects.toMatchObject({ code: "busy" });
  });

  it("pauses, resumes, cancels", async () => {
    fake = await startFakeOctoPrint({ apiKey: KEY });
    const c = connect(fake);
    await expect(c.pause()).rejects.toMatchObject({ code: "rejected" });
    startPrinting(fake.printer, "a.gcode");
    await c.pause();
    expect(fake.printer.state).toBe("paused");
    await expect(c.pause()).rejects.toMatchObject({ code: "rejected" });
    await c.resume();
    expect(fake.printer.state).toBe("printing");
    await c.cancel();
    expect(fake.printer.state).toBe("idle");
  });

  it("sets temperatures and sends console G-code when idle", async () => {
    fake = await startFakeOctoPrint({ apiKey: KEY });
    const c = connect(fake);
    await c.setTemperature!("nozzle", 210);
    await c.setTemperature!("bed", 55);
    expect(fake.printer.nozzle.target).toBe(210);
    expect(fake.printer.bed.target).toBe(55);
    expect(await c.sendGcode!("M115")).toBe("sent");
    expect(fake.printer.gcode).toEqual(["M115"]);
    startPrinting(fake.printer, "a.gcode");
    await expect(c.sendGcode!("G28")).rejects.toMatchObject({ code: "rejected" });
  });

  it("reports a wrong API key as auth without leaking it", async () => {
    fake = await startFakeOctoPrint({ apiKey: KEY });
    const log = captureLog();
    const c = octoprintDriver.connect({ host: "127.0.0.1", port: fake.port, apiKey: "not-the-key-123" }, log.deps);
    const r = await c.test();
    expect(r).toMatchObject({ ok: false, code: "auth" });
    expect((r as { hint?: string }).hint).toContain("Application Keys");
    expect(JSON.stringify(r)).not.toContain("not-the-key-123");
    const s = await c.status();
    expect(s.state).toBe("offline");
    expect(s.message).not.toContain("not-the-key-123");
    await expect(c.pause()).rejects.toMatchObject({ code: "auth" });
    expect(log.text()).not.toContain("not-the-key-123");
  });

  it("times out and handles unreachable printers", async () => {
    fake = await startFakeOctoPrint({ apiKey: KEY });
    fake.hang.add("/api/printer");
    const c = connect(fake, { timeoutMs: 150 });
    const s = await c.status();
    expect(s.state).toBe("offline");
    expect(s.message).toContain("did not answer");
    const port = await closedPort();
    const off = octoprintDriver.connect({ host: "127.0.0.1", port, apiKey: KEY });
    expect(await off.test()).toMatchObject({ ok: false, code: "unreachable" });
    expect((await off.status()).state).toBe("offline");
  });
});
