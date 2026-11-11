// End to end through the real pieces: the server core, the real flashforge-tcp driver (from the
// setup page's printer config) and the FakeQD330 printer on a local TCP port. Import a model file →
// prepare for the catalog model → request → Confirm → upload + start on the printer → progress →
// completed. Only the slicer is a stand-in (no slicer binary in the test environment).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IPC, type PendingAction, type PrepareSummary, type PrintControlStatus, type PrinterStatus } from "@morphix/shared";
import type { MorphixConfig } from "@morphix/config";
import { FakeQD330, type QD330ControllerOptions } from "@morphix/printer";
import type { SlicerAdapter, SliceJob } from "@morphix/slicing";
import { createFlashforgeTcpDriver } from "../packages/printer/src/drivers/lan/flashforge-tcp";
import { createCore, type Core } from "../apps/server/src/core";
import { DEFAULT_CONFIG } from "../apps/server/src/setup-module";
import { boxStl } from "./photo3d-helpers";

const FAST: Partial<QD330ControllerOptions> = {
  connectTimeoutMs: 500, replyTimeoutMs: 300, startReplyTimeoutMs: 300, uploadFinishTimeoutMs: 300,
  startConfirmTimeoutMs: 800, confirmTimeoutMs: 500, pauseConfirmTimeoutMs: 500, pollIntervalMs: 20, uploadFlushDelayMs: 0,
};

const sliced: SliceJob[] = [];
const gxSlicer: SlicerAdapter = {
  id: "prusaslicer", name: "StandInSlicer", supports: (p) => p.fileFormat === "gx", installHint: () => "",
  detect: async () => ({ id: "prusaslicer", path: "/bin/true", version: "test", via: "path" }),
  slice: async (_i, job) => {
    sliced.push(job);
    const out = join(job.outDir, "..", "stand-in.gx");
    writeFileSync(out, Buffer.from("xgcode 1.0\n;stand-in .gx payload\n"));
    return { ok: true, printablePath: out, format: "gx", estimatedTimeS: 1200, filamentMm: 800, warnings: [] };
  },
};

const savedPoll = process.env.MORPHIX_PRINTER_POLL_SECONDS;
beforeAll(() => void (process.env.MORPHIX_PRINTER_POLL_SECONDS = "0.05"));
afterAll(() => {
  if (savedPoll === undefined) delete process.env.MORPHIX_PRINTER_POLL_SECONDS;
  else process.env.MORPHIX_PRINTER_POLL_SECONDS = savedPoll;
});

let core: Core | null = null;
let fake: FakeQD330 | null = null;
let dir = "";
afterEach(async () => {
  await core?.stop();
  await fake?.close();
  core = null;
  fake = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  sliced.length = 0;
});

