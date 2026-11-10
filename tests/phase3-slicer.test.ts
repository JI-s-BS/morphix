import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyLeveling, capFirstLayers,
  buildGlb,
  defaultPrinter,
  parsePrusaIni,
  parseSlicerVersion,
  preparePrint,
  prusaArgs,
  prusaProfileIni,
  QD330_PLA_DEFAULTS,
  readGx,
  SLICERS,
  toSlicerInstall,
  validateGx,
  writeBinaryStl,
  type ExecFileFn,
  type MorphixSliceJob,
  type SlicerInfo,
} from "@morphix/slicing";
import { box, fakeSlicerExec, ORCA_GCODE, PRUSA_GCODE } from "./phase3-fixtures";

const PROFILES = resolve(__dirname, "..", "config", "slicer-profiles");
const PRUSA: SlicerInfo = { kind: "prusaslicer", path: "/usr/bin/prusa-slicer", version: "2.9.0" };
const ORCA: SlicerInfo = { kind: "orcaslicer", path: "/opt/OrcaSlicer/orca-slicer", version: "2.2.0" };
const tmp = () => mkdtemp(join(tmpdir(), "morphix-p3-"));
const NO_SLICER = { searchPath: [] as string[], env: {} };

/** Slices through the adapter, for the QD330 by default. */
function sliceWith(s: SlicerInfo, job: Partial<MorphixSliceJob> & { modelPath: string; outDir: string }, exec?: ExecFileFn) {
  return SLICERS[s.kind].slice(toSlicerInstall(s), { printer: defaultPrinter(), filament: "pla", ...job }, { exec });
}

async function stlFile(): Promise<string> {
  const dir = await tmp();
  const p = join(dir, "in.stl");
  await writeFile(p, writeBinaryStl(box(20, 20, 20, { x: 100, y: 100, z: 0 })));
  return p;
}

describe("slicer profiles (UNVERIFIED)", () => {
  it("are generated for the QD330 and match the TypeScript defaults", async () => {
    const text = prusaProfileIni(defaultPrinter());
    const ini = parsePrusaIni(text);
    expect(ini.nozzle_diameter).toBe(String(QD330_PLA_DEFAULTS.nozzleDiameterMm));
    expect(ini.temperature).toBe(String(QD330_PLA_DEFAULTS.nozzleTempC));
    expect(ini.bed_temperature).toBe(String(QD330_PLA_DEFAULTS.bedTempC));
    expect(ini.layer_height).toBe(String(QD330_PLA_DEFAULTS.layerHeightMm));
    expect(ini.fill_density).toBe(`${QD330_PLA_DEFAULTS.infillPercent}%`);
    expect(ini.perimeters).toBe(String(QD330_PLA_DEFAULTS.perimeters));
    expect(ini.bed_shape).toBe("-110x-110,110x-110,110x110,-110x110");
    expect(ini.max_print_height).toBe("220");
    expect(text).toMatch(/UNVERIFIED/);
    expect(await readFile(join(PROFILES, "qd330-pla-0.2mm.ini"), "utf8")).toBe(text); // the checked-in snapshot is current
    for (const f of ["qd330-machine.json", "qd330-process-0.2mm.json"]) expect(JSON.parse(await readFile(join(PROFILES, "orcaslicer", f), "utf8"))._comment).toMatch(/UNVERIFIED/);
    expect(QD330_PLA_DEFAULTS.verified).toBe(false);
  });
});

describe("slicer detection", () => {
  it("returns nothing when no slicer is installed", async () => {
    for (const a of Object.values(SLICERS)) expect(await a.detect(NO_SLICER)).toBeNull();
  });

  it("finds an executable on the search path and reads its version", async () => {
    const dir = await tmp();
    const bin = join(dir, "prusa-slicer");
    await writeFile(bin, "not really a slicer");
    await chmod(bin, 0o755);
    const { exec, calls } = fakeSlicerExec();
    const found = await SLICERS.prusaslicer.detect({ searchPath: [dir], env: {}, exec });
    expect(found).toEqual({ id: "prusaslicer", path: bin, version: "2.9.0+linux-aarch64-GTK3", via: "path", notes: [] });
    expect(calls).toEqual([{ file: bin, args: ["--help"] }]);
  });

  it("honours the MORPHIX_ORCA_SLICER override", async () => {
    const dir = await tmp();
    const bin = join(dir, "custom-orca");
    await writeFile(bin, "x");
    await chmod(bin, 0o755);
    const found = await SLICERS.orcaslicer.detect({ searchPath: [], env: { MORPHIX_ORCA_SLICER: bin, DISPLAY: ":0" }, skipVersion: true });
    expect(found).toEqual({ id: "orcaslicer", path: bin, version: null, via: "custom", notes: [] });
  });

  it("parses version banners", () => {
    expect(parseSlicerVersion("PrusaSlicer-2.9.2+linux-arm64-GTK3 based on Slic3r")).toBe("2.9.2+linux-arm64-GTK3");
    expect(parseSlicerVersion("OrcaSlicer 2.2.0")).toBe("2.2.0");
    expect(parseSlicerVersion("bash: command not found")).toBeNull();
  });
});

