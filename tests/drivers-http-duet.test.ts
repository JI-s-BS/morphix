// Duet (RepRapFirmware) driver against the fake Duet (packages/printer/src/drivers/http/fake/duet.ts) in
// standalone (rr_*) and SBC (DSF /machine/*) modes.
import { afterEach, describe, expect, it } from "vitest";
import { duetDriver } from "../packages/printer/src/drivers/http/duet";
import { startFakeDuet, type FakeDuet } from "../packages/printer/src/drivers/http/fake/duet";
import { startPrinting } from "../packages/printer/src/drivers/http/fake/common";
import type { PrinterConnection } from "../packages/printer/src/drivers/types";
import { captureLog, closedPort, gcode } from "./drivers-http-helpers";

let fake: FakeDuet | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const connect = (f: FakeDuet, extra: Record<string, string | number> = {}): PrinterConnection =>
  duetDriver.connect({ host: "127.0.0.1", port: f.port, timeoutMs: 500, ...extra });

for (const mode of ["standalone", "dsf"] as const) {
  describe(`duet driver (${mode})`, () => {
    it("detects the mode and reads the board", async () => {
      fake = await startFakeDuet({ mode });
      const r = await connect(fake).test();
      expect(r).toEqual({
        ok: true,
        info: { model: "Duet 3 MB6HC", firmware: `RepRapFirmware for Duet 3 MB6HC 3.5.1${mode === "dsf" ? " (SBC)" : ""}`, serial: "08DJM-FAKE", name: "Fake Duet" },
      });
    });

    it("maps the object model", async () => {
      fake = await startFakeDuet({ mode });
      const c = connect(fake);
      let s = await c.status();
      expect(s.state).toBe("idle");
      expect(s.temps).toEqual({ nozzle: { actual: 25, target: 0 }, bed: { actual: 24, target: 0 } });
      fake.printer.files.set("benchy.gcode", Buffer.alloc(1000));
      startPrinting(fake.printer, "benchy.gcode");
      expect((await c.status()).state).toBe("heating");
      fake.printer.nozzle.actual = 215;
      fake.printer.bed.actual = 60;
      fake.printer.progress = 0.3;
      fake.printer.elapsedS = 500;
      s = await c.status();
      expect(s.state).toBe("printing");
      expect(s.job).toEqual({ file: "benchy.gcode", progress: 0.3, elapsedS: 500, remainingS: 800, layer: [10, 50] });
      fake.printer.state = "paused";
      expect((await c.status()).state).toBe("paused");
      for (const [status, state] of [["halted", "error"], ["simulating", "busy"], ["off", "offline"], ["pausing", "busy"], ["changingTool", "busy"]] as const) {
        fake.statusOverride = status;
        expect((await c.status()).state, status).toBe(state);
      }
    });

    it("uploads, starts only when idle, pauses, resumes and cancels (M25 then M0)", async () => {
      fake = await startFakeDuet({ mode });
      const c = connect(fake);
      await c.upload({ name: "cube.gcode", data: gcode(), format: "gcode" });
      expect(fake.printer.files.get("cube.gcode")?.toString()).toBe(gcode().toString());
      expect(fake.printer.state).toBe("idle");
      await c.start("cube.gcode");
      expect(fake.printer.gcode).toEqual(['M32 "0:/gcodes/cube.gcode"']);
      expect(fake.printer.state).toBe("printing");
      await expect(c.start("cube.gcode")).rejects.toMatchObject({ code: "busy" });
      await c.pause();
      expect(fake.printer.state).toBe("paused");
      await c.resume();
      expect(fake.printer.state).toBe("printing");
      await c.cancel();
      expect(fake.printer.gcode.slice(-2)).toEqual(["M25", "M0"]);
      expect(fake.printer.state).toBe("cancelled");
      await expect(c.resume()).rejects.toMatchObject({ code: "rejected" });
    });

    it("sets temperatures and runs console G-code", async () => {
      fake = await startFakeDuet({ mode });
      const c = connect(fake);
      await c.setTemperature!("nozzle", 205);
      await c.setTemperature!("bed", 65);
      expect(fake.printer.nozzle.target).toBe(205);
      expect(fake.printer.bed.target).toBe(65);
      expect(await c.sendGcode!("M115")).toContain("FIRMWARE_VERSION: 3.5.1");
      startPrinting(fake.printer, "x.gcode");
      await expect(c.sendGcode!("G28")).rejects.toMatchObject({ code: "rejected" });
    });

    it("logs in with the board password, re-logs in after a session timeout, and rejects a wrong one", async () => {
      fake = await startFakeDuet({ mode, password: "duetpw9" });
      const log = captureLog();
      const c = duetDriver.connect({ host: "127.0.0.1", port: fake.port, password: "duetpw9" }, log.deps);
      expect((await c.test()).ok).toBe(true);
      fake.expireSessions();
      expect((await c.status()).state).toBe("idle");
      expect(fake.logins).toBeGreaterThanOrEqual(2);
      const bad = duetDriver.connect({ host: "127.0.0.1", port: fake.port, password: "wrong-duet" }, log.deps);
      const r = await bad.test();
      expect(r).toMatchObject({ ok: false, code: "auth" });
      expect(JSON.stringify(r)).not.toContain("wrong-duet");
      expect((await bad.status()).state).toBe("offline");
      expect(log.text()).not.toMatch(/duetpw9|wrong-duet/);
      await c.close();
    });
  });
}

describe("duet driver (errors)", () => {
  it("reports no free sessions as busy", async () => {
    fake = await startFakeDuet({ mode: "standalone", noFreeSessions: true });
    expect(await connect(fake).test()).toMatchObject({ ok: false, code: "busy" });
  });

  it("times out and handles unreachable boards", async () => {
    fake = await startFakeDuet({ mode: "standalone" });
    fake.hang.add("/rr_connect");
    const c = connect(fake, { timeoutMs: 150 });
    expect(await c.test()).toMatchObject({ ok: false, code: "timeout" });
    expect((await c.status()).state).toBe("offline");
    const off = duetDriver.connect({ host: "127.0.0.1", port: await closedPort() });
    expect(await off.test()).toMatchObject({ ok: false, code: "unreachable" });
    expect((await off.status()).state).toBe("offline");
  });
});
