import { describe, expect, it } from "vitest";
import { COMMAND_SPECS, RateLimitedError, type CommandCapability } from "@morphix/printer";
import { guardLoopbackOnly, startRig, useCleanup } from "./phase5-helpers";
import { machineController, machineSent, sleep, until } from "./printer-control-helpers";

guardLoopbackOnly();
const cleanup = useCleanup();

const heat = { requestedBy: "touch" as const, approvedBy: "touch" as const };

describe("heater idle safety timer", () => {
  it("turns the heaters off after the idle time and logs it as a system cool-down", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup, { heaterIdleTimeoutMs: 150 });
    await c.setNozzleTemp(200, heat);
    await c.setBedTemp(60, heat);
    const s = c.heaterSafety();
    expect(s.armed).toBe(true);
    expect(s.remainingMs).toBeGreaterThan(0);
    expect(s.remainingMs).toBeLessThanOrEqual(150);
    await until(() => rig.fake.nozzle.target === 0 && rig.fake.bed.target === 0, 2000, "idle cool-down");
    await until(() => rig.log.some((e) => e.op === "coolDown"), 1000, "log");
    expect(rig.log.find((e) => e.op === "coolDown")).toMatchObject({ requestedBy: "system", reason: "heater idle timeout", outcome: "confirmed" });
    expect(c.heaterSafety()).toMatchObject({ armed: false, targets: { nozzle: 0, bed: 0 } });
  });

  it("is an idle timer: each heating command restarts it", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup, { heaterIdleTimeoutMs: 400 });
    await c.setNozzleTemp(180, heat);
    await sleep(200);
    await c.setNozzleTemp(190, heat);
    await sleep(220); // past the first command's deadline, well before the second's
    expect(rig.fake.nozzle.target).toBe(190);
    await until(() => rig.fake.nozzle.target === 0, 2000, "idle cool-down");
  });

  it("leaves the heaters alone while a print is running, then cools once it is over", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup, { heaterIdleTimeoutMs: 120 });
    await c.setNozzleTemp(200, heat);
    rig.fake.machineStatus = "BUILDING_FROM_SD"; // a print started (e.g. from the printer's screen)
    await sleep(300);
    expect(rig.fake.nozzle.target).toBe(200);
    expect(rig.log.some((e) => e.op === "coolDown")).toBe(false);
    expect(c.heaterSafety().armed).toBe(true); // re-armed for another period
    rig.fake.machineStatus = "READY";
    await until(() => rig.fake.nozzle.target === 0, 2000, "cool-down after the print");
  });

  it("retries when the printer cannot be reached", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup, { heaterIdleTimeoutMs: 80, heaterRetryMs: 60 });
    await c.setNozzleTemp(200, heat);
    rig.fake.failures = { refuseControl: true };
    await sleep(200);
    expect(rig.fake.nozzle.target).toBe(200);
    // Between attempts the timer is briefly disarmed while a retry runs; on a slow Pi a fixed
    // instant can land mid-retry, so wait for it to re-arm instead of sampling once.
    await until(() => c.heaterSafety().armed, 2000, "safety timer re-armed after a failed cool-down");
    rig.fake.failures = {};
    await until(() => rig.fake.nozzle.target === 0, 2000, "cool-down after reconnect");
  });

  it("dispose() stops the timer", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup, { heaterIdleTimeoutMs: 80 });
    await c.setBedTemp(50, heat);
    c.dispose();
    expect(c.heaterSafety().armed).toBe(false);
    await sleep(200);
    expect(rig.fake.bed.target).toBe(50);
  });

  it("rejects a non-positive timeout", async () => {
    const rig = await startRig({}, cleanup);
    expect(() => rig.controller({ heaterIdleTimeoutMs: 0 })).toThrow(/heaterIdleTimeoutMs/);
  });
});

