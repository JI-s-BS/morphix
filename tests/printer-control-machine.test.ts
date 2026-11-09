import { describe, expect, it } from "vitest";
import {
  CommandDisabledError,
  ControlLimitError,
  ControllerDisabledError,
  HeaterApprovalError,
  QD330Controller,
  fanCommand,
  lightCommand,
  normalizeFan,
  normalizeLight,
  normalizeTemp,
  parseLed,
} from "@morphix/printer";
import { GX, guardLoopbackOnly, startRig, useCleanup } from "./phase5-helpers";
import { machineController, machineSent } from "./printer-control-helpers";

guardLoopbackOnly();
const cleanup = useCleanup();

describe("machine controls: switches", () => {
  it("every machine command throws ControllerDisabledError on a disabled controller and sends nothing", async () => {
    const rig = await startRig({}, cleanup);
    const c = rig.controller({ enabled: false, allowUnverified: { light: true, fan: true, temperatures: true, motors: true } });
    const by = { requestedBy: "touch" as const };
    await expect(c.home(by)).rejects.toThrow(ControllerDisabledError);
    await expect(c.setLight(true, by)).rejects.toThrow(ControllerDisabledError);
    await expect(c.setFan(50, by)).rejects.toThrow(ControllerDisabledError);
    await expect(c.setNozzleTemp(200, { ...by, approvedBy: "touch" })).rejects.toThrow(ControllerDisabledError);
    await expect(c.setBedTemp(60, { ...by, approvedBy: "touch" })).rejects.toThrow(ControllerDisabledError);
    await expect(c.coolDown(by)).rejects.toThrow(ControllerDisabledError);
    await expect(c.motorsOff(by)).rejects.toThrow(ControllerDisabledError);
    await expect(c.emergencyStop(by)).rejects.toThrow(ControllerDisabledError);
    expect(rig.fake.received).toEqual([]);
    expect(rig.log).toHaveLength(8);
    expect(rig.log.every((e) => e.outcome === "rejected" && e.requestedBy === "touch")).toBe(true);
  });

  it("unverified commands need their own allowUnverified flag; the error says which", async () => {
    const rig = await startRig({}, cleanup);
    const c = rig.controller({ allowUnverified: { light: true } });
    const by = { requestedBy: "portal" as const };
    const flagOf = (p: Promise<unknown>) => p.then(() => "none", (e: CommandDisabledError) => (e instanceof CommandDisabledError ? e.flag : String(e)));
    expect(await flagOf(c.setFan(true, by))).toBe("fan");
    expect(await flagOf(c.setNozzleTemp(200, { ...by, approvedBy: "portal" }))).toBe("temperatures");
    expect(await flagOf(c.setBedTemp(0, by))).toBe("temperatures");
    expect(await flagOf(c.coolDown(by))).toBe("temperatures");
    expect(await flagOf(c.motorsOff(by))).toBe("motors");
    await expect(c.setFan(true, by)).rejects.toThrow(ControllerDisabledError); // subclass, so UIs can treat both alike
    await expect(c.motorsOff(by)).rejects.toThrow(/allowUnverified\.motors = true/);
    expect(machineSent(rig.fake.received)).toEqual([]);

    // the enabled flag and the verified command work
    expect((await c.setLight(false, by)).confirmed).toBe(true);
    expect((await c.home(by)).confirmed).toBe(true);
    expect(machineSent(rig.fake.received)).toEqual(["M146 r0 g0 b0 F0", "G28"]);
    expect(Object.isFrozen(c.allowUnverified)).toBe(true);
  });

  it("requires requestedBy on every machine command", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup);
    await expect(c.home(undefined as never)).rejects.toThrow(/requestedBy/);
    await expect(c.setLight(true, { requestedBy: "someone" } as never)).rejects.toThrow(/requestedBy/);
    await expect(c.emergencyStop({} as never)).rejects.toThrow(/requestedBy/);
    expect(rig.fake.received).toEqual([]);
  });
});

