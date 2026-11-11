// The active-printer seam: config → getDriver(id).connect(...), QD330 fallback, status mapping
// and state-checked controls, with a fake driver (no network).
import { describe, expect, it } from "vitest";
import { findPrinter } from "@morphix/catalog";
import type { MorphixConfig } from "@morphix/config";
import type { DriverCapabilities, DriverConfig, DriverStatus, PrinterConnection, PrinterDriver } from "@morphix/printer";
import { DriverControl, DriverObserver, resolveActivePrinter, toPrinterStatus } from "../apps/server/src/printers";
import { DEFAULT_CONFIG, loadSetupModule } from "../apps/server/src/setup-module";

class FakeConnection implements PrinterConnection {
  readonly driver = "moonraker" as const;
  calls: string[] = [];
  state: DriverStatus = { state: "idle", checkedAt: "2026-01-01T00:00:00Z" };
  caps: DriverCapabilities = { fileFormats: ["gcode"], upload: true, startPrint: true, pause: true, resume: true, cancel: true, setTemperature: true, gcodeConsole: false, camera: { kind: "mjpeg", url: "http://10.0.0.5/webcam/?action=stream" } };
  constructor(readonly config: DriverConfig) {}
  capabilities() { return this.caps; }
  async test() { return { ok: true as const, info: { model: "Voron", firmware: "Klipper 0.12", name: "garage" } }; }
  async status() { this.calls.push("status"); return this.state; }
  async upload() { this.calls.push("upload"); }
  async start(f: string) { this.calls.push(`start ${f}`); }
  async pause() { this.calls.push("pause"); }
  async resume() { this.calls.push("resume"); }
  async cancel() { this.calls.push("cancel"); }
  async setTemperature(h: "nozzle" | "bed", c: number) { this.calls.push(`temp ${h} ${c}`); }
  async close() { this.calls.push("close"); }
}

let last: FakeConnection | null = null;
const fakeDriver: PrinterDriver = {
  id: "moonraker",
  name: "Fake Moonraker",
  description: "test",
  fields: [
    { key: "host", label: "Host", kind: "host", required: true },
    { key: "apiKey", label: "API key", kind: "secret", required: false },
  ],
  connect: (config) => (last = new FakeConnection(config)),
};
const lookup = (id: string) => (id === "moonraker" ? fakeDriver : undefined);

const cfg = (over: Partial<MorphixConfig>): MorphixConfig => ({ ...structuredClone(DEFAULT_CONFIG), ...over });
const garage = { id: "p1", name: "Garage", modelId: "afinia-qd330", driver: "moonraker" as const, connection: { host: "10.0.0.5", port: 7125 } };

describe("resolveActivePrinter", () => {
  it("falls back to the QD330 path when nothing is configured", async () => {
    expect(await resolveActivePrinter(null, null, { lookup })).toMatchObject({ kind: "qd330", reason: "no printer configured" });
    expect(await resolveActivePrinter(cfg({ printers: [] }), null, { lookup })).toMatchObject({ kind: "qd330" });
  });

  it("uses the active printer and adds its secrets from the store", async () => {
    const other = { ...garage, id: "p2", name: "Other" };
    const store = { getSecret: async (k: string) => (k === "printer:p1:apiKey" ? "k-123" : undefined) };
    const a = await resolveActivePrinter(cfg({ printers: [other, garage], activePrinterId: "p1" }), store, { lookup });
    expect(a.kind).toBe("driver");
    expect(last!.config).toEqual({ host: "10.0.0.5", port: 7125, apiKey: "k-123" });
  });

  it("picks the only printer when none is marked active, else falls back", async () => {
    expect((await resolveActivePrinter(cfg({ printers: [garage] }), null, { lookup })).kind).toBe("driver");
    expect(await resolveActivePrinter(cfg({ printers: [garage, { ...garage, id: "p2" }] }), null, { lookup })).toMatchObject({ kind: "qd330", reason: "no active printer chosen" });
  });

  it("falls back with a reason when the driver isn't in this build", async () => {
    const a = await resolveActivePrinter(cfg({ printers: [{ ...garage, driver: "bambu-lan" }] }), null, { lookup });
    expect(a).toMatchObject({ kind: "qd330", reason: "driver bambu-lan is not available in this build" });
  });
});

