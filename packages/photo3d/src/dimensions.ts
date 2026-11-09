// Comparing a model's bounding box with the intended dimensions, and scaling to them.
import { computeBounds, scaleMesh, translateMesh, type Mesh, type Vec3 } from "@morphix/slicing";
import type { Dimensions } from "./analyze";
import type { Axis } from "./images";

export const DIMENSION_TOLERANCE = 0.03;
/** Below this absolute error an axis always passes (FDM can't do better anyway). */
export const DIMENSION_ABS_FLOOR_MM = 0.2;

export interface AxisCheck {
  axis: Axis;
  intendedMm: number;
  actualMm: number;
  errorPct: number;
  ok: boolean;
}

export interface DimensionCheck {
  ok: boolean;
  tolerance: number;
  axes: AxisCheck[];
  /** The sizes match only after reordering the axes (model is rotated). */
  axesSwapped: boolean;
  summary: string;
}

const AXES: [Axis, keyof Vec3][] = [["width", "x"], ["depth", "y"], ["height", "z"]];

export function checkDimensions(size: Vec3, intended: Record<Axis, { valueMm: number }>, tolerance = DIMENSION_TOLERANCE): DimensionCheck {
  const axes = AXES.map(([axis, k]) => {
    const want = intended[axis].valueMm;
    const got = size[k];
    const err = Math.abs(got - want);
    return { axis, intendedMm: round(want), actualMm: round(got), errorPct: round((err / want) * 100), ok: err <= Math.max(want * tolerance, DIMENSION_ABS_FLOOR_MM) };
  });
  const ok = axes.every((a) => a.ok);
  let axesSwapped = false;
  if (!ok) {
    const a = [size.x, size.y, size.z].sort((p, q) => p - q);
    const b = AXES.map(([axis]) => intended[axis].valueMm).sort((p, q) => p - q);
    axesSwapped = a.every((v, i) => Math.abs(v - b[i]) <= Math.max(b[i] * tolerance, DIMENSION_ABS_FLOOR_MM));
  }
  const bad = axes.filter((x) => !x.ok);
  const summary = ok
    ? `Size ${fmt(size)} mm matches the intended dimensions within ${tolerance * 100}%.`
    : `Size ${fmt(size)} mm differs from intended: ${bad.map((x) => `${x.axis} ${x.actualMm} vs ${x.intendedMm} mm (${x.errorPct}%)`).join(", ")}${axesSwapped ? " — the axes appear swapped (model is rotated)" : ""}.`;
  return { ok, tolerance, axes, axesSwapped, summary };
}

/**
 * Uniform scale for a model whose native units are arbitrary (Meshy): scale so the
 * most trustworthy dimension matches. Ties prefer the largest dimension (smallest
 * relative error from the photo).
 */
export function chooseScaleAxis(d: Dimensions): Axis {
  const axes: Axis[] = ["height", "width", "depth"];
  return axes.reduce((best, a) => {
    const da = d[a], db = d[best];
    if (da.confidence > db.confidence + 1e-9) return a;
    if (Math.abs(da.confidence - db.confidence) <= 1e-9 && da.valueMm > db.valueMm) return a;
    return best;
  }, axes[0]);
}

export function scaleToDimension(mesh: Mesh, axis: Axis, targetMm: number): { mesh: Mesh; factor: number } {
  const size = computeBounds(mesh).size;
  const k = AXES.find(([a]) => a === axis)![1];
  const factor = size[k] > 0 ? targetMm / size[k] : 1;
  return { mesh: scaleMesh(mesh, factor), factor };
}

/** Centres the model on X/Y and puts its lowest point on Z = 0. */
export function placeOnBed(mesh: Mesh): Mesh {
  const b = computeBounds(mesh);
  return translateMesh(mesh, { x: -(b.min.x + b.max.x) / 2, y: -(b.min.y + b.max.y) / 2, z: -b.min.z });
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function fmt(s: Vec3): string {
  return `${round(s.x)} x ${round(s.y)} x ${round(s.z)}`;
}
