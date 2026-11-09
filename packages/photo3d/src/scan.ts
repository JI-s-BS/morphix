// 3D scan import: OBJ, PLY (ASCII, binary little/big endian), STL and GLB -> Mesh in
// millimetres, Z-up, on the bed. Phone LiDAR / photogrammetry apps (Polycam, Scaniverse,
// RealityScan, 3D Scanner App) usually export metres and Y-up, so both are detected.
import {
  computeBounds,
  detectUpAxis,
  faceCross,
  isBinaryStl,
  isGlb,
  parseGlb,
  parseStl,
  scaleMesh,
  yUpToZUp,
  type Mesh,
  type UpAxis,
} from "@morphix/slicing";
import { placeOnBed } from "./dimensions";
import { Photo3dError } from "./errors";
import type { LengthUnit } from "./images";

export type ScanFormat = "obj" | "ply" | "stl" | "glb";

// ------------------------------------------------------------------ OBJ

/** Wavefront OBJ: `v` and `f` records (v, v/vt, v//vn, v/vt/vn, negative indices); polygons are fan-triangulated. */
export function parseObj(buf: Uint8Array): Mesh {
  const text = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("utf8");
  const pos: number[] = [];
  const idx: number[] = [];
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo++;
    const line = raw.trim();
    if (line.startsWith("v ") || line.startsWith("v\t")) {
      const p = line.split(/\s+/);
      const x = Number(p[1]), y = Number(p[2]), z = Number(p[3]);
      if (![x, y, z].every(Number.isFinite)) throw new Photo3dError("MX-P3D-041", `OBJ line ${lineNo}: bad vertex.`);
      pos.push(x, y, z);
    } else if (line.startsWith("f ") || line.startsWith("f\t")) {
      const nv = pos.length / 3;
      const vs = line
        .split(/\s+/)
        .slice(1)
        .map((tok) => {
          const i = parseInt(tok.split("/")[0], 10);
          if (!Number.isFinite(i) || i === 0) throw new Photo3dError("MX-P3D-041", `OBJ line ${lineNo}: bad face index "${tok}".`);
          const r = i < 0 ? nv + i : i - 1;
          if (r < 0 || r >= nv) throw new Photo3dError("MX-P3D-041", `OBJ line ${lineNo}: face index ${i} is out of range.`);
          return r;
        });
      for (let k = 1; k + 1 < vs.length; k++) idx.push(vs[0], vs[k], vs[k + 1]);
    }
  }
  if (pos.length === 0) throw new Photo3dError("MX-P3D-041", "OBJ file has no vertices.");
  if (idx.length === 0) throw new Photo3dError("MX-P3D-042", "OBJ file has vertices but no faces (a point cloud); export a mesh.");
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

// ------------------------------------------------------------------ PLY

type PlyType = "int8" | "uint8" | "int16" | "uint16" | "int32" | "uint32" | "float32" | "float64";
const PLY_TYPES: Record<string, PlyType> = {
  char: "int8", int8: "int8", uchar: "uint8", uint8: "uint8",
  short: "int16", int16: "int16", ushort: "uint16", uint16: "uint16",
  int: "int32", int32: "int32", uint: "uint32", uint32: "uint32",
  float: "float32", float32: "float32", double: "float64", float64: "float64",
};
const PLY_SIZE: Record<PlyType, number> = { int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, float64: 8 };

interface PlyProp {
  name: string;
  type: PlyType;
  /** For list properties: the count type. */
  countType?: PlyType;
}
interface PlyElement {
  name: string;
  count: number;
  props: PlyProp[];
}

