// Real OpenSCAD, only where it is installed (the Pi has /usr/bin/openscad 2021.01).
// Claude is still faked: this checks rendering, STL parsing and the mesh checks.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { generateCadModel } from "@morphix/cad";
import { parseStl, validateMesh } from "@morphix/slicing";
import { answer, fakeClaude } from "./cad-helpers";

const hasOpenscad = (() => {
  try {
    execFileSync("openscad", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

const BRACKET = `
w = 40;    // length
d = 20;    // depth
h = 10;    // height
hole = 3.4; // M3 clearance
difference() {
  translate([-w/2, -d/2, 0]) cube([w, d, h]);
  for (x = [-12, 12]) translate([x, 0, -1]) cylinder(d = hole, h = h + 2, $fn = 32);
}
`;

describe.skipIf(!hasOpenscad)("real openscad (installed)", () => {
  it("renders Claude's code into a watertight part of the stated size", async () => {
    const claude = fakeClaude([answer({ scad: BRACKET, sizeMm: { x: 40, y: 20, z: 10 } })]);
    const r = await generateCadModel({ description: "small bracket with two M3 holes", maxAttempts: 1 }, { anthropicApiKey: "test", fetch: claude.fetch, openscadTimeoutMs: 120_000 });
    expect(r.attempts).toBe(1);
    expect(r.sizeMm.x).toBeCloseTo(40, 1);
    expect(r.sizeMm.y).toBeCloseTo(20, 1);
    expect(r.sizeMm.z).toBeCloseTo(10, 1);
    const v = validateMesh(parseStl(r.stl));
    expect(v.watertight).toBe(true);
    expect(v.volumeMm3).toBeGreaterThan(7000);
    expect(v.volumeMm3).toBeLessThan(8000);
  }, 130_000);
});
