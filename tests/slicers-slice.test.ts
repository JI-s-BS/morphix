// Slicing through the adapters: argument lists per slicer, output in the printer's file
// format (.gcode, .gx, .gcode.3mf), post-processing only where it is safe, vendor-profile
// fallback, unsupported combinations, pickSlicer and preparePrint for a non-QD330 printer.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  capFirstLayers, defaultPrinter, LEVEL_MARKER, parsePrusaIni, pickSlicer, preparePrint, readGx, SLICERS, unsupportedReason, writeBinaryStl,
  type MorphixSliceJob, type SlicerInstall,
} from "@morphix/slicing";
import { box, PRUSA_GCODE } from "./phase3-fixtures";
import { BAMBU_GCODE, ENDER3, fakeExec, KLIPPER, P1S, ULTIMAKER } from "./slicers-helpers";

const tmp = () => mkdtemp(join(tmpdir(), "morphix-slicers-"));
const PRUSA: SlicerInstall = { id: "prusaslicer", path: "/usr/bin/prusa-slicer", version: "2.9.2", via: "apt" };
const ORCA: SlicerInstall = { id: "orcaslicer", path: "/usr/bin/orca-slicer", version: "2.3.0", via: "path" };
const BAMBU: SlicerInstall = { id: "bambustudio", path: "/opt/bambu/bambu-studio", version: "01.10.02.76", via: "path" };

async function job(printer = ENDER3, extra: Partial<MorphixSliceJob> = {}): Promise<MorphixSliceJob> {
  const outDir = await tmp();
  const modelPath = join(outDir, "in.stl");
  await writeFile(modelPath, writeBinaryStl(box(20, 20, 20)));
  return { modelPath, outDir, printer, filament: "pla", ...extra };
}
const loads = (args: string[]) => args.flatMap((a, i) => (a === "--load" ? [args[i + 1]] : []));
const withMarker = PRUSA_GCODE.replace("G28\n", `G28\nM190 S60\n${LEVEL_MARKER}\n`);