describe("rate limiting and debouncing", () => {
  it("rejects a repeated command inside minCommandIntervalMs, then allows it", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup, { minCommandIntervalMs: 300 });
    expect((await c.setLight(false, { requestedBy: "touch" })).confirmed).toBe(true);
    const err = await c.setLight(true, { requestedBy: "touch" }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterMs).toBeGreaterThan(0);
    expect(err.retryAfterMs).toBeLessThanOrEqual(300);
    expect(rig.log.at(-1)).toMatchObject({ op: "light", outcome: "rejected", requestedBy: "touch" });
    // other commands have their own interval
    expect((await c.setFan(20, { requestedBy: "touch" })).acknowledged).toBe(true);
    await sleep(320);
    expect((await c.setLight(true, { requestedBy: "touch" })).confirmed).toBe(true);
    expect(machineSent(rig.fake.received)).toEqual(["M146 r0 g0 b0 F0", "M106 S51", "M146 r255 g255 b255 F0"]);
  });

  it("identical taps while one is running share its result; a different request is refused", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup, { minCommandIntervalMs: 0 });
    const a = c.setLight(false, { requestedBy: "touch" });
    const b = c.setLight(false, { requestedBy: "voice" });
    await expect(c.setLight(true, { requestedBy: "touch" })).rejects.toThrow(/already in progress/);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    expect(machineSent(rig.fake.received)).toEqual(["M146 r0 g0 b0 F0"]);
    expect(rig.log.filter((e) => e.op === "light").map((e) => e.outcome)).toEqual(["rejected", "confirmed"]);
  });

  it("never debounces cancel, cool-down or emergency stop", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup, { minCommandIntervalMs: 10_000 });
    for (let i = 0; i < 2; i++) {
      expect((await c.coolDown({ requestedBy: "touch" })).confirmed).toBe(true);
      expect((await c.cancel({ requestedBy: "touch" })).confirmed).toBe(true);
      expect((await c.emergencyStop({ requestedBy: "touch" })).confirmed).toBe(true);
    }
    expect(machineSent(rig.fake.received).filter((x) => x === "M26")).toHaveLength(4);
  });

  it("debounces heating per heater", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup, { minCommandIntervalMs: 10_000 });
    await c.setNozzleTemp(200, heat);
    await expect(c.setNozzleTemp(210, heat)).rejects.toThrow(RateLimitedError);
    expect((await c.setBedTemp(60, heat)).confirmed).toBe(true);
  });
});

