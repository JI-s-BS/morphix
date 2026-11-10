// Printing on a driver printer, end to end through the real core: prepare (mesh stages + slicer
// adapter for the catalog model) → request → user confirms → upload + start → followed to the end.
// Fake driver (as "flashforge-tcp" for the catalog's afinia-qd330) and a fake slicer adapter:
// no network, no slicer binary.
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IPC, type PendingAction, type PrepareSummary, type PrintControlStatus } from "@morphix/shared";
import type { MorphixConfig } from "@morphix/config";
import type { DriverCapabilities, DriverStatus, PrinterConnection, PrinterDriver } from "@morphix/printer";
import type { SliceJob, SlicerAdapter } from "@morphix/slicing";
import { createCore, type Core } from "../apps/server/src/core";
import { createDriverSlicer, installedAdapters } from "../apps/server/src/slicers";
import { DEFAULT_CONFIG } from "../apps/server/src/setup-module";
import { boxStl } from "./photo3d-helpers";

const MODEL_ID = "afinia-qd330";
const now = () => new Date().toISOString();

class FakeConnection implements PrinterConnection {
  readonly driver = "flashforge-tcp" as const;
  calls: string[] = [];
  uploads: { name: string; bytes: number; format: string }[] = [];
  state: DriverStatus = { state: "idle", checkedAt: now() };
  caps: DriverCapabilities = { fileFormats: ["gx"], upload: true, startPrint: true, pause: true, resume: true, cancel: true, setTemperature: false, gcodeConsole: false, camera: false };
  capabilities() { return this.caps; }
  async test() { return { ok: true as const, info: {} }; }
  async status() { return this.state; }
  async upload(f: { name: string; data: Buffer; format: string }) { this.calls.push("upload"); this.uploads.push({ name: f.name, bytes: f.data.length, format: f.format }); }
  async start(name: string) {
    this.calls.push(`start ${name}`);
    this.state = { state: "printing", checkedAt: now(), job: { file: name, progress: 0.1, layer: [1, 50] } };
  }
  async pause() { this.calls.push("pause"); }
  async resume() { this.calls.push("resume"); }
  async cancel() { this.calls.push("cancel"); this.state = { state: "idle", checkedAt: now() }; }
  async close() {}
}

const sliceJobs: SliceJob[] = [];
const fakeAdapter = (installed = true): SlicerAdapter => ({
  id: "orcaslicer",
  name: "FakeSlicer",
  detect: async () => (installed ? { id: "orcaslicer", path: "/usr/bin/fake", version: "2.3", via: "path" } : null),
  supports: (p) => p.fileFormat === "gx",
  installHint: () => "Install OrcaSlicer from its AppImage.",
  slice: async (_i, job) => {
    sliceJobs.push(job);
    const out = join(tmpdir(), `fake-${Date.now()}.gx`); // outside the job folder on purpose
    writeFileSync(out, "xgcode 1.0\n;fake\n");
    return { ok: true, printablePath: out, format: "gx", estimatedTimeS: 3600, filamentMm: 1200, warnings: [] };
  },
});

let core: Core | null = null;
let dir = "";
const savedPoll = process.env.MORPHIX_PRINTER_POLL_SECONDS;
beforeAll(() => {
  process.env.MORPHIX_PRINTER_POLL_SECONDS = "0.02"; // poll the fake printer every 20 ms
});
afterAll(() => {
  if (savedPoll === undefined) delete process.env.MORPHIX_PRINTER_POLL_SECONDS;
  else process.env.MORPHIX_PRINTER_POLL_SECONDS = savedPoll;
});
afterEach(async () => {
  await core?.stop();
  core = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  sliceJobs.length = 0;
});

