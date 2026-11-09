import { describe, expect, it } from "vitest";
import {
  buildGlb,
  checkBuildVolume,
  computeBounds,
  isBinaryStl,
  MeshFormatError,
  parseGlb,
  parseStl,
  repairMesh,
  scaledCheck,
  signedVolume,
  stlSize,
  validateMesh,
  writeAsciiStl,
  writeBinaryStl,
  type Mesh,
} from "@morphix/slicing";
import { box, soup } from "./phase3-fixtures";

const sorted = (m: Mesh) => {
  const tris: string[] = [];
  for (let t = 0; t < m.indices.length / 3; t++) {
    const vs = [0, 1, 2].map((k) => Array.from(m.positions.subarray(m.indices[t * 3 + k] * 3, m.indices[t * 3 + k] * 3 + 3)).join(","));
    tris.push(vs.join("|"));
  }
  return tris.sort();
};

describe("STL I/O", () => {
  it("round-trips binary STL", () => {
    const m = box(10, 20, 30);
    const buf = writeBinaryStl(m);
    expect(buf.length).toBe(84 + 12 * 50);
    expect(isBinaryStl(buf)).toBe(true);
    const back = parseStl(buf);
    expect(back.indices.length).toBe(36);
    expect(sorted(back)).toEqual(sorted(m));
    // Normals are recomputed: first triangle is the bottom face (-Z).
    expect(buf.readFloatLE(84 + 8)).toBeCloseTo(-1);
  });

  it("detects binary STL whose header starts with 'solid'", () => {
    const buf = writeBinaryStl(box(1, 1, 1), "solid but actually binary");
    expect(parseStl(buf).indices.length).toBe(36);
  });

  it("round-trips ASCII STL", () => {
    const m = box(1.5, 2, 3);
    const text = writeAsciiStl(m, "cube");
    expect(text.startsWith("solid cube")).toBe(true);
    const back = parseStl(Buffer.from(text));
    expect(sorted(back)).toEqual(sorted(m));
  });

  it("rejects garbage", () => {
    expect(() => parseStl(Buffer.from("hello world"))).toThrow(MeshFormatError);
  });

  it("keeps the Phase 1/2 helpers working", () => {
    const buf = writeBinaryStl(box(10, 20, 30));
    expect(stlSize(buf)).toEqual({ x: 10, y: 20, z: 30 });
    expect(scaledCheck({ x: 10, y: 20, z: 30 }, 60).size).toEqual({ x: 20, y: 40, z: 60 });
    expect(checkBuildVolume({ x: 300, y: 10, z: 10 }).fits).toBe(false);
  });
});

describe("GLB reader", () => {
  it("converts Y-up metres to Z-up millimetres and applies node transforms", () => {
    // Unit tetra-ish triangle in glTF space at y = 1 m.
    const tri = { positions: Float32Array.from([0, 1, 0, 1, 1, 0, 0, 1, 1]) };
    const moved = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]), translation: [2, 0, 0], scale: [2, 2, 2] };
    const glb = buildGlb([tri, moved]);
    const r = parseGlb(glb);
    expect(r.meshCount).toBe(2);
    expect(r.primitiveCount).toBe(2);
    const p = Array.from(r.mesh.positions);
    // glTF (0,1,0) m -> printer (0, 0, 1000) mm
    expect(p.slice(0, 3)).toEqual([0, -0, 1000]);
    // glTF (0,1,1) -> (0, -1000, 1000)
    expect(p.slice(6, 9)).toEqual([0, -1000, 1000]);
    // second mesh: vertex (1,0,0) scaled x2 then translated +2 in X -> x = 4 m
    expect(p[9 + 3]).toBeCloseTo(4000);
    // vertex (0,1,0) scaled x2 -> glTF y=2 -> printer z = 2000
    expect(p[9 + 8]).toBeCloseTo(2000);
  });

  it("honours unitScaleMm and rotations", () => {
    const s = Math.SQRT1_2; // 90 deg about Z
    const glb = buildGlb([{ positions: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 1, 0]), rotation: [0, 0, s, s] }]);
    const r = parseGlb(glb, { unitScaleMm: 1, zUp: false });
    expect(r.mesh.positions[0]).toBeCloseTo(0);
    expect(r.mesh.positions[1]).toBeCloseTo(1);
  });

  it("reads a closed mesh that validates as watertight", () => {
    const b = box(1, 1, 1);
    const r = parseGlb(buildGlb([{ positions: b.positions, indices: b.indices }]), { unitScaleMm: 10, zUp: false });
    const rep = validateMesh(r.mesh);
    expect(rep.watertight).toBe(true);
    expect(rep.volumeMm3).toBeCloseTo(1000);
  });

  it("rejects Draco-compressed files with a clear message", () => {
    const glb = buildGlb([{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]) }]);
    const jsonLen = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString("utf8"));
    json.extensionsRequired = ["KHR_draco_mesh_compression"];
    let j = Buffer.from(JSON.stringify(json));
    j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
    const bin = glb.subarray(20 + jsonLen);
    const head = Buffer.alloc(20);
    head.writeUInt32LE(0x46546c67, 0);
    head.writeUInt32LE(2, 4);
    head.writeUInt32LE(20 + j.length + bin.length, 8);
    head.writeUInt32LE(j.length, 12);
    head.writeUInt32LE(0x4e4f534a, 16);
    expect(() => parseGlb(Buffer.concat([head, j, bin]))).toThrow(/draco/i);
  });
});

