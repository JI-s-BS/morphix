// When the main process starts and stops the Print Guardian from printer polls:
// a user Stop sticks for the rest of that print, filament load/unload jobs are not
// watched, and the next print is watched again. Fake context; nothing is spawned.
import { describe, expect, it, vi } from "vitest";
import type { PrinterStatus } from "@morphix/shared";
import { Printing } from "../apps/desktop/electron/printing";
import type { Ctx } from "../apps/desktop/electron/context";

function rig() {
  const ctx = {
    db: { exec: () => undefined, run: () => undefined, get: () => undefined, all: () => [], flush: () => undefined },
    storage: { root: "/tmp/morphix-guardian-test" },
    log: { write: () => undefined },
    send: () => undefined,
    event: () => undefined,
    url: () => null,
    currentProjectId: null,
  } as unknown as Ctx;
  const p = new Printing(ctx, {
    repoRoot: "/opt/morphix", printerHost: "192.168.10.51", controlsEnabled: false, gxVerified: false,
    pausedStatuses: ["PAUSED"], allowUnverified: {} as never,
  });
  const start = vi.spyOn(p.guardian, "start").mockImplementation(() => p.guardian.snapshot());
  const stop = vi.spyOn(p.guardian, "stop").mockImplementation(async () => undefined);
  let n = 0;
  const poll = (o: Partial<PrinterStatus>) =>
    p.onPrinterStatus({ online: true, checkedAt: new Date(Date.now() + ++n * 10_000).toISOString(), ...o });
  return { p, start, stop, poll };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const printing = (file = "benchy.gx", progress = 12): Partial<PrinterStatus> => ({ machine: "BUILDING_FROM_SD", moveMode: "MOVING", currentFile: file, progress });
const READY: Partial<PrinterStatus> = { machine: "READY", moveMode: "READY" };

describe("guardian auto-start from printer polls", () => {
  it("starts for a print found running", async () => {
    const { start, poll } = rig();
    poll(printing());
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("a user Stop stays stopped for the rest of that print, and the next print is watched again", async () => {
    const { p, start, stop, poll } = rig();
    poll(printing());
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    await p.guardianCommand("stop"); // the Stop button (IPC passes only the command)
    expect(stop).toHaveBeenCalledWith("stopped by operator");
    for (let i = 0; i < 20; i++) poll(printing("benchy.gx", 12 + i));
    poll(printing("benchy.gx", 40)); // paused/resumed etc. still the same print
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    // the operator can still turn it back on by hand
    await p.guardianCommand("start");
    expect(start).toHaveBeenCalledTimes(2);
    await p.guardianCommand("stop");
    // the print ends; the next one is watched automatically
    poll(READY);
    poll(printing("next.gx", 0));
    await flush();
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("does not watch Morphix's own filament load/unload jobs", async () => {
    const { start, poll } = rig();
    poll(printing("morphix-filament-load.gx", 0));
    poll(printing("/data/morphix-filament-unload.gx", 50));
    await flush();
    expect(start).not.toHaveBeenCalled();
  });

  it("forwards offline polls to the guardian (so it stops trusting a stale 'printing')", () => {
    const { p, poll } = rig();
    const upd = vi.spyOn(p.guardian, "updatePrinterStatus");
    poll(printing());
    p.onPrinterStatus({ online: false, checkedAt: new Date(Date.now() + 1e6).toISOString(), error: "Control failed" });
    expect(upd).toHaveBeenCalledTimes(2);
    expect(upd.mock.calls[1][0]).toMatchObject({ online: false });
  });
});