describe("emergency stop", () => {
  it("cancels the print and turns the heaters off (no M112 by default), even with temperatures disabled", async () => {
    const rig = await startRig({}, cleanup);
    const c = rig.controller({ minCommandIntervalMs: 0 }); // no allowUnverified at all
    cleanup(async () => c.dispose());
    const t = rig.auth.authorize({ jobId: "j", fileName: "Afinia_Cube.gx", approvedBy: "touch" });
    expect((await c.startPrint({ jobId: "j", fileName: "Afinia_Cube.gx", authorization: t })).confirmed).toBe(true);
    expect([rig.fake.nozzle.target, rig.fake.bed.target]).toEqual([210, 50]);

    const r = await c.emergencyStop({ requestedBy: "voice", reason: "user shouted stop" });
    expect(r).toMatchObject({ op: "emergencyStop", sent: true, acknowledged: true, confirmed: true, protocolVerified: false, data: { m112: false } });
    expect(r.data?.steps.map((s) => [s.command, s.acknowledged])).toEqual([
      ["M26", true],
      ["M104 S0 T0", true],
      ["M140 S0", true],
    ]);
    expect(rig.fake.machineStatus).toBe("READY");
    expect([rig.fake.nozzle.target, rig.fake.bed.target]).toEqual([0, 0]);
    expect(machineSent(rig.fake.received)).not.toContain("M112");
    expect(rig.log.at(-1)).toMatchObject({ op: "emergencyStop", outcome: "confirmed", requestedBy: "voice", reason: "user shouted stop", command: "M26; M104 S0 T0; M140 S0" });
  });

  it("sends M112 first only behind its own flag, and survives M112 dropping the link", async () => {
    const rig = await startRig({ failures: { dropAfterM112: true } }, cleanup);
    const c = machineController(rig, cleanup, { allowUnverified: { emergencyStopM112: true } });
    rig.fake.machineStatus = "BUILDING_FROM_SD";
    const r = await c.emergencyStop({ requestedBy: "touch" });
    expect(r.data?.m112).toBe(true);
    expect(machineSent(rig.fake.received)).toEqual(["M112", "M26", "M104 S0 T0", "M140 S0"]);
    expect(rig.fake.emergencyHalted).toBe(true);
    expect(r.confirmed).toBe(true);
    // M112 is still not available on its own and the other flags stay off
    expect(c.allowUnverified).toEqual({ emergencyStopM112: true });
  });

  it("reports which steps failed and is not confirmed when the printer keeps going", async () => {
    const rig = await startRig({ failures: { ignoreCancel: true, rejectVerbs: ["M140"] } }, cleanup);
    const c = machineController(rig, cleanup);
    rig.fake.machineStatus = "BUILDING_FROM_SD";
    rig.fake.setTemp("bed", 50, 50);
    const r = await c.emergencyStop({ requestedBy: "touch" });
    expect(r).toMatchObject({ sent: true, acknowledged: false, confirmed: false });
    expect(r.error).toMatch(/M140 S0: not accepted/);
    expect(r.error).toMatch(/did not become READY with heater targets 0/);
    expect(r.note).toMatch(/printer's own screen or power switch/);
    expect(rig.log.at(-1)?.outcome).toBe("failed");
  });

  it("duplicate taps share one run", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup);
    const [a, b] = await Promise.all([c.emergencyStop({ requestedBy: "touch" }), c.emergencyStop({ requestedBy: "voice" })]);
    expect(a).toBe(b);
    expect(machineSent(rig.fake.received).filter((x) => x === "M26")).toHaveLength(1);
  });

  it("interrupts a running confirmation wait and drops commands queued before it", async () => {
    const rig = await startRig({ homeDurationMs: 5000 }, cleanup);
    rig.fake.position = { x: 0, y: 0, z: 0 };
    const c = machineController(rig, cleanup, { homeConfirmTimeoutMs: 10_000 });
    const started = Date.now();
    const homing = c.home({ requestedBy: "touch" });
    const fan = c.setFan(100, { requestedBy: "touch" });
    await until(() => rig.fake.received.includes("G28"), 1000, "G28");
    const stop = c.emergencyStop({ requestedBy: "touch" });
    const [h, f, s] = await Promise.all([homing, fan, stop]);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(h).toMatchObject({ sent: true, confirmed: false });
    expect(h.error).toMatch(/emergency stop requested/);
    expect(f).toMatchObject({ sent: false, confirmed: false });
    expect(f.error).toMatch(/emergency stop was requested before fan/);
    expect(s.acknowledged).toBe(true);
    expect(machineSent(rig.fake.received)).toEqual(["G28", "M26", "M104 S0 T0", "M140 S0"]);
    // later commands run normally
    expect((await c.setLight(false, { requestedBy: "touch" })).confirmed).toBe(true);
  });

  it("disarms the heater timer", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup);
    await c.setNozzleTemp(200, heat);
    expect(c.heaterSafety().armed).toBe(true);
    await c.emergencyStop({ requestedBy: "touch" });
    expect(c.heaterSafety().armed).toBe(false);
  });
});

