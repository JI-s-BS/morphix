// Mesh validation report (read-only; see repair.ts for fixes).
import { computeBounds, faceArea, signedVolume, surfaceArea, triangleCount, vertexCount, type Bounds, type Mesh } from "./mesh";
import { defaultMinArea, defaultWeldTolerance, degenerateTriangles, edgeStats, findShells, weldVertices, type EdgeStats } from "./topology";

export interface ShellInfo {
  triangles: number;
  areaMm2: number;
  /** Signed volume; only meaningful for closed shells. */
  volumeMm3: number;
  closed: boolean;
}

export interface ValidationReport {
  triangles: number;
  /** Vertices as stored (STL input stores 3 per triangle). */
  vertices: number;
  /** Distinct vertices after welding with `weldTolerance`. */
  uniqueVertices: number;
  weldTolerance: number;
  bounds: Bounds;
  surfaceAreaMm2: number;
  /** |signed volume|; reliable only when `watertight`. */
  volumeMm3: number;
  /** Signed volume < 0: normals predominantly point inwards. */
  inverted: boolean;
  degenerateFaces: number;
  edges: EdgeStats;
  /** Every edge shared by exactly two consistently oriented triangles. */
  watertight: boolean;
  /** No edge shared by more than two triangles. */
  manifold: boolean;
  consistentWinding: boolean;
  shellCount: number;
  /** Largest shells first, at most 20. */
  shells: ShellInfo[];
  /** Non-finite coordinates (NaN/Infinity) found in the input. */
  invalidCoordinates: number;
  /** Human-readable problems, empty when the mesh is clean. */
  issues: string[];
  /** True when nothing should stop slicing (slicers can still cope with minor issues). */
  printable: boolean;
}

export interface ValidateOptions {
  weldTolerance?: number;
  minArea?: number;
}

export function validateMesh(mesh: Mesh, opts: ValidateOptions = {}): ValidationReport {
  let invalidCoordinates = 0;
  for (const v of mesh.positions) if (!Number.isFinite(v)) invalidCoordinates++;
  const tol = opts.weldTolerance ?? defaultWeldTolerance(mesh);
  const welded = weldVertices(mesh, tol).mesh;
  const minArea = opts.minArea ?? defaultMinArea(mesh);
  const degenerate = new Set(degenerateTriangles(welded, minArea));
  const edges = edgeStats(welded);
  const { shells } = findShells(welded);

  // A shell is closed when none of its edges are boundary edges.
  const boundaryVerts = boundaryVertexSet(welded);
  const shellInfo: ShellInfo[] = shells.map((tris) => {
    let area = 0;
    let closed = true;
    for (const t of tris) {
      area += faceArea(welded, t);
      if (closed && !degenerate.has(t)) {
        const i = welded.indices;
        if (boundaryVerts.has(i[t * 3]) || boundaryVerts.has(i[t * 3 + 1]) || boundaryVerts.has(i[t * 3 + 2])) closed = false;
      }
    }
    return { triangles: tris.length, areaMm2: area, volumeMm3: signedVolume(welded, tris), closed };
  });
  shellInfo.sort((a, b) => b.areaMm2 - a.areaMm2);

  const vol = signedVolume(welded);
  const watertight = edges.boundaryEdges === 0 && edges.nonManifoldEdges === 0 && edges.inconsistentEdges === 0 && triangleCount(mesh) > 0;
  const issues: string[] = [];
  const n = triangleCount(mesh);
  if (n === 0) issues.push("mesh has no triangles");
  if (invalidCoordinates) issues.push(`${invalidCoordinates} non-finite coordinates`);
  if (degenerate.size) issues.push(`${degenerate.size} degenerate (zero-area) faces`);
  if (edges.boundaryEdges) issues.push(`${edges.boundaryEdges} open (boundary) edges: mesh is not watertight`);
  if (edges.nonManifoldEdges) issues.push(`${edges.nonManifoldEdges} non-manifold edges (shared by >2 faces)`);
  if (edges.inconsistentEdges) issues.push(`${edges.inconsistentEdges} edges with inconsistent winding`);
  if (vol < 0) issues.push("normals point inwards (negative volume)");
  if (shells.length > 1) issues.push(`${shells.length} disconnected shells`);
  return {
    triangles: n,
    vertices: vertexCount(mesh),
    uniqueVertices: welded.positions.length / 3,
    weldTolerance: tol,
    bounds: computeBounds(mesh),
    surfaceAreaMm2: surfaceArea(welded),
    volumeMm3: Math.abs(vol),
    inverted: vol < 0,
    degenerateFaces: degenerate.size,
    edges,
    watertight,
    manifold: edges.nonManifoldEdges === 0,
    consistentWinding: edges.inconsistentEdges === 0,
    shellCount: shells.length,
    shells: shellInfo.slice(0, 20),
    invalidCoordinates,
    issues,
    printable: n > 0 && invalidCoordinates === 0 && Math.abs(vol) > 0,
  };
}

function boundaryVertexSet(mesh: Mesh): Set<number> {
  const idx = mesh.indices;
  const nv = mesh.positions.length / 3;
  const uses = new Map<number, number>();
  for (let t = 0; t < idx.length / 3; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? u * nv + v : v * nv + u;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  const out = new Set<number>();
  for (const [key, n] of uses) {
    if (n !== 1) continue;
    out.add(Math.floor(key / nv));
    out.add(key % nv);
  }
  return out;
}
