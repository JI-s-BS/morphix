// Print preparation (Phase 3). Phase 1 only provides build-volume checks used by
// the viewer; slicing is delegated to an existing engine (OrcaSlicer/PrusaSlicer,
// validated against official Afinia slicer output) — never a slicer written from scratch.
import { fitsBuildVolume } from "@morphix/domain";
import { QD330_BUILD_VOLUME_MM } from "@morphix/shared";

// Phase 3 print-preparation engine (see docs/PHASE3.md). Anything that touches the
// QD330 file format or slicer profiles is UNVERIFIED against official Afinia output.
export * from "./mesh";
export * from "./stl";
export * from "./glb";
export * from "./topology";
export * from "./validate";
export * from "./repair";
export * from "./place";
export * from "./upaxis";
export * from "./gcode";
export * from "./thumbnail";
export * from "./gx";
export * from "./profiles";
export * from "./filaments";
export * from "./slicer";
export * from "./leveling";
export * from "./prepare";
export * from "./advisor";
export * from "./advised";

export interface SizeCheck {
  size: { x: number; y: number; z: number };
  fits: boolean;
  volume: typeof QD330_BUILD_VOLUME_MM;
}

export function checkBuildVolume(size: { x: number; y: number; z: number }): SizeCheck {
  return { size, fits: fitsBuildVolume(size, QD330_BUILD_VOLUME_MM), volume: QD330_BUILD_VOLUME_MM };
}

/** Axis-aligned size of a binary or ASCII STL, in file units (mm). */
export function stlSize(buf: Buffer): { x: number; y: number; z: number } | null {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number, z: number) => {
    const v = [x, y, z];
    for (let i = 0; i < 3; i++) {
      if (v[i] < min[i]) min[i] = v[i];
      if (v[i] > max[i]) max[i] = v[i];
    }
  };
  const isBinary = buf.length >= 84 && 84 + buf.readUInt32LE(80) * 50 === buf.length;
  if (isBinary) {
    const n = buf.readUInt32LE(80);
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50 + 12;
      for (let k = 0; k < 3; k++) add(buf.readFloatLE(o + k * 12), buf.readFloatLE(o + k * 12 + 4), buf.readFloatLE(o + k * 12 + 8));
    }
  } else {
    for (const m of buf.toString("latin1").matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) add(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  if (!Number.isFinite(min[0])) return null;
  return { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] };
}

/** Size after scaling to a target height (Z), plus the build-volume check. */
export function scaledCheck(native: { x: number; y: number; z: number }, targetHeightMm: number | null): SizeCheck {
  const k = targetHeightMm && native.z > 0 ? targetHeightMm / native.z : 1;
  return checkBuildVolume({ x: native.x * k, y: native.y * k, z: native.z * k });
}

export type SizeDimension = "height" | "width" | "length" | "longest";

/**
 * Proportional resize: the target height (Z) that makes the chosen dimension `sizeMm`.
 * Width = X, length = Y, height = Z (same axes as scaledCheck and the viewer).
 */
export function heightForDimension(native: { x: number; y: number; z: number }, dimension: SizeDimension, sizeMm: number): number {
  const along = dimension === "width" ? native.x : dimension === "length" ? native.y : dimension === "longest" ? Math.max(native.x, native.y, native.z) : native.z;
  if (!(along > 0) || !(native.z > 0)) return sizeMm;
  return (sizeMm / along) * native.z;
}
export * from "./speed";
