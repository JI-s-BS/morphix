// Minimal glTF 2.0 binary (.glb) reader: triangle geometry only (no materials, textures,
// skinning or morph targets). Handles multiple meshes/primitives, node hierarchies with
// matrix or TRS transforms, indexed and non-indexed primitives, strips and fans.
//
// glTF is Y-up, right-handed, nominally metres. Printers are Z-up millimetres. Meshy
// output is NOT reliably in metres, so callers should normalise by target height
// (preparePrint does); `unitScaleMm` only matters when no target height is given.
import { mergeMeshes, type Mesh } from "./mesh";
import { MeshFormatError } from "./stl";

export interface GlbReadOptions {
  /** Multiply glTF units by this to get mm. Default 1000 (glTF metres). */
  unitScaleMm?: number;
  /** Convert glTF Y-up to printer Z-up: (x, y, z) -> (x, -z, y). Default true. */
  zUp?: boolean;
}

export interface GlbReadResult {
  mesh: Mesh;
  meshCount: number;
  primitiveCount: number;
  skippedPrimitives: { mesh: number; primitive: number; reason: string }[];
}

type Json = Record<string, any>;
type M4 = number[]; // column-major 4x4 (glTF convention)

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const UNSUPPORTED_EXTENSIONS = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_mesh_quantization"];

export function isGlb(buf: Uint8Array): boolean {
  return buf.length >= 12 && new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true) === GLB_MAGIC;
}

export function parseGlb(buf: Uint8Array, opts: GlbReadOptions = {}): GlbReadResult {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (!isGlb(buf)) throw new MeshFormatError("not a GLB file (bad magic)");
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new MeshFormatError(`unsupported glTF version ${version}`);
  const total = Math.min(dv.getUint32(8, true), buf.length);
  let json: Json | null = null;
  let bin: Uint8Array | null = null;
  for (let o = 12; o + 8 <= total; ) {
    const len = dv.getUint32(o, true);
    const type = dv.getUint32(o + 4, true);
    const body = buf.subarray(o + 8, o + 8 + len);
    if (type === CHUNK_JSON && !json) json = JSON.parse(Buffer.from(body).toString("utf8"));
    else if (type === CHUNK_BIN && !bin) bin = body;
    o += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new MeshFormatError("GLB has no JSON chunk");
  const required: string[] = json.extensionsRequired ?? [];
  const blocked = required.filter((e) => UNSUPPORTED_EXTENSIONS.includes(e));
  if (blocked.length) throw new MeshFormatError(`GLB uses unsupported compression: ${blocked.join(", ")} (export uncompressed GLB or STL)`);

  const ctx = { json, bin };
  const parts: Mesh[] = [];
  const skipped: GlbReadResult["skippedPrimitives"] = [];
  let primitiveCount = 0;
  const usedMeshes = new Set<number>();

  const visit = (nodeIdx: number, parent: M4, depth: number) => {
    if (depth > 64) throw new MeshFormatError("glTF node hierarchy too deep (cycle?)");
    const node: Json = json!.nodes?.[nodeIdx];
    if (!node) return;
    const world = mul4(parent, localMatrix(node));
    if (typeof node.mesh === "number") {
      usedMeshes.add(node.mesh);
      const mesh: Json = json!.meshes?.[node.mesh];
      (mesh?.primitives ?? []).forEach((prim: Json, pi: number) => {
        primitiveCount++;
        const r = readPrimitive(ctx, prim, world);
        if (typeof r === "string") skipped.push({ mesh: node.mesh, primitive: pi, reason: r });
        else parts.push(r);
      });
    }
    for (const c of node.children ?? []) visit(c, world, depth + 1);
  };

  const sceneIdx = json.scene ?? 0;
  const roots: number[] | undefined = json.scenes?.[sceneIdx]?.nodes;
  if (roots && roots.length) for (const r of roots) visit(r, IDENTITY4, 0);
  else {
    // No scene: treat every mesh as untransformed.
    (json.meshes ?? []).forEach((mesh: Json, mi: number) =>
      (mesh.primitives ?? []).forEach((prim: Json, pi: number) => {
        usedMeshes.add(mi);
        primitiveCount++;
        const r = readPrimitive(ctx, prim, IDENTITY4);
        if (typeof r === "string") skipped.push({ mesh: mi, primitive: pi, reason: r });
        else parts.push(r);
      }),
    );
  }
  if (parts.length === 0) throw new MeshFormatError("GLB contains no triangle geometry");

  const merged = mergeMeshes(parts);
  const k = opts.unitScaleMm ?? 1000;
  const zUp = opts.zUp ?? true;
  const p = merged.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (zUp) {
      p[i] = x * k;
      p[i + 1] = -z * k;
      p[i + 2] = y * k;
    } else {
      p[i] = x * k;
      p[i + 1] = y * k;
      p[i + 2] = z * k;
    }
  }
  return { mesh: merged, meshCount: usedMeshes.size, primitiveCount, skippedPrimitives: skipped };
}

