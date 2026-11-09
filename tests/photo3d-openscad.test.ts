import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { checkScadSafety, designWithOpenscad, openscadVersion, runOpenscad, stripScad, type Dimensions, type OpenscadSpec } from "@morphix/photo3d";
import { boxStl, fakeGemini, fakeOpenscad, geminiBody, missingOpenscad } from "./photo3d-helpers";

const GOOD = `w = 80; d = 60; h = 50;\ntranslate([-w/2, -d/2, 0]) cube([w, d, h]);`;

describe("OpenSCAD safety checks", () => {
  it("accepts ordinary parametric code", () => {
    expect(checkScadSafety(GOOD)).toEqual({ ok: true, problems: [] });
    expect(checkScadSafety(`$fn = 64;\nfor (i = [0 : 5 : 40]) translate([i, 0, 0]) cylinder(d = 3, h = 2);\nuse_count = 2; // import() in a comment is fine\necho("include <x>");`).ok).toBe(true);
  });

  it.each([
    ['import("/etc/passwd.stl");', /import/],
    ["include <MCAD/gears.scad>\ncube(1);", /include/],
    ["use <../lib.scad>\ncube(1);", /use/],
    ['surface(file = "heights.dat");', /surface|file=/],
    ['linear_extrude(height = 2, file = "a.dxf");', /file=/],
    ['x = dxf_dim(file = "a.dxf", name = "w"); cube(x);', /dxf/],
    ["$fn = 5000; sphere(10);", /\$fn/],
    ["$fs = 0.001; sphere(10);", /\$fs/],
    ["for (i = [0 : 1 : 100000]) cube(i);", /range/],
    ["for (i = [0 : 0 : 10]) cube(i);", /zero step/],
    ["echo(1);", /no 3D geometry/],
  ])("rejects %s", (code, why) => {
    const r = checkScadSafety(code);
    expect(r.ok).toBe(false);
    expect(r.problems.join("; ")).toMatch(why);
  });

  it("strips comments and strings before checking", () => {
    expect(stripScad('cube(1); // import("x")\n/* use <y> */ echo("surface(")')).not.toMatch(/import|use|surface/);
  });
});

describe("OpenSCAD runner", () => {
  it("runs openscad -o out.stl in.scad and returns the STL", async () => {
    const f = fakeOpenscad(() => ({ stl: boxStl(1, 2, 3) }));
    const r = await runOpenscad(GOOD, { exec: f.exec });
    expect(r.ok).toBe(true);
    expect(f.runs[0]).toBe(GOOD);
  });

  it("reports a missing binary, timeouts, compile errors and empty output", async () => {
    expect(await runOpenscad(GOOD, { exec: missingOpenscad })).toMatchObject({ ok: false, kind: "missing" });
    expect(await runOpenscad(GOOD, { exec: fakeOpenscad(() => ({ code: null, timedOut: true })).exec })).toMatchObject({ ok: false, kind: "timeout" });
    const ce = await runOpenscad(GOOD, { exec: fakeOpenscad(() => ({ code: 1, stderr: "ERROR: Parser error in file model.scad, line 2: syntax error" })).exec });
    expect(ce).toMatchObject({ ok: false, kind: "compile" });
    expect(await runOpenscad(GOOD, { exec: fakeOpenscad(() => ({ code: 1, stderr: "Current top level object is empty." })).exec })).toMatchObject({ kind: "empty" });
    expect(await runOpenscad(GOOD, { exec: fakeOpenscad(() => ({ code: 0 })).exec })).toMatchObject({ kind: "empty" });
    expect(await openscadVersion({ exec: missingOpenscad })).toBeNull();
  });
});

const spec: OpenscadSpec = { summary: "block", features: ["rectangular block"], wallThicknessMm: 3, holes: [], toleranceMm: null, bedOrientation: "flat", notes: "" };
const dims: Dimensions = {
  width: { valueMm: 80, confidence: 1, method: "user-measurement" },
  depth: { valueMm: 60, confidence: 1, method: "user-measurement" },
  height: { valueMm: 50, confidence: 1, method: "user-measurement" },
};
const input = { objectName: "block", description: "a block", spec, dimensions: dims };

