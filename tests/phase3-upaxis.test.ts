import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGlb, computeBounds, detectUpAxis, preparePrint, signedVolume, writeBinaryStl, yUpToZUp, type Mesh } from "@morphix/slicing";
import { box, invertedPyramid } from "./phase3-fixtures";

/** Upright pyramid with its base on min Y (a Y-up "figurine"). */
function yUpPyramid(): Mesh {
  // invertedPyramid has its base at max Z; mirror to base at min Z, then rotate Z-up -> Y-up.
  const p = invertedPyramid();
  const pos = p.positions.slice();
  for (let i = 0; i < pos.length; i += 3) {
    const z = 20 - pos[i + 2];
    const y = pos[i + 1];
    pos[i + 1] = z; // Z-up -> Y-up: (x, y, z) -> (x, z, -y)
    pos[i + 2] = -y;
  }
  // The mirror flipped orientation; restore outward winding.
  const idx = p.indices.slice();
  for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  return { positions: pos, indices: idx };
}

describe("up axis", () => {
  it("converts Y-up to Z-up as a proper rotation", () => {
    const m = yUpToZUp(box(10, 30, 20));
    expect(computeBounds(m).size).toEqual({ x: 10, y: 20, z: 30 });
    expect(signedVolume(m)).toBeCloseTo(6000);
  });

  it("matches proportions against a Z-up reference (scale-independent)", () => {
    const reference = box(0.3, 0.2, 0.5); // GLB after conversion: 0.5 tall
    expect(detectUpAxis(box(30, 50, 20), reference)).toMatchObject({ axis: "y", method: "reference" });
    expect(detectUpAxis(box(30, 20, 50), reference)).toMatchObject({ axis: "z", method: "reference" });
  });

  it("uses flat-base evidence without a reference", () => {
    const y = yUpPyramid();
    expect(signedVolume(y)).toBeGreaterThan(0);
    expect(detectUpAxis(y)).toMatchObject({ axis: "y", method: "heuristic" });
    expect(detectUpAxis(yUpToZUp(y))).toMatchObject({ axis: "z", method: "heuristic" });
    expect(detectUpAxis(box(10, 10, 10)).axis).toBe("z"); // ties stay Z-up
  });

  it("preparePrint normalises a Y-up STL using the sibling GLB", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morphix-up-"));
    const b = box(0.3, 0.5, 0.2); // Meshy GLB: Y-up, 0.5 tall
    await writeFile(join(dir, "model.glb"), buildGlb([{ positions: b.positions, indices: b.indices }]));
    await writeFile(join(dir, "model.stl"), writeBinaryStl(box(30, 50, 20))); // same model, Y-up STL
    const r = await preparePrint({ inputPath: join(dir, "model.stl"), targetHeightMm: 80, options: { slice: false, orientation: "keep", outputDir: join(dir, "out") } });
    expect(r.upAxis).toMatchObject({ axis: "y", method: "reference" });
    expect(r.size.z).toBeCloseTo(80, 3);
    expect(r.size.x).toBeCloseTo(48, 3);
    expect(r.size.y).toBeCloseTo(32, 3);
  });

  it("honours a forced up axis for STL and GLB", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morphix-up-"));
    const stl = await preparePrint({ buffer: writeBinaryStl(box(30, 50, 20)), format: "stl", options: { slice: false, orientation: "keep", upAxis: "y", outputDir: dir } });
    expect(stl.size).toEqual({ x: 30, y: 20, z: 50 });
    const b = box(1, 2, 3);
    const glb = await preparePrint({ buffer: buildGlb([{ positions: b.positions, indices: b.indices }]), options: { slice: false, orientation: "keep", upAxis: "z", glbUnitScaleMm: 10, outputDir: dir } });
    expect(glb.upAxis.axis).toBe("z");
    expect(glb.size.z).toBeCloseTo(30);
  });
});