describe("readInfo (M115)", () => {
  it("returns parsed machine info, works while disabled, and is logged", async () => {
    const rig = await startRig({}, cleanup);
    const c = rig.controller({ enabled: false });
    const r = await c.readInfo({ requestedBy: "portal" });
    expect(r).toMatchObject({ op: "info", sent: true, acknowledged: true, confirmed: true, protocolVerified: true });
    expect(r.data).toMatchObject({ machineType: "Afinia 3D QD330", firmware: "v2.1.3", serial: "SNFAKE0000001" });
    expect(r.data?.raw).toMatch(/Tool Count: 1/);
    expect(rig.fake.received).toEqual(["M601 S1", "M115", "M602"]);
    expect(rig.log.at(-1)).toMatchObject({ op: "info", outcome: "confirmed", requestedBy: "portal", command: "M115" });
  });

  it("reports an unreachable printer as an error result", async () => {
    const rig = await startRig({}, cleanup);
    const c = rig.controller();
    await rig.fake.close();
    const r = await c.readInfo();
    expect(r).toMatchObject({ sent: false, confirmed: false });
    expect(r.error).toMatch(/cannot reach printer/);
  });
});

describe("home (G28, verified)", () => {
  it("homes from READY and confirms from M114 + MoveMode", async () => {
    const rig = await startRig({ homeDurationMs: 80 }, cleanup);
    rig.fake.position = { x: 20, y: 30, z: 5 };
    const c = machineController(rig, cleanup);
    const r = await c.home({ requestedBy: "voice", reason: "user asked" });
    expect(r).toMatchObject({ op: "home", sent: true, acknowledged: true, confirmed: true, protocolVerified: true, data: { alreadyHome: false } });
    expect(r.status?.position).toEqual({ x: 110, y: 110, z: 220 });
    expect(r.note).toBeUndefined();
    expect(rig.fake.homeCount).toBe(1);
    expect(rig.log.at(-1)).toMatchObject({ op: "home", outcome: "confirmed", requestedBy: "voice", reason: "user asked", command: "G28" });
  });

  it("says so when the head was already home", async () => {
    const rig = await startRig({}, cleanup);
    const r = await machineController(rig, cleanup).home({ requestedBy: "touch" });
    expect(r).toMatchObject({ confirmed: true, data: { alreadyHome: true } });
    expect(r.note).toMatch(/already at the home position/);
  });

  it("is refused while printing, paused or moving", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup);
    for (const [machine, move, why] of [
      ["BUILDING_FROM_SD", "MOVING", /refused while printing/],
      ["PAUSED", "READY", /refused while printing/],
      ["READY", "MOVING", /moving/],
    ] as const) {
      rig.fake.machineStatus = machine;
      rig.fake.moveMode = move;
      const r = await c.home({ requestedBy: "touch" });
      expect(r).toMatchObject({ sent: false, acknowledged: false, confirmed: false });
      expect(r.error).toMatch(why);
    }
    expect(machineSent(rig.fake.received)).toEqual([]);
    expect(rig.log.map((e) => e.outcome)).toEqual(["failed", "failed", "failed"]);
  });

  it("is not confirmed when the printer ignores it", async () => {
    const rig = await startRig({ failures: { ignoreHome: true } }, cleanup);
    rig.fake.position = { x: 1, y: 2, z: 3 };
    const r = await machineController(rig, cleanup, { homeConfirmTimeoutMs: 200 }).home({ requestedBy: "touch" });
    expect(r).toMatchObject({ sent: true, acknowledged: true, confirmed: false });
    expect(r.error).toMatch(/did not become homed at X110 Y110 Z220.*X1 Y2 Z3/);
  });
});

