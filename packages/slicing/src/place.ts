// Scaling, plate placement, auto-orientation and build-volume checks.
import { QD330_BUILD_VOLUME_MM } from "@morphix/shared";
import {
  computeBounds,
  faceCross,
  IDENTITY3,
  rotateMesh,
  rotationBetween,
  scaleMesh,
  translateMesh,
  triangleCount,
  type Mat3,
  type Mesh,
  type Vec3,
} from "./mesh";

export type BuildVolume = { x: number; y: number; z: number };

/** QD330 volume from the firmware M115 report (220^3 mm) — UNVERIFIED against the official spec. */
export const DEFAULT_BUILD_VOLUME: BuildVolume = { ...QD330_BUILD_VOLUME_MM };

/** Uniformly scales the mesh so its Z extent equals `targetHeightMm`. */
export function scaleToHeight(mesh: Mesh, targetHeightMm: number): { mesh: Mesh; scale: number } {
  const h = computeBounds(mesh).size.z;
  if (!(targetHeightMm > 0) || !Number.isFinite(targetHeightMm)) throw new RangeError("target height must be a positive number of mm");
  if (!(h > 0)) throw new RangeError("mesh has zero height; cannot scale to a target height");
  const scale = targetHeightMm / h;
  return { mesh: scaleMesh(mesh, scale), scale };
}

/** Centres the mesh in X/Y on the plate centre and drops it so min Z = 0. */
export function placeOnPlate(mesh: Mesh, volume: BuildVolume = DEFAULT_BUILD_VOLUME): { mesh: Mesh; offset: Vec3 } {
  const b = computeBounds(mesh);
  const offset = {
    x: volume.x / 2 - (b.min.x + b.max.x) / 2,
    y: volume.y / 2 - (b.min.y + b.max.y) / 2,
    z: -b.min.z,
  };
  return { mesh: translateMesh(mesh, offset), offset };
}

export interface BuildVolumeResult {
  fits: boolean;
  size: Vec3;
  volume: BuildVolume;
  /** Per-axis overflow in mm (0 when within limits). */
  overflowMm: Vec3;
  /** Largest uniform scale factor (relative to the current size) that still fits. */
  maxUniformScale: number;
  /** Clear message for the UI / voice assistant. */
  message: string;
}

/** Build-volume check; `marginMm` is kept free on each side in X/Y (default 0). */
export function checkFit(size: Vec3, volume: BuildVolume = DEFAULT_BUILD_VOLUME, marginMm = 0): BuildVolumeResult {
  const lim = { x: volume.x - 2 * marginMm, y: volume.y - 2 * marginMm, z: volume.z };
  const overflowMm = { x: Math.max(0, size.x - lim.x), y: Math.max(0, size.y - lim.y), z: Math.max(0, size.z - lim.z) };
  const fits = overflowMm.x === 0 && overflowMm.y === 0 && overflowMm.z === 0;
  const ratios = [lim.x / size.x, lim.y / size.y, lim.z / size.z].filter((r) => Number.isFinite(r));
  const maxUniformScale = ratios.length ? Math.min(...ratios) : Infinity;
  const fmt = (v: number) => v.toFixed(1);
  const dims = `${fmt(size.x)} x ${fmt(size.y)} x ${fmt(size.z)} mm`;
  const message = fits
    ? `Fits: ${dims} within ${volume.x} x ${volume.y} x ${volume.z} mm.`
    : `Too large: ${dims} exceeds the ${volume.x} x ${volume.y} x ${volume.z} mm build volume` +
      ` (over by ${(["x", "y", "z"] as const).filter((k) => overflowMm[k] > 0).map((k) => `${k.toUpperCase()} ${fmt(overflowMm[k])} mm`).join(", ")}).` +
      ` Scale to at most ${(maxUniformScale * 100).toFixed(0)}% (height ${fmt(size.z * maxUniformScale)} mm).`;
  return { fits, size, volume, overflowMm, maxUniformScale, message };
}

// --------------------------------------------------------------- orientation

export interface OrientationCandidate {
  /** Model direction that ends up pointing down (-Z). */
  down: Vec3;
  rotation: Mat3;
  /** Area of faces lying flat on the bed (mm^2). */
  baseAreaMm2: number;
  /** Downward-facing area steeper than the overhang angle, excluding the base (mm^2). */
  overhangAreaMm2: number;
  heightMm: number;
  score: number;
}

export interface OrientationResult {
  rotation: Mat3;
  chosen: OrientationCandidate;
  /** True if the original orientation was kept. */
  unchanged: boolean;
  candidates: OrientationCandidate[];
}

export interface OrientOptions {
  /** Overhang threshold from vertical, degrees (default 45: faces pointing more than 45 deg downward need support). */
  overhangAngleDeg?: number;
  /** Faces within this angle of straight down and touching the bed count as base (default 5 deg). */
  flatToleranceDeg?: number;
  /** Extra normal-cluster candidates beyond the 6 axis directions (default 12). */
  maxCandidates?: number;
  /** Score margin the best candidate must beat the current orientation by (default 0.05). */
  keepBias?: number;
}

