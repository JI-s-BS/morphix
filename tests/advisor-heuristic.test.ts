import { describe, expect, it } from "vitest";
import {
  ADVICE_LIMITS,
  autoOrient,
  computeBounds,
  heuristicAdvice,
  inferIntendedUse,
  overhangStats,
  validateMesh,
  type AdviseSlicingInput,
  type Mesh,
  type SlicerInfo,
} from "@morphix/slicing";
import { box } from "./phase3-fixtures";
import { cShape, tShape } from "./advisor-fixtures";

const PRUSA: SlicerInfo = { kind: "prusaslicer", path: "/usr/bin/prusa-slicer", version: "2.9.0" };
const ORCA: SlicerInfo = { kind: "orcaslicer", path: "/opt/OrcaSlicer/orca-slicer", version: "2.2.0" };

function inputFor(mesh: Mesh, extra: Partial<AdviseSlicingInput> = {}): AdviseSlicingInput {
  return {
    size: computeBounds(mesh).size,
    validation: validateMesh(mesh),
    overhang: overhangStats(mesh),
    orientation: autoOrient(mesh, { keepBias: Infinity }),
    availableSlicers: [PRUSA],
    ...extra,
  };
}

describe("overhangStats", () => {
  it("finds no overhangs on a cube and measures bed contact", () => {
    const s = overhangStats(box(20, 20, 20));
    expect(s.overhangAreaMm2).toBe(0);
    expect(s.bedContactAreaMm2).toBeCloseTo(400, 3);
    expect(s.totalAreaMm2).toBeCloseTo(2400, 3);
    expect(s.maxOverhangAngleDeg).toBe(0);
    expect(s.plateReachableRatio).toBe(1);
  });

  it("measures a flat ceiling over the plate", () => {
    const s = overhangStats(tShape());
    expect(s.overhangAreaMm2).toBeCloseTo(1600, 0);
    expect(s.severeOverhangAreaMm2).toBeCloseTo(1600, 0);
    expect(s.maxOverhangAngleDeg).toBe(90);
    expect(s.plateReachableRatio).toBeGreaterThan(0.95);
  });

  it("sees overhangs that sit above the model", () => {
    const s = overhangStats(cShape());
    // Top slab underside (1600) plus the pillar's underside resting on the bottom slab (400).
    expect(s.overhangAreaMm2).toBeCloseTo(2000, 0);
    // Only the faces resting on the pillar / bottom slab (2 x 400) count as reachable.
    expect(s.plateReachableRatio).toBeGreaterThan(0.35);
    expect(s.plateReachableRatio).toBeLessThan(0.45);
  });
});

describe("heuristicAdvice", () => {
  it("prints a plain cube with defaults and no supports", () => {
    const a = heuristicAdvice(inputFor(box(30, 30, 30)));
    expect(a).toMatchObject({ slicer: "prusaslicer", slicerPath: PRUSA.path, layerHeightMm: 0.2, infillPercent: 15, walls: 2, supports: "none", orientation: "auto", brim: false, brimWidthMm: 0, source: "heuristic" });
    expect(a.reasons.join(" ")).toMatch(/no supports/i);
    expect(a.warnings).toEqual([]);
    expect(a.confidence).toBeGreaterThan(0.5);
  });

  it("chooses build-plate supports for a T and model supports for a C", () => {
    expect(heuristicAdvice(inputFor(tShape())).supports).toBe("buildplate");
    expect(heuristicAdvice(inputFor(cShape())).supports).toBe("auto");
  });

  it("adds a brim to tall thin parts", () => {
    const a = heuristicAdvice(inputFor(box(10, 10, 80)));
    expect(a.brim).toBe(true);
    expect(a.brimWidthMm).toBe(8);
    expect(a.reasons.join(" ")).toMatch(/tall and thin/);
    expect(heuristicAdvice(inputFor(box(15, 15, 45))).brimWidthMm).toBe(5);
  });

  it("makes functional parts stronger", () => {
    const a = heuristicAdvice(inputFor(box(40, 30, 20), { intendedUse: "functional" }));
    expect(a).toMatchObject({ infillPercent: 30, walls: 3, intendedUse: "functional" });
    const strong = heuristicAdvice(inputFor(box(40, 30, 20), { description: "a strong wall bracket for a shelf" }));
    expect(strong).toMatchObject({ infillPercent: 40, walls: 4, intendedUse: "functional" });
  });

  it("uses fine layers for tiny or small decorative models and draft layers for huge ones", () => {
    expect(heuristicAdvice(inputFor(box(15, 15, 15))).layerHeightMm).toBe(0.12);
    expect(heuristicAdvice(inputFor(box(40, 40, 40), { intendedUse: "decorative" })).layerHeightMm).toBe(0.15);
    const huge = heuristicAdvice(inputFor(box(200, 200, 160), { intendedUse: "decorative" }));
    expect(huge.layerHeightMm).toBe(0.28);
    expect(huge.infillPercent).toBe(10);
    expect(huge.brim).toBe(true);
    expect(heuristicAdvice(inputFor(box(200, 200, 160), { intendedUse: "functional" })).layerHeightMm).toBe(0.25);
  });

  it("prefers PrusaSlicer, falls back to Orca and explains when none is installed", () => {
    expect(heuristicAdvice(inputFor(box(30, 30, 30), { availableSlicers: [ORCA, PRUSA] })).slicer).toBe("prusaslicer");
    const orca = heuristicAdvice(inputFor(box(30, 30, 30), { availableSlicers: [ORCA] }));
    expect(orca.slicer).toBe("orcaslicer");
    expect(orca.reasons.join(" ")).toMatch(/OrcaSlicer instead/);
    const none = heuristicAdvice(inputFor(box(30, 30, 30), { availableSlicers: [] }));
    expect(none.slicer).toBeNull();
    expect(none.warnings.join(" ")).toMatch(/sudo apt install prusa-slicer/);
  });

  it("keeps a decorative model upright when auto-orient laid it down but the pose is printable", () => {
    const mesh = box(10, 10, 80);
    const o = autoOrient(mesh);
    expect(o.unchanged).toBe(false);
    const a = heuristicAdvice({ ...inputFor(mesh), orientation: o, intendedUse: "decorative" });
    expect(a.orientation).toBe("keep");
    expect(heuristicAdvice({ ...inputFor(mesh), orientation: o, intendedUse: "functional" }).orientation).toBe("auto");
    expect(heuristicAdvice({ ...inputFor(mesh), lockOrientation: "keep" }).orientation).toBe("keep");
  });

  it("warns about size, tiny parts and holes, and works without measurements", () => {
    const big = heuristicAdvice({ size: { x: 300, y: 50, z: 50 }, availableSlicers: [PRUSA] });
    expect(big.warnings.join(" ")).toMatch(/too big/);
    expect(big.confidence).toBeLessThan(0.7);
    const tiny = heuristicAdvice(inputFor(box(5, 5, 5)));
    expect(tiny.warnings.join(" ")).toMatch(/tiny/);
    for (const a of [big, tiny]) {
      expect(a.layerHeightMm).toBeGreaterThanOrEqual(ADVICE_LIMITS.layerHeightMm.min);
      expect(a.layerHeightMm).toBeLessThanOrEqual(ADVICE_LIMITS.layerHeightMm.max);
    }
  });

  it("infers intended use from the description", () => {
    expect(inferIntendedUse("a phone stand")).toBe("functional");
    expect(inferIntendedUse("a cute dragon figurine")).toBe("decorative");
    expect(inferIntendedUse("a thing")).toBe("unknown");
    expect(inferIntendedUse(undefined)).toBe("unknown");
  });
});
