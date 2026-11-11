// Slicer profiles generated from the printer catalog: the centre-origin QD330 (behaviour kept
// from the old hand-written files) and a corner-origin Ender-3, plus round beds, vendor
// profiles and temperature limits. MORPHIX_WRITE_PROFILE_SNAPSHOTS=1 rewrites the checked-in
// QD330 snapshots in config/slicer-profiles.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bedCenter, bedShape, defaultPrinter, filamentFor, LEVEL_MARKER, orcaFilamentJson, orcaMachineJson, orcaProcessJson, parsePrusaIni, printableVolume,
  printerZOffsetMm, profileZOffset, prusaProfileIni, startSequence, toOrcaPlaceholders, FILAMENTS,
} from "@morphix/slicing";
import { ENDER3, KLIPPER, P1S } from "./slicers-helpers";

const PROFILES = resolve(__dirname, "..", "config", "slicer-profiles");
const QD330 = defaultPrinter();
const SNAPSHOTS: Record<string, () => string> = {
  "qd330-pla-0.2mm.ini": () => prusaProfileIni(QD330),
  "orcaslicer/qd330-machine.json": () => JSON.stringify(orcaMachineJson(QD330), null, 2) + "\n",
  "orcaslicer/qd330-process-0.2mm.json": () => JSON.stringify(orcaProcessJson(QD330), null, 2) + "\n",
  "orcaslicer/qd330-pla.json": () => JSON.stringify(orcaFilamentJson(FILAMENTS.pla, QD330.filamentMm), null, 2) + "\n",
};
const startOf = (ini: string) => parsePrusaIni(ini).start_gcode.replace(/\\n/g, "\n");
const fill = (g: string) => g.replace(/\[first_layer_bed_temperature\]/g, "60").replace(/\[first_layer_temperature\]/g, "210");

describe("QD330 (centre origin): same behaviour as the old hand-written profile", () => {
  it("the checked-in snapshots are what the generator makes", async () => {
    for (const [file, make] of Object.entries(SNAPSHOTS)) {
      if (process.env.MORPHIX_WRITE_PROFILE_SNAPSHOTS === "1") await writeFile(join(PROFILES, file), make());
      expect(await readFile(join(PROFILES, file), "utf8"), file).toBe(make());
    }
  });

  it("keeps bed, offset, fan, purge line and leveling marker", () => {
    const text = prusaProfileIni(QD330);
    const ini = parsePrusaIni(text);
    expect(ini).toMatchObject({
      bed_shape: "-110x-110,110x-110,110x110,-110x110", max_print_height: "220", nozzle_diameter: "0.4", gcode_flavor: "marlin",
      z_offset: "-0.05", filament_diameter: "1.75", temperature: "210", bed_temperature: "60", disable_fan_first_layers: "2",
      layer_height: "0.2", perimeters: "2", fill_density: "15%", first_layer_speed: "20", skirts: "1", brim_width: "0",
    });
    expect(profileZOffset(text)).toBe(-0.05);
    expect(printerZOffsetMm(QD330)).toBe(-0.05);
    const start = startOf(text).split("\n");
    // The old profile's start G-code, line for line after the header comment.
    expect(start.slice(1)).toEqual([
      "M140 S[first_layer_bed_temperature] T0", "M104 S[first_layer_temperature] T0", "M107", "G90", "M82", "G28", "G1 Z30 F600",
      "M190 S[first_layer_bed_temperature]", LEVEL_MARKER, "M109 S[first_layer_temperature] T0", "G92 E0", "G1 X-100 Y-100 F3000", "G1 Z0.4 F600",
      "; purge: 2 x 200 mm at 150% flow (0.15 mm filament per mm)", "G1 X100 Y-100 E30 F600", "G1 Y-99.2 F600", "G1 X-100 Y-99.2 E60 F600", "G92 E0",
    ]);
    expect(start[0]).toMatch(/Afinia QD330 \(centre-origin bed -110\.\.110\).*UNVERIFIED/);
    expect(parsePrusaIni(text).end_gcode.split("\\n")).toEqual(["; Morphix end G-code (UNVERIFIED)", "M104 S0 T0", "M140 S0", "M107", "G91", "G1 E-2 F1800", "G1 Z10 F600", "G90", "G28 X Y", "M84"]);
    expect(startSequence(fill(startOf(text))).ordered).toBe(true);
    expect(bedCenter(QD330)).toEqual({ x: 0, y: 0 });
  });

  it("OrcaSlicer gets the same start G-code with its own placeholders, on smooth PEI", () => {
    const m = orcaMachineJson(QD330) as Record<string, string & string[]>;
    expect(m.printable_area).toEqual(["-110x-110", "110x-110", "110x110", "-110x110"]);
    expect(m.machine_start_gcode).toContain("M140 S[bed_temperature_initial_layer_single] T0");
    expect(m.machine_start_gcode).toContain("M109 S[nozzle_temperature_initial_layer] T0");
    expect(m.machine_start_gcode).not.toMatch(/first_layer/);
    expect(orcaProcessJson(QD330)).toMatchObject({ curr_bed_type: "High Temp Plate", layer_height: "0.2", sparse_infill_density: "15%", enable_support: "0" });
  });
});

