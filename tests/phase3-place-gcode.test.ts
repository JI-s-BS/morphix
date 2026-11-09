import { describe, expect, it } from "vitest";
import {
  analyzeGcode,
  applyOrientation,
  autoOrient,
  checkFit,
  computeBounds,
  extractLayers,
  parseDuration,
  placeOnPlate,
  scaleToHeight,
  signedVolume,
} from "@morphix/slicing";
import { box, invertedPyramid, ORCA_GCODE, PRUSA_GCODE } from "./phase3-fixtures";

describe("scale, place, fit", () => {
  it("scales to a target height and centres on the 220 mm plate", () => {
    const { mesh, scale } = scaleToHeight(box(0.2, 0.1, 0.4, { x: -3, y: 7, z: 2 }), 50);
    expect(scale).toBeCloseTo(125);
    const placed = placeOnPlate(mesh).mesh;
    const b = computeBounds(placed);
    expect(b.size.z).toBeCloseTo(50, 4);
    expect(b.min.z).toBeCloseTo(0, 5);
    expect((b.min.x + b.max.x) / 2).toBeCloseTo(110, 4);
    expect((b.min.y + b.max.y) / 2).toBeCloseTo(110, 4);
  });

  it("rejects bad heights", () => {
    expect(() => scaleToHeight(box(1, 1, 1), 0)).toThrow(RangeError);
  });

  it("gives a clear too-large result", () => {
    const r = checkFit({ x: 250, y: 100, z: 300 });
    expect(r.fits).toBe(false);
    expect(r.overflowMm).toEqual({ x: 30, y: 0, z: 80 });
    expect(r.maxUniformScale).toBeCloseTo(220 / 300);
    expect(r.message).toMatch(/^Too large: 250\.0 x 100\.0 x 300\.0 mm exceeds the 220 x 220 x 220 mm build volume/);
    expect(r.message).toMatch(/X 30\.0 mm, Z 80\.0 mm/);
    expect(checkFit({ x: 220, y: 220, z: 220 }).fits).toBe(true);
  });
});

describe("autoOrient", () => {
  it("turns a pyramid standing on its apex onto its base", () => {
    const m = invertedPyramid();
    expect(signedVolume(m)).toBeGreaterThan(0);
    const o = autoOrient(m);
    expect(o.unchanged).toBe(false);
    expect(o.chosen.down.z).toBeCloseTo(1);
    expect(o.chosen.baseAreaMm2).toBeCloseTo(400);
    const placed = placeOnPlate(applyOrientation(m, o)).mesh;
    // Base (the 400 mm^2 face) now on the bed, apex on top, volume still positive.
    expect(computeBounds(placed).size.z).toBeCloseTo(20);
    expect(signedVolume(placed)).toBeCloseTo(signedVolume(m), 3);
    const pos = placed.positions;
    const zs = Array.from({ length: pos.length / 3 }, (_, i) => pos[i * 3 + 2]);
    expect(zs.filter((z) => Math.abs(z) < 1e-4).length).toBe(4);
  });

  it("keeps a model when no candidate is clearly better", () => {
    const o = autoOrient(box(30, 30, 30));
    expect(o.unchanged).toBe(true);
    expect(o.candidates.length).toBeGreaterThanOrEqual(6);
  });

  it("lays a tall box on its largest face", () => {
    const o = autoOrient(box(30, 30, 60));
    expect(o.unchanged).toBe(false);
    expect(Math.abs(o.chosen.down.z)).toBeCloseTo(0);
    expect(o.chosen.baseAreaMm2).toBeCloseTo(1800);
    expect(computeBounds(applyOrientation(box(30, 30, 60), o)).size.z).toBeCloseTo(30);
  });

  it("never changes orientation with an infinite keep bias (orientation: 'keep')", () => {
    expect(autoOrient(invertedPyramid(), { keepBias: Infinity }).unchanged).toBe(true);
  });
});

describe("G-code analysis", () => {
  it("parses PrusaSlicer estimates", () => {
    const e = analyzeGcode(PRUSA_GCODE);
    expect(e.printTimeS).toBe(3723);
    expect(e.filamentMm).toBeCloseTo(1234.56);
    expect(e.filamentG).toBeCloseTo(3.68);
    expect(e.filamentCm3).toBeCloseTo(2.97);
    expect(e.layerCount).toBe(3);
    expect(e.layerHeightMm).toBeCloseTo(0.2);
    expect(e.nozzleTempC).toBe(210);
    expect(e.bedTempC).toBe(60);
    expect(e.generator).toMatch(/^PrusaSlicer 2\.9\.0/);
    expect(e.source).toEqual({ time: "slicer", filament: "slicer" });
  });

  it("parses OrcaSlicer header values", () => {
    const e = analyzeGcode(ORCA_GCODE);
    expect(e.printTimeS).toBe(360);
    expect(e.layerCount).toBe(3);
    expect(e.filamentMm).toBeCloseTo(456.7);
    expect(e.nozzleTempC).toBe(205);
    expect(e.generator).toMatch(/^OrcaSlicer 2\.2\.0/);
  });

  it("falls back to computing from moves", () => {
    const bare = PRUSA_GCODE.split("\n").filter((l) => !l.startsWith(";")).join("\n");
    const e = analyzeGcode(bare);
    expect(e.source).toEqual({ time: "computed", filament: "computed" });
    expect(e.filamentMm).toBeCloseTo(12);
    expect(e.layerCount).toBe(3);
    expect(e.layerHeightMm).toBeCloseTo(0.2);
    expect(e.filamentG).toBeCloseTo((12 * Math.PI * 0.875 ** 2 * 1.24) / 1000, 5);
    expect(e.printTimeS).toBeGreaterThan(0);
  });

  it("parses durations", () => {
    expect(parseDuration("1d 2h 3m 4s")).toBe(93784);
    expect(parseDuration("45s")).toBe(45);
    expect(parseDuration("n/a")).toBeNull();
  });

  it("extracts per-layer toolpaths", () => {
    const layers = extractLayers(PRUSA_GCODE);
    expect(layers.map((l) => l.z)).toEqual([0.2, 0.4, 0.6]);
    expect(layers.every((l) => Math.abs(l.heightMm - 0.2) < 1e-9)).toBe(true);
    expect(layers[0].paths).toHaveLength(1);
    expect(layers[0].paths[0]).toMatchObject({ kind: "extrude", feature: "External perimeter" });
    expect(layers[0].paths[0].points).toEqual([100, 100, 120, 100, 120, 120, 100, 120, 100, 100]);
    expect(layers[2].paths[0].feature).toBe("Top solid infill");
    expect(layers[1].extrudedMm).toBeCloseTo(4);
    const withTravel = extractLayers(ORCA_GCODE, { includeTravel: true });
    expect(withTravel).toHaveLength(3);
    expect(withTravel[0].paths.map((p) => p.kind)).toEqual(["extrude"]);
    expect(extractLayers(PRUSA_GCODE, { maxLayers: 2 })).toHaveLength(2);
  });

  it("handles relative extrusion (M83)", () => {
    const layers = extractLayers(ORCA_GCODE);
    expect(layers[0].extrudedMm).toBeCloseTo(1);
    expect(layers[0].paths[0].feature).toBe("Outer wall");
  });
});
