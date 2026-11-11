// PrusaLink driver against the fake PrusaLink (packages/printer/src/drivers/http/fake/prusalink.ts),
// including HTTP Digest login (with and without qop, stale nonces) and the older X-Api-Key login.
import { afterEach, describe, expect, it } from "vitest";
import { prusalinkDriver } from "../packages/printer/src/drivers/http/prusalink";
import { startFakePrusaLink, type FakePrusaLink } from "../packages/printer/src/drivers/http/fake/prusalink";
import { startPrinting } from "../packages/printer/src/drivers/http/fake/common";
import type { PrinterConnection } from "../packages/printer/src/drivers/types";
import { captureLog, closedPort, gcode } from "./drivers-http-helpers";

const PW = "fakePrusaPw42";
let fake: FakePrusaLink | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const connect = (f: FakePrusaLink, extra: Record<string, string | number> = {}): PrinterConnection =>
  prusalinkDriver.connect({ host: "127.0.0.1", port: f.port, password: PW, timeoutMs: 500, ...extra });

describe("prusalink driver", () => {
  for (const qop of [false, true]) {
    it(`logs in with HTTP Digest (${qop ? "qop=auth" : "no qop, RFC 2069"})`, async () => {
      fake = await startFakePrusaLink({ password: PW, qop });
      const log = captureLog();
      const c = prusalinkDriver.connect({ host: "127.0.0.1", port: fake.port, password: PW }, log.deps);
      expect(await c.test()).toEqual({ ok: true, info: { name: "Fake MK4", serial: "SN-FAKE-0001", firmware: "PrusaLink 2.1.2" } });
      expect(log.text()).not.toContain(PW);
    });
  }

  it("answers a stale nonce by logging in again", async () => {
    fake = await startFakePrusaLink({ password: PW, qop: true });
    const c = connect(fake);
    expect((await c.status()).state).toBe("idle");
    fake.expireNonce();
    expect((await c.status()).state).toBe("idle");
  });

  it("reports a wrong password as auth (one retry, no loop) and never leaks it", async () => {
    fake = await startFakePrusaLink({ password: PW });
    const c = connect(fake, { password: "wrong-pass-77" });
    const r = await c.test();
    expect(r).toMatchObject({ ok: false, code: "auth" });
    expect((r as { hint?: string }).hint).toContain("Settings → Network → PrusaLink");
    expect(JSON.stringify(r)).not.toContain("wrong-pass-77");
    expect(fake.log.filter((l) => l === "GET /api/version")).toHaveLength(2);
    const s = await c.status();
    expect(s.state).toBe("offline");
    await expect(c.start("a.gcode")).rejects.toMatchObject({ code: "auth" });
    expect(await prusalinkDriver.connect({ host: "127.0.0.1", port: fake.port }).test()).toMatchObject({ ok: false, code: "auth" });
  });

  it("supports the X-Api-Key login of older firmware", async () => {
    fake = await startFakePrusaLink({ apiKey: "OldKey123" });
    expect((await prusalinkDriver.connect({ host: "127.0.0.1", port: fake.port, apiKey: "OldKey123" }).test()).ok).toBe(true);
    expect(await prusalinkDriver.connect({ host: "127.0.0.1", port: fake.port, apiKey: "nope" }).test()).toMatchObject({ ok: false, code: "auth" });
  });

  it("says when PrusaLink is too old for the v1 API", async () => {
    fake = await startFakePrusaLink({ password: PW, noV1: true });
    expect(await connect(fake).test()).toMatchObject({ ok: false, code: "unsupported" });
  });

  it("maps printer states", async () => {
    fake = await startFakePrusaLink({ password: PW });
    const c = connect(fake);
    expect((await c.status()).state).toBe("idle");
    startPrinting(fake.printer, "benchy.gcode");
    expect((await c.status()).state).toBe("heating");
    fake.printer.nozzle.actual = 215;
    fake.printer.bed.actual = 60;
    fake.printer.progress = 0.4;
    fake.printer.elapsedS = 900;
    let s = await c.status();
    expect(s.state).toBe("printing");
    expect(s.job).toEqual({ file: "benchy.gcode", progress: 0.4, elapsedS: 900, remainingS: 1200 });
    fake.printer.state = "paused";
    expect((await c.status()).state).toBe("paused");
    fake.override = "ATTENTION";
    s = await c.status();
    expect(s.state).toBe("busy");
    expect(s.message).toContain("needs attention");
    fake.override = "BUSY";
    expect((await c.status()).state).toBe("busy");
    fake.override = "FINISHED";
    expect((await c.status()).state).toBe("idle");
    fake.override = "STOPPED";
    expect((await c.status()).state).toBe("idle");
    fake.override = "ERROR";
    expect((await c.status()).state).toBe("error");
  });

  it("uploads with PUT (never Print-After-Upload), then starts only when idle", async () => {
    fake = await startFakePrusaLink({ password: PW, qop: true });
    const c = connect(fake);
    const data = gcode("G28\n".repeat(5000));
    await c.upload({ name: "cube.gcode", data, format: "gcode" });
    expect(fake.printer.files.get("cube.gcode")?.length).toBe(data.length);
    expect(fake.lastUploadHeaders?.["print-after-upload"]).toBe("?0");
    expect(fake.lastUploadHeaders?.overwrite).toBe("?1");
    expect(fake.printer.state).toBe("idle");
    // The large body is sent once: the Digest challenge was fetched first.
    expect(fake.log.filter((l) => l.startsWith("PUT"))).toHaveLength(1);
    await c.upload({ name: "cube.gcode", data, format: "gcode" }); // re-upload replaces while idle
    await c.start("cube.gcode");
    expect(fake.printer.state).toBe("printing");
    await expect(c.start("cube.gcode")).rejects.toMatchObject({ code: "busy" });
    await expect(c.upload({ name: "cube.gcode", data, format: "gcode" })).rejects.toMatchObject({ code: "rejected" });
  });

  it("uses the storage the printer reports (MK3S+ Prusa Link: local)", async () => {
    fake = await startFakePrusaLink({ password: PW, storage: "local" });
    const c = connect(fake);
    await c.upload({ name: "a.gcode", data: gcode(), format: "gcode" });
    expect(fake.log).toContain("PUT /api/v1/files/local/a.gcode");
  });

  it("pauses, resumes and cancels by job id", async () => {
    fake = await startFakePrusaLink({ password: PW });
    const c = connect(fake);
    await expect(c.pause()).rejects.toMatchObject({ code: "rejected" });
    startPrinting(fake.printer, "a.gcode");
    await c.pause();
    expect(fake.printer.state).toBe("paused");
    expect(fake.log).toContain("PUT /api/v1/job/100/pause");
    await c.resume();
    expect(fake.printer.state).toBe("printing");
    await c.cancel();
    expect(fake.printer.state).toBe("cancelled");
    expect(fake.log).toContain("DELETE /api/v1/job/100");
    expect(c.capabilities().setTemperature).toBe(false);
    expect(c.setTemperature).toBeUndefined();
  });

  it("times out and handles unreachable printers", async () => {
    fake = await startFakePrusaLink({ password: PW });
    fake.hang.add("/api/v1/status");
    const c = connect(fake, { timeoutMs: 150 });
    expect(await c.test()).toMatchObject({ ok: false, code: "timeout" });
    expect((await c.status()).state).toBe("offline");
    const off = prusalinkDriver.connect({ host: "127.0.0.1", port: await closedPort(), password: PW });
    expect(await off.test()).toMatchObject({ ok: false, code: "unreachable" });
    expect((await off.status()).state).toBe("offline");
  });
});