describe("Ender-3 (corner origin, 220 x 220 x 250, no probe)", () => {
  const text = prusaProfileIni(ENDER3);
  const ini = parsePrusaIni(text);

  it("bed from 0,0, Marlin 2, the catalog's height", () => {
    expect(ini).toMatchObject({ bed_shape: "0x0,220x0,220x220,0x220", max_print_height: "250", gcode_flavor: "marlin2", z_offset: "0" });
    expect(bedCenter(ENDER3)).toEqual({ x: 110, y: 110 });
    expect(printableVolume(ENDER3)).toEqual({ x: 220, y: 220, z: 250 });
  });

  it("purges along its front edge, no FlashForge T0, no leveling marker without a probe", () => {
    const start = startOf(text);
    expect(start).toContain("G1 X10 Y10 F3000");
    expect(start).toContain("G1 X210 Y10 E30 F600");
    expect(start).toContain("G1 X10 Y10.8 E60 F600");
    expect(start).not.toMatch(/ T0/);
    expect(start).not.toContain(LEVEL_MARKER);
    expect(start).toMatch(/corner-origin bed 0\.\.220 x 0\.\.220/);
    const s = startSequence(fill(start));
    expect(s.home).toBeLessThan(s.nozzleWait);
    expect(s.prime).toBeGreaterThan(s.nozzleWait);
  });

  it("Orca bed is corner-origin too", () => {
    expect((orcaMachineJson(ENDER3) as { printable_area: string[] }).printable_area).toEqual(["0x0", "220x0", "220x220", "0x220"]);
  });
});

