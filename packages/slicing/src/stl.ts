// STL (binary + ASCII) reader and writers. STL has no units; Morphix treats STL as millimetres.
import { computeFaceNormals, meshFromSoup, triangleCount, type Mesh } from "./mesh";

export class MeshFormatError extends Error {}

export function isBinaryStl(buf: Uint8Array): boolean {
  if (buf.length < 84) return false;
  const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(80, true);
  // Exact size match is the reliable test: many binary STLs also start with "solid".
  return 84 + n * 50 === buf.length;
}

/** Parses binary or ASCII STL into an unwelded mesh (3 vertices per triangle; run repairMesh to weld). */
export function parseStl(buf: Uint8Array): Mesh {
  if (isBinaryStl(buf)) return parseBinaryStl(buf);
  const head = Buffer.from(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, 512)).toString("latin1");
  if (/^\s*solid/.test(head)) return parseAsciiStl(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("latin1"));
  if (buf.length >= 84) {
    // Truncated or padded binary file: read what is complete, if the count is plausible.
    const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(80, true);
    if (n > 0 && 84 + n * 50 <= buf.length + 2) return parseBinaryStl(buf, Math.min(n, Math.floor((buf.length - 84) / 50)));
  }
  throw new MeshFormatError("not a recognisable STL file");
}

function parseBinaryStl(buf: Uint8Array, count?: number): Mesh {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = count ?? dv.getUint32(80, true);
  const soup = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12; // skip the stored normal; it is recomputed
    for (let k = 0; k < 9; k++) soup[t * 9 + k] = dv.getFloat32(o + k * 4, true);
  }
  return meshFromSoup(soup);
}

function parseAsciiStl(text: string): Mesh {
  const out: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(Number(m[1]), Number(m[2]), Number(m[3]));
  if (out.length === 0 || out.length % 9 !== 0) throw new MeshFormatError(`ASCII STL has ${out.length / 3} vertices (not a multiple of 3)`);
  if (out.some((v) => !Number.isFinite(v))) throw new MeshFormatError("ASCII STL contains non-numeric coordinates");
  return meshFromSoup(out);
}

/** Binary STL with freshly computed face normals. */
export function writeBinaryStl(mesh: Mesh, header = "Morphix binary STL (mm)"): Buffer {
  const n = triangleCount(mesh);
  const buf = Buffer.alloc(84 + n * 50);
  buf.write(header.slice(0, 80), 0, "latin1");
  buf.writeUInt32LE(n, 80);
  const normals = computeFaceNormals(mesh);
  const p = mesh.positions, idx = mesh.indices;
  let o = 84;
  for (let t = 0; t < n; t++) {
    buf.writeFloatLE(normals[t * 3], o);
    buf.writeFloatLE(normals[t * 3 + 1], o + 4);
    buf.writeFloatLE(normals[t * 3 + 2], o + 8);
    o += 12;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      buf.writeFloatLE(p[v], o);
      buf.writeFloatLE(p[v + 1], o + 4);
      buf.writeFloatLE(p[v + 2], o + 8);
      o += 12;
    }
    o += 2; // attribute byte count = 0
  }
  return buf;
}

export function writeAsciiStl(mesh: Mesh, name = "morphix"): string {
  const n = triangleCount(mesh);
  const normals = computeFaceNormals(mesh);
  const p = mesh.positions, idx = mesh.indices;
  const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(Math.fround(v)));
  const lines = [`solid ${name}`];
  for (let t = 0; t < n; t++) {
    lines.push(`  facet normal ${f(normals[t * 3])} ${f(normals[t * 3 + 1])} ${f(normals[t * 3 + 2])}`, "    outer loop");
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      lines.push(`      vertex ${f(p[v])} ${f(p[v + 1])} ${f(p[v + 2])}`);
    }
    lines.push("    endloop", "  endfacet");
  }
  lines.push(`endsolid ${name}`, "");
  return lines.join("\n");
}