describe("capabilities()", () => {
  const byName = (caps: CommandCapability[]) => Object.fromEntries(caps.map((c) => [c.command, c]));

  it("lists every command with G-code, verified status and flag", async () => {
    const rig = await startRig({}, cleanup);
    const caps = byName(rig.controller({ enabled: false }).capabilities());
    expect(Object.keys(caps)).toEqual(COMMAND_SPECS.map((s) => s.command));
    expect(caps.home).toMatchObject({ gcode: ["G28"], protocolVerified: true });
    expect(caps.home.flag).toBeUndefined();
    expect(caps.cancel.protocolVerified).toBe(true);
    for (const [cmd, flag] of [["setLight", "light"], ["setFan", "fan"], ["setNozzleTemp", "temperatures"], ["setBedTemp", "temperatures"], ["coolDown", "temperatures"], ["motorsOff", "motors"]] as const) {
      expect(caps[cmd]).toMatchObject({ protocolVerified: false, flag });
    }
    expect(caps.pause.protocolVerified).toBe(false);
    expect(caps.emergencyStop.protocolVerified).toBe(false);
    // disabled controller: only read-only commands are enabled
    expect(Object.values(caps).filter((c) => c.enabled).map((c) => c.command)).toEqual(["readStatus", "readInfo"]);
    expect(caps.home.reason).toMatch(/disabled/);
  });

  it("reflects flags and the printer state", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup, { allowUnverified: { light: true } });
    // status not read yet
    let caps = byName(c.capabilities());
    expect(caps.home).toMatchObject({ enabled: true, allowedNow: false, reason: expect.stringMatching(/not known/) });
    expect(caps.cancel.allowedNow).toBe(true);
    expect(caps.emergencyStop.allowedNow).toBe(true);
    expect(caps.setFan).toMatchObject({ enabled: false, allowedNow: false, reason: expect.stringMatching(/allowUnverified\.fan/) });

    await c.readStatus();
    caps = byName(c.capabilities());
    expect(caps.home.allowedNow).toBe(true);
    expect(caps.setLight.allowedNow).toBe(true);
    expect(caps.startPrint.allowedNow).toBe(true);
    expect(caps.pause.allowedNow).toBe(false);

    rig.fake.machineStatus = "BUILDING_FROM_SD";
    await c.readStatus();
    caps = byName(c.capabilities());
    expect(caps.home).toMatchObject({ allowedNow: false, reason: expect.stringMatching(/refused while printing/) });
    expect(caps.pause.allowedNow).toBe(true);
    expect(caps.setLight.allowedNow).toBe(true);
    expect(caps.startPrint.allowedNow).toBe(false);

    // an explicit status wins over the cached one
    expect(byName(c.capabilities({ online: false, checkedAt: "", error: "timeout" })).home.reason).toMatch(/offline: timeout/);
  });

  it("temperature commands follow the print and cancel window", async () => {
    const rig = await startRig({ failures: { ignoreCancel: true } }, cleanup);
    const c = machineController(rig, cleanup);
    rig.fake.machineStatus = "BUILDING_FROM_SD";
    await c.readStatus();
    let caps = byName(c.capabilities());
    expect(caps.setNozzleTemp.allowedNow).toBe(false);
    expect(caps.coolDown.allowedNow).toBe(false);
    await c.cancel({ requestedBy: "touch" });
    caps = byName(c.capabilities());
    expect(caps.coolDown.allowedNow).toBe(true); // just cancelled
    expect(caps.setNozzleTemp).toMatchObject({ allowedNow: false, reason: expect.stringMatching(/heating needs READY/) });
  });

  it("shows debounce and in-progress state", async () => {
    const rig = await startRig({ homeDurationMs: 150 }, cleanup);
    rig.fake.position = { x: 0, y: 0, z: 0 };
    const c = machineController(rig, cleanup, { minCommandIntervalMs: 5000 });
    await c.readStatus();
    const homing = c.home({ requestedBy: "touch" });
    expect(byName(c.capabilities()).home.reason).toBe("already in progress");
    await homing;
    expect(byName(c.capabilities()).home.reason).toMatch(/try again in \d+ ms/);
  });

  it("observer polls through controller.transport keep the cached state current", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup);
    rig.fake.machineStatus = "BUILDING_FROM_SD";
    await c.transport.query(["M119", "M105", "M114", "M27"]);
    expect(byName(c.capabilities()).pause.allowedNow).toBe(true);
  });
});