describe("slicing through the adapters", () => {
  it("reports 'slicer-not-installed' clearly", async () => {
    const r = await preparePrint({ inputPath: await stlFile(), options: { outputDir: await tmp(), detect: NO_SLICER } });
    expect(r.slicer.ok).toBe(false);
    if (!r.slicer.ok) {
      expect(r.slicer.reason).toBe("slicer-not-installed");
      expect(r.slicer.message).toMatch(/apt install prusa-slicer/);
    }
  });

  it("runs PrusaSlicer with the profile and parses its G-code", async () => {
    const { exec, calls } = fakeSlicerExec();
    const stl = await stlFile();
    const out = await tmp();
    const r = await sliceWith(PRUSA, { modelPath: stl, outDir: out, supports: "auto" }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe(PRUSA.path);
    expect(calls[0].args).toEqual([
      "--export-gcode", "--load", join(out, "printer-afinia-qd330.ini"), "--load", join(out, "filament-pla.ini"), "--output", join(out, "morphix.gcode"),
      "--center", "0,0", "--support-material", "--support-material-auto", stl,
    ]);
    expect(await readFile(join(out, "printer-afinia-qd330.ini"), "utf8")).toBe(await readFile(join(PROFILES, "qd330-pla-0.2mm.ini"), "utf8"));
    expect(r.rawGcodePath).toBe(join(out, "morphix.gcode"));
    expect(r.format).toBe("gx");
    expect(r.printablePath).toBe(join(out, "model.gx"));
    expect(r.estimates?.printTimeS).toBe(3723);
    expect(r.estimates?.layerCount).toBe(3);
  });

  it("builds override flags", () => {
    const a = prusaArgs({ stlPath: "m.stl", outPath: "o.gcode", ini: "p.ini", supports: "buildplate", layerHeightMm: 0.3, infillPercent: 20, center: { x: 110, y: 110 } });
    expect(a).toContain("--support-material-buildplate-only");
    expect(a.join(" ")).toContain("--layer-height 0.3 --first-layer-height 0.3 --fill-density 20%");
    expect(a[a.length - 1]).toBe("m.stl");
  });

  it("runs OrcaSlicer with a per-job process file", async () => {
    const { exec, calls } = fakeSlicerExec(ORCA_GCODE);
    const out = await tmp();
    const r = await sliceWith(ORCA, { modelPath: await stlFile(), outDir: out, supports: "auto", infillPercent: 25 }, exec);
    expect(r.ok).toBe(true);
    const args = calls[0].args;
    expect(args.slice(0, 2)).toEqual(["--slice", "0"]);
    const settings = args[args.indexOf("--load-settings") + 1].split(";");
    const proc = JSON.parse(await readFile(settings[1], "utf8"));
    expect(proc).toMatchObject({ enable_support: "1", sparse_infill_density: "25%" });
    if (r.ok) expect(r.rawGcodePath).toBe(join(out, "plate_1.gcode"));
  });

  it("reports slicer failures with the log", async () => {
    const { exec } = fakeSlicerExec(PRUSA_GCODE, { code: 1, stderr: "Object outside print volume" });
    const r = await sliceWith(PRUSA, { modelPath: await stlFile(), outDir: await tmp() }, exec);
    expect(r).toMatchObject({ ok: false, reason: "slicer-failed" });
    if (!r.ok) expect(r.log).toMatch(/outside print volume/);
  });
});

describe("preparePrint", () => {
  // A Meshy-like GLB: Y-up, arbitrary small units, offset from the origin.
  const meshyLike = () => {
    const b = box(0.6, 1.0, 0.4, { x: 0.3, y: -0.2, z: 0.1 }); // glTF: 1.0 tall along Y
    return buildGlb([{ positions: b.positions, indices: b.indices }]);
  };

  it("prepares a GLB without a slicer: scaled, centred, fits, clear reason", async () => {
    const stages: string[] = [];
    const r = await preparePrint({
      buffer: meshyLike(),
      targetHeightMm: 50,
      options: { orientation: "keep", outputDir: await tmp(), profilesDir: PROFILES, detect: NO_SLICER, onProgress: (s) => stages.push(s) },
    });
    expect(r.format).toBe("glb");
    expect(r.size.z).toBeCloseTo(50, 3);
    expect(r.size.y).toBeCloseTo(20, 3); // glTF Z (0.4) -> printer Y
    expect(r.size.x).toBeCloseTo(30, 3);
    expect(r.fits.fits).toBe(true);
    expect(r.report.final.watertight).toBe(true);
    expect(r.report.final.bounds.min.z).toBeCloseTo(0, 4);
    expect((r.report.final.bounds.min.x + r.report.final.bounds.max.x) / 2).toBeCloseTo(110, 3);
    expect(r.slicer).toMatchObject({ ok: false, reason: "slicer-not-installed" });
    expect(r.gx).toMatchObject({ ok: false, reason: "slicer-not-installed" });
    expect(r.ok).toBe(false);
    expect(r.estimates.source).toBe("mesh-heuristic");
    expect(r.estimates.layerCount).toBe(250);
    expect(r.repairedStl.length).toBe(84 + 12 * 50);
    expect(await readFile(r.files.stl)).toEqual(r.repairedStl);
    expect(stages).toEqual(["load", "validate", "repair", "place", "slice", "done"]);
  });

  it("produces a validated (but unverified) .gx with a slicer", async () => {
    const { exec, calls } = fakeSlicerExec();
    const dir = await tmp();
    const r = await preparePrint({ buffer: meshyLike(), targetHeightMm: 40, options: { outputDir: dir, slicer: PRUSA, supports: "auto", profilesDir: PROFILES, exec } });
    expect(r.ok).toBe(true);
    expect(calls[0].args[calls[0].args.length - 1]).toBe(join(dir, "model.stl"));
    expect(r.estimates).toEqual({ printTimeS: 3723, filamentMm: 1234.56, filamentG: 3.68, layerCount: 3, source: "slicer" });
    if (!r.gx.ok) throw new Error(r.gx.message);
    expect(r.gx.verified).toBe(false);
    expect(r.gx.validation.ok).toBe(true);
    const onDisk = await readFile(r.files.gx!);
    expect(validateGx(onDisk).ok).toBe(true);
    expect(readGx(onDisk).gcode.toString()).toBe(capFirstLayers(applyLeveling(PRUSA_GCODE).gcode)); // bed levelled, first 2 layers capped, otherwise as sliced
    expect(r.warnings.join(" ")).toMatch(/UNVERIFIED/);
  });

  it("refuses to slice a model that is too large", async () => {
    const { exec, calls } = fakeSlicerExec();
    const r = await preparePrint({ buffer: meshyLike(), format: "glb", targetHeightMm: 250, options: { orientation: "keep", outputDir: await tmp(), slicer: PRUSA, exec } });
    expect(r.fits.fits).toBe(false);
    expect(r.slicer).toMatchObject({ ok: false, reason: "too-large" });
    expect(r.gx).toMatchObject({ ok: false, reason: "too-large" });
    if (!r.slicer.ok) expect(r.slicer.message).toMatch(/^Too large/);
    expect(calls).toHaveLength(0);
  });

  it("reads an STL from disk and can skip slicing", async () => {
    const dir = await tmp();
    await mkdir(join(dir, "in"), { recursive: true });
    const p = join(dir, "in", "part.stl");
    await writeFile(p, writeBinaryStl(box(10, 10, 10)));
    const r = await preparePrint({ inputPath: p, options: { slice: false, outputDir: join(dir, "out"), baseName: "part" } });
    expect(r.format).toBe("stl");
    expect(r.scale).toBe(1);
    expect(r.size).toEqual({ x: 10, y: 10, z: 10 });
    expect(r.slicer).toMatchObject({ ok: false, reason: "skipped" });
    expect(r.files.stl).toBe(join(dir, "out", "part.stl"));
  });
});