describe("PrusaSlicer adapter", () => {
  it("Ender-3: generated profile, bed centre 110,110, plain .gcode with the first layers capped", async () => {
    const j = await job(ENDER3, { supports: "buildplate", layerHeightMm: 0.28, speedMmS: 400, zOffsetMm: 0.1 });
    const { exec, calls } = fakeExec();
    const r = await SLICERS.prusaslicer.slice(PRUSA, j, { exec });
    if (!r.ok) throw new Error(r.message);
    const args = calls[0].args;
    expect(calls[0].file).toBe("/usr/bin/prusa-slicer");
    expect(loads(args)).toEqual([join(j.outDir, "printer-test-ender-3.ini"), join(j.outDir, "filament-pla.ini"), join(j.outDir, "morphix-speed.ini"), join(j.outDir, "morphix-z-offset.ini")]);
    expect(args.slice(args.indexOf("--center"), args.indexOf("--center") + 2)).toEqual(["--center", "110,110"]);
    expect(args).toContain("--support-material-buildplate-only");
    expect(args.join(" ")).toContain("--layer-height 0.28");
    expect(parsePrusaIni(await readFile(loads(args)[0], "utf8")).bed_shape).toBe("0x0,220x0,220x220,0x220");
    expect(parsePrusaIni(await readFile(loads(args)[2], "utf8")).perimeter_speed).toBe("150"); // the Ender has no catalog max: 150 mm/s
    expect(r).toMatchObject({ format: "gcode", printablePath: join(j.outDir, "model.gcode"), gcodePath: join(j.outDir, "model.gcode"), profile: "generated" });
    expect(r.gx).toBeUndefined();
    expect(await readFile(r.printablePath, "utf8")).toBe(capFirstLayers(PRUSA_GCODE)); // no probe: no leveling added
    expect(r.leveling).toMatchObject({ mode: "printer", commands: [] });
    expect(r.estimatedTimeS).toBe(3723);
  });

  it("Klipper printer: the catalog's leveling command replaces the marker", async () => {
    const { exec } = fakeExec({ gcode: withMarker });
    const r = await SLICERS.prusaslicer.slice(PRUSA, await job(KLIPPER), { exec });
    if (!r.ok) throw new Error(r.message);
    expect(r.leveling).toMatchObject({ mode: "gcode", commands: ["BED_MESH_CALIBRATE"], markerFound: true });
    expect(await readFile(r.printablePath, "utf8")).toMatch(/^BED_MESH_CALIBRATE$/m);
    expect(r.warnings.join(" ")).toMatch(/UNVERIFIED command \(BED_MESH_CALIBRATE\), from the printer catalog/);
  });

  it("QD330: .gx with G29 leveling, as before", async () => {
    const j = await job(defaultPrinter());
    const { exec, calls } = fakeExec({ gcode: withMarker });
    const r = await SLICERS.prusaslicer.slice(PRUSA, j, { exec });
    if (!r.ok || !r.gx) throw new Error("no gx");
    expect(calls[0].args.slice(calls[0].args.indexOf("--center"), calls[0].args.indexOf("--center") + 2)).toEqual(["--center", "0,0"]);
    expect(r.format).toBe("gx");
    expect(r.gx.validation.ok).toBe(true);
    expect(readGx(await readFile(r.printablePath)).gcode.toString()).toMatch(/^G29$/m);
    expect(r.warnings.join(" ")).toMatch(/checklist L1/);
  });

  it("prefers the vendor profile, and falls back to the generated one when PrusaSlicer refuses it", async () => {
    const p = { ...ENDER3, vendorProfiles: { prusaslicer: "Creality Ender-3" } };
    const ok = fakeExec();
    const r1 = await SLICERS.prusaslicer.slice(PRUSA, await job(p), { exec: ok.exec });
    expect(r1).toMatchObject({ ok: true, profile: "vendor" });
    expect(ok.calls[0].args.slice(1, 3)).toEqual(["--printer-profile", "Creality Ender-3"]);
    expect(loads(ok.calls[0].args)[0]).toMatch(/print-test-ender-3\.ini$/);
    expect(parsePrusaIni(await readFile(loads(ok.calls[0].args)[0], "utf8")).binary_gcode).toBe("0"); // vendor profiles may turn on .bgcode

    const refused = fakeExec({ fail: (a) => a.includes("--printer-profile") });
    const r2 = await SLICERS.prusaslicer.slice(PRUSA, await job(p), { exec: refused.exec });
    expect(r2).toMatchObject({ ok: true, profile: "generated" });
    expect(refused.calls).toHaveLength(2);
    expect(refused.calls[1].args).not.toContain("--printer-profile");
    if (r2.ok) expect(r2.warnings.join(" ")).toMatch(/could not use its vendor profile "Creality Ender-3".*Unknown printer profile/);
  });

  it("uses the generated profile on PrusaSlicer older than 2.6 (no --printer-profile)", async () => {
    const { exec, calls } = fakeExec();
    const r = await SLICERS.prusaslicer.slice({ ...PRUSA, version: "2.5.0+linux-armv7l" }, await job({ ...ENDER3, vendorProfiles: { prusaslicer: "Creality Ender-3" } }), { exec });
    expect(calls[0].args).not.toContain("--printer-profile");
    if (r.ok) expect(r.warnings.join(" ")).toMatch(/older than 2\.6/);
  });

  it("runs a Flatpak install with the job folders shared", async () => {
    const j = await job();
    const { exec, calls } = fakeExec();
    await SLICERS.prusaslicer.slice({ id: "prusaslicer", path: "/usr/bin/flatpak", baseArgs: ["run", "com.prusa3d.PrusaSlicer"], version: "2.9.2", via: "flatpak" }, j, { exec });
    expect(calls[0].file).toBe("/usr/bin/flatpak");
    expect(calls[0].args.slice(0, 4)).toEqual(["run", `--filesystem=${j.outDir}`, "com.prusa3d.PrusaSlicer", "--export-gcode"]); // model is in outDir here
  });

  it("refuses Bambu and Ultimaker printers with a reason", async () => {
    expect(SLICERS.prusaslicer.supports(P1S)).toBe(false);
    expect(SLICERS.prusaslicer.supports(ULTIMAKER)).toBe(false);
    const r = await SLICERS.prusaslicer.slice(PRUSA, await job(P1S), { exec: fakeExec().exec });
    expect(r).toMatchObject({ ok: false, reason: "unsupported-printer" });
    if (!r.ok) expect(r.message).toMatch(/OrcaSlicer or Bambu Studio/);
  });
});

