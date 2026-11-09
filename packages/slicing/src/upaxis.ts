// Up-axis detection and normalisation. STL has no orientation convention; Meshy's STL
// export may be Y-up (like its GLB) or Z-up — UNVERIFIED. Everything downstream expects Z-up.
import { computeBounds, faceCross, mapVertices, triangleCount, type Mesh } from "./mesh";

export type UpAxis = "z" | "y";

export interface UpAxisDetection {
  axis: UpAxis;
  /** "reference": matched against a Z-up reference mesh (e.g. the Meshy GLB of the same model);
   *  "heuristic": flat-base evidence; "default": no evidence, assumed Z-up. */
  method: "reference" | "heuristic" | "default";
  reason: string;
}

/** Y-up -> Z-up: (x, y, z) -> (x, -z, y). A proper rotation (+90 deg about X), winding preserved. */
export function yUpToZUp(mesh: Mesh): Mesh {
  return mapVertices(mesh, (x, y, z) => [x, -z, y]);
}

export function normalizeUpAxis(mesh: Mesh, axis: UpAxis): Mesh {
  return axis === "y" ? yUpToZUp(mesh) : mesh;
}

/**
 * Decides whether `mesh` is Y-up or Z-up.
 * With `reference` (a Z-up mesh of the same model, such as the converted GLB), compares
 * bounding-box proportions of both interpretations; scale does not matter.
 * Without it, compares the flat-base area on the bottom of Z against the bottom of Y and
 * only reports Y-up on strong evidence (> 3x and > 1 % of the surface).
 */
export function detectUpAxis(mesh: Mesh, reference?: Mesh): UpAxisDetection {
  const s = computeBounds(mesh).size;
  if (reference) {
    const r = computeBounds(reference).size;
    const err = (a: [number, number, number]) => {
      const k = [a[0] / r.x, a[1] / r.y, a[2] / r.z].map((v) => Math.log(v || 1e-12));
      const mean = (k[0] + k[1] + k[2]) / 3;
      return Math.hypot(k[0] - mean, k[1] - mean, k[2] - mean);
    };
    const ez = err([s.x, s.y, s.z]);
    const ey = err([s.x, s.z, s.y]); // Y-up after conversion has size (x, z, y)
    if (Math.abs(ez - ey) > 0.05) {
      const axis: UpAxis = ey < ez ? "y" : "z";
      return { axis, method: "reference", reason: `bounding-box proportions match the reference as ${axis.toUpperCase()}-up (error ${Math.min(ez, ey).toFixed(3)} vs ${Math.max(ez, ey).toFixed(3)})` };
    }
    // Proportions ambiguous (e.g. Y and Z extents equal): fall through to the heuristic.
  }
  const baseZ = baseArea(mesh, 2), baseY = baseArea(mesh, 1);
  let total = 0;
  for (let t = 0; t < triangleCount(mesh); t++) {
    const c = faceCross(mesh, t);
    total += Math.hypot(c[0], c[1], c[2]) / 2;
  }
  if (baseY > 3 * baseZ && baseY > 0.01 * total) {
    return { axis: "y", method: "heuristic", reason: `flat base at min Y (${baseY.toFixed(1)} mm^2) vs min Z (${baseZ.toFixed(1)} mm^2)` };
  }
  if (baseZ > 0.01 * total) return { axis: "z", method: "heuristic", reason: `flat base at min Z (${baseZ.toFixed(1)} mm^2)` };
  return { axis: "z", method: "default", reason: "no clear flat base; assumed Z-up (pass upAxis or a reference GLB to be sure)" };
}

/** Area of faces pointing (within ~8 deg) down along `axis` and lying at its minimum. */
function baseArea(mesh: Mesh, axis: 1 | 2): number {
  const b = computeBounds(mesh);
  const min = axis === 2 ? b.min.z : b.min.y;
  const extent = Math.hypot(b.size.x, b.size.y, b.size.z);
  const tol = Math.max(extent * 5e-4, 1e-6);
  const p = mesh.positions, idx = mesh.indices;
  let area = 0;
  const c = [0, 0, 0];
  for (let t = 0; t < triangleCount(mesh); t++) {
    faceCross(mesh, t, c);
    const l = Math.hypot(c[0], c[1], c[2]);
    if (l === 0 || c[axis] / l > -0.99) continue;
    if ([0, 1, 2].every((k) => p[idx[t * 3 + k] * 3 + axis] - min < tol)) area += l / 2;
  }
  return area;
}
