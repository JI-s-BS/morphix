// Importing a design found by Smart Model Search (downloaded by the user, or through the
// Thingiverse API). Every part is kept as its own STL at its exact exported size and
// orientation; parts are laid out on QD330-sized build plates so printing plate 1 prints all
// the parts that fit, and further plates hold the rest. The model page reads the manifest for
// the source, licence, parts, hardware and assembly steps. Nothing is sliced or printed here.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MAX_FILES, arrangeOnPlates, checkListedParts, isModelFileName, partSize, readModelFile, type ModelPart, type SmartModelResult } from "@morphix/model-search";
import { writeBinaryStl } from "@morphix/slicing";
import type { LibraryManifest } from "@morphix/shared";
import { type Ctx, moveProject, now } from "./context";

export interface ImportedFile {
  name: string;
  bytes: Buffer;
}

export interface LibraryImportResult {
  projectId: string;
  versionId: string;
  parts: string[];
  warnings: string[];
  manifest: LibraryManifest;
}

const SOURCE_NAME: Record<string, string> = { printables: "Printables", thingiverse: "Thingiverse", makerworld: "MakerWorld", other: "the source site" };
const safe = (n: string) => n.replace(/[^\w .()+-]/g, "_").slice(0, 100) || "file";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function addAsset(ctx: Ctx, versionId: string, kind: string, abs: string, data: Buffer | string): void {
  ctx.storage.writeAtomic(abs, data);
  ctx.db.run("INSERT INTO assets(id, version_id, kind, rel_path, bytes, sha256, created_at) VALUES (?,?,?,?,?,?,?)", [
    randomUUID(), versionId, kind, ctx.storage.relative(abs), Buffer.byteLength(data), sha(data), now(),
  ]);
}

