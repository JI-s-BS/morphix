// Generic filament profiles: limits, the PrusaSlicer overlay, and the OrcaSlicer file.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BED_MAX_C, NOZZLE_MAX_C, sanitizeFileName } from "@morphix/printer";
import {
  changeTemperature, filamentChangeGcode, orcaFilamentJson, filamentJobFileName, isFilamentJobFile, validateGx, writeGx, FILAMENT_IDS, FILAMENTS, filamentProfile, parsePrusaIni, prusaFilamentConfig, writeBinaryStl, writePrusaFilamentIni, defaultPrinter, SLICERS, toSlicerInstall, type ExecFileFn, type FilamentId, type SlicerInfo,
} from "@morphix/slicing";
import { box, fakeSlicerExec, ORCA_GCODE } from "./phase3-fixtures";

const PRUSA: SlicerInfo = { kind: "prusaslicer", path: "/usr/bin/prusa-slicer", version: "2.9.2" };
const ORCA: SlicerInfo = { kind: "orcaslicer", path: "/usr/bin/orca-slicer", version: "2.2.0" };
const tmp = () => mkdtemp(join(tmpdir(), "morphix-fil-"));
const sliceStl = (o: { stlPath: string; outDir: string; slicer: SlicerInfo; filament: FilamentId; exec: ExecFileFn }) =>
  SLICERS[o.slicer.kind].slice(toSlicerInstall(o.slicer), { modelPath: o.stlPath, outDir: o.outDir, printer: defaultPrinter(), filament: o.filament }, { exec: o.exec });

describe("generic filament profiles", () => {
  it("cover the common materials and stay inside the printer's heater limits", () => {
    expect(FILAMENT_IDS).toEqual(["pla", "pla-plus", "petg", "elegoo-rapid-petg", "abs", "asa", "tpu"]);
    for (const f of Object.values(FILAMENTS)) {
      for (const t of [f.nozzleC, f.firstLayerNozzleC, f.changeC]) expect(t).toBeLessThanOrEqual(NOZZLE_MAX_C);
      for (const t of [f.bedC, f.firstLayerBedC]) expect(t).toBeLessThanOrEqual(BED_MAX_C);
      expect(f.nozzleC).toBeGreaterThanOrEqual(180);
      expect(f.fanMinPct).toBeLessThanOrEqual(f.fanMaxPct);
    }
    expect(FILAMENTS.tpu.maxVolumetricMm3S).toBeLessThan(FILAMENTS.pla.maxVolumetricMm3S); // TPU must print slowly
    expect(FILAMENTS.abs.fanMaxPct).toBeLessThanOrEqual(20); // ABS warps with lots of cooling
  });

  it("falls back to PLA for unknown ids and heats hot enough for both when swapping", () => {
    expect(filamentProfile("nylon").id).toBe("pla");
    expect(changeTemperature("pla", "petg")).toBe(FILAMENTS.petg.changeC);
    expect(changeTemperature("asa", "pla")).toBe(FILAMENTS.asa.changeC);
  });

  it("writes a PrusaSlicer overlay with the filament's temperatures, fan, retraction and flow cap", async () => {
    const dir = await tmp();
    const ini = parsePrusaIni(await readFile(await writePrusaFilamentIni(dir, "petg"), "utf8"));
    expect(ini).toMatchObject({
      filament_type: "PETG", temperature: "240", first_layer_temperature: "240", bed_temperature: "80", first_layer_bed_temperature: "80",
      min_fan_speed: "30", max_fan_speed: "50", disable_fan_first_layers: "3", filament_max_volumetric_speed: "8",
    });
    // Only filament keys: the overlay must never change the printer, bed shape or start G-code.
    for (const k of Object.keys(prusaFilamentConfig(FILAMENTS.abs))) expect(k).not.toMatch(/bed_shape|start_gcode|end_gcode|z_offset|nozzle_diameter/);
  });

  it("slices with the chosen filament layered over the base profile", async () => {
    const { exec, calls } = fakeSlicerExec();
    const out = await tmp();
    const stl = join(out, "m.stl");
    await writeFile(stl, writeBinaryStl(box(20, 20, 20)));
    const r = await sliceStl({ stlPath: stl, outDir: out, slicer: PRUSA, filament: "tpu", exec });
    expect(r.ok).toBe(true);
    const args = calls[0].args;
    const loads = args.flatMap((a, i) => (a === "--load" ? [args[i + 1]] : []));
    expect(loads).toEqual([join(out, "printer-afinia-qd330.ini"), join(out, "filament-tpu.ini")]);
    expect(parsePrusaIni(await readFile(loads[1], "utf8")).temperature).toBe("225");
  });

  it("gives OrcaSlicer a matching filament file", async () => {
    const { exec, calls } = fakeSlicerExec(ORCA_GCODE);
    const out = await tmp();
    const stl = join(out, "m.stl");
    await writeFile(stl, writeBinaryStl(box(20, 20, 20)));
    await sliceStl({ stlPath: stl, outDir: out, slicer: ORCA, filament: "abs", exec });
    const args = calls[0].args;
    const json = JSON.parse(await readFile(args[args.indexOf("--load-filaments") + 1], "utf8"));
    expect(json).toMatchObject({ filament_type: ["ABS"], nozzle_temperature: ["245"], hot_plate_temp: ["100"], fan_max_speed: ["15"] });
  });
});