export function parsePly(buf: Uint8Array): Mesh {
  const headEnd = findHeaderEnd(buf);
  const header = Buffer.from(buf.buffer, buf.byteOffset, headEnd.textEnd).toString("latin1").split(/\r?\n/);
  if (header[0].trim() !== "ply") throw new Photo3dError("MX-P3D-041", "Not a PLY file.");
  let format = "";
  const elements: PlyElement[] = [];
  for (const raw of header.slice(1)) {
    const p = raw.trim().split(/\s+/);
    if (p[0] === "format") format = p[1];
    else if (p[0] === "element") elements.push({ name: p[1], count: Number(p[2]), props: [] });
    else if (p[0] === "property") {
      const el = elements[elements.length - 1];
      if (!el) throw new Photo3dError("MX-P3D-041", "PLY property before any element.");
      if (p[1] === "list") {
        const countType = PLY_TYPES[p[2]], type = PLY_TYPES[p[3]];
        if (!countType || !type) throw new Photo3dError("MX-P3D-041", `PLY list type "${p[2]} ${p[3]}" is not supported.`);
        el.props.push({ name: p[4], type, countType });
      } else {
        const type = PLY_TYPES[p[1]];
        if (!type) throw new Photo3dError("MX-P3D-041", `PLY property type "${p[1]}" is not supported.`);
        el.props.push({ name: p[2], type });
      }
    }
  }
  if (elements.some((e) => !Number.isInteger(e.count) || e.count < 0)) throw new Photo3dError("MX-P3D-041", "PLY element count is invalid.");
  const vertexEl = elements.find((e) => e.name === "vertex");
  if (!vertexEl || vertexEl.count === 0) throw new Photo3dError("MX-P3D-041", "PLY file has no vertices.");
  const xi = ["x", "y", "z"].map((n) => vertexEl.props.findIndex((p) => p.name === n));
  if (xi.some((i) => i < 0)) throw new Photo3dError("MX-P3D-041", "PLY vertices lack x/y/z.");

  const positions = new Float32Array(vertexEl.count * 3);
  const indices: number[] = [];
  const onFace = (vs: number[]) => {
    for (const v of vs) if (!(v >= 0 && v < vertexEl.count)) throw new Photo3dError("MX-P3D-041", `PLY face index ${v} is out of range.`);
    for (let k = 1; k + 1 < vs.length; k++) indices.push(vs[0], vs[k], vs[k + 1]);
  };
  const faceListIdx = (el: PlyElement) => el.props.findIndex((p) => p.countType && /^vertex_ind(ex|ices)$/.test(p.name));

  if (format === "ascii") {
    const body = Buffer.from(buf.buffer, buf.byteOffset + headEnd.dataStart, buf.byteLength - headEnd.dataStart).toString("latin1");
    const tok = body.split(/\s+/).filter(Boolean);
    let t = 0;
    const next = () => {
      if (t >= tok.length) throw new Photo3dError("MX-P3D-041", "PLY data ends early.");
      return Number(tok[t++]);
    };
    for (const el of elements) {
      const fi = el.name === "face" ? faceListIdx(el) : -1;
      for (let r = 0; r < el.count; r++) {
        const vals: number[] = [];
        let list: number[] | null = null;
        el.props.forEach((p, pi) => {
          if (p.countType) {
            const n = next();
            const l = Array.from({ length: n }, next);
            if (pi === fi) list = l;
            vals.push(NaN);
          } else vals.push(next());
        });
        if (el === vertexEl) for (let k = 0; k < 3; k++) positions[r * 3 + k] = vals[xi[k]];
        else if (list) onFace(list);
      }
    }
  } else if (format === "binary_little_endian" || format === "binary_big_endian") {
    const le = format === "binary_little_endian";
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let o = headEnd.dataStart;
    const read = (type: PlyType): number => {
      if (o + PLY_SIZE[type] > buf.byteLength) throw new Photo3dError("MX-P3D-041", "PLY data ends early.");
      let v: number;
      switch (type) {
        case "int8": v = dv.getInt8(o); break;
        case "uint8": v = dv.getUint8(o); break;
        case "int16": v = dv.getInt16(o, le); break;
        case "uint16": v = dv.getUint16(o, le); break;
        case "int32": v = dv.getInt32(o, le); break;
        case "uint32": v = dv.getUint32(o, le); break;
        case "float32": v = dv.getFloat32(o, le); break;
        default: v = dv.getFloat64(o, le);
      }
      o += PLY_SIZE[type];
      return v;
    };
    for (const el of elements) {
      const fi = el.name === "face" ? faceListIdx(el) : -1;
      const fixed = el.props.every((p) => !p.countType);
      if (el !== vertexEl && fixed) {
        // Skip fixed-size elements we don't use without decoding them.
        const stride = el.props.reduce((s, p) => s + PLY_SIZE[p.type], 0);
        o += stride * el.count;
        if (o > buf.byteLength) throw new Photo3dError("MX-P3D-041", "PLY data ends early.");
        continue;
      }
      for (let r = 0; r < el.count; r++) {
        for (let pi = 0; pi < el.props.length; pi++) {
          const p = el.props[pi];
          if (p.countType) {
            const n = read(p.countType);
            const l = new Array<number>(n);
            for (let k = 0; k < n; k++) l[k] = read(p.type);
            if (pi === fi) onFace(l);
          } else {
            const v = read(p.type);
            if (el === vertexEl) {
              const k = xi.indexOf(pi);
              if (k >= 0) positions[r * 3 + k] = v;
            }
          }
        }
      }
    }
  } else {
    throw new Photo3dError("MX-P3D-041", `PLY format "${format || "missing"}" is not supported.`);
  }
  if (positions.some((v) => !Number.isFinite(v))) throw new Photo3dError("MX-P3D-041", "PLY file contains invalid coordinates.");
  if (indices.length === 0) throw new Photo3dError("MX-P3D-042", "PLY file has vertices but no faces (a point cloud); export a mesh.");
  return { positions, indices: Uint32Array.from(indices) };
}

