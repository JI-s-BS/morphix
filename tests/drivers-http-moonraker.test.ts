// Moonraker driver against the fake Moonraker (packages/printer/src/drivers/http/fake/moonraker.ts).
import { afterEach, describe, expect, it } from "vitest";
import { moonrakerDriver } from "../packages/printer/src/drivers/http/moonraker";
import { startFakeMoonraker, type FakeMoonraker } from "../packages/printer/src/drivers/http/fake/moonraker";
import { startPrinting } from "../packages/printer/src/drivers/http/fake/common";
import type { PrinterConnection } from "../packages/printer/src/drivers/types";
import { captureLog, closedPort, gcode } from "./drivers-http-helpers";

let fake: FakeMoonraker | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const connect = (f: FakeMoonraker, extra: Record<string, string | number> = {}): PrinterConnection =>
  moonrakerDriver.connect({ host: "127.0.0.1", port: f.port, timeoutMs: 500, ...extra });

describe("moonraker driver", () => {
  it("tests the connection and reports Klipper's version", async () => {
    fake = await startFakeMoonraker();
    const r = await connect(fake).test();
    expect(r).toEqual({ ok: true, info: { name: "fake-voron", firmware: "Klipper v0.12.0-fake" } });
  });

  it("maps print_stats states", async () => {
    fake = await startFakeMoonraker();
    const c = connect(fake);
    expect((await c.status()).state).toBe("idle");

    startPrinting(fake.printer, "benchy.gcode");
    let s = await c.status();
    expect(s.state).toBe("heating"); // printing, no filament used yet, heaters far below target
    expect(s.temps).toEqual({ nozzle: { actual: 25, target: 215 }, bed: { actual: 24, target: 60 } });

    fake.printer.nozzle.actual = 215;
    fake.printer.bed.actual = 60;
    fake.filamentUsed = 12.5;
    fake.printer.progress = 0.25;
    fake.printer.elapsedS = 600;
    fake.layer = [5, 120];
    s = await c.status();
    expect(s.state).toBe("printing");
    expect(s.job).toEqual({ file: "benchy.gcode", progress: 0.25, elapsedS: 600, remainingS: 1800, layer: [5, 120] });

    fake.printer.state = "paused";
    expect((await c.status()).state).toBe("paused");
    fake.printer.state = "complete";
    s = await c.status();
    expect(s.state).toBe("idle");
    expect(s.message).toBe("Finished benchy.gcode");
    fake.printer.state = "cancelled";
    expect((await c.status()).state).toBe("idle");
    fake.printer.state = "error";
    fake.errorMessage = "Move out of range";
    s = await c.status();
    expect(s.state).toBe("error");
    expect(s.message).toBe("Move out of range");
  });

  it("maps Klipper not ready", async () => {
    fake = await startFakeMoonraker({ klippyState: "shutdown", stateMessage: "MCU 'mcu' shutdown: Timer too close\nmore" });
    let s = await connect(fake).status();
    expect(s.state).toBe("error");
    expect(s.message).toContain("Timer too close");
    expect(s.message).not.toContain("more");
    fake.opts.klippyState = "startup";
    expect((await connect(fake).status()).state).toBe("busy");
    fake.opts.klippyState = "disconnected";
    s = await connect(fake).status();
    expect(s.state).toBe("offline");
    expect(s.message).toContain("Klipper is not connected");
  });

  it("uploads, then starts only when idle", async () => {
    fake = await startFakeMoonraker();
    const c = connect(fake);
    await c.upload({ name: "cube.gcode", data: gcode(), format: "gcode" });
    expect(fake.printer.files.get("cube.gcode")?.toString()).toBe(gcode().toString());
    expect(fake.printer.state).toBe("idle"); // upload never starts a print
    await c.start("cube.gcode");
    expect(fake.printer.state).toBe("printing");
    await expect(c.start("cube.gcode")).rejects.toMatchObject({ code: "busy" });
    await expect(c.upload({ name: "x.gx", data: gcode(), format: "gx" })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("pauses, resumes and cancels, refusing out-of-state commands", async () => {
    fake = await startFakeMoonraker();
    const c = connect(fake);
    await expect(c.pause()).rejects.toMatchObject({ code: "rejected" });
    await expect(c.cancel()).rejects.toMatchObject({ code: "rejected" });
    startPrinting(fake.printer, "a.gcode");
    fake.printer.files.set("a.gcode", gcode());
    await expect(c.resume()).rejects.toMatchObject({ code: "rejected" });
    await c.pause();
    expect(fake.printer.state).toBe("paused");
    await c.resume();
    expect(fake.printer.state).toBe("printing");
    await c.cancel();
    expect(fake.printer.state).toBe("cancelled");
  });

  it("sets temperatures and refuses console G-code while printing", async () => {
    fake = await startFakeMoonraker();
    const c = connect(fake);
    await c.setTemperature!("nozzle", 200.4);
    await c.setTemperature!("bed", 60);
    expect(fake.printer.nozzle.target).toBe(200);
    expect(fake.printer.bed.target).toBe(60);
    await expect(c.setTemperature!("nozzle", -5)).rejects.toMatchObject({ code: "rejected" });
    expect(await c.sendGcode!("G28")).toBe("ok");
    startPrinting(fake.printer, "a.gcode");
    await expect(c.sendGcode!("G28")).rejects.toMatchObject({ code: "rejected" });
    expect(await c.sendGcode!("M112")).toBe("ok"); // emergency stop always goes through
    await expect(c.sendGcode!("G28\nG1 Z0")).rejects.toMatchObject({ code: "rejected" });
  });

  it("uses the API key and reports auth failures without leaking it", async () => {
    fake = await startFakeMoonraker({ apiKey: "s3cret-key" });
    const log = captureLog();
    const bad = moonrakerDriver.connect({ host: "127.0.0.1", port: fake.port, apiKey: "wrong-key" }, log.deps);
    const r = await bad.test();
    expect(r).toMatchObject({ ok: false, code: "auth" });
    expect(JSON.stringify(r)).not.toContain("wrong-key");
    expect((await bad.status()).state).toBe("offline");
    await expect(bad.start("a.gcode")).rejects.toMatchObject({ code: "auth" });
    expect((await connect(fake, { apiKey: "s3cret-key" }).test()).ok).toBe(true);
    expect(log.text()).not.toContain("wrong-key");
  });

  it("reads the webcam from /server/webcams/list", async () => {
    fake = await startFakeMoonraker({ webcams: [{ name: "cam", enabled: true, service: "mjpegstreamer-adaptive", stream_url: "/webcam/?action=stream", snapshot_url: "/webcam/?action=snapshot" }] });
    const c = connect(fake);
    expect(c.capabilities().camera).toBe(false);
    await c.test();
    expect(c.capabilities().camera).toEqual({ kind: "mjpeg", url: "http://127.0.0.1/webcam/?action=stream" });
    await fake.close();
    fake = await startFakeMoonraker({ webcams: [{ name: "cam", service: "webrtc-camerastreamer", stream_url: "/webcam/webrtc", snapshot_url: "/webcam/?action=snapshot" }] });
    const c2 = connect(fake);
    await c2.status();
    expect(c2.capabilities().camera).toEqual({ kind: "snapshot", url: "http://127.0.0.1/webcam/?action=snapshot" });
  });

  it("times out instead of hanging", async () => {
    fake = await startFakeMoonraker();
    fake.hang.add("/server/info");
    const c = connect(fake, { timeoutMs: 150 });
    const t0 = Date.now();
    const r = await c.test();
    expect(r).toMatchObject({ ok: false, code: "timeout" });
    const s = await c.status();
    expect(s.state).toBe("offline");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("never throws from test()/status() for an unreachable printer", async () => {
    const port = await closedPort();
    const c = moonrakerDriver.connect({ host: "127.0.0.1", port, timeoutMs: 500 });
    expect(await c.test()).toMatchObject({ ok: false, code: "unreachable" });
    expect((await c.status()).state).toBe("offline");
    const bad = moonrakerDriver.connect({ host: "" });
    expect(await bad.test()).toMatchObject({ ok: false, code: "rejected" });
    expect((await bad.status()).state).toBe("offline");
  });
});