export function importLibraryModel(ctx: Ctx, result: SmartModelResult, files: ImportedFile[], opts: { thumbnailRel?: string | null } = {}): LibraryImportResult {
  if (!files.length) throw new Error("Choose the model files you downloaded (STL or 3MF).");
  if (files.length > MAX_FILES) throw new Error(`That's a lot of files — import up to ${MAX_FILES} at a time.`);
  const parts: ModelPart[] = [];
  const preserved: ImportedFile[] = [];
  const warnings: string[] = [];
  for (const f of files) {
    const name = safe(f.name);
    if (/\.zip$/i.test(name)) {
      preserved.push({ name, bytes: f.bytes });
      warnings.push(`${name} is a ZIP: unzip it and import the STL/3MF files inside.`);
      continue;
    }
    if (!isModelFileName(name)) {
      preserved.push({ name, bytes: f.bytes }); // instructions, PDFs, images: kept with the project
      continue;
    }
    try {
      for (const p of readModelFile(name, f.bytes)) {
        let n = p.name;
        for (let i = 2; parts.some((x) => x.name === n); i++) n = `${p.name} (${i})`;
        parts.push({ name: n, mesh: p.mesh });
      }
    } catch (e) {
      preserved.push({ name, bytes: f.bytes });
      warnings.push(`${name}: kept, but it couldn't be read as a printable part (${(e as Error).message}).`);
    }
  }
  if (!parts.length) throw new Error("No printable parts were found. Import the design's STL or 3MF files.");

  const sizes = parts.map((p) => partSize(p));
  const { plates, tooBig } = arrangeOnPlates(parts);
  if (!plates.length) {
    const big = sizes.map((s) => `${s.name} (${s.sizeMm.x} × ${s.sizeMm.y} × ${s.sizeMm.z} mm)`).join(", ");
    throw new Error(`None of the parts fit the QD330 (220 × 220 × 220 mm): ${big}.`);
  }
  if (tooBig.length) warnings.push(`Too big for the QD330 (220 × 220 × 220 mm): ${tooBig.join(", ")}. These can't be printed here as they are.`);
  if (plates.length > 1) warnings.push(`All parts don't fit on one build plate: plate 1 of ${plates.length} is ready now; print the next plate afterwards from the model page.`);
  warnings.push(...checkListedParts(result.parts, parts.map((p) => p.name)));
  if (result.nonPrintedParts.length) warnings.push(`You'll also need: ${result.nonPrintedParts.join(", ")} (not printed).`);

  const projectId = randomUUID();
  const versionId = randomUUID();
  const t = now();
  ctx.db.run("INSERT INTO projects(id, title, prompt, state, created_at, updated_at) VALUES (?,?,?,?,?,?)", [
    projectId, result.name.slice(0, 60), result.pageUrl ? `${result.name} — imported from ${result.pageUrl}` : `${result.name} — imported from a file`, "idea", t, t,
  ]);
  moveProject(ctx, projectId, "generating");
  const dir = ctx.storage.modelDir(projectId, versionId);
  parts.forEach((p, i) => addAsset(ctx, versionId, "assembly-part", join(dir, `part-${String(i + 1).padStart(2, "0")}-${safe(p.name)}.stl`), writeBinaryStl(p.mesh, `Morphix part ${p.name}`)));
  plates.forEach((pl, i) => addAsset(ctx, versionId, "plate", join(dir, `plate-${i + 1}.stl`), writeBinaryStl(pl.mesh, `Morphix plate ${i + 1}`)));
  for (const f of preserved) addAsset(ctx, versionId, "original", join(dir, `original-${f.name}`), f.bytes);

  const plateOf = (name: string) => {
    const i = plates.findIndex((pl) => pl.parts.includes(name));
    return i < 0 ? null : i + 1;
  };
  const manifest: LibraryManifest = {
    source: result.pageUrl,
    sourceName: result.pageUrl ? SOURCE_NAME[result.source] ?? "the source site" : "your file",
    license: result.license,
    licenseVerified: result.licenseVerified,
    creator: result.creator,
    parts: sizes.map((s) => ({ ...s, plate: plateOf(s.name) })),
    plates: plates.map((p) => p.parts),
    currentPlate: 1,
    tooBig,
    preserved: preserved.map((f) => f.name),
    nonPrintedParts: result.nonPrintedParts,
    assembly: result.assembly,
    evidence: result.evidence,
    warnings,
  };
  const primary = join(dir, "model.stl");
  const plate1 = writeBinaryStl(plates[0].mesh, "Morphix plate 1");
  ctx.storage.writeAtomic(primary, plate1);
  addAsset(ctx, versionId, "assembly-manifest", join(dir, "assembly.json"), JSON.stringify(manifest, null, 2));
  ctx.db.run(
    `INSERT INTO model_versions(id, project_id, version, source, kind, format, rel_path, stl_rel_path, bytes, target_height_mm, thumbnail_rel_path, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    // target height null = keep the designer's exact size
    [versionId, projectId, 1, "library", "preview", "stl", ctx.storage.relative(primary), ctx.storage.relative(primary), plate1.length, null, opts.thumbnailRel ?? null, t],
  );
  ctx.db.run("UPDATE projects SET latest_version_id = ?, updated_at = ? WHERE id = ?", [versionId, t, projectId]);
  moveProject(ctx, projectId, "reviewing");
  ctx.db.flush();
  ctx.log.write("info", "library model imported", { projectId, source: result.pageUrl, parts: parts.length, plates: plates.length, tooBig: tooBig.length });
  return { projectId, versionId, parts: parts.map((p) => p.name), warnings, manifest };
}

/** The manifest of a library model version (null for Meshy/demo models). */
/** A model file the user picked (no search result behind it): same import, kept at its exact size. */
export function importModelFiles(ctx: Ctx, files: ImportedFile[]): LibraryImportResult {
  const first = files.find((f) => isModelFileName(f.name)) ?? files[0];
  const name = (first?.name ?? "model").replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 60) || "Imported model";
  const result: SmartModelResult = {
    id: `file-${randomUUID()}`, source: "other", name, pageUrl: "", imageUrl: null, thumbUrl: null, qrDataUrl: null,
    description: "", license: null, licenseVerified: false, creator: null, parts: [], nonPrintedParts: [], assembly: [],
    printAsIs: true, evidence: [], files: [], download: "manual",
  };
  return importLibraryModel(ctx, result, files);
}

export function libraryManifest(ctx: Ctx, versionId: string): LibraryManifest | null {
  const a = ctx.db.get("SELECT rel_path FROM assets WHERE version_id = ? AND kind = 'assembly-manifest' ORDER BY created_at DESC LIMIT 1", [versionId]);
  if (!a) return null;
  try {
    return JSON.parse(ctx.storage.read(ctx.storage.path(String(a.rel_path))).toString("utf8")) as LibraryManifest;
  } catch {
    return null;
  }
}

/**
 * Makes plate `plate` the current model of a library project (a new version, so it can be
 * prepared and printed like any model). Parts, plates and originals stay with version 1.
 */
export function useLibraryPlate(ctx: Ctx, projectId: string, plate: number): { versionId: string; manifest: LibraryManifest } {
  const first = ctx.db.get("SELECT * FROM model_versions WHERE project_id = ? AND source = 'library' ORDER BY version ASC LIMIT 1", [projectId]);
  if (!first) throw new Error("This isn't an imported library model.");
  const base = libraryManifest(ctx, String(first.id));
  if (!base) throw new Error("The parts list for this model is missing.");
  if (!(plate >= 1 && plate <= base.plates.length)) throw new Error(`There are ${base.plates.length} plates.`);
  const dir = ctx.storage.modelDir(projectId, String(first.id));
  const plateAbs = join(dir, `plate-${plate}.stl`);
  if (!existsSync(plateAbs)) throw new Error(`Plate ${plate} file is missing.`);
  const n = Number(ctx.db.get("SELECT COUNT(*) AS n FROM model_versions WHERE project_id = ?", [projectId])?.n ?? 0) + 1;
  const versionId = randomUUID();
  const t = now();
  const manifest: LibraryManifest = { ...base, currentPlate: plate };
  const bytes = ctx.storage.read(plateAbs);
  ctx.db.run(
    `INSERT INTO model_versions(id, project_id, version, source, kind, format, rel_path, stl_rel_path, bytes, target_height_mm, thumbnail_rel_path, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [versionId, projectId, n, "library", "preview", "stl", ctx.storage.relative(plateAbs), ctx.storage.relative(plateAbs), bytes.length, null, first.thumbnail_rel_path ?? null, t],
  );
  addAsset(ctx, versionId, "assembly-manifest", join(ctx.storage.modelDir(projectId, versionId), "assembly.json"), JSON.stringify(manifest, null, 2));
  ctx.db.run("UPDATE projects SET latest_version_id = ?, updated_at = ? WHERE id = ?", [versionId, t, projectId]);
  ctx.db.flush();
  return { versionId, manifest };
}