function findHeaderEnd(buf: Uint8Array): { textEnd: number; dataStart: number } {
  const limit = Math.min(buf.length, 64 * 1024);
  const head = Buffer.from(buf.buffer, buf.byteOffset, limit).toString("latin1");
  const m = /end_header[ \t]*(\r?\n)/.exec(head);
  if (!m) throw new Photo3dError("MX-P3D-041", "PLY header has no end_header.");
  return { textEnd: m.index, dataStart: m.index + m[0].length };
}

// ------------------------------------------------------------------ detection + import

export function detectScanFormat(name: string, bytes: Uint8Array): ScanFormat | null {
  if (isGlb(bytes)) return "glb";
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 256)).toString("latin1");
  if (/^ply\r?\n/.test(head)) return "ply";
  if (isBinaryStl(bytes) || /^\s*solid[\s\S]*facet/.test(Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 2048)).toString("latin1"))) return "stl";
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === "obj" || /(^|\n)\s*v\s+[-+.\d]/.test(head)) return "obj";
  if (ext === "stl") return "stl";
  return null;
}

export type ScanUnits = LengthUnit | "auto";

export interface ScanImportOptions {
  /** "auto" (default) guesses from the size, or from `expectedSizeMm` when given. */
  units?: ScanUnits;
  /** "auto" (default): flat-base heuristic, falling back to the format's usual convention. */
  upAxis?: UpAxis | "auto";
  /** Largest expected dimension (e.g. from the photo analysis), used to pick units. */
  expectedSizeMm?: number;
}

export interface ScanImport {
  format: ScanFormat;
  mesh: Mesh;
  /** Scale applied to file units to get millimetres. */
  unitScale: number;
  units: LengthUnit;
  unitsMethod: "given" | "format" | "expected-size" | "size-heuristic";
  unitsConfident: boolean;
  upAxis: UpAxis;
  upAxisMethod: "given" | "format" | "heuristic" | "default";
  sizeMm: { x: number; y: number; z: number };
  notes: string[];
}

const UNIT_SCALE: Record<LengthUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

/** Reads a scan file and returns a Z-up millimetre mesh centred on the bed. Throws MX-P3D-040..042. */
export function importScan(name: string, bytes: Uint8Array, o: ScanImportOptions = {}): ScanImport {
  const format = detectScanFormat(name, bytes);
  if (!format) throw new Photo3dError("MX-P3D-040", `"${name}" is not an OBJ, PLY, STL or GLB file.`);
  const notes: string[] = [];
  let mesh: Mesh;
  let upAxis: UpAxis;
  let upAxisMethod: ScanImport["upAxisMethod"];
  try {
    if (format === "glb") {
      // glTF is Y-up by specification; parseGlb converts to Z-up. Keep file units for now.
      const r = parseGlb(bytes, { unitScaleMm: 1, zUp: (o.upAxis ?? "auto") !== "z" });
      if (r.skippedPrimitives.length) notes.push(`${r.skippedPrimitives.length} non-triangle primitive(s) skipped`);
      mesh = r.mesh;
      upAxis = o.upAxis === "z" ? "z" : "y";
      upAxisMethod = o.upAxis && o.upAxis !== "auto" ? "given" : "format";
    } else {
      mesh = format === "obj" ? parseObj(bytes) : format === "ply" ? parsePly(bytes) : parseStl(bytes);
      if (o.upAxis && o.upAxis !== "auto") {
        upAxis = o.upAxis;
        upAxisMethod = "given";
      } else {
        const d = decideUpAxis(mesh, format);
        upAxis = d.axis;
        upAxisMethod = d.method;
        notes.push(`up axis: ${d.reason}`);
      }
      if (upAxis === "y") mesh = yUpToZUp(mesh);
    }
  } catch (e) {
    if (e instanceof Photo3dError) throw e;
    throw new Photo3dError("MX-P3D-041", `Could not read the ${format.toUpperCase()} file: ${(e as Error).message}`);
  }
  if (mesh.indices.length === 0) throw new Photo3dError("MX-P3D-042", "The scan has no triangles.");

  const raw = computeBounds(mesh).size;
  const extent = Math.max(raw.x, raw.y, raw.z);
  if (!(extent > 0) || !Number.isFinite(extent)) throw new Photo3dError("MX-P3D-041", "The scan has zero size or invalid coordinates.");
  const u = pickUnits(format, extent, o);
  mesh = placeOnBed(u.scale === 1 ? mesh : scaleMesh(mesh, u.scale));
  const size = computeBounds(mesh).size;
  if (!u.confident) notes.push(`units uncertain: assumed ${u.units} (largest side ${round(extent)} file units)`);
  return {
    format,
    mesh,
    unitScale: u.scale,
    units: u.units,
    unitsMethod: u.method,
    unitsConfident: u.confident,
    upAxis,
    upAxisMethod,
    sizeMm: { x: round(size.x), y: round(size.y), z: round(size.z) },
    notes,
  };
}