describe("Elegoo Rapid PETG profile", () => {
  const f = FILAMENTS["elegoo-rapid-petg"];

  it("uses Elegoo's published temperatures, within the QD330's heaters", () => {
    expect(filamentProfile("elegoo-rapid-petg")).toBe(f);
    expect(f).toMatchObject({ label: "Elegoo Rapid PETG", material: "PETG", brand: "Elegoo", densityGcm3: 1.29 });
    // Elegoo: nozzle 240-270 °C, bed 65-75 °C. The QD330 nozzle stops at 250 °C.
    for (const t of [f.nozzleC, f.firstLayerNozzleC, f.changeC]) {
      expect(t).toBeGreaterThanOrEqual(240);
      expect(t).toBeLessThanOrEqual(Math.min(270, NOZZLE_MAX_C));
    }
    for (const t of [f.bedC, f.firstLayerBedC]) {
      expect(t).toBeGreaterThanOrEqual(65);
      expect(t).toBeLessThanOrEqual(75);
    }
    expect([f.nozzleC, f.bedC, f.firstLayerBedC, f.changeC]).toEqual([245, 70, 75, 245]);
    // Not pushed faster than generic PETG: the QD330 profile doesn't allow "rapid" speeds.
    expect(f.maxVolumetricMm3S).toBeLessThanOrEqual(FILAMENTS.petg.maxVolumetricMm3S);
    expect(f.notes.join(" ")).toMatch(/dry.*60 °C/i);
    // The generic PETG profile stays as it was.
    expect(FILAMENTS.petg).toMatchObject({ label: "PETG", nozzleC: 240, bedC: 80 });
  });

  it("heats hot enough for both when swapping to or from it", () => {
    expect(changeTemperature("pla", "elegoo-rapid-petg")).toBe(245);
    expect(changeTemperature("elegoo-rapid-petg", "asa")).toBe(FILAMENTS.asa.changeC);
    const g = filamentChangeGcode("load", changeTemperature("pla", "elegoo-rapid-petg"), f.label);
    expect(g).toMatch(/^M109 S245 T0$/m);
    expect(g).toMatch(/; filament_type = Elegoo Rapid PETG/);
  });

  it("writes a PETG PrusaSlicer overlay with Elegoo's numbers", async () => {
    const dir = await tmp();
    const path = await writePrusaFilamentIni(dir, "elegoo-rapid-petg");
    expect(path).toBe(join(dir, "filament-elegoo-rapid-petg.ini"));
    const ini = parsePrusaIni(await readFile(path, "utf8"));
    expect(ini).toMatchObject({
      filament_type: "PETG", filament_settings_id: "Morphix Elegoo Rapid PETG (Elegoo)", filament_density: "1.29",
      temperature: "245", first_layer_temperature: "245", bed_temperature: "70", first_layer_bed_temperature: "75",
      min_fan_speed: "30", max_fan_speed: "50", disable_fan_first_layers: "3", filament_max_volumetric_speed: "8",
    });
  });

  it("slices with it in PrusaSlicer and OrcaSlicer", async () => {
    const out = await tmp();
    const stl = join(out, "m.stl");
    await writeFile(stl, writeBinaryStl(box(20, 20, 20)));
    const prusa = fakeSlicerExec();
    expect((await sliceStl({ stlPath: stl, outDir: out, slicer: PRUSA, filament: "elegoo-rapid-petg", exec: prusa.exec })).ok).toBe(true);
    const args = prusa.calls[0].args;
    const loads = args.flatMap((a, i) => (a === "--load" ? [args[i + 1]] : []));
    expect(loads).toEqual([join(out, "printer-afinia-qd330.ini"), join(out, "filament-elegoo-rapid-petg.ini")]);

    const orca = fakeSlicerExec(ORCA_GCODE);
    await sliceStl({ stlPath: stl, outDir: out, slicer: ORCA, filament: "elegoo-rapid-petg", exec: orca.exec });
    const oargs = orca.calls[0].args;
    const json = JSON.parse(await readFile(oargs[oargs.indexOf("--load-filaments") + 1], "utf8"));
    expect(json).toEqual(orcaFilamentJson(f));
    expect(json).toMatchObject({
      name: "Morphix Elegoo Rapid PETG (Elegoo)", filament_type: ["PETG"], filament_density: ["1.29"],
      nozzle_temperature: ["245"], hot_plate_temp: ["70"], hot_plate_temp_initial_layer: ["75"], fan_max_speed: ["50"], filament_max_volumetric_speed: ["8"],
    });
  });
});

