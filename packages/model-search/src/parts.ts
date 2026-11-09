// Reading downloaded model files into separate printable parts, without changing their size
// or orientation (designers export print-ready parts; bearings and screws need exact sizes),
// checking each part against the QD330, and laying all parts out on build plates so a
// multi-part design is printed as every part — never squashed into one decorative mesh.
import { inflateRawSync } from "node:zlib";
import { computeBounds, mergeMeshes, parseGlb, parseStl, translateMesh, type Mesh } from "@morphix/slicing";
import { parseObj, parsePly } from "@morphix/photo3d";

export interface ModelPart {
  name: string;
  mesh: Mesh;
}

export interface PartSize {
  name: string;
  sizeMm: { x: number; y: number; z: number };
  fits: boolean;
}

export const QD330_PLATE = { x: 220, y: 220, z: 220 } as const;
const MODEL_EXT = /\.(stl|obj|ply|glb|3mf)$/i;
export const isModelFileName = (name: string) => MODEL_EXT.test(name);

// ---------------------------------------------------------------------------------------
// Minimal ZIP reader (3MF is a ZIP of XML). Store and deflate only; no ZIP64.

export function readZip(buf: Uint8Array, maxTotalBytes = 400_000_000): Map<string, Buffer> {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP file (no end of central directory)");
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error("ZIP central directory is damaged");
    const method = b.readUInt16LE(p + 10);
    const compressed = b.readUInt32LE(p + 20);
    const size = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (b.readUInt32LE(local) !== 0x04034b50) throw new Error(`ZIP entry ${name} is damaged`);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(start, start + compressed);
    total += size;
    if (total > maxTotalBytes) throw new Error("ZIP is too large to unpack safely");
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw));
    // other compression methods: skipped (not used by 3MF writers)
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// 3MF

type Mat = number[]; // 3MF 4x3, row-major: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32
const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const parseMat = (s: string | undefined): Mat => {
  const v = (s ?? "").trim().split(/\s+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENTITY;
};
/** a then b (apply a first). */
const compose = (a: Mat, b: Mat): Mat => {
  const r: Mat = new Array(12).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j] + (i === 3 ? b[9 + j] : 0);
    }
  }
  return r;
};
const attrs = (tag: string): Record<string, string> => {
  const o: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) o[m[1]] = m[2];
  return o;
};
const UNIT_MM: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

interface ObjDef {
  name: string;
  mesh?: Mesh;
  components: { path: string; id: string; transform: Mat }[];
}

function parseModelXml(xml: string, path: string, objects: Map<string, ObjDef>): { items: { path: string; id: string; transform: Mat }[]; scale: number } {
  const scale = UNIT_MM[attrs(/<model\b[^>]*>/.exec(xml)?.[0] ?? "").unit ?? "millimeter"] ?? 1;
  // Translations are in the file's units too.
  const tf = (s: string | undefined): Mat => {
    const m = parseMat(s);
    return m === IDENTITY || scale === 1 ? m : [...m.slice(0, 9), m[9] * scale, m[10] * scale, m[11] * scale];
  };
  for (const m of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const a = attrs(m[1]);
    const body = m[2];
    const def: ObjDef = { name: a.name || `part ${a.id}`, components: [] };
    const meshXml = /<mesh\b[\s\S]*?<\/mesh>/.exec(body)?.[0];
    if (meshXml) {
      const pos: number[] = [];
      for (const v of meshXml.matchAll(/<vertex\b([^>]*)\/?>/g)) {
        const va = attrs(v[1]);
        pos.push(Number(va.x) * scale, Number(va.y) * scale, Number(va.z) * scale);
      }
      const idx: number[] = [];
      for (const t of meshXml.matchAll(/<triangle\b([^>]*)\/?>/g)) {
        const ta = attrs(t[1]);
        idx.push(Number(ta.v1), Number(ta.v2), Number(ta.v3));
      }
      if (pos.length && idx.length) def.mesh = { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
    }
    for (const c of body.matchAll(/<component\b([^>]*)\/?>/g)) {
      const ca = attrs(c[1]);
      def.components.push({ path: ca["p:path"] || path, id: ca.objectid, transform: tf(ca.transform) });
    }
    objects.set(`${path}#${a.id}`, def);
  }
  const items = [...xml.matchAll(/<item\b([^>]*)\/?>/g)].map((m) => {
    const a = attrs(m[1]);
    return { path: a["p:path"] || path, id: a.objectid, transform: tf(a.transform) };
  });
  return { items, scale };
}

function transformMesh(mesh: Mesh, t: Mat): Mesh {
  if (t === IDENTITY) return mesh;
  const p = mesh.positions;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = x * t[0] + y * t[3] + z * t[6] + t[9];
    out[i + 1] = x * t[1] + y * t[4] + z * t[7] + t[10];
    out[i + 2] = x * t[2] + y * t[5] + z * t[8] + t[11];
  }
  return { positions: out, indices: mesh.indices };
}

