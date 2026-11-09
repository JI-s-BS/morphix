// Smart Model Search import: 3MF reading (incl. Bambu-style component files), plate layout,
// QD330 fit checks, listed-part checks, and the full library import into a project.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { arrangeOnPlates, checkListedParts, partSize, read3mf, readModelFile, readZip, type ModelPart, type SmartModelResult } from "@morphix/model-search";
import { computeBounds, parseStl, writeBinaryStl, type Mesh } from "@morphix/slicing";
import { MorphixDb } from "@morphix/database";
import { Logger, Storage } from "@morphix/storage";
import type { AppEvent } from "@morphix/shared";
import type { Ctx } from "../apps/desktop/electron/context";
import { importLibraryModel, libraryManifest, useLibraryPlate } from "../apps/desktop/electron/library-import";

/** Axis-aligned box mesh from (0,0,0) to (x,y,z). */
function box(x: number, y: number, z: number): Mesh {
  const p = [0, 0, 0, x, 0, 0, x, y, 0, 0, y, 0, 0, 0, z, x, 0, z, x, y, z, 0, y, z];
  const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: Float32Array.from(p), indices: Uint32Array.from(i) };
}
const size = (m: Mesh) => {
  const b = computeBounds(m);
  return [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map((v) => Math.round(v * 10) / 10);
};

/** Tiny ZIP writer (store or deflate) for building test 3MF files. */
function zip(files: Record<string, string>, deflate = true): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const body = deflate ? deflateRawSync(data) : data;
    const n = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const meshXml = (m: Mesh) => {
  let v = "";
  for (let i = 0; i < m.positions.length; i += 3) v += `<vertex x="${m.positions[i]}" y="${m.positions[i + 1]}" z="${m.positions[i + 2]}"/>`;
  let t = "";
  for (let i = 0; i < m.indices.length; i += 3) t += `<triangle v1="${m.indices[i]}" v2="${m.indices[i + 1]}" v3="${m.indices[i + 2]}"/>`;
  return `<mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh>`;
};
const RELS = `<?xml version="1.0"?><Relationships><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

describe("3MF import", () => {
  it("reads every build item as its own part, applying transforms and units", () => {
    const model = `<?xml version="1.0"?><model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>
      <object id="1" name="Arm" type="model">${meshXml(box(2, 1, 0.5))}</object>
      <object id="2" name="Cap" type="model">${meshXml(box(1, 1, 0.3))}</object>
    </resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 5 0"/><item objectid="2"/></build></model>`;
    for (const deflate of [true, false]) {
      const parts = read3mf(zip({ "_rels/.rels": RELS, "3D/3dmodel.model": model }, deflate));
      expect(parts.map((p) => p.name)).toEqual(["Arm", "Cap"]);
      expect(size(parts[0].mesh)).toEqual([20, 10, 5]); // centimetres → mm
      expect(computeBounds(parts[0].mesh).min.x).toBeCloseTo(50); // transform applied (5 cm)
    }
  });

  it("follows Bambu/Production-style components in other model files", () => {
    const root = `<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>
      <object id="10" name="Spinner body"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="2 0 0 0 2 0 0 0 2 0 0 0"/></components></object>
    </resources><build><item objectid="10"/></build></model>`;
    const obj = `<model unit="millimeter"><resources><object id="1">${meshXml(box(10, 10, 5))}</object></resources></model>`;
    const parts = read3mf(zip({ "_rels/.rels": RELS, "3D/3dmodel.model": root, "3D/Objects/object_1.model": obj }));
    expect(parts).toHaveLength(1);
    expect(parts[0].name).toBe("Spinner body");
    expect(size(parts[0].mesh)).toEqual([20, 20, 10]);
  });

  it("rejects files that aren't models, and reads STL as-is (no rotation or scaling)", () => {
    expect(() => readZip(Buffer.from("not a zip at all"))).toThrow(/ZIP/);
    const stl = writeBinaryStl(box(30, 10, 60));
    const [part] = readModelFile("Tall arm.stl", stl);
    expect(part.name).toBe("Tall arm");
    expect(size(part.mesh)).toEqual([30, 10, 60]);
    expect(() => readModelFile("notes.txt", Buffer.from("hi"))).toThrow(/STL, 3MF/);
  });
});

describe("plates and fit", () => {
  const P = (name: string, x: number, y: number, z: number): ModelPart => ({ name, mesh: box(x, y, z) });

  it("puts all parts that fit on one QD330 plate, without overlaps", () => {
    const { plates, tooBig } = arrangeOnPlates([P("body", 80, 80, 8), P("cap 1", 22, 22, 4), P("cap 2", 22, 22, 4)]);
    expect(tooBig).toEqual([]);
    expect(plates).toHaveLength(1);
    expect(plates[0].parts.sort()).toEqual(["body", "cap 1", "cap 2"]);
    const s = size(plates[0].mesh);
    expect(s[0]).toBeLessThanOrEqual(220);
    expect(s[1]).toBeLessThanOrEqual(220);
    expect(s[2]).toBe(8); // all on the bed (z from 0)
  });

  it("uses more plates when needed and flags parts too big for the printer", () => {
    const parts = [P("a", 200, 150, 10), P("b", 200, 150, 10), P("huge", 300, 50, 10), P("tall", 50, 50, 230)];
    const { plates, tooBig } = arrangeOnPlates(parts);
    expect(tooBig.sort()).toEqual(["huge", "tall"]);
    expect(plates).toHaveLength(2);
    expect(partSize(P("rot", 210, 100, 5)).fits).toBe(true);
    expect(partSize(P("huge", 300, 50, 10)).fits).toBe(false);
  });

  it("warns when the listing mentions parts that weren't imported", () => {
    expect(checkListedParts(["spinner body", "bearing caps", "weights"], ["Spinner body", "Cap"])).toEqual([
      "The listing mentions 3 printed parts but 2 came in — check every file was downloaded.",
      "Couldn't match these listed parts to a file: weights.",
    ]);
    expect(checkListedParts([], ["anything"])).toEqual([]);
  });
});