/**
 * Picks a stable lay-flat rotation. Candidates: the 6 axis directions plus the largest
 * clusters of coplanar face normals. Score (lower is better), normalised by total area:
 *   overhangArea - 2 * baseArea + 0.1 * height/diagonal.
 * The current orientation wins unless another candidate is better by `keepBias`, so
 * upright figurines are not laid on their backs for a marginal gain.
 */
export function autoOrient(mesh: Mesh, opts: OrientOptions = {}): OrientationResult {
  const n = triangleCount(mesh);
  const normals = new Float64Array(n * 3);
  const areas = new Float64Array(n);
  let total = 0;
  const c = [0, 0, 0];
  for (let t = 0; t < n; t++) {
    faceCross(mesh, t, c);
    const l = Math.hypot(c[0], c[1], c[2]);
    areas[t] = l / 2;
    total += l / 2;
    if (l > 0) {
      normals[t * 3] = c[0] / l;
      normals[t * 3 + 1] = c[1] / l;
      normals[t * 3 + 2] = c[2] / l;
    }
  }
  const dirs: Vec3[] = [
    { x: 0, y: 0, z: -1 },
    { x: 0, y: 0, z: 1 },
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
  ];
  // Area-weighted clusters of similar normals (quantised to ~3 degrees).
  const q = 20;
  const clusters = new Map<string, { x: number; y: number; z: number; a: number }>();
  for (let t = 0; t < n; t++) {
    if (areas[t] === 0) continue;
    const nx = normals[t * 3], ny = normals[t * 3 + 1], nz = normals[t * 3 + 2];
    const key = `${Math.round(nx * q)},${Math.round(ny * q)},${Math.round(nz * q)}`;
    const cl = clusters.get(key) ?? { x: 0, y: 0, z: 0, a: 0 };
    cl.x += nx * areas[t];
    cl.y += ny * areas[t];
    cl.z += nz * areas[t];
    cl.a += areas[t];
    clusters.set(key, cl);
  }
  const top = [...clusters.values()].sort((a, b) => b.a - a.a).slice(0, opts.maxCandidates ?? 12);
  for (const cl of top) {
    const l = Math.hypot(cl.x, cl.y, cl.z);
    if (l === 0) continue;
    const d = { x: cl.x / l, y: cl.y / l, z: cl.z / l };
    if (!dirs.some((e) => e.x * d.x + e.y * d.y + e.z * d.z > 0.999)) dirs.push(d);
  }

  const cosFlat = Math.cos(((opts.flatToleranceDeg ?? 5) * Math.PI) / 180);
  const sinOver = Math.cos(((opts.overhangAngleDeg ?? 45) * Math.PI) / 180);
  const b = computeBounds(mesh);
  const diag = Math.hypot(b.size.x, b.size.y, b.size.z) || 1;
  const p = mesh.positions, idx = mesh.indices;
  const candidates = dirs.map((down): OrientationCandidate => {
    const R = rotationBetween(down, { x: 0, y: 0, z: -1 });
    // Only rotated Z is needed: z' = R[6..8] . v, nz' = R[6..8] . n
    const zr = (v: number) => R[6] * p[v * 3] + R[7] * p[v * 3 + 1] + R[8] * p[v * 3 + 2];
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < idx.length; i++) {
      const z = zr(idx[i]);
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const zTol = Math.max(5e-4 * diag, 1e-4);
    let base = 0, over = 0;
    for (let t = 0; t < n; t++) {
      const nz = R[6] * normals[t * 3] + R[7] * normals[t * 3 + 1] + R[8] * normals[t * 3 + 2];
      if (nz >= -sinOver) continue;
      const onBed = zr(idx[t * 3]) - minZ < zTol && zr(idx[t * 3 + 1]) - minZ < zTol && zr(idx[t * 3 + 2]) - minZ < zTol;
      if (onBed && nz <= -cosFlat) base += areas[t];
      else over += areas[t];
    }
    const height = maxZ - minZ;
    const score = total > 0 ? (over - 2 * base) / total + (0.1 * height) / diag : 0;
    return { down, rotation: R, baseAreaMm2: base, overhangAreaMm2: over, heightMm: height, score };
  });
  const current = candidates[0];
  let best = current;
  for (const cand of candidates) if (cand.score < best.score) best = cand;
  const keep = best === current || current.score - best.score < (opts.keepBias ?? 0.05);
  const chosen = keep ? current : best;
  return { rotation: keep ? ([...IDENTITY3] as Mat3) : chosen.rotation, chosen, unchanged: keep, candidates };
}

export function applyOrientation(mesh: Mesh, o: OrientationResult): Mesh {
  return o.unchanged ? mesh : rotateMesh(mesh, o.rotation);
}