describe("designWithOpenscad", () => {
  it("succeeds first time when the size matches", async () => {
    const g = fakeGemini({ scad: [{ body: geminiBody({ scad: GOOD }) }] });
    const f = fakeOpenscad(() => ({ stl: boxStl(80, 60, 50) }));
    const r = await designWithOpenscad(input, { gemini: g.client, exec: f.exec });
    expect(r.dimensionCheck.ok).toBe(true);
    expect(r.attempts.map((a) => a.outcome)).toEqual(["ok"]);
    const prompt = g.calls[0].body.contents[0].parts[0].text as string;
    expect(prompt).toContain("80 mm (X, width) x 60 mm (Y, depth) x 50 mm (Z, height)");
  });

  it("feeds compile errors and unsafe code back to Gemini and retries", async () => {
    const g = fakeGemini({
      scad: [
        { body: geminiBody({ scad: 'import("a.stl");' }) },
        { body: geminiBody({ scad: "cube([80,60,50]" }) },
        { body: geminiBody({ scad: GOOD }) },
      ],
    });
    const f = fakeOpenscad((code) => (code === GOOD ? { stl: boxStl(80, 60, 50) } : { code: 1, stderr: "ERROR: Parser error in file model.scad, line 1: syntax error" }));
    const r = await designWithOpenscad(input, { gemini: g.client, exec: f.exec });
    expect(r.attempts.map((a) => a.outcome)).toEqual(["unsafe", "compile", "ok"]);
    expect(f.runs).toHaveLength(2); // the unsafe code never ran
    const third = g.calls[2].body.contents[0].parts[0].text as string;
    expect(third).toContain("Parser error");
    expect(third).toContain("rejected by safety checks");
  });

  it("retries a dimension mismatch and returns the closest result if it never converges", async () => {
    const g = fakeGemini({ scad: [{ body: geminiBody({ scad: GOOD }) }] });
    let n = 0;
    const sizes = [[90, 60, 50], [83, 60, 50], [86, 60, 50]];
    const f = fakeOpenscad(() => ({ stl: boxStl(...(sizes[n++] as [number, number, number])) }));
    const r = await designWithOpenscad(input, { gemini: g.client, exec: f.exec });
    expect(r.dimensionCheck.ok).toBe(false);
    expect(r.dimensionCheck.axes[0].actualMm).toBe(83);
    expect(r.attempts.map((a) => a.outcome)).toEqual(["dimension-mismatch", "dimension-mismatch", "dimension-mismatch"]);
    expect(g.calls[1].body.contents[0].parts[0].text).toContain("width 90 vs 80 mm");
  });

  it("detects swapped axes", async () => {
    const g = fakeGemini({ scad: [{ body: geminiBody({ scad: GOOD }) }] });
    const f = fakeOpenscad(() => ({ stl: boxStl(60, 80, 50) }));
    const r = await designWithOpenscad(input, { gemini: g.client, exec: f.exec, maxAttempts: 1 });
    expect(r.dimensionCheck.axesSwapped).toBe(true);
  });

  it("stops at once with MX-P3D-030 when openscad is missing", async () => {
    const g = fakeGemini({ scad: [{ body: geminiBody({ scad: GOOD }) }] });
    await expect(designWithOpenscad(input, { gemini: g.client, exec: missingOpenscad })).rejects.toMatchObject({ code: "MX-P3D-030" });
    expect(g.calls).toHaveLength(1);
  });

  it("gives up after 3 failed compiles with MX-P3D-032", async () => {
    const g = fakeGemini({ scad: [{ body: geminiBody({ scad: GOOD }) }] });
    const f = fakeOpenscad(() => ({ code: 1, stderr: "ERROR: something" }));
    await expect(designWithOpenscad(input, { gemini: g.client, exec: f.exec })).rejects.toMatchObject({ code: "MX-P3D-032" });
    expect(f.runs).toHaveLength(3);
  });
});

// Real OpenSCAD, only where it is installed (e.g. on the Pi after `apt install openscad`).
const hasOpenscad = (() => {
  try {
    execFileSync("openscad", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenscad)("real openscad (installed)", () => {
  it("renders a block with exact dimensions", async () => {
    const r = await runOpenscad(GOOD, { timeoutMs: 60_000 });
    expect(r.ok).toBe(true);
  }, 70_000);
});
