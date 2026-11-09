// Core triangle-mesh type and geometric helpers shared by the Phase 3 modules.
// Units are millimetres, Z up (printer convention) unless a function says otherwise.

export type Vec3 = { x: number; y: number; z: number };

/** Indexed triangle mesh. `indices.length` is 3 * triangle count. */
export interface Mesh {
  positions: Float32Array; // xyz per vertex
  indices: Uint32Array; // 3 vertex indices per triangle
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
}

/** Row-major 3x3 rotation matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function triangleCount(mesh: Mesh): number {
  return mesh.indices.length / 3;
}

export function vertexCount(mesh: Mesh): number {
  return mesh.positions.length / 3;
}

/** Builds a mesh from a flat triangle soup (9 floats per triangle). Vertices are not shared. */
export function meshFromSoup(soup: ArrayLike<number>): Mesh {
  const positions = Float32Array.from(soup as ArrayLike<number>);
  const indices = new Uint32Array(positions.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

export function cloneMesh(mesh: Mesh): Mesh {
  return { positions: mesh.positions.slice(), indices: mesh.indices.slice() };
}

export function computeBounds(mesh: Mesh): Bounds {
  const p = mesh.positions;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  // Only vertices referenced by triangles count (unreferenced vertices are ignored).
  const idx = mesh.indices;
  for (let i = 0; i < idx.length; i++) {
    const o = idx[i] * 3;
    for (let k = 0; k < 3; k++) {
      const v = p[o + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!Number.isFinite(min[0])) return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 0, z: 0 } };
  return {
    min: { x: min[0], y: min[1], z: min[2] },
    max: { x: max[0], y: max[1], z: max[2] },
    size: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
  };
}

export function diagonal(b: Bounds): number {
  return Math.hypot(b.size.x, b.size.y, b.size.z);
}

/** Unnormalised face normal (length = 2 * area) of triangle t. */
export function faceCross(mesh: Mesh, t: number, out: number[] = [0, 0, 0]): number[] {
  const p = mesh.positions;
  const a = mesh.indices[t * 3] * 3, b = mesh.indices[t * 3 + 1] * 3, c = mesh.indices[t * 3 + 2] * 3;
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
  out[0] = uy * vz - uz * vy;
  out[1] = uz * vx - ux * vz;
  out[2] = ux * vy - uy * vx;
  return out;
}

export function faceArea(mesh: Mesh, t: number): number {
  const n = faceCross(mesh, t);
  return 0.5 * Math.hypot(n[0], n[1], n[2]);
}

/** Unit face normals (zero vector for degenerate faces). Used when writing STL. */
export function computeFaceNormals(mesh: Mesh): Float32Array {
  const n = triangleCount(mesh);
  const out = new Float32Array(n * 3);
  const c = [0, 0, 0];
  for (let t = 0; t < n; t++) {
    faceCross(mesh, t, c);
    const l = Math.hypot(c[0], c[1], c[2]);
    if (l > 0) {
      out[t * 3] = c[0] / l;
      out[t * 3 + 1] = c[1] / l;
      out[t * 3 + 2] = c[2] / l;
    }
  }
  return out;
}

export function surfaceArea(mesh: Mesh): number {
  let a = 0;
  for (let t = 0; t < triangleCount(mesh); t++) a += faceArea(mesh, t);
  return a;
}

/** Signed volume via the divergence theorem; positive for outward-facing closed meshes. */
export function signedVolume(mesh: Mesh, tris?: Iterable<number>): number {
  const p = mesh.positions;
  const idx = mesh.indices;
  let v = 0;
  const list = tris ?? range(triangleCount(mesh));
  for (const t of list) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

function* range(n: number): Iterable<number> {
  for (let i = 0; i < n; i++) yield i;
}

// ---------------------------------------------------------------- transforms

/** Returns a new mesh with every vertex mapped through `f(x, y, z) -> [x, y, z]`. */
export function mapVertices(mesh: Mesh, f: (x: number, y: number, z: number) => [number, number, number]): Mesh {
  const src = mesh.positions;
  const dst = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const r = f(src[i], src[i + 1], src[i + 2]);
    dst[i] = r[0];
    dst[i + 1] = r[1];
    dst[i + 2] = r[2];
  }
  return { positions: dst, indices: mesh.indices.slice() };
}

export function scaleMesh(mesh: Mesh, k: number): Mesh {
  return mapVertices(mesh, (x, y, z) => [x * k, y * k, z * k]);
}

export function translateMesh(mesh: Mesh, d: Vec3): Mesh {
  return mapVertices(mesh, (x, y, z) => [x + d.x, y + d.y, z + d.z]);
}

/** Applies a rotation matrix. A negative determinant also flips triangle winding to keep normals outward. */
export function rotateMesh(mesh: Mesh, m: Mat3): Mesh {
  const out = mapVertices(mesh, (x, y, z) => [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ]);
  if (det3(m) < 0) flipAllWinding(out);
  return out;
}

export function flipAllWinding(mesh: Mesh): void {
  const idx = mesh.indices;
  for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = t;
  }
}

export function det3(m: Mat3): number {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

/** Rotation (Rodrigues) that maps unit vector `from` onto unit vector `to`. */
export function rotationBetween(from: Vec3, to: Vec3): Mat3 {
  const f = normalize(from), t = normalize(to);
  const c = f.x * t.x + f.y * t.y + f.z * t.z;
  if (c > 1 - 1e-12) return [...IDENTITY3] as Mat3;
  if (c < -1 + 1e-12) {
    // 180 degrees about any axis perpendicular to `from`.
    const axis = Math.abs(f.x) < 0.9 ? normalize(cross(f, { x: 1, y: 0, z: 0 })) : normalize(cross(f, { x: 0, y: 1, z: 0 }));
    return axisAngle(axis, Math.PI);
  }
  const v = cross(f, t);
  const k = 1 / (1 + c);
  return [
    v.x * v.x * k + c, v.x * v.y * k - v.z, v.x * v.z * k + v.y,
    v.y * v.x * k + v.z, v.y * v.y * k + c, v.y * v.z * k - v.x,
    v.z * v.x * k - v.y, v.z * v.y * k + v.x, v.z * v.z * k + c,
  ];
}

export function axisAngle(axis: Vec3, angle: number): Mat3 {
  const { x, y, z } = normalize(axis);
  const c = Math.cos(angle), s = Math.sin(angle), C = 1 - c;
  return [
    x * x * C + c, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, y * y * C + c, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, z * z * C + c,
  ];
}

export function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** Concatenates meshes into one (no welding). */
export function mergeMeshes(meshes: Mesh[]): Mesh {
  let nv = 0, ni = 0;
  for (const m of meshes) {
    nv += m.positions.length;
    ni += m.indices.length;
  }
  const positions = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  let pv = 0, pi = 0;
  for (const m of meshes) {
    positions.set(m.positions, pv);
    const base = pv / 3;
    for (let i = 0; i < m.indices.length; i++) indices[pi + i] = m.indices[i] + base;
    pv += m.positions.length;
    pi += m.indices.length;
  }
  return { positions, indices };
}