const until = async (fn: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  return fn();
};
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe("QD330 end to end (real driver, fake printer)", () => {
  it("imports, prepares, prints after Confirm, and follows the print to the end", async () => {
    fake = new FakeQD330();
    const port = await fake.listen();
    dir = mkdtempSync(join(tmpdir(), "morphix-e2e-"));
    const config: MorphixConfig = {
      ...structuredClone(DEFAULT_CONFIG),
      printers: [{ id: "qd", name: "Lab QD330", modelId: "afinia-qd330", driver: "flashforge-tcp", connection: { host: "127.0.0.1", port } }],
      activePrinterId: "qd",
      setupComplete: true,
    };
    core = await createCore({
      dataDir: join(dir, "data"), repoRoot: resolve(__dirname, ".."), version: "e2e", config,
      driverLookup: (id) => (id === "flashforge-tcp" ? createFlashforgeTcpDriver(FAST) : undefined),
      slicers: [gxSlicer],
      driverStartChecks: { everyMs: 50, times: 40 },
    });
    await core.start();
    const call = (ch: string, ...args: unknown[]) => core!.registry.call(ch, args);
    const jobState = (id: string) => String(core!.ctx.db.get("SELECT state FROM print_jobs WHERE id = ?", [id])?.state);

    // The printer is online through the real driver.
    expect(await until(async () => ((await call(IPC.printerStatus)) as PrinterStatus).online)).toBe(true);
    expect(((await call(IPC.printerStatus)) as PrinterStatus).machine).toBe("READY");

    // Import a model file and prepare it for the catalog's QD330.
    const imp = (await call(IPC.importModelFiles, [{ name: "calibration_cube.stl", bytes: ab(boxStl(20, 20, 20)) }])) as { versionId: string };
    const sum = (await call(IPC.preparePrint, imp.versionId, { layerHeightMm: 0.2, infillPercent: 15, supports: "none" })) as PrepareSummary;
    expect(sum.ok).toBe(true);
    expect(sum.gx.fileName).toMatch(/\.gx$/);
    expect(sliced[0].printer).toMatchObject({ id: "afinia-qd330", fileFormat: "gx" });
    expect(sum.size).toMatchObject({ x: 20, y: 20, z: 20 });

    // Nothing reaches the printer before Confirm.
    await call(IPC.requestPrint, sum.jobId);
    const pending = (await call(IPC.pendingAction)) as PendingAction;
    expect(pending.prompt).toBe(`Send ${sum.gx.fileName} to Lab QD330 and start printing.`);
    expect(fake.files.size).toBe(0);
    expect(fake.received.some((c) => /^M2[348]\b/.test(c))).toBe(false);

    // Confirm: the file is uploaded and started on the printer.
    await call(IPC.confirmAction, pending.id);
    expect(await until(() => fake!.files.has(sum.gx.fileName!))).toBe(true);
    expect(await until(() => fake!.machineStatus === "BUILDING_FROM_SD")).toBe(true);
    expect(await until(() => jobState(sum.jobId) === "printing")).toBe(true);

    fake.setProgress(40, [12, 100]);
    expect(await until(async () => ((await call(IPC.printStatus)) as PrintControlStatus).job?.progress === 40)).toBe(true);
    expect(((await call(IPC.printStatus)) as PrintControlStatus).job).toMatchObject({ jobId: sum.jobId, phase: "printing" });

    fake.finishPrint();
    expect(await until(() => jobState(sum.jobId) === "completed")).toBe(true);
  }, 30_000);

  it("refuses to send a print while the printer is busy", async () => {
    fake = new FakeQD330();
    fake.machineStatus = "BUILDING_FROM_SD";
    fake.currentFile = "someone-elses.gx";
    fake.progress = 20;
    const port = await fake.listen();
    dir = mkdtempSync(join(tmpdir(), "morphix-e2e-"));
    const config: MorphixConfig = {
      ...structuredClone(DEFAULT_CONFIG),
      printers: [{ id: "qd", name: "Lab QD330", modelId: "afinia-qd330", driver: "flashforge-tcp", connection: { host: "127.0.0.1", port } }],
      activePrinterId: "qd",
    };
    core = await createCore({
      dataDir: join(dir, "data"), repoRoot: resolve(__dirname, ".."), version: "e2e", config,
      driverLookup: (id) => (id === "flashforge-tcp" ? createFlashforgeTcpDriver(FAST) : undefined),
      slicers: [gxSlicer],
    });
    await core.start();
    const call = (ch: string, ...args: unknown[]) => core!.registry.call(ch, args);
    expect(await until(async () => ((await call(IPC.printerStatus)) as PrinterStatus).online)).toBe(true);
    const imp = (await call(IPC.importModelFiles, [{ name: "cube.stl", bytes: ab(boxStl(20, 20, 20)) }])) as { versionId: string };
    const sum = (await call(IPC.preparePrint, imp.versionId, { layerHeightMm: 0.2, infillPercent: 15, supports: "none" })) as PrepareSummary;
    await expect(call(IPC.requestPrint, sum.jobId)).rejects.toThrow(/Lab QD330 is printing/);
    expect(fake.uploads).toHaveLength(0);
  }, 30_000);
});