describe("setLight (M146, unverified)", () => {
  it("turns the light off and on, sets a colour, and confirms from M119 LED", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup);
    const off = await c.setLight(false, { requestedBy: "touch" });
    expect(off).toMatchObject({ op: "light", sent: true, acknowledged: true, confirmed: true, protocolVerified: false, data: { on: false, led: false } });
    expect(rig.fake.led).toBe(false);
    const red = await c.setLight({ r: 255, g: 0, b: 0 }, { requestedBy: "voice" });
    expect(red).toMatchObject({ confirmed: true, data: { color: { r: 255, g: 0, b: 0 }, on: true, led: true } });
    expect(rig.fake.ledColor).toEqual({ r: 255, g: 0, b: 0 });
    expect(machineSent(rig.fake.received)).toEqual(["M146 r0 g0 b0 F0", "M146 r255 g0 b0 F0"]);
    expect(rig.log.at(-1)).toMatchObject({ op: "light", requestedBy: "voice", command: "M146 r255 g0 b0 F0", outcome: "confirmed" });
  });

  it("is allowed while printing", async () => {
    const rig = await startRig({}, cleanup);
    rig.fake.machineStatus = "BUILDING_FROM_SD";
    expect((await machineController(rig, cleanup).setLight(false, { requestedBy: "touch" })).confirmed).toBe(true);
  });

  it("rejects bad colours before sending", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup);
    await expect(c.setLight({ r: 256, g: 0, b: 0 }, { requestedBy: "touch" })).rejects.toThrow(ControlLimitError);
    await expect(c.setLight({ r: 1.5, g: 0, b: 0 }, { requestedBy: "touch" })).rejects.toThrow(/integer 0-255/);
    await expect(c.setLight("on" as never, { requestedBy: "touch" })).rejects.toThrow(ControlLimitError);
    expect(rig.fake.received).toEqual([]);
    expect(rig.log.map((e) => e.outcome)).toEqual(["rejected", "rejected", "rejected"]);
  });

  it("is not confirmed when the LED does not change or is not reported", async () => {
    const rig = await startRig({ failures: { ignoreLight: true } }, cleanup);
    const c = machineController(rig, cleanup);
    const ignored = await c.setLight(false, { requestedBy: "touch" });
    expect(ignored).toMatchObject({ acknowledged: true, confirmed: false });
    expect(ignored.error).toMatch(/LED: 0.*last: LED: 1/);
    rig.fake.failures = { noLedInM119: true };
    const unknown = await c.setLight(false, { requestedBy: "touch" });
    expect(unknown).toMatchObject({ acknowledged: true, confirmed: false });
    expect(unknown.error).toMatch(/no "LED:" line/);
    rig.fake.failures = { rejectVerbs: ["M146"] };
    const rejected = await c.setLight(false, { requestedBy: "touch" });
    expect(rejected).toMatchObject({ sent: true, acknowledged: false, confirmed: false });
    expect(rejected.error).toMatch(/did not accept M146/);
  });
});

describe("setFan (M106/M107, unverified)", () => {
  it("sets speed in percent, turns off with M107, and never claims confirmation", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup);
    const half = await c.setFan(50, { requestedBy: "portal" });
    expect(half).toMatchObject({ op: "fan", sent: true, acknowledged: true, confirmed: false, protocolVerified: false, data: { percent: 50 } });
    expect(half.note).toMatch(/does not report fan speed/);
    expect(half.error).toBeUndefined();
    expect(rig.fake.fanPercent).toBe(50);
    await c.setFan(true, { requestedBy: "touch" });
    expect(rig.fake.fanPwm).toBe(255);
    await c.setFan(false, { requestedBy: "touch" });
    expect(rig.fake.fanPwm).toBe(0);
    expect(machineSent(rig.fake.received)).toEqual(["M106 S128", "M106 S255", "M107"]);
    expect(rig.log.map((e) => e.outcome)).toEqual(["unconfirmed", "unconfirmed", "unconfirmed"]);
  });

  it("rejects speeds outside 0-100", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup);
    await expect(c.setFan(101, { requestedBy: "touch" })).rejects.toThrow(ControlLimitError);
    await expect(c.setFan(-1, { requestedBy: "touch" })).rejects.toThrow(/0-100/);
    await expect(c.setFan(Number.NaN, { requestedBy: "touch" })).rejects.toThrow(ControlLimitError);
    expect(rig.fake.received).toEqual([]);
  });
});