describe("driver status", () => {
  it("maps DriverStatus to the PrinterStatus the UI shows", () => {
    expect(toPrinterStatus({ state: "printing", checkedAt: "t", temps: { nozzle: { actual: 210, target: 215 }, bed: { actual: 60 } }, job: { file: "a.gcode", progress: 0.42, layer: [3, 90] } })).toEqual({
      online: true, checkedAt: "t", machine: "PRINTING", currentFile: "a.gcode", progress: 42, layer: [3, 90],
      temps: { nozzle: { current: 210, target: 215 }, bed: { current: 60, target: 0 } },
    });
    expect(toPrinterStatus({ state: "offline", checkedAt: "t", message: "no route to host" })).toMatchObject({ online: false, error: "no route to host" });
  });

  it("the observer reports every poll and survives a throwing driver", async () => {
    const conn = new FakeConnection({});
    const seen: string[] = [];
    const obs = new DriverObserver(conn, (s) => seen.push(s.machine ?? s.error ?? "?"));
    await obs.poll();
    conn.status = async () => {
      throw new Error("socket hang up");
    };
    await obs.poll();
    expect(seen).toEqual(["IDLE", "socket hang up"]);
    expect(await obs.info()).toEqual({ machineType: "Voron", machineName: "garage", firmware: "Klipper 0.12", serial: undefined });
  });
});

describe("DriverControl", () => {
  const setup = () => {
    const conn = new FakeConnection({});
    const obs = new DriverObserver(conn, () => {});
    return { conn, ctl: new DriverControl(conn, garage, obs) };
  };

  it("only pauses while printing, resumes while paused, cancels with a job", async () => {
    const { conn, ctl } = setup();
    expect((await ctl.pause()).ok).toBe(false);
    expect((await ctl.resume()).ok).toBe(false);
    expect((await ctl.cancel()).ok).toBe(false);
    expect(conn.calls.filter((c) => c !== "status")).toEqual([]);
    conn.state = { state: "printing", checkedAt: "t", job: { file: "a.gcode", progress: 0.5 } };
    expect(await ctl.pause()).toMatchObject({ ok: true });
    conn.state = { state: "paused", checkedAt: "t", job: { file: "a.gcode", progress: 0.5 } };
    expect(await ctl.resume()).toMatchObject({ ok: true });
    expect(await ctl.cancel()).toMatchObject({ ok: true });
    expect(conn.calls.filter((c) => c !== "status")).toEqual(["pause", "resume", "cancel"]);
    expect(ctl.status().job).toMatchObject({ fileName: "a.gcode", phase: "paused", progress: 50 });
  });

  it("refuses commands the printer doesn't support and reports driver errors plainly", async () => {
    const { conn, ctl } = setup();
    conn.state = { state: "printing", checkedAt: "t" };
    conn.caps = { ...conn.caps, pause: false };
    expect((await ctl.pause()).message).toMatch(/can't be paused/);
    conn.caps = { ...conn.caps, pause: true };
    const { DriverError } = await import("@morphix/printer");
    conn.pause = async () => {
      throw new DriverError("rejected", "Klippy is shutdown", "Restart the firmware from Mainsail.");
    };
    expect(await ctl.pause()).toEqual({ ok: false, message: "Pause didn't work: Klippy is shutdown Restart the firmware from Mainsail." });
  });

  it("clamps temperatures to the catalog model's limits and never starts a print", async () => {
    const { conn, ctl } = setup();
    const model = findPrinter(garage.modelId)!;
    await ctl.machine({ cmd: "nozzle", celsius: 999 });
    await ctl.machine({ cmd: "bed", celsius: -20 });
    await ctl.machine({ cmd: "cooldown" });
    expect((await ctl.machine({ cmd: "home" })).ok).toBe(false);
    expect(conn.calls.filter((c) => c.startsWith("temp"))).toEqual([`temp nozzle ${model.maxNozzleC}`, "temp bed 0", "temp nozzle 0", "temp bed 0"]);
    expect(conn.calls.some((c) => c.startsWith("start") || c === "upload")).toBe(false);
  });

  it("refuses temperature changes during a print", async () => {
    const { conn, ctl } = setup();
    conn.state = { state: "printing", checkedAt: "t" };
    expect(await ctl.machine({ cmd: "nozzle", celsius: 200 })).toMatchObject({ ok: false, message: expect.stringMatching(/during a print/) });
    expect(conn.calls.some((c) => c.startsWith("temp"))).toBe(false);
  });

  it("refuses temperatures for an unknown model or an offline printer", async () => {
    const conn = new FakeConnection({});
    const ctl = new DriverControl(conn, { ...garage, modelId: "nobody-knows" }, new DriverObserver(conn, () => {}));
    expect((await ctl.machine({ cmd: "nozzle", celsius: 200 })).ok).toBe(false);
    const { conn: c2, ctl: k2 } = setup();
    c2.state = { state: "offline", checkedAt: "t" };
    expect(await k2.machine({ cmd: "nozzle", celsius: 200 })).toEqual({ ok: false, message: "The printer is offline." });
    expect(c2.calls.some((c) => c.startsWith("temp"))).toBe(false);
  });
});

describe("setup module loader", () => {
  it("uses only the functions the setup module exports", () => {
    const m = loadSetupModule({ createConfigStore: () => null, resetAdmin: "not a function" });
    expect(typeof m.createConfigStore).toBe("function");
    expect(m.resetAdmin).toBeUndefined();
    expect(m.createAuthProvider).toBeUndefined();
  });
});