describe("filament load/unload job", () => {
  it("heats, waits for temperature, then feeds forward to load", () => {
    const g = filamentChangeGcode("load", 240, "PETG");
    const lines = g.split("\n");
    const heat = lines.findIndex((l) => l.startsWith("M109 S240"));
    const firstFeed = lines.findIndex((l) => /^G1 E\d/.test(l));
    expect(heat).toBeGreaterThan(-1);
    expect(firstFeed).toBeGreaterThan(heat); // never moves the feeder on a cold nozzle
    expect(lines.findIndex((l) => l === "G28")).toBeLessThan(heat); // nozzle up high before purging
    expect(g).toMatch(/G1 E100 /);
    expect(g).not.toMatch(/M83/); // absolute extrusion only
  });

  it("is laid out like a slicer file (the firmware didn't run a bare one)", () => {
    const g = filamentChangeGcode("unload", 220, "PLA");
    const firstCommand = g.split("\n").find((l) => /^[GM]\d/.test(l));
    expect(firstCommand).toBe("M140 S0 T0");
    expect(g).toMatch(/^; generated by /);
    expect(g).toMatch(/;TYPE:Custom/);
    expect(g).toMatch(/;LAYER_CHANGE/);
    expect(g.trimEnd().endsWith("; prusaslicer_config = end")).toBe(true);
    expect(g.length).toBeGreaterThanOrEqual(24_000);
  });

  it("unloads by pulling the filament back out after heating", () => {
    const g = filamentChangeGcode("unload", 220);
    expect(g.indexOf("M109 S220")).toBeLessThan(g.indexOf("G1 E-80"));
  });

  it("is a valid printer file that the controller will accept", () => {
    const gx = writeGx({ gcode: filamentChangeGcode("load", 220), printTimeS: 150, filamentMm: 100, layerHeightMm: 0.2, bedTempC: 0, extruderTempC: 220 });
    expect(validateGx(gx).ok).toBe(true);
    expect(isFilamentJobFile(filamentJobFileName("load"))).toBe(true);
    expect(isFilamentJobFile("morphix-1234.gx")).toBe(false);
    expect(() => sanitizeFileName(filamentJobFileName("unload"))).not.toThrow();
  });
});

describe("first layer height above the bed", () => {
  it("default Z offset is -0.05 mm", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const ini = readFileSync(resolve(__dirname, "../config/slicer-profiles/qd330-pla-0.2mm.ini"), "utf8");
    const orca = JSON.parse(readFileSync(resolve(__dirname, "../config/slicer-profiles/orcaslicer/qd330-machine.json"), "utf8"));
    expect(ini).toMatch(/^z_offset = -0\.05$/m);
    expect(orca.z_offset).toBe("-0.05");
  });
});
