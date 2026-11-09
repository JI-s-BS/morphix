// deploy.sh waits while Morphix is working: designs, slicing and uploads count as busy; a print
// running on the printer, or a job waiting for the user, doesn't (they survive a restart).
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { busyReasons, startBusyMarker } from "../apps/desktop/electron/busy";
import { buildCadPrompt } from "@morphix/cad";

const job = (title: string, running: string | null, waiting?: string): any => ({
  title,
  stages: [
    { key: "build", status: running === "build" ? "running" : "done" },
    { key: "approval", status: waiting === "approval" ? "waiting_for_user" : running === "approval" ? "running" : "pending" },
    { key: "print", status: running === "print" ? "running" : "pending" },
  ],
});

describe("busy marker for deploys", () => {
  it("counts the app's own work, not printing or waiting for the user", () => {
    expect(busyReasons([job("Bottle", "build")])).toEqual(["Bottle: build"]);
    expect(busyReasons([job("Bottle", "print"), job("Cap", null, "approval")])).toEqual([]);
  });

  it("writes the file while busy and removes it when idle", () => {
    const file = join(mkdtempSync(join(tmpdir(), "busy-")), "run", "busy");
    let jobs = [job("Bottle", "build")];
    const stop = startBusyMarker(file, () => jobs, 60_000);
    expect(readFileSync(file, "utf8")).toContain("Bottle: build");
    stop();
    expect(existsSync(file)).toBe(false);
    jobs = [job("Bottle", "print")];
    const stop2 = startBusyMarker(file, () => jobs, 60_000);
    expect(existsSync(file)).toBe(false);
    stop2();
  });
});

describe("changing a Claude design", () => {
  it("gives Claude the existing OpenSCAD and asks for only the change", () => {
    const p = buildCadPrompt({ description: "add a screw-on cap", baseScad: "bottle_h = 164;\ncylinder(h = bottle_h, d = 74);" });
    expect(p).toContain("CHANGE to the user's existing design");
    expect(p).toContain("bottle_h = 164;");
    expect(buildCadPrompt({ description: "a bottle" })).not.toContain("existing design");
  });
});

describe("Claude thinks about what the person needs", () => {
  it("asks Claude to add companion parts like a bottle cap, on one plate, and to say so", async () => {
    const { CAD_SYSTEM_PROMPT } = await import("@morphix/cad");
    expect(CAD_SYSTEM_PROMPT).toMatch(/a bottle or jar gets a screw cap/);
    expect(CAD_SYSTEM_PROMPT).toMatch(/One print plate: the main part plus any companion parts/);
    expect(CAD_SYSTEM_PROMPT).toMatch(/Name every added part in `notes`/);
  });
});