function resolveObject(key: string, objects: Map<string, ObjDef>, t: Mat, depth = 0): Mesh[] {
  const o = objects.get(key);
  if (!o || depth > 8) return [];
  const out: Mesh[] = o.mesh ? [transformMesh(o.mesh, t)] : [];
  for (const c of o.components) out.push(...resolveObject(`${c.path}#${c.id}`, objects, compose(c.transform, t), depth + 1));
  return out;
}

/** Every build item (or every mesh object, if there are no items) as its own part. */
export function read3mf(bytes: Uint8Array): ModelPart[] {
  const files = readZip(bytes);
  const objects = new Map<string, ObjDef>();
  const modelPaths = [...files.keys()].filter((n) => /\.model$/i.test(n));
  if (!modelPaths.length) throw new Error("3MF has no 3D model inside");
  const rootRel = /Target="([^"]+\.model)"/i.exec(files.get("_rels/.rels")?.toString("utf8") ?? "")?.[1];
  const root = "/" + (rootRel ?? "/3D/3dmodel.model").replace(/^\/+/, "");
  let items: { path: string; id: string; transform: Mat }[] = [];
  for (const name of modelPaths) {
    const path = "/" + name.replace(/^\/+/, "");
    const r = parseModelXml(files.get(name)!.toString("utf8"), path, objects);
    if (path.toLowerCase() === root.toLowerCase()) items = r.items;
  }
  const parts: ModelPart[] = [];
  const named = (n: string) => {
    let name = n.replace(/[^\w .()+-]/g, "_").slice(0, 80) || "part";
    for (let i = 2; parts.some((p) => p.name === name); i++) name = `${n} ${i}`;
    return name;
  };
  if (items.length) {
    for (const it of items) {
      const meshes = resolveObject(`${it.path}#${it.id}`, objects, it.transform);
      if (meshes.length) parts.push({ name: named(objects.get(`${it.path}#${it.id}`)?.name ?? "part"), mesh: meshes.length === 1 ? meshes[0] : mergeMeshes(meshes) });
    }
  } else {
    for (const [, o] of objects) if (o.mesh) parts.push({ name: named(o.name), mesh: o.mesh });
  }
  if (!parts.length) throw new Error("3MF has no printable mesh");
  return parts;
}

/** Any supported model file → its parts. Geometry is kept exactly as exported (mm, Z up). */
export function readModelFile(fileName: string, bytes: Uint8Array): ModelPart[] {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[^\w .()+-]/g, "_").slice(0, 80) || "part";
  const ext = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase();
  switch (ext) {
    case "3mf":
      return read3mf(bytes).map((p, i, all) => ({ name: all.length === 1 ? base : `${base} – ${p.name || i + 1}`, mesh: p.mesh }));
    case "stl":
      return [{ name: base, mesh: parseStl(bytes) }];
    case "obj":
      return [{ name: base, mesh: parseObj(bytes) }];
    case "ply":
      return [{ name: base, mesh: parsePly(bytes) }];
    case "glb":
      return [{ name: base, mesh: parseGlb(bytes, { unitScaleMm: 1000, zUp: true }).mesh }];
    default:
      throw new Error(`${fileName} is not a model file Morphix can read (STL, 3MF, OBJ, PLY or GLB)`);
  }
}

export function partSize(p: ModelPart, plate = QD330_PLATE): PartSize {
  const b = computeBounds(p.mesh);
  const s = { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z };
  // A part may be turned 90° on the plate, so compare the footprint either way round.
  const flat = (s.x <= plate.x && s.y <= plate.y) || (s.y <= plate.x && s.x <= plate.y);
  return { name: p.name, sizeMm: { x: round1(s.x), y: round1(s.y), z: round1(s.z) }, fits: flat && s.z <= plate.z && s.x > 0 && s.y > 0 && s.z > 0 };
}
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface Plate {
  parts: string[];
  mesh: Mesh;
  sizeMm: { x: number; y: number };
}