describe("temperatures (M104/M140, unverified)", () => {
  it("heats the nozzle and bed with approval and confirms from the M105 targets", async () => {
    const rig = await startRig({ heatRatePerSec: 500 }, cleanup);
    const c = machineController(rig, cleanup);
    const n = await c.setNozzleTemp(200, { requestedBy: "voice", approvedBy: "voice" });
    expect(n).toMatchObject({ op: "nozzleTemp", sent: true, acknowledged: true, confirmed: true, protocolVerified: false, data: { heater: "nozzle", target: 200 } });
    expect(n.status?.temps?.nozzle?.target).toBe(200);
    const b = await c.setBedTemp(60.4, { requestedBy: "portal", approvedBy: "portal" });
    expect(b).toMatchObject({ op: "bedTemp", confirmed: true, data: { target: 60 } });
    expect(machineSent(rig.fake.received)).toEqual(["M104 S200 T0", "M140 S60"]);
    expect(rig.log.at(-1)).toMatchObject({ op: "bedTemp", approvedBy: "portal", requestedBy: "portal", command: "M140 S60" });
    // the fake heats over time
    await new Promise((r) => setTimeout(r, 400));
    const st = await c.readStatus();
    expect(st.temps?.nozzle).toEqual({ current: 200, target: 200 });
    expect(st.temps?.bed).toEqual({ current: 60, target: 60 });
    expect(c.heaterSafety()).toMatchObject({ armed: true, targets: { nozzle: 200, bed: 60 } });
  });

  it("refuses heating without an explicit approvedBy, and values outside the hard limits", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup);
    await expect(c.setNozzleTemp(200, { requestedBy: "voice" })).rejects.toThrow(HeaterApprovalError);
    await expect(c.setBedTemp(50, { requestedBy: "guardian", approvedBy: "gemini" as never })).rejects.toThrow(HeaterApprovalError);
    await expect(c.setNozzleTemp(251, { requestedBy: "touch", approvedBy: "touch" })).rejects.toThrow(ControlLimitError);
    await expect(c.setNozzleTemp(-1, { requestedBy: "touch", approvedBy: "touch" })).rejects.toThrow(/0-250/);
    await expect(c.setBedTemp(101, { requestedBy: "touch", approvedBy: "touch" })).rejects.toThrow(/0-100/);
    await expect(c.setBedTemp(Number.POSITIVE_INFINITY, { requestedBy: "touch", approvedBy: "touch" })).rejects.toThrow(ControlLimitError);
    expect(rig.fake.received).toEqual([]);
    expect(rig.log.every((e) => e.outcome === "rejected")).toBe(true);
    expect(c.heaterSafety().armed).toBe(false);
    // 0 °C needs no approval
    expect((await c.setNozzleTemp(0, { requestedBy: "system" })).confirmed).toBe(true);
  });

  it("limits can be lowered but not raised", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup, { maxNozzleC: 220, maxBedC: 70 });
    await expect(c.setNozzleTemp(230, { requestedBy: "touch", approvedBy: "touch" })).rejects.toThrow(/0-220/);
    await expect(c.setBedTemp(80, { requestedBy: "touch", approvedBy: "touch" })).rejects.toThrow(/0-70/);
    expect(() => rig.controller({ maxNozzleC: 300 })).toThrow(/maxNozzleC/);
    expect(() => rig.controller({ maxBedC: 120 })).toThrow(/maxBedC/);
  });

  it("refuses to change temperatures during a print", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup);
    for (const machine of ["BUILDING_FROM_SD", "PAUSED"]) {
      rig.fake.machineStatus = machine;
      const heat = await c.setNozzleTemp(180, { requestedBy: "touch", approvedBy: "touch" });
      expect(heat).toMatchObject({ sent: false, confirmed: false });
      expect(heat.error).toMatch(/not changed during a print/);
      const cool = await c.coolDown({ requestedBy: "touch" });
      expect(cool).toMatchObject({ sent: false, confirmed: false });
      expect(cool.error).toMatch(/cancel it first/);
      expect((await c.setBedTemp(0, { requestedBy: "touch" })).sent).toBe(false);
    }
    expect(machineSent(rig.fake.received)).toEqual([]);
    expect(c.heaterSafety().armed).toBe(false);
  });

  it("allows cooling right after a cancel even if the printer still reports the print", async () => {
    const rig = await startRig({ failures: { ignoreCancel: true } }, cleanup);
    const c = machineController(rig, cleanup);
    rig.fake.machineStatus = "BUILDING_FROM_SD";
    rig.fake.setTemp("nozzle", 210, 210);
    const cancel = await c.cancel({ requestedBy: "touch" });
    expect(cancel.confirmed).toBe(false); // printer ignored it
    const cool = await c.coolDown({ requestedBy: "touch", reason: "after cancel" });
    expect(cool).toMatchObject({ sent: true, acknowledged: true, confirmed: true });
    expect(rig.fake.nozzle.target).toBe(0);
    // heating is still refused
    expect((await c.setNozzleTemp(200, { requestedBy: "touch", approvedBy: "touch" })).error).toMatch(/during a print/);
  });

  it("the cancel window expires", async () => {
    const rig = await startRig({ failures: { ignoreCancel: true } }, cleanup);
    const c = machineController(rig, cleanup, { cancelCoolDownWindowMs: 50 });
    rig.fake.machineStatus = "BUILDING_FROM_SD";
    await c.cancel({ requestedBy: "touch" });
    await new Promise((r) => setTimeout(r, 80));
    expect((await c.coolDown({ requestedBy: "touch" })).error).toMatch(/cancel it first/);
  });

  it("heating needs READY (not an unknown state)", async () => {
    const rig = await startRig({}, cleanup);
    rig.fake.machineStatus = "BUSY";
    const r = await machineController(rig, cleanup).setNozzleTemp(150, { requestedBy: "touch", approvedBy: "touch" });
    expect(r).toMatchObject({ sent: false });
    expect(r.error).toMatch(/needs READY/);
  });

  it("coolDown sets both targets to 0 and disarms the safety timer", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup);
    await c.setNozzleTemp(180, { requestedBy: "touch", approvedBy: "touch" });
    await c.setBedTemp(50, { requestedBy: "touch", approvedBy: "touch" });
    expect(c.heaterSafety().armed).toBe(true);
    const r = await c.coolDown({ requestedBy: "voice" });
    expect(r).toMatchObject({ op: "coolDown", sent: true, acknowledged: true, confirmed: true, protocolVerified: false });
    expect([rig.fake.nozzle.target, rig.fake.bed.target]).toEqual([0, 0]);
    expect(machineSent(rig.fake.received).slice(-2)).toEqual(["M104 S0 T0", "M140 S0"]);
    expect(c.heaterSafety()).toMatchObject({ armed: false, targets: { nozzle: 0, bed: 0 } });
  });

  it("setting one heater to 0 keeps the timer while the other is on", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup);
    await c.setNozzleTemp(180, { requestedBy: "touch", approvedBy: "touch" });
    await c.setBedTemp(50, { requestedBy: "touch", approvedBy: "touch" });
    await c.setNozzleTemp(0, { requestedBy: "touch" });
    expect(c.heaterSafety()).toMatchObject({ armed: true, targets: { nozzle: 0, bed: 50 } });
    await c.setBedTemp(0, { requestedBy: "touch" });
    expect(c.heaterSafety().armed).toBe(false);
  });

  it("is not confirmed when the printer ignores the target", async () => {
    const rig = await startRig({ failures: { ignoreTemps: true } }, cleanup);
    const c = machineController(rig, cleanup);
    const r = await c.setNozzleTemp(190, { requestedBy: "touch", approvedBy: "touch" });
    expect(r).toMatchObject({ sent: true, acknowledged: true, confirmed: false });
    expect(r.error).toMatch(/nozzle target 190 °C.*nozzle 26.9\/0 °C/);
    expect(c.heaterSafety().armed).toBe(true); // the heater might still be on: the timer stays armed
  });
});