/**
 * STL: the slicing heuristic (Z-up unless a flat base clearly sits at min Y).
 * OBJ/PLY: scanning and DCC apps export Y-up, so Y-up unless a flat base clearly sits at min Z.
 */
function decideUpAxis(mesh: Mesh, format: ScanFormat): { axis: UpAxis; method: "heuristic" | "format" | "default"; reason: string } {
  if (format === "stl") {
    const d = detectUpAxis(mesh);
    return { axis: d.axis, method: d.method === "reference" ? "heuristic" : d.method, reason: d.reason };
  }
  const z = minFaceArea(mesh, 2), y = minFaceArea(mesh, 1);
  if (z.area > 3 * y.area && z.area > 0.01 * z.total) {
    return { axis: "z", method: "heuristic", reason: `flat base at min Z (${round(z.area)} vs ${round(y.area)} at min Y), so the file is Z-up` };
  }
  return { axis: "y", method: "format", reason: `assumed Y-up (usual for ${format.toUpperCase()} scans)` };
}

/** Area of faces pointing down along `axis` (within ~8 deg) that lie at its minimum. */
function minFaceArea(mesh: Mesh, axis: 1 | 2): { area: number; total: number } {
  const b = computeBounds(mesh);
  const min = axis === 2 ? b.min.z : b.min.y;
  const tol = Math.max(Math.hypot(b.size.x, b.size.y, b.size.z) * 5e-4, 1e-9);
  const p = mesh.positions, idx = mesh.indices;
  let area = 0, total = 0;
  const c = [0, 0, 0];
  for (let t = 0; t < idx.length / 3; t++) {
    faceCross(mesh, t, c);
    const l = Math.hypot(c[0], c[1], c[2]);
    total += l / 2;
    if (l === 0 || c[axis] / l > -0.99) continue;
    if ([0, 1, 2].every((k) => p[idx[t * 3 + k] * 3 + axis] - min < tol)) area += l / 2;
  }
  return { area, total };
}

function pickUnits(format: ScanFormat, extent: number, o: ScanImportOptions): { units: LengthUnit; scale: number; method: ScanImport["unitsMethod"]; confident: boolean } {
  if (o.units && o.units !== "auto") return { units: o.units, scale: UNIT_SCALE[o.units], method: "given", confident: true };
  if (o.expectedSizeMm && o.expectedSizeMm > 0) {
    // The unit that brings the size closest (in log terms) to the expected size.
    const cands: LengthUnit[] = ["mm", "cm", "in", "m"];
    const scored = cands.map((units) => ({ units, err: Math.abs(Math.log((extent * UNIT_SCALE[units]) / o.expectedSizeMm!)) }));
    scored.sort((a, b) => a.err - b.err);
    const best = scored[0];
    // Confident if within 2x of the expectation and clearly better than the runner-up.
    const confident = best.err < Math.log(2) && scored[1].err - best.err > Math.log(1.5);
    return { units: best.units, scale: UNIT_SCALE[best.units], method: "expected-size", confident };
  }
  if (format === "glb") {
    // glTF is metres by spec; trust it unless that would make the object absurdly big.
    if (extent <= 3) return { units: "m", scale: 1000, method: "format", confident: true };
    return { units: "mm", scale: 1, method: "size-heuristic", confident: extent >= 10 };
  }
  // Printable things are ~5-500 mm. In metres that is 0.005-0.5; in millimetres 5-500.
  if (extent <= 2.5) return { units: "m", scale: 1000, method: "size-heuristic", confident: extent >= 0.005 };
  return { units: "mm", scale: 1, method: "size-heuristic", confident: extent >= 8 && extent <= 2500 };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