describe("validateMesh", () => {
  it("reports a clean cube", () => {
    const r = validateMesh(box(10, 10, 10));
    expect(r).toMatchObject({ triangles: 12, uniqueVertices: 8, watertight: true, manifold: true, consistentWinding: true, shellCount: 1, inverted: false, degenerateFaces: 0 });
    expect(r.volumeMm3).toBeCloseTo(1000);
    expect(r.surfaceAreaMm2).toBeCloseTo(600);
    expect(r.issues).toEqual([]);
  });

  it("welds STL soup for analysis", () => {
    const r = validateMesh(soup(box(10, 10, 10)));
    expect(r.vertices).toBe(36);
    expect(r.uniqueVertices).toBe(8);
    expect(r.watertight).toBe(true);
  });

  it("finds open edges", () => {
    const m = box(10, 10, 10);
    const open = { positions: m.positions, indices: m.indices.slice(3) };
    const r = validateMesh(open);
    expect(r.edges.boundaryEdges).toBe(3);
    expect(r.watertight).toBe(false);
    expect(r.shells[0].closed).toBe(false);
  });

  it("finds inconsistent winding and inverted meshes", () => {
    const m = box(10, 10, 10);
    const flipped = m.indices.slice();
    [flipped[1], flipped[2]] = [flipped[2], flipped[1]];
    expect(validateMesh({ positions: m.positions, indices: flipped }).edges.inconsistentEdges).toBe(3);
    const inv = m.indices.slice();
    for (let i = 0; i < inv.length; i += 3) [inv[i + 1], inv[i + 2]] = [inv[i + 2], inv[i + 1]];
    const r = validateMesh({ positions: m.positions, indices: inv });
    expect(r.inverted).toBe(true);
    expect(r.consistentWinding).toBe(true);
  });

  it("finds disconnected shells, degenerate and non-manifold faces", () => {
    const a = box(10, 10, 10), b = box(1, 1, 1, { x: 50, y: 0, z: 0 });
    const both: Mesh = { positions: Float32Array.from([...a.positions, ...b.positions]), indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, (i) => i + 8)]) };
    expect(validateMesh(both).shellCount).toBe(2);
    const degen: Mesh = { positions: Float32Array.from([...a.positions, 0, 0, 0]), indices: Uint32Array.from([...a.indices, 0, 1, 1]) };
    expect(validateMesh(degen).degenerateFaces).toBe(1);
    const nm: Mesh = { positions: Float32Array.from([...a.positions, 5, 5, 20]), indices: Uint32Array.from([...a.indices, 4, 5, 8]) };
    expect(validateMesh(nm).edges.nonManifoldEdges).toBe(1);
  });
});

describe("repairMesh", () => {
  it("welds, fixes winding and orientation, drops degenerate/duplicate faces and tiny shells", () => {
    const a = box(10, 10, 10);
    const idx = Array.from(a.indices);
    [idx[4], idx[5]] = [idx[5], idx[4]]; // flip one face
    const tiny = box(0.1, 0.1, 0.1, { x: 40, y: 0, z: 0 });
    const m: Mesh = {
      positions: Float32Array.from([...a.positions, ...tiny.positions]),
      indices: Uint32Array.from([...idx, 0, 1, 1, ...idx.slice(6, 9), ...Array.from(tiny.indices, (i) => i + 8)]),
    };
    const { mesh, summary } = repairMesh(soup(m));
    expect(summary.verticesMerged).toBeGreaterThan(0);
    expect(summary.degenerateFacesRemoved).toBe(1);
    expect(summary.duplicateFacesRemoved).toBe(1);
    expect(summary.shellsRemoved).toBe(1);
    expect(summary.facesFlipped).toBe(1);
    expect(summary.changed).toBe(true);
    const r = validateMesh(mesh);
    expect(r.watertight).toBe(true);
    expect(r.shellCount).toBe(1);
    expect(r.triangles).toBe(12);
    expect(signedVolume(mesh)).toBeCloseTo(1000);
  });

  it("turns an inside-out mesh outward", () => {
    const m = box(2, 2, 2);
    for (let i = 0; i < m.indices.length; i += 3) [m.indices[i + 1], m.indices[i + 2]] = [m.indices[i + 2], m.indices[i + 1]];
    const { mesh, summary } = repairMesh(m);
    expect(summary.shellsInverted).toBe(1);
    expect(signedVolume(mesh)).toBeCloseTo(8);
  });

  it("leaves holes open and says so", () => {
    const m = box(10, 10, 10);
    const { mesh, summary } = repairMesh({ positions: m.positions, indices: m.indices.slice(3) });
    expect(validateMesh(mesh).edges.boundaryEdges).toBe(3);
    expect(summary.notes.join(" ")).toMatch(/not filled/);
    expect(computeBounds(mesh).size).toEqual({ x: 10, y: 10, z: 10 });
  });
});