describe("motorsOff (M18, unverified)", () => {
  it("disables motors from READY, acknowledged only", async () => {
    const rig = await startRig({}, cleanup);
    const r = await machineController(rig, cleanup).motorsOff({ requestedBy: "portal" });
    expect(r).toMatchObject({ op: "motorsOff", sent: true, acknowledged: true, confirmed: false, protocolVerified: false });
    expect(r.note).toMatch(/does not report motor state/);
    expect(rig.fake.motorsEnabled).toBe(false);
    expect(rig.log.at(-1)).toMatchObject({ op: "motorsOff", outcome: "unconfirmed", requestedBy: "portal", command: "M18" });
  });

  it("is refused while printing", async () => {
    const rig = await startRig({}, cleanup);
    const c = machineController(rig, cleanup);
    const t = rig.auth.authorize({ jobId: "j", fileName: "Afinia_Cube.gx", approvedBy: "touch" });
    expect((await c.startPrint({ jobId: "j", fileName: "Afinia_Cube.gx", authorization: t })).confirmed).toBe(true);
    const r = await c.motorsOff({ requestedBy: "touch" });
    expect(r).toMatchObject({ sent: false, confirmed: false });
    expect(r.error).toMatch(/refused while printing/);
    expect(rig.fake.motorsEnabled).toBe(true);
  });
});

