// Basic, conservative mesh repair. It does NOT fill holes or fix self-intersections;
// PrusaSlicer/OrcaSlicer run their own repair on import and cope with small defects.
import { faceArea, signedVolume, triangleCount, type Mesh } from "./mesh";
import { defaultMinArea, defaultWeldTolerance, degenerateTriangles, findShells, weldVertices } from "./topology";

export interface RepairOptions {
  weldTolerance?: number;
  minArea?: number;
  /**
   * Remove shells whose surface area is below this fraction of the total (the largest
   * shell is always kept). Default 0.001 (0.1 %). Set 0 to keep every shell.
   */
  minShellAreaFraction?: number;
  /** Remove shells with fewer triangles than this. Default 0 (disabled). */
  minShellTriangles?: number;
}

export interface RepairSummary {
  verticesMerged: number;
  degenerateFacesRemoved: number;
  duplicateFacesRemoved: number;
  facesFlipped: number;
  /** Shells whose orientation was reversed so their volume is positive (outward normals). */
  shellsInverted: number;
  shellsRemoved: number;
  trianglesRemovedWithShells: number;
  /** Normals are recomputed from winding whenever the mesh is written (STL normals are never trusted). */
  normalsRecomputed: true;
  changed: boolean;
  notes: string[];
}

export function repairMesh(input: Mesh, opts: RepairOptions = {}): { mesh: Mesh; summary: RepairSummary } {
  const notes: string[] = [];
  // 1. Weld.
  const welded = weldVertices(input, opts.weldTolerance ?? defaultWeldTolerance(input));
  let mesh = welded.mesh;

  // 2. Drop degenerate and duplicate faces.
  const bad = new Set(degenerateTriangles(mesh, opts.minArea ?? defaultMinArea(input)));
  const seen = new Set<string>();
  let duplicates = 0;
  mesh = filterTriangles(mesh, (t, a, b, c) => {
    if (bad.has(t)) return false;
    const key = [a, b, c].sort((x, y) => x - y).join(",");
    if (seen.has(key)) {
      duplicates++;
      return false;
    }
    seen.add(key);
    return true;
  });

  // 3. Remove tiny disconnected shells.
  const fraction = opts.minShellAreaFraction ?? 0.001;
  const minTris = opts.minShellTriangles ?? 0;
  let shellsRemoved = 0, trisRemoved = 0;
  {
    const { shells } = findShells(mesh);
    if (shells.length > 1 && (fraction > 0 || minTris > 0)) {
      const areas = shells.map((s) => s.reduce((acc, t) => acc + faceArea(mesh, t), 0));
      const total = areas.reduce((a, b) => a + b, 0);
      const largest = areas.indexOf(Math.max(...areas));
      const drop = new Set<number>();
      shells.forEach((s, i) => {
        if (i === largest) return;
        if (areas[i] < fraction * total || s.length < minTris) {
          shellsRemoved++;
          trisRemoved += s.length;
          for (const t of s) drop.add(t);
        }
      });
      if (drop.size) mesh = filterTriangles(mesh, (t) => !drop.has(t));
    }
  }

  // 4. Consistent winding per shell (BFS over manifold edges), then outward orientation.
  const { flipped, inverted } = orientShells(mesh);
  if (flipped || inverted) notes.push("winding made consistent; shells oriented outward by signed volume");

  mesh = compact(mesh);
  const summary: RepairSummary = {
    verticesMerged: welded.merged,
    degenerateFacesRemoved: bad.size,
    duplicateFacesRemoved: duplicates,
    facesFlipped: flipped,
    shellsInverted: inverted,
    shellsRemoved,
    trianglesRemovedWithShells: trisRemoved,
    normalsRecomputed: true,
    changed: bad.size + duplicates + flipped + inverted + shellsRemoved > 0,
    notes,
  };
  if (welded.merged > 0) notes.push(`${welded.merged} duplicate vertices welded`);
  notes.push("holes are not filled; open edges remain open (the slicer's own repair may close small gaps)");
  return { mesh, summary };
}

/** Flips triangles in place so each shell is consistently wound with positive volume. */
function orientShells(mesh: Mesh): { flipped: number; inverted: number } {
  const idx = mesh.indices;
  const nt = triangleCount(mesh);
  const nv = mesh.positions.length / 3;
  const edgeTris = new Map<number, number[]>();
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const u = idx[t * 3 + k], v = idx[t * 3 + ((k + 1) % 3)];
      const key = u < v ? u * nv + v : v * nv + u;
      const list = edgeTris.get(key);
      if (list) list.push(t);
      else edgeTris.set(key, [t]);
    }
  }
  const hasDirected = (t: number, u: number, v: number) => {
    for (let k = 0; k < 3; k++) if (idx[t * 3 + k] === u && idx[t * 3 + ((k + 1) % 3)] === v) return true;
    return false;
  };
  const flip = (t: number) => {
    const tmp = idx[t * 3 + 1];
    idx[t * 3 + 1] = idx[t * 3 + 2];
    idx[t * 3 + 2] = tmp;
  };
  const visited = new Uint8Array(nt);
  let flipped = 0, inverted = 0;
  for (let seed = 0; seed < nt; seed++) {
    if (visited[seed]) continue;
    visited[seed] = 1;
    const component = [seed];
    const queue = [seed];
    while (queue.length) {
      const t = queue.pop()!;
      for (let k = 0; k < 3; k++) {
        const u = idx[t * 3 + k], v = idx[t * 3 + ((k + 1) % 3)];
        const list = edgeTris.get(u < v ? u * nv + v : v * nv + u)!;
        if (list.length !== 2) continue; // only propagate across manifold edges
        const o = list[0] === t ? list[1] : list[0];
        if (visited[o]) continue;
        visited[o] = 1;
        // Neighbour must traverse the shared edge as v->u; if it has u->v it is flipped.
        if (hasDirected(o, u, v)) {
          flip(o);
          flipped++;
        }
        component.push(o);
        queue.push(o);
      }
    }
    if (signedVolume(mesh, component) < 0) {
      for (const t of component) flip(t);
      inverted++;
    }
  }
  return { flipped, inverted };
}

function filterTriangles(mesh: Mesh, keep: (t: number, a: number, b: number, c: number) => boolean): Mesh {
  const idx = mesh.indices;
  const out: number[] = [];
  for (let t = 0; t < idx.length / 3; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    if (keep(t, a, b, c)) out.push(a, b, c);
  }
  return { positions: mesh.positions, indices: Uint32Array.from(out) };
}

/** Drops unreferenced vertices. */
function compact(mesh: Mesh): Mesh {
  const map = new Int32Array(mesh.positions.length / 3).fill(-1);
  const pos: number[] = [];
  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i];
    if (map[v] < 0) {
      map[v] = pos.length / 3;
      pos.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
    }
    indices[i] = map[v];
  }
  return { positions: Float32Array.from(pos), indices };
}