function readPrimitive(ctx: { json: Json; bin: Uint8Array | null }, prim: Json, world: M4): Mesh | string {
  const mode = prim.mode ?? 4;
  if (mode !== 4 && mode !== 5 && mode !== 6) return `primitive mode ${mode} is not triangles`;
  if (prim.extensions && Object.keys(prim.extensions).some((e) => UNSUPPORTED_EXTENSIONS.includes(e))) return "compressed primitive";
  if (typeof prim.attributes?.POSITION !== "number") return "no POSITION attribute";
  const pos = readAccessor(ctx, prim.attributes.POSITION);
  if (pos.components !== 3) return "POSITION is not VEC3";
  const nv = pos.count;
  let tri: number[] | Uint32Array;
  const idx = typeof prim.indices === "number" ? readAccessor(ctx, prim.indices).data : null;
  const seq = idx ?? Array.from({ length: nv }, (_, i) => i);
  if (mode === 4) tri = idx ? Uint32Array.from(seq) : Uint32Array.from(seq.slice(0, seq.length - (seq.length % 3)));
  else {
    const out: number[] = [];
    for (let i = 2; i < seq.length; i++) {
      if (mode === 5) out.push(...(i % 2 ? [seq[i - 1], seq[i - 2], seq[i]] : [seq[i - 2], seq[i - 1], seq[i]]));
      else out.push(seq[0], seq[i - 1], seq[i]);
    }
    tri = Uint32Array.from(out);
  }
  for (let i = 0; i < tri.length; i++) if (tri[i] >= nv) return "index out of range";
  const positions = new Float32Array(nv * 3);
  const m = world;
  for (let i = 0; i < nv; i++) {
    const x = pos.data[i * 3], y = pos.data[i * 3 + 1], z = pos.data[i * 3 + 2];
    positions[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
    positions[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    positions[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  const indices = tri instanceof Uint32Array ? tri : Uint32Array.from(tri);
  // Mirroring transforms (negative determinant) reverse winding; flip back so normals stay outward.
  if (det4(m) < 0) for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  return { positions, indices };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function readAccessor(ctx: { json: Json; bin: Uint8Array | null }, index: number): { data: number[]; count: number; components: number } {
  const acc: Json = ctx.json.accessors?.[index];
  if (!acc) throw new MeshFormatError(`missing accessor ${index}`);
  if (acc.sparse) throw new MeshFormatError("sparse accessors are not supported");
  const components = COMPONENTS[acc.type];
  const csize = COMPONENT_BYTES[acc.componentType];
  if (!components || !csize) throw new MeshFormatError(`unsupported accessor type ${acc.type}/${acc.componentType}`);
  const count: number = acc.count;
  const data = new Array<number>(count * components).fill(0);
  if (typeof acc.bufferView !== "number") return { data, count, components }; // all zeros per spec
  const view: Json = ctx.json.bufferViews?.[acc.bufferView];
  if (!view) throw new MeshFormatError(`missing bufferView ${acc.bufferView}`);
  const buffer: Json = ctx.json.buffers?.[view.buffer ?? 0];
  if (buffer?.uri !== undefined) throw new MeshFormatError("external or data-URI buffers are not supported in GLB input");
  if (!ctx.bin) throw new MeshFormatError("GLB has no BIN chunk");
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = view.byteStride ?? components * csize;
  const dv = new DataView(ctx.bin.buffer, ctx.bin.byteOffset, ctx.bin.byteLength);
  const last = base + (count - 1) * stride + components * csize;
  if (count > 0 && last > ctx.bin.byteLength) throw new MeshFormatError("accessor reads past end of BIN chunk");
  const norm = acc.normalized === true;
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < components; c++) {
      const o = base + i * stride + c * csize;
      let v: number;
      switch (acc.componentType) {
        case 5126: v = dv.getFloat32(o, true); break;
        case 5125: v = dv.getUint32(o, true); break;
        case 5123: v = dv.getUint16(o, true); if (norm) v /= 65535; break;
        case 5122: v = dv.getInt16(o, true); if (norm) v = Math.max(v / 32767, -1); break;
        case 5121: v = dv.getUint8(o); if (norm) v /= 255; break;
        default: v = dv.getInt8(o); if (norm) v = Math.max(v / 127, -1);
      }
      data[i * components + c] = v;
    }
  }
  return { data, count, components };
}

const IDENTITY4: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function localMatrix(node: Json): M4 {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  // Column-major T * R * S.
  return [
    (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
    2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
    2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function mul4(a: M4, b: M4): M4 {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let rI = 0; rI < 4; rI++) for (let k = 0; k < 4; k++) r[c * 4 + rI] += a[k * 4 + rI] * b[c * 4 + k];
  return r;
}

function det4(m: M4): number {
  // Determinant of the upper-left 3x3 (the linear part) is what decides mirroring.
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

// ------------------------------------------------------------------ writer (tests/fixtures)

/** Builds a minimal GLB with one mesh per entry. Used by tests and for debugging exports. */
export function buildGlb(
  meshes: { positions: Float32Array; indices?: Uint32Array; matrix?: number[]; translation?: number[]; scale?: number[]; rotation?: number[] }[],
): Buffer {
  const binParts: Buffer[] = [];
  const bufferViews: Json[] = [];
  const accessors: Json[] = [];
  const nodes: Json[] = [];
  const gltfMeshes: Json[] = [];
  let offset = 0;
  const push = (data: Buffer) => {
    const pad = (4 - (data.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
    binParts.push(data, Buffer.alloc(pad));
    offset += data.length + pad;
    return bufferViews.length - 1;
  };
  meshes.forEach((m, i) => {
    const pv = push(Buffer.from(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength));
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let j = 0; j < m.positions.length; j++) {
      min[j % 3] = Math.min(min[j % 3], m.positions[j]);
      max[j % 3] = Math.max(max[j % 3], m.positions[j]);
    }
    accessors.push({ bufferView: pv, componentType: 5126, count: m.positions.length / 3, type: "VEC3", min, max });
    const prim: Json = { attributes: { POSITION: accessors.length - 1 }, mode: 4 };
    if (m.indices) {
      const iv = push(Buffer.from(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength));
      accessors.push({ bufferView: iv, componentType: 5125, count: m.indices.length, type: "SCALAR" });
      prim.indices = accessors.length - 1;
    }
    gltfMeshes.push({ primitives: [prim] });
    const node: Json = { mesh: i };
    for (const k of ["matrix", "translation", "scale", "rotation"] as const) if (m[k]) node[k] = m[k];
    nodes.push(node);
  });
  const json = {
    asset: { version: "2.0", generator: "morphix-test" },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: gltfMeshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(binParts);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const ch = (len: number, type: number) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  return Buffer.concat([header, ch(jsonBuf.length, CHUNK_JSON), jsonBuf, ch(bin.length, CHUNK_BIN), bin]);
}