/**
 * Lays parts out in rows (tallest footprint first) with `gap` mm between them, sitting on
 * z = 0, starting new plates when one is full. Parts too big for the printer are returned
 * in `tooBig` and never placed.
 */
export function arrangeOnPlates(parts: ModelPart[], plate = QD330_PLATE, gap = 6): { plates: Plate[]; tooBig: string[] } {
  const tooBig: string[] = [];
  const boxes = parts
    .map((p) => {
      const sz = partSize(p, plate);
      if (!sz.fits) {
        tooBig.push(p.name);
        return null;
      }
      const b = computeBounds(p.mesh);
      let mesh = translateMesh(p.mesh, { x: -b.min.x, y: -b.min.y, z: -b.min.z });
      let w = sz.sizeMm.x, d = sz.sizeMm.y;
      if (w > plate.x || d > plate.y) {
        // turn it 90° around Z so it fits
        const q = mesh.positions;
        const r = new Float32Array(q.length);
        for (let i = 0; i < q.length; i += 3) {
          r[i] = q[i + 1];
          r[i + 1] = w - q[i];
          r[i + 2] = q[i + 2];
        }
        mesh = { positions: r, indices: mesh.indices };
        [w, d] = [d, w];
      }
      return { name: p.name, mesh, w, d };
    })
    .filter((x): x is { name: string; mesh: Mesh; w: number; d: number } => x !== null)
    .sort((a, b) => b.d - a.d || b.w - a.w);

  const plates: { items: { name: string; mesh: Mesh }[]; x: number; y: number; rowD: number; maxX: number }[] = [];
  const fresh = () => ({ items: [] as { name: string; mesh: Mesh }[], x: 0, y: 0, rowD: 0, maxX: 0 });
  for (const box of boxes) {
    let placed = false;
    for (const pl of plates) {
      if (pl.x + box.w <= plate.x && pl.y + box.d <= plate.y) {
        // same row
      } else if (pl.y + pl.rowD + gap + box.d <= plate.y && box.w <= plate.x) {
        pl.y += pl.rowD + gap; // new row
        pl.x = 0;
        pl.rowD = 0;
      } else continue;
      pl.items.push({ name: box.name, mesh: translateMesh(box.mesh, { x: pl.x, y: pl.y, z: 0 }) });
      pl.maxX = Math.max(pl.maxX, pl.x + box.w);
      pl.x += box.w + gap;
      pl.rowD = Math.max(pl.rowD, box.d);
      placed = true;
      break;
    }
    if (!placed) {
      const pl = fresh();
      pl.items.push({ name: box.name, mesh: box.mesh });
      pl.maxX = box.w;
      pl.x = box.w + gap;
      pl.rowD = box.d;
      plates.push(pl);
    }
  }
  return {
    tooBig,
    plates: plates.map((pl) => ({ parts: pl.items.map((i) => i.name), mesh: mergeMeshes(pl.items.map((i) => i.mesh)), sizeMm: { x: round1(pl.maxX), y: round1(pl.y + pl.rowD) } })),
  };
}

/**
 * Compares the parts the listing mentions with the files imported. Listing part names come
 * from the search (unverified), so this only warns; it never blocks.
 */
export function checkListedParts(listed: string[], imported: string[]): string[] {
  if (!listed.length) return [];
  const stem = (w: string) => w.replace(/(es|s)$/, "");
  const words = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["part", "parts", "the", "and", "for", "with", "print", "printed"].includes(w)).map(stem);
  const have = imported.map(words);
  const missing = listed.filter((l) => {
    const w = words(l);
    return w.length > 0 && !have.some((h) => w.some((x) => h.some((y) => y.includes(x) || x.includes(y))));
  });
  const out: string[] = [];
  if (imported.length < listed.length) out.push(`The listing mentions ${listed.length} printed parts but ${imported.length} came in — check every file was downloaded.`);
  if (missing.length) out.push(`Couldn't match these listed parts to a file: ${missing.join(", ")}.`);
  return out;
}