describe("other printers", () => {
  it("a printer with a probe gets the leveling marker; Klipper maps to Marlin 2 in PrusaSlicer, klipper in Orca", () => {
    expect(startOf(prusaProfileIni(KLIPPER))).toContain(LEVEL_MARKER);
    expect(parsePrusaIni(prusaProfileIni(KLIPPER)).gcode_flavor).toBe("marlin2");
    expect(orcaMachineJson(KLIPPER).gcode_flavor).toBe("klipper");
  });

  it("uses the catalog's start / end G-code when it has one", () => {
    const p = { ...ENDER3, startGcode: "G28\nM190 S[first_layer_bed_temperature]\nM109 S[first_layer_temperature]\nPRINT_START", endGcode: "PRINT_END" };
    expect(startOf(prusaProfileIni(p))).toBe(p.startGcode);
    expect(orcaMachineJson(p).machine_start_gcode).toBe("G28\nM190 S[bed_temperature_initial_layer_single]\nM109 S[nozzle_temperature_initial_layer]\nPRINT_START\n");
    expect(orcaMachineJson(p).machine_end_gcode).toBe("PRINT_END\n");
  });

  it("translates placeholders only inside [ ] / { }", () => {
    expect(toOrcaPlaceholders("; temperature note\nM104 S[temperature]\nM140 S{bed_temperature[0]}")).toBe("; temperature note\nM104 S[nozzle_temperature]\nM140 S{bed_temperature_initial_layer_single[0]}");
  });

  it("round delta beds: centred polygon, inscribed square for the fit check", () => {
    const delta = { ...ENDER3, bed: { x: 200, y: 200, z: 300, shape: "circle" as const }, origin: "center" as const };
    const pts = bedShape(delta);
    expect(pts).toHaveLength(32);
    expect(pts[0]).toEqual([100, 0]);
    expect(printableVolume(delta)).toEqual({ x: 141, y: 141, z: 300 });
    expect(startOf(prusaProfileIni(delta))).toContain("G1 X-60.5 Y-60.5 F3000");
  });

  it("2.85 mm filament purges less filament per mm", () => {
    const p = { ...ENDER3, filamentMm: 2.85 as const };
    expect(parsePrusaIni(prusaProfileIni(p)).filament_diameter).toBe("2.85");
    expect(startOf(prusaProfileIni(p))).toContain("G1 X210 Y10 E11.31 F600");
  });

  it("clamps filament temperatures to the printer, and warns without a heated bed", () => {
    const cold = { ...ENDER3, maxNozzleC: 230, maxBedC: 70 };
    const petg = filamentFor(cold, "petg");
    expect(petg.filament).toMatchObject({ nozzleC: 230, firstLayerNozzleC: 230, bedC: 70, firstLayerBedC: 70 });
    expect(petg.warnings.join(" ")).toMatch(/230 °C.*70 °C/s);
    const noBed = filamentFor({ ...ENDER3, heatedBed: false }, "abs");
    expect(noBed.filament.bedC).toBe(0);
    expect(noBed.warnings[0]).toMatch(/heated bed/);
    expect(filamentFor(ENDER3, "pla")).toEqual({ filament: FILAMENTS.pla, warnings: [] });
    expect(startOf(prusaProfileIni({ ...ENDER3, heatedBed: false }))).not.toMatch(/M1[49]0/);
  });

  it("vendor profiles: PrusaSlicer loads only print keys, Orca/Bambu inherit the bundled printer", () => {
    const vendor = prusaProfileIni({ ...ENDER3, vendorProfiles: { prusaslicer: "Creality Ender-3" } }, { vendor: "Creality Ender-3" });
    expect(parsePrusaIni(vendor)).not.toHaveProperty("bed_shape");
    expect(parsePrusaIni(vendor)).not.toHaveProperty("start_gcode");
    expect(parsePrusaIni(vendor)).toHaveProperty("layer_height", "0.2");
    expect(orcaMachineJson(P1S, { vendor: "Bambu Lab P1S 0.4 nozzle" })).toEqual({ type: "machine", name: "Morphix Bambu Lab P1S 0.4 nozzle (UNVERIFIED)", from: "User", inherits: "Bambu Lab P1S 0.4 nozzle", instantiation: "true" });
    expect(orcaMachineJson(P1S, { vendor: "x", zOffsetMm: 0.1 }).z_offset).toBe("0.1");
    expect(orcaProcessJson(P1S).curr_bed_type).toBe("Textured PEI Plate");
  });

  it("caps profile speeds at the printer's maximum", () => {
    const slow = { ...ENDER3, maxSpeedMmS: 50 };
    expect(parsePrusaIni(prusaProfileIni(slow))).toMatchObject({ infill_speed: "50", travel_speed: "50", perimeter_speed: "40" });
    expect(orcaProcessJson(slow, { speedMmS: 300 })).toMatchObject({ sparse_infill_speed: "50", initial_layer_speed: "20" });
  });
});