async function setup(opts: { conn?: FakeConnection; installed?: boolean; modelId?: string } = {}) {
  dir = mkdtempSync(join(tmpdir(), "morphix-driver-print-"));
  const conn = opts.conn ?? new FakeConnection();
  const driver: PrinterDriver = { id: "flashforge-tcp", name: "Fake", description: "", fields: [{ key: "host", label: "Host", kind: "host", required: true }], connect: () => conn };
  const config: MorphixConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    printers: [{ id: "p1", name: "Garage", modelId: opts.modelId ?? MODEL_ID, driver: "flashforge-tcp", connection: { host: "10.0.0.9" } }],
    activePrinterId: "p1",
  };
  core = await createCore({
    dataDir: join(dir, "data"), repoRoot: resolve(__dirname, ".."), version: "test", config,
    driverLookup: (id) => (id === "flashforge-tcp" ? driver : undefined),
    slicers: [fakeAdapter(opts.installed ?? true)],
    driverStartChecks: { everyMs: 5, times: 20 },
  });
  await core.start();
  const { db, storage } = core.ctx;
  const t = now();
  db.run("INSERT INTO projects(id, title, prompt, state, created_at, updated_at) VALUES (?,?,?,?,?,?)", ["proj1", "Test box", "a box", "reviewing", t, t]);
  const stl = storage.path("models", "proj1", "v1", "model.stl");
  storage.writeAtomic(stl, boxStl(20, 20, 10));
  db.run(
    `INSERT INTO model_versions(id, project_id, version, source, kind, format, rel_path, stl_rel_path, bytes, target_height_mm, thumbnail_rel_path, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ["v1", "proj1", 1, "library", "preview", "stl", storage.relative(stl), storage.relative(stl), 100, null, null, t],
  );
  const call = (ch: string, ...args: unknown[]) => core!.registry.call(ch, args);
  const jobState = (id: string) => String(core!.ctx.db.get("SELECT state FROM print_jobs WHERE id = ?", [id])?.state);
  return { conn, call, jobState };
}

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((ok) => setTimeout(ok, 10));
  return fn();
};

const manual = { layerHeightMm: 0.2, infillPercent: 15, supports: "none" };

async function prepareAndConfirm(h: Awaited<ReturnType<typeof setup>>) {
  const sum = (await h.call(IPC.preparePrint, "v1", manual)) as PrepareSummary;
  await h.call(IPC.requestPrint, sum.jobId);
  const pending = (await h.call(IPC.pendingAction)) as PendingAction;
  await h.call(IPC.confirmAction, pending.id);
  expect(await until(() => h.conn.calls.length === 2)).toBe(true);
  return { sum, pending };
}

describe("printing on a driver printer", () => {
  it("prepares for the printer's own model and sends nothing before the user confirms", async () => {
    const h = await setup();
    const sum = (await h.call(IPC.preparePrint, "v1", manual)) as PrepareSummary;
    expect(sum.ok).toBe(true);
    expect(sum.gx).toMatchObject({ ok: true, verified: true, fileName: expect.stringMatching(/^morphix-[0-9a-f]{8}\.gx$/) });
    expect(sum.slicer).toEqual({ ok: true, name: "FakeSlicer 2.3" });
    expect(sum.estimates).toMatchObject({ printTimeS: 3600, filamentMm: 1200, source: "slicer" });
    expect(sliceJobs[0].printer.id).toBe(MODEL_ID);
    expect(sliceJobs[0]).toMatchObject({ layerHeightMm: 0.2, infillPercent: 15, supports: "none" });
    // The printable file was copied into the job's folder.
    const row = core!.ctx.db.get("SELECT file_rel_path, state FROM print_jobs WHERE id = ?", [sum.jobId]);
    expect(String(row?.file_rel_path)).toMatch(new RegExp(`^prints/${sum.jobId}/morphix-.*\\.gx$`));
    expect(row?.state).toBe("ready_for_approval");
    await h.call(IPC.requestPrint, sum.jobId);
    expect(((await h.call(IPC.pendingAction)) as PendingAction).prompt).toBe(`Send ${sum.gx.fileName} to Garage and start printing.`);
    expect(h.conn.calls).toEqual([]);
  });

  it("uploads and starts only after Confirm, then follows the print until it completes", async () => {
    const h = await setup();
    const { sum } = await prepareAndConfirm(h);
    expect(h.conn.calls).toEqual(["upload", `start ${sum.gx.fileName}`]);
    expect(h.conn.uploads[0]).toMatchObject({ name: sum.gx.fileName, format: "gx" });
    expect(h.conn.uploads[0].bytes).toBeGreaterThan(0);
    expect(await until(() => h.jobState(sum.jobId) === "printing")).toBe(true);
    const st = (await h.call(IPC.printStatus)) as PrintControlStatus;
    expect(st).toMatchObject({ enabled: true, job: { jobId: sum.jobId, phase: "printing", progress: 10 } });
    h.conn.state = { state: "finishing", checkedAt: now(), job: { progress: 1 } };
    await until(() => false, 100);
    h.conn.state = { state: "idle", checkedAt: now() };
    expect(await until(() => h.jobState(sum.jobId) === "completed")).toBe(true);
    expect(((await h.call(IPC.printStatus)) as PrintControlStatus).job).toBeNull();
  });

  it("records a cancel from Morphix as cancelled", async () => {
    const h = await setup();
    const { sum } = await prepareAndConfirm(h);
    expect(await until(() => h.jobState(sum.jobId) === "printing")).toBe(true);
    await until(() => false, 60); // let a poll see "printing"
    expect(await h.call(IPC.cancelPrint)).toMatchObject({ ok: true });
    expect(await until(() => h.jobState(sum.jobId) === "cancelled")).toBe(true);
  });

  it("refuses to propose a print while the printer is busy, offline, or can't start prints", async () => {
    const h = await setup();
    const sum = (await h.call(IPC.preparePrint, "v1", manual)) as PrepareSummary;
    h.conn.state = { state: "printing", checkedAt: now(), job: { file: "someone-elses.gcode" } };
    await until(() => false, 60);
    await expect(h.call(IPC.requestPrint, sum.jobId)).rejects.toThrow(/Garage is printing/);
    h.conn.state = { state: "offline", checkedAt: now(), message: "no route" };
    await until(() => false, 60);
    await expect(h.call(IPC.requestPrint, sum.jobId)).rejects.toThrow(/Garage is offline/);
    h.conn.state = { state: "idle", checkedAt: now() };
    h.conn.caps = { ...h.conn.caps, startPrint: false };
    await until(() => false, 60);
    await expect(h.call(IPC.requestPrint, sum.jobId)).rejects.toThrow(/can't start prints on Garage/);
    expect(h.conn.calls).toEqual([]);
  });

  it("re-checks the printer at Confirm and sends nothing if it became busy", async () => {
    const h = await setup();
    const sum = (await h.call(IPC.preparePrint, "v1", manual)) as PrepareSummary;
    await h.call(IPC.requestPrint, sum.jobId);
    const pending = (await h.call(IPC.pendingAction)) as PendingAction;
    const notices: string[] = [];
    core!.registry.subscribe((ch, e) => {
      const ev = e as { type?: string; message?: string };
      if (ch === IPC.appEvent && ev.type === "notice") notices.push(String(ev.message));
    });
    h.conn.state = { state: "heating", checkedAt: now() };
    await h.call(IPC.confirmAction, pending.id);
    expect(await until(() => notices.some((m) => m.startsWith("Print not started")))).toBe(true);
    expect(notices.find((m) => m.startsWith("Print not started"))).toMatch(/Garage is heating, so the print was not sent/);
    expect(h.conn.calls).toEqual([]);
    expect(h.jobState(sum.jobId)).toBe("ready_for_approval");
  });

  it("explains plainly when no slicer is installed", async () => {
    const h = await setup({ installed: false });
    const sum = (await h.call(IPC.preparePrint, "v1", manual)) as PrepareSummary;
    expect(sum.ok).toBe(false);
    expect(sum.slicer).toMatchObject({ ok: false, reason: "slicer-not-installed", message: expect.stringMatching(/No slicer is installed.*AppImage/) });
    await expect(h.call(IPC.requestPrint, sum.jobId)).rejects.toThrow(/prepare the model|isn't ready/);
  });

  it("asks for the printer model when it isn't in the catalog", async () => {
    const h = await setup({ modelId: "nobody-knows-this-one" });
    await h.call(IPC.preparePrint, "v1", manual).catch(() => null);
    const job = core!.ctx.db.get("SELECT id FROM print_jobs ORDER BY created_at DESC LIMIT 1");
    await expect(h.call(IPC.requestPrint, String(job?.id ?? "x"))).rejects.toThrow(/Pick your printer's model/);
  });
});

describe("slicer picking", () => {
  const model = { id: "m", brand: "B", model: "M", fileFormat: "gx" } as unknown as SliceJob["printer"];
  const job = { modelPath: "/x.stl", outDir: "/tmp/x", printer: model, filament: "pla" } as SliceJob;
  it("prefers the user's slicer, skips ones that can't make the file, caches installs", async () => {
    const used: string[] = [];
    let detects = 0;
    const mk = (id: "prusaslicer" | "orcaslicer", ok: boolean): SlicerAdapter => ({
      id, name: id, supports: () => ok, installHint: () => "",
      detect: async () => (detects++, { id, path: id, version: null, via: "path" }),
      slice: async () => (used.push(id), { ok: true, printablePath: "/x.gx", format: "gx", warnings: [] }),
    });
    const slice = createDriverSlicer([mk("prusaslicer", false), mk("orcaslicer", true)], { preferred: "prusaslicer" });
    expect((await slice(job)).slicer).toBe("orcaslicer");
    await slice(job);
    expect(used).toEqual(["orcaslicer", "orcaslicer"]);
    expect(detects).toBe(1);
  });
  it("says when no slicer can make the printer's file", async () => {
    const r = await createDriverSlicer([])(job);
    expect(r.out).toMatchObject({ ok: false, reason: "unsupported-printer" });
  });
  it("reads SLICERS from packages/slicing when it exports them", () => {
    expect(installedAdapters({})).toEqual([]);
    expect(installedAdapters({ SLICERS: { orcaslicer: fakeAdapter() } })).toHaveLength(1);
  });
});