describe("pure helpers", () => {
  it("build the expected commands", () => {
    expect(lightCommand(normalizeLight(true))).toBe("M146 r255 g255 b255 F0");
    expect(lightCommand(normalizeLight({ r: 0, g: 10, b: 20 }))).toBe("M146 r0 g10 b20 F0");
    expect(fanCommand(normalizeFan(0))).toBe("M107");
    expect(fanCommand(normalizeFan(100))).toBe("M106 S255");
    expect(fanCommand(normalizeFan(33.3))).toBe("M106 S84");
    expect(normalizeTemp(199.6, 250, "nozzle")).toBe(200);
    expect(() => normalizeTemp("200", 250, "nozzle")).toThrow(ControlLimitError);
    expect(parseLed("MachineStatus: READY\nLED: 0")).toBe(false);
    expect(parseLed("LED: 1")).toBe(true);
    expect(parseLed("MachineStatus: READY")).toBeUndefined();
  });

  it("the fake keeps the recorded M105/M114 lines until something changes", async () => {
    const rig = await startRig({ files: { "x.gx": GX } }, cleanup);
    const r = await rig.controller({ enabled: false }).transport.query(["M105", "M114"]);
    expect(r).toEqual({ M105: "T0:26.9/0.0 T1:0.0/0.0 B:24.4/0.0", M114: "X:110.037 Y:110.037 Z:220.000 A:0.000 B:0" });
  });

  it("a controller pointed at a real address never connects in tests", async () => {
    const c = new QD330Controller({ enabled: true, host: "192.0.2.1", connectTimeoutMs: 10, allowUnverified: { light: true } });
    const r = await c.setLight(true, { requestedBy: "touch" });
    expect(r).toMatchObject({ sent: false, error: expect.stringMatching(/real host/) });
    c.dispose();
  });
});
