import { describe, expect, it } from "vitest";
import { buildGlb, computeBounds, parseStl, writeAsciiStl, writeBinaryStl } from "@morphix/slicing";
import { detectScanFormat, importScan, parseObj, parsePly } from "@morphix/photo3d";
import { box } from "./photo3d-helpers";

/** Box as OBJ text (quads, 1-based indices, v/vt/vn style), optionally Y-up. */
function boxObj(sx: number, sy: number, sz: number, opts: { yUp?: boolean; negative?: boolean } = {}): string {
  // In Y-up files the printer's Z is the file's Y and printer Y is -file Z.
  const P = (x: number, y: number, z: number) => (opts.yUp ? [x, z, -y] : [x, y, z]);
  const v = [
    P(0, 0, 0), P(sx, 0, 0), P(sx, sy, 0), P(0, sy, 0),
    P(0, 0, sz), P(sx, 0, sz), P(sx, sy, sz), P(0, sy, sz),
  ];
  const quads = [[1, 4, 3, 2], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]];
  const lines = ["# scan export", "mtllib scan.mtl", "o Scan", ...v.map((p) => `v ${p.join(" ")}`), "vt 0 0", "vn 0 0 1"];
  for (const q of quads) lines.push("f " + q.map((i) => (opts.negative ? `${i - 9}/1/1` : `${i}/1/1`)).join(" "));
  return lines.join("\n") + "\n";
}

function plyHeader(format: string, nv: number, nf: number, extra = ""): string {
  return `ply\nformat ${format} 1.0\ncomment test\nelement vertex ${nv}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\n${extra}element face ${nf}\nproperty list uchar int vertex_indices\nend_header\n`;
}

function boxPly(format: "ascii" | "binary_little_endian" | "binary_big_endian", sx: number, sy: number, sz: number): Buffer {
  const m = box(sx, sy, sz);
  const nv = m.positions.length / 3, nf = m.indices.length / 3;
  if (format === "ascii") {
    const rows: string[] = [];
    for (let i = 0; i < nv; i++) rows.push(`${m.positions[i * 3]} ${m.positions[i * 3 + 1]} ${m.positions[i * 3 + 2]} 200`);
    for (let t = 0; t < nf; t++) rows.push(`3 ${m.indices[t * 3]} ${m.indices[t * 3 + 1]} ${m.indices[t * 3 + 2]}`);
    return Buffer.from(plyHeader("ascii", nv, nf) + rows.join("\n") + "\n");
  }
  const le = format === "binary_little_endian";
  const body = Buffer.alloc(nv * 13 + nf * 13);
  let o = 0;
  for (let i = 0; i < nv; i++) {
    for (let k = 0; k < 3; k++) {
      le ? body.writeFloatLE(m.positions[i * 3 + k], o) : body.writeFloatBE(m.positions[i * 3 + k], o);
      o += 4;
    }
    body.writeUInt8(200, o++);
  }
  for (let t = 0; t < nf; t++) {
    body.writeUInt8(3, o++);
    for (let k = 0; k < 3; k++) {
      le ? body.writeInt32LE(m.indices[t * 3 + k], o) : body.writeInt32BE(m.indices[t * 3 + k], o);
      o += 4;
    }
  }
  return Buffer.concat([Buffer.from(plyHeader(format, nv, nf)), body]);
}

const sizeOf = (r: { sizeMm: { x: number; y: number; z: number } }) => [r.sizeMm.x, r.sizeMm.y, r.sizeMm.z];

describe("OBJ parser", () => {
  it("reads quads (fan-triangulated), slash indices and negative indices", () => {
    const m = parseObj(Buffer.from(boxObj(10, 20, 30)));
    expect(m.indices.length).toBe(36);
    expect(computeBounds(m).size).toEqual({ x: 10, y: 20, z: 30 });
    expect(parseObj(Buffer.from(boxObj(10, 20, 30, { negative: true }))).indices).toEqual(m.indices);
  });

  it("rejects point clouds and bad indices", () => {
    expect(() => parseObj(Buffer.from("v 0 0 0\nv 1 0 0\n"))).toThrow(expect.objectContaining({ code: "MX-P3D-042" }));
    expect(() => parseObj(Buffer.from("v 0 0 0\nf 1 2 3\n"))).toThrow(expect.objectContaining({ code: "MX-P3D-041" }));
  });
});

