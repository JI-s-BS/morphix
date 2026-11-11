// flashforge-tcp driver (QD330Controller wrapped as a PrinterDriver) against the FakeQD330.
import { describe, expect, it } from "vitest";
import { FakeQD330, type FakeQD330Options, type QD330ControllerOptions } from "@morphix/printer";
import { createFlashforgeTcpDriver, mapFlashforgeTcpStatus } from "../packages/printer/src/drivers/lan/flashforge-tcp";
import { LAN_DRIVERS } from "../packages/printer/src/drivers/lan";
import { captureLog, closedPort, useCleanup } from "./drivers-lan-helpers";

const GX = Buffer.from("xgcode 1.0\n;fake .gx payload\n");

const FAST: Partial<QD330ControllerOptions> = {
  connectTimeoutMs: 500,
  replyTimeoutMs: 300,
  startReplyTimeoutMs: 300,
  uploadFinishTimeoutMs: 300,
  startConfirmTimeoutMs: 500,
  confirmTimeoutMs: 500,
  pauseConfirmTimeoutMs: 500,
  pollIntervalMs: 20,
  uploadFlushDelayMs: 0,
};

describe("flashforge-tcp: status mapping", () => {
  const at = new Date().toISOString();
  it("maps M119 MachineStatus / MoveMode", () => {
    expect(mapFlashforgeTcpStatus({ online: false, checkedAt: at, error: "x" }).state).toBe("offline");
    expect(mapFlashforgeTcpStatus({ online: true, checkedAt: at, machine: "READY", moveMode: "READY" }).state).toBe("idle");
    expect(mapFlashforgeTcpStatus({ online: true, checkedAt: at, machine: "READY", moveMode: "MOVING" }).state).toBe("busy");
    expect(mapFlashforgeTcpStatus({ online: true, checkedAt: at, machine: "BUILDING_FROM_SD", progress: 10 }).state).toBe("printing");
    expect(mapFlashforgeTcpStatus({ online: true, checkedAt: at, machine: "BUILDING_FROM_SD", progress: 0, temps: { nozzle: { current: 80, target: 210 } } }).state).toBe("heating");
    expect(mapFlashforgeTcpStatus({ online: true, checkedAt: at, machine: "PAUSED" }).state).toBe("paused");
    expect(mapFlashforgeTcpStatus({ online: true, checkedAt: at, machine: "BUILDING_FROM_SD", moveMode: "PAUSED" }).state).toBe("paused");
    expect(mapFlashforgeTcpStatus({ online: true, checkedAt: at, machine: "BUILDING_COMPLETED" }).state).toBe("busy");
    expect(mapFlashforgeTcpStatus({ online: true, checkedAt: at, machine: "SOMETHING" }).state).toBe("busy");
  });

  it("is registered with the other lan drivers and offers no unverified machine commands", () => {
    expect(LAN_DRIVERS.map((d) => d.id).sort()).toEqual(["bambu-lan", "creality-k1", "elegoo-sdcp", "flashforge-http", "flashforge-tcp"]);
    for (const d of LAN_DRIVERS) {
      for (const f of d.fields) expect(f.help, `${d.id}.${f.key}`).toBeTruthy();
    }
    const c = createFlashforgeTcpDriver().connect({ host: "127.0.0.1" });
    expect(c.capabilities()).toMatchObject({ setTemperature: false, gcodeConsole: false, fileFormats: ["gx"] });
    expect(c.setTemperature).toBeUndefined();
    expect(c.sendGcode).toBeUndefined();
  });
});

describe("flashforge-tcp: against the fake QD330", () => {
  const cleanup = useCleanup();

  async function rig(opts: FakeQD330Options = {}, cfg: Record<string, unknown> = {}) {
    const fake = new FakeQD330({ files: { "Afinia_Cube.gx": GX }, ...opts });
    const port = await fake.listen();
    cleanup(() => fake.close());
    const log = captureLog();
    const c = createFlashforgeTcpDriver(FAST).connect({ host: "127.0.0.1", port, ...cfg }, { log: log.log });
    cleanup(() => c.close());
    return { fake, c, log };
  }

  it("test() reads M115", async () => {
    const { c } = await rig();
    expect(await c.test()).toEqual({ ok: true, info: { model: "Afinia 3D QD330", firmware: "v2.1.3", serial: "SNFAKE0000001", name: "QD330" } });
  });

  it("status() is idle with temperatures", async () => {
    const { c } = await rig();
    const s = await c.status();
    expect(s.state).toBe("idle");
    expect(s.temps?.nozzle?.actual).toEqual(expect.any(Number));
  });

  it("uploads a .gx, starts it, refuses a second start while busy, pauses, resumes and cancels", async () => {
    const { c, log } = await rig();
    await c.upload({ name: "My Part.gx", data: GX, format: "gx" });
    await c.start("My Part.gx");
    expect(["heating", "printing"]).toContain((await c.status()).state);
    await expect(c.start("Afinia_Cube.gx")).rejects.toMatchObject({ code: "busy" });
    await expect(c.upload({ name: "b.gx", data: GX, format: "gx" })).rejects.toMatchObject({ code: "busy" });
    await c.pause();
    expect((await c.status()).state).toBe("paused");
    await c.resume();
    expect(["heating", "printing"]).toContain((await c.status()).state);
    await c.cancel();
    expect((await c.status()).state).toBe("idle");
    expect(log.lines.some((l) => l.message.includes("start confirmed"))).toBe(true);
  });

  it("refuses plain G-code unless allowed, then stores it as .g", async () => {
    const { c } = await rig();
    await expect(c.upload({ name: "a.gcode", data: GX, format: "gcode" })).rejects.toMatchObject({ code: "unsupported" });
    const { c: c2, fake } = await rig({}, { allowPlainGcode: true });
    await c2.upload({ name: "a.gcode", data: GX, format: "gcode" });
    expect([...(fake as unknown as { files: Map<string, Uint8Array> }).files.keys()]).toContain("a.g");
  });

  it("pause/resume with nothing running are rejected; cancel when idle sends nothing", async () => {
    const { c, fake } = await rig();
    await expect(c.pause()).rejects.toMatchObject({ code: "rejected" });
    await expect(c.resume()).rejects.toMatchObject({ code: "rejected" });
    await c.cancel();
    expect((fake as unknown as { received: string[] }).received).not.toContain("M26");
  });

  it("another program holding control is reported as busy with a plain hint", async () => {
    const { c } = await rig({ failures: { refuseControl: true } });
    const r = await c.test();
    expect(r).toMatchObject({ ok: false, code: "busy" });
    if (!r.ok) expect(r.hint).toMatch(/FlashPrint/);
  });

  it("a silent printer times out; test() and status() do not throw", async () => {
    const { c } = await rig({ failures: { silent: ["M115", "M119"] } });
    expect(await c.test()).toMatchObject({ ok: false, code: "timeout" });
    expect((await c.status()).state).toBe("offline");
  });

  it("an unreachable printer gives ok:false / offline", async () => {
    const port = await closedPort();
    const c = createFlashforgeTcpDriver(FAST).connect({ host: "127.0.0.1", port });
    expect(await c.test()).toMatchObject({ ok: false, code: "unreachable" });
    expect((await c.status()).state).toBe("offline");
    await expect(c.start("Afinia_Cube.gx")).rejects.toMatchObject({ code: "unreachable" });
  });

  it("a missing IP address is reported by test() instead of throwing from connect()", async () => {
    const c = createFlashforgeTcpDriver().connect({});
    expect(await c.test()).toMatchObject({ ok: false, code: "rejected" });
    expect((await c.status()).state).toBe("offline");
  });
});
