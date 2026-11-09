// Mesh topology: vertex welding, edge classification and connected shells.
import { computeBounds, diagonal, faceCross, triangleCount, type Mesh } from "./mesh";

/** Default weld tolerance: one millionth of the bounding-box diagonal (min 1e-9). */
export function defaultWeldTolerance(mesh: Mesh): number {
  return Math.max(diagonal(computeBounds(mesh)) * 1e-6, 1e-9);
}

/**
 * Merges vertices closer than `tolerance` (grid snapping, then exact-key merge).
 * Unreferenced vertices are dropped. Triangle order and count are unchanged.
 */
export function weldVertices(mesh: Mesh, tolerance = defaultWeldTolerance(mesh)): { mesh: Mesh; merged: number } {
  const p = mesh.positions;
  const idx = mesh.indices;
  const inv = 1 / tolerance;
  const keyToNew = new Map<string, number>();
  const oldToNew = new Int32Array(p.length / 3).fill(-1);
  const out: number[] = [];
  let referenced = 0;
  const indices = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i];
    let n = oldToNew[v];
    if (n < 0) {
      referenced++;
      const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
      const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
      const found = keyToNew.get(key);
      if (found !== undefined) n = found;
      else {
        n = out.length / 3;
        out.push(x, y, z);
        keyToNew.set(key, n);
      }
      oldToNew[v] = n;
    }
    indices[i] = n;
  }
  return { mesh: { positions: Float32Array.from(out), indices }, merged: referenced - out.length / 3 };
}

export interface EdgeStats {
  edges: number;
  /** Edges used by exactly one triangle (holes / open boundary). */
  boundaryEdges: number;
  /** Edges shared by more than two triangles. */
  nonManifoldEdges: number;
  /** Manifold edges whose two triangles traverse them in the same direction (flipped neighbour). */
  inconsistentEdges: number;
}

/** Edge analysis on an already-welded mesh. Degenerate (collapsed-index) triangles are skipped. */
export function edgeStats(mesh: Mesh): EdgeStats {
  const idx = mesh.indices;
  const nv = mesh.positions.length / 3;
  // Per undirected edge: total uses and net direction (+1 for a<b traversal, -1 for b<a).
  const uses = new Map<number, number>();
  const net = new Map<number, number>();
  for (let t = 0; t < idx.length / 3; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? u * nv + v : v * nv + u;
      uses.set(key, (uses.get(key) ?? 0) + 1);
      net.set(key, (net.get(key) ?? 0) + (u < v ? 1 : -1));
    }
  }
  let boundaryEdges = 0, nonManifoldEdges = 0, inconsistentEdges = 0;
  for (const [key, n] of uses) {
    if (n === 1) boundaryEdges++;
    else if (n > 2) nonManifoldEdges++;
    else if (net.get(key) !== 0) inconsistentEdges++;
  }
  return { edges: uses.size, boundaryEdges, nonManifoldEdges, inconsistentEdges };
}

/** Connected components of triangles sharing a vertex (welded mesh). Returns shell id per triangle. */
export function findShells(mesh: Mesh): { shellOf: Int32Array; shells: number[][] } {
  const idx = mesh.indices;
  const nv = mesh.positions.length / 3;
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const nt = idx.length / 3;
  for (let t = 0; t < nt; t++) {
    union(idx[t * 3], idx[t * 3 + 1]);
    union(idx[t * 3], idx[t * 3 + 2]);
  }
  const rootToShell = new Map<number, number>();
  const shells: number[][] = [];
  const shellOf = new Int32Array(nt);
  for (let t = 0; t < nt; t++) {
    const r = find(idx[t * 3]);
    let s = rootToShell.get(r);
    if (s === undefined) {
      s = shells.length;
      rootToShell.set(r, s);
      shells.push([]);
    }
    shells[s].push(t);
    shellOf[t] = s;
  }
  return { shellOf, shells };
}

/** Triangles that are degenerate: repeated vertex index or area below `minArea`. */
export function degenerateTriangles(mesh: Mesh, minArea: number): number[] {
  const idx = mesh.indices;
  const out: number[] = [];
  const c = [0, 0, 0];
  for (let t = 0; t < triangleCount(mesh); t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], d = idx[t * 3 + 2];
    if (a === b || b === d || a === d) {
      out.push(t);
      continue;
    }
    faceCross(mesh, t, c);
    if (0.5 * Math.hypot(c[0], c[1], c[2]) <= minArea) out.push(t);
  }
  return out;
}

/** Default degenerate-area threshold: (1e-6 * diagonal)^2, i.e. effectively zero area. */
export function defaultMinArea(mesh: Mesh): number {
  const d = diagonal(computeBounds(mesh));
  return (d * 1e-6) ** 2;
}