describe("PLY parser", () => {
  it.each(["ascii", "binary_little_endian", "binary_big_endian"] as const)("reads %s with extra vertex properties", (f) => {
    const m = parsePly(boxPly(f, 10, 20, 30));
    expect(m.indices.length).toBe(36);
    expect(computeBounds(m).size).toEqual({ x: 10, y: 20, z: 30 });
  });

  it("skips unknown elements and rejects point clouds", () => {
    const withEdges = Buffer.from(
      "ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar uint vertex_index\nelement edge 1\nproperty int vertex1\nproperty int vertex2\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n0 1\n",
    );
    expect(parsePly(withEdges).indices).toEqual(Uint32Array.from([0, 1, 2]));
    const cloud = Buffer.from("ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n" + "\0".repeat(12));
    expect(() => parsePly(cloud)).toThrow(expect.objectContaining({ code: "MX-P3D-042" }));
    expect(() => parsePly(Buffer.from("ply\nformat ascii 1.0\nelement vertex 3\n"))).toThrow(expect.objectContaining({ code: "MX-P3D-041" }));
  });
});

describe("importScan", () => {
  it("detects formats from content", () => {
    expect(detectScanFormat("a.bin", boxPly("ascii", 1, 1, 1))).toBe("ply");
    expect(detectScanFormat("x", Buffer.from(boxObj(1, 1, 1)))).toBe("obj");
    expect(detectScanFormat("x", writeBinaryStl(box(1, 1, 1)))).toBe("stl");
    expect(detectScanFormat("x", Buffer.from(writeAsciiStl(box(1, 1, 1))))).toBe("stl");
    expect(detectScanFormat("x", buildGlb([{ positions: box(1, 1, 1).positions, indices: box(1, 1, 1).indices }]))).toBe("glb");
    expect(detectScanFormat("photo.jpg", Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(() => importScan("photo.jpg", Buffer.from([0xff, 0xd8, 0xff]))).toThrow(expect.objectContaining({ code: "MX-P3D-040" }));
  });

  it("converts a metre-scale Y-up phone LiDAR OBJ to Z-up millimetres on the bed", () => {
    const r = importScan("scan.obj", Buffer.from(boxObj(0.08, 0.06, 0.05, { yUp: true })));
    expect(r.units).toBe("m");
    expect(r.unitsConfident).toBe(true);
    expect(r.upAxis).toBe("y");
    sizeOf(r).forEach((v, i) => expect(v).toBeCloseTo([80, 60, 50][i], 1));
    const b = computeBounds(r.mesh);
    expect(b.min.z).toBeCloseTo(0, 5);
    expect((b.min.x + b.max.x) / 2).toBeCloseTo(0, 5);
  });

  it("uses the expected size from the photo analysis to pick units", () => {
    // 8 x 6 x 5 file units: ambiguous between cm and mm without context.
    const obj = Buffer.from(boxObj(8, 6, 5));
    const r = importScan("scan.obj", obj, { expectedSizeMm: 85, upAxis: "z" });
    expect(r.units).toBe("cm");
    expect(r.unitsMethod).toBe("expected-size");
    expect(sizeOf(r)).toEqual([80, 60, 50]);
    const u = importScan("scan.obj", Buffer.from(boxObj(6, 5, 4)), { upAxis: "z" });
    expect(u.units).toBe("mm");
    expect(u.unitsConfident).toBe(false);
    expect(importScan("scan.obj", obj, { units: "in", upAxis: "z" }).sizeMm.x).toBeCloseTo(203.2, 1);
  });

  it("treats a Z-up OBJ with a clear flat base as Z-up", () => {
    // Thin plate lying flat: big face at min Z, small one at min Y.
    const r = importScan("plate.obj", Buffer.from(boxObj(100, 100, 4)));
    expect(r).toMatchObject({ upAxis: "z", upAxisMethod: "heuristic" });
    expect(sizeOf(r)).toEqual([100, 100, 4]);
  });

  it("keeps STL in millimetres and Z-up", () => {
    const r = importScan("part.stl", writeBinaryStl(box(40, 30, 20)));
    expect(r).toMatchObject({ format: "stl", units: "mm", upAxis: "z" });
    expect(sizeOf(r)).toEqual([40, 30, 20]);
    expect(parseStl(writeBinaryStl(r.mesh)).indices.length).toBe(36);
  });

  it("reads binary PLY and GLB (metres, Y-up by spec)", () => {
    // A box has no clear base, so a PLY is assumed Y-up unless told otherwise.
    expect(sizeOf(importScan("s.ply", boxPly("binary_little_endian", 40, 30, 20)))).toEqual([40, 20, 30]);
    expect(sizeOf(importScan("s.ply", boxPly("binary_little_endian", 40, 30, 20), { upAxis: "z" }))).toEqual([40, 30, 20]);
    const yUp = box(0.04, 0.02, 0.03); // glTF: x=40 mm, up (y)=20 mm, z=30 mm -> depth
    const r = importScan("s.glb", buildGlb([{ positions: yUp.positions, indices: yUp.indices }]));
    expect(r).toMatchObject({ format: "glb", units: "m", upAxis: "y", upAxisMethod: "format" });
    sizeOf(r).forEach((v, i) => expect(v).toBeCloseTo([40, 30, 20][i], 1));
  });
});