describe("OrcaSlicer / Bambu Studio adapters", () => {
  it("Ender-3 via Orca: --slice / --arrange / settings / filament / outputdir, plain .gcode", async () => {
    const j = await job(ENDER3, { infillPercent: 30, zOffsetMm: -0.1 });
    const { exec, calls } = fakeExec();
    const r = await SLICERS.orcaslicer.slice(ORCA, j, { exec });
    if (!r.ok) throw new Error(r.message);
    const machine = join(j.outDir, "morphix-machine.json"), proc = join(j.outDir, "morphix-process.json"), fil = join(j.outDir, "filament-pla.json");
    expect(calls[0].args).toEqual(["--slice", "0", "--arrange", "1", "--load-settings", `${machine};${proc}`, "--load-filaments", fil, "--outputdir", j.outDir, j.modelPath]);
    expect(JSON.parse(await readFile(machine, "utf8"))).toMatchObject({ gcode_flavor: "marlin2", z_offset: "-0.1", printable_area: ["0x0", "220x0", "220x220", "0x220"] });
    expect(JSON.parse(await readFile(proc, "utf8"))).toMatchObject({ sparse_infill_density: "30%" });
    expect(r).toMatchObject({ format: "gcode", rawGcodePath: join(j.outDir, "plate_1.gcode"), printablePath: join(j.outDir, "model.gcode") });
  });

  it.each([["orcaslicer", ORCA], ["bambustudio", BAMBU]] as const)("Bambu P1S via %s: sliced .gcode.3mf from the bundled printer, never post-processed", async (id, install) => {
    const j = await job(P1S, { printableDir: undefined, baseName: "cube" });
    const { exec, calls } = fakeExec();
    const r = await SLICERS[id].slice(install, j, { exec });
    if (!r.ok) throw new Error(r.message);
    const args = calls[0].args;
    expect(args.slice(args.indexOf("--export-3mf"), args.indexOf("--export-3mf") + 2)).toEqual(["--export-3mf", "cube.gcode.3mf"]);
    expect(JSON.parse(await readFile(join(j.outDir, "morphix-machine.json"), "utf8"))).toMatchObject({ inherits: "Bambu Lab P1S 0.4 nozzle" });
    expect(r).toMatchObject({ format: "gcode.3mf", printablePath: join(j.outDir, "cube.gcode.3mf"), profile: "vendor", leveling: null });
    expect(await readFile(r.gcodePath!, "utf8")).toBe(BAMBU_GCODE); // extracted for the preview, untouched
    expect(r.estimatedTimeS).toBe(600);
  });

  it("won't guess Bambu start G-code: no vendor profile = unsupported, and no fallback", async () => {
    const bare = { ...P1S, vendorProfiles: undefined };
    expect(SLICERS.orcaslicer.supports(bare)).toBe(false);
    expect(unsupportedReason("bambustudio", bare)).toMatch(/won't guess Bambu start G-code/);
    const refused = fakeExec({ fail: () => true });
    const r = await SLICERS.orcaslicer.slice(ORCA, await job(P1S), { exec: refused.exec });
    expect(r).toMatchObject({ ok: false, reason: "slicer-failed" });
    expect(refused.calls).toHaveLength(1);
  });

  it("Orca can still make FlashForge .gx for the QD330 (Morphix wraps it)", async () => {
    const r = await SLICERS.orcaslicer.slice(ORCA, await job(defaultPrinter()), { exec: fakeExec().exec });
    expect(r).toMatchObject({ ok: true, format: "gx" });
  });

  it("Ultimaker .ufp is unsupported everywhere, with the reason", () => {
    for (const a of Object.values(SLICERS)) expect(a.supports(ULTIMAKER), a.id).toBe(false);
    expect(unsupportedReason("orcaslicer", ULTIMAKER)).toMatch(/Griffin.*Cura/);
  });
});

describe("pickSlicer", () => {
  it("takes the preferred slicer, else PrusaSlicer first for plain printers", () => {
    expect(pickSlicer(ENDER3, [ORCA, PRUSA])).toMatchObject({ ok: true, install: PRUSA });
    expect(pickSlicer(ENDER3, [ORCA, PRUSA], "orcaslicer")).toMatchObject({ ok: true, install: ORCA, warnings: [] });
    const r = pickSlicer(ENDER3, [ORCA], "prusaslicer");
    expect(r).toMatchObject({ ok: true, install: ORCA });
    if (r.ok) expect(r.warnings[0]).toMatch(/not installed/);
  });

  it("Bambu printers: Bambu Studio, then Orca; never PrusaSlicer", () => {
    expect(pickSlicer(P1S, [PRUSA, ORCA, BAMBU])).toMatchObject({ ok: true, install: BAMBU });
    expect(pickSlicer(P1S, [PRUSA, ORCA])).toMatchObject({ ok: true, install: ORCA });
    const r = pickSlicer(P1S, [PRUSA], "prusaslicer", { distro: "debian", arch: "arm64" });
    expect(r).toMatchObject({ ok: false, reason: "slicer-not-installed" });
    if (!r.ok) expect(r.message).toMatch(/installed: PrusaSlicer, which can't.*no official arm64/);
  });

  it("prefers a slicer the catalog names a vendor profile for", () => {
    const k1 = { ...KLIPPER, vendorProfiles: { orcaslicer: "Creality K1 (0.4 nozzle)" } };
    expect(pickSlicer(k1, [PRUSA, ORCA])).toMatchObject({ ok: true, install: ORCA });
    expect(pickSlicer(k1, [PRUSA])).toMatchObject({ ok: true, install: PRUSA });
  });

  it("explains unsupported printers and missing slicers", () => {
    expect(pickSlicer(ULTIMAKER, [PRUSA, ORCA])).toMatchObject({ ok: false, reason: "unsupported-printer" });
    const r = pickSlicer(ENDER3, [], undefined, { distro: "raspbian", arch: "arm64" });
    if (r.ok) throw new Error("picked");
    expect(r.message).toMatch(/No slicer installed for the Creality Ender-3\. Install PrusaSlicer: sudo apt install prusa-slicer/);
  });
});

describe("preparePrint for any catalog printer", () => {
  it("Ender-3: its own build volume, a .gcode to send, no .gx", async () => {
    const dir = await tmp();
    const r = await preparePrint({
      buffer: writeBinaryStl(box(20, 20, 240)), format: "stl",
      options: { printer: ENDER3, outputDir: dir, slicer: PRUSA, exec: fakeExec().exec, upAxis: "z", orientation: "keep" },
    });
    expect(r.fits.fits).toBe(true); // 240 mm tall fits the Ender's 250, not the QD330's 220
    expect(r.printerId).toBe("test-ender-3");
    expect(r.ok).toBe(true);
    expect(r.printable).toEqual({ ok: true, path: join(dir, "model.gcode"), format: "gcode" });
    expect(r.gx).toMatchObject({ ok: false, reason: "not-gx" });
    expect(r.files.gcode).toBe(join(dir, "model.gcode"));
    expect(r.estimates.source).toBe("slicer");
    expect(r.warnings.join(" ")).not.toMatch(/\.gx/);
  });

  it("Bambu printer with only PrusaSlicer given: clear unsupported reason", async () => {
    const r = await preparePrint({ buffer: writeBinaryStl(box(20, 20, 20)), format: "stl", options: { printer: P1S, outputDir: await tmp(), slicer: PRUSA, exec: fakeExec().exec } });
    expect(r.slicer).toMatchObject({ ok: false, reason: "unsupported-printer" });
    expect(r.printable).toMatchObject({ ok: false, reason: "unsupported-printer" });
    expect(r.ok).toBe(false);
  });

  it("detects and picks the preferred slicer for the printer", async () => {
    const dir = await tmp();
    const bin = join(dir, "orca-slicer");
    await writeFile(bin, "x", { mode: 0o755 });
    const r = await preparePrint({
      buffer: writeBinaryStl(box(20, 20, 20)), format: "stl",
      options: { printer: P1S, outputDir: join(dir, "out"), preferredSlicer: "orcaslicer", detect: { searchPath: [dir], env: { DISPLAY: ":0" } }, exec: fakeExec().exec },
    });
    expect(r.slicer).toMatchObject({ ok: true, slicer: { kind: "orcaslicer", path: bin } });
    expect(r.printable).toMatchObject({ ok: true, format: "gcode.3mf", path: join(dir, "out", "model.gcode.3mf") });
  });
});