describe("library import into a project", () => {
  const result: SmartModelResult = {
    id: "r1", source: "printables", name: "Bearing Fidget Spinner", pageUrl: "https://www.printables.com/model/123-spinner",
    imageUrl: null, thumbUrl: null, qrDataUrl: null, description: "3 arms", license: "CC BY 4.0", licenseVerified: true, creator: "Maker",
    parts: ["body", "caps"], nonPrintedParts: ["608 bearing"], assembly: ["Press the bearing in", "Snap the caps on"], printAsIs: false,
    evidence: ["300 makes"], files: [], download: "manual",
  };
  async function ctx(): Promise<{ c: Ctx; events: AppEvent[] }> {
    const storage = new Storage(mkdtempSync(join(tmpdir(), "morphix-lib-")));
    storage.init();
    const db = await MorphixDb.open(storage);
    const events: AppEvent[] = [];
    return { events, c: { db, storage, log: new Logger(storage), send: () => {}, event: (e) => events.push(e), url: (r) => (r ? `/library/${r}` : null), currentProjectId: null } };
  }

  it("keeps every part at its exact size, builds plate 1 and a manifest, and never starts printing", async () => {
    const { c, events } = await ctx();
    const model = `<model unit="millimeter"><resources><object id="1" name="cap">${meshXml(box(22, 22, 4))}</object><object id="2" name="cap">${meshXml(box(22, 22, 4))}</object></resources>
      <build><item objectid="1"/><item objectid="2"/></build></model>`;
    const r = importLibraryModel(c, result, [
      { name: "body.stl", bytes: writeBinaryStl(box(80, 80, 8)) },
      { name: "caps.3mf", bytes: zip({ "_rels/.rels": RELS, "3D/3dmodel.model": model }) },
      { name: "instructions.pdf", bytes: Buffer.from("%PDF-1.4 fake") },
    ]);
    expect(r.parts).toHaveLength(3);
    const v = c.db.get("SELECT * FROM model_versions WHERE id = ?", [r.versionId])!;
    expect(v).toMatchObject({ source: "library", target_height_mm: null });
    const plate = parseStl(c.storage.read(c.storage.path(String(v.rel_path))));
    expect(size(plate)[2]).toBe(8);
    const assets = c.db.all("SELECT kind FROM assets WHERE version_id = ?", [r.versionId]).map((a) => a.kind);
    expect(assets.filter((k) => k === "assembly-part")).toHaveLength(3);
    expect(assets).toContain("original"); // the PDF is kept
    const m = libraryManifest(c, r.versionId)!;
    expect(m).toMatchObject({ sourceName: "Printables", license: "CC BY 4.0", licenseVerified: true, currentPlate: 1, nonPrintedParts: ["608 bearing"], assembly: result.assembly });
    expect(m.parts.every((p) => p.fits && p.plate === 1)).toBe(true);
    expect(m.preserved).toEqual(["instructions.pdf"]);
    expect(r.warnings.join(" ")).toMatch(/608 bearing/);
    expect(events.some((e) => e.type === "print-status")).toBe(false);
    expect(c.db.get("SELECT state FROM projects WHERE id = ?", [r.projectId])!.state).toBe("reviewing");
  });

  it("loads further build plates as new versions", async () => {
    const { c } = await ctx();
    const r = importLibraryModel(c, result, [
      { name: "big1.stl", bytes: writeBinaryStl(box(200, 150, 10)) },
      { name: "big2.stl", bytes: writeBinaryStl(box(200, 150, 10)) },
    ]);
    expect(libraryManifest(c, r.versionId)!.plates).toHaveLength(2);
    const p2 = useLibraryPlate(c, r.projectId, 2);
    expect(p2.manifest.currentPlate).toBe(2);
    expect(c.db.get("SELECT latest_version_id FROM projects WHERE id = ?", [r.projectId])!.latest_version_id).toBe(p2.versionId);
    expect(() => useLibraryPlate(c, r.projectId, 3)).toThrow(/2 plates/);
  });

  it("refuses imports with nothing printable, or nothing that fits", async () => {
    const { c } = await ctx();
    expect(() => importLibraryModel(c, result, [{ name: "readme.txt", bytes: Buffer.from("hi") }])).toThrow(/No printable parts/);
    expect(() => importLibraryModel(c, result, [{ name: "huge.stl", bytes: writeBinaryStl(box(400, 400, 10)) }])).toThrow(/None of the parts fit/);
  });
});
