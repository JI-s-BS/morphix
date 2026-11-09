// Print speed from the Prepare page: one speed for every move — the first layer too — capped at
// the QD330's 600 mm/s, loaded as a third PrusaSlicer profile after the base and filament ones.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clampSpeed, filamentSpeedLimit, orcaSpeedConfig, prusaArgs, prusaSpeedConfig, QD330_MAX_SPEED_MMS, writePrusaSpeedIni } from "@morphix/slicing";
import { QD330_MAX_SPEED_MMS as SHARED_MAX } from "@morphix/shared";

describe("print speed", () => {
  it("uses the printer's 600 mm/s maximum everywhere", () => {
    expect(QD330_MAX_SPEED_MMS).toBe(600);
    expect(SHARED_MAX).toBe(600);
    expect(clampSpeed(9000)).toBe(600);
    expect(clampSpeed(3)).toBe(20);
  });

  it("prints at the chosen speed, with the first layer at 20 mm/s", () => {
    const c = prusaSpeedConfig(300);
    expect(c.first_layer_speed).toBe(20);
    expect(c.perimeter_speed).toBe(300);
    expect(c.external_perimeter_speed).toBe(300);
    expect(c.infill_speed).toBe(300);
    expect(c.travel_speed).toBeGreaterThanOrEqual(300);
    expect(prusaSpeedConfig(60).travel_speed).toBe(150); // travel never slower than a sensible minimum
    expect(orcaSpeedConfig(300)).toMatchObject({ initial_layer_speed: "20", outer_wall_speed: "300", sparse_infill_speed: "300" });
  });

  it("writes the speed overlay and loads it after the filament profile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "speed-"));
    const ini = await writePrusaSpeedIni(dir, 450);
    expect(readFileSync(ini, "utf8")).toMatch(/^first_layer_speed = 20$/m);
    expect(readFileSync(ini, "utf8")).toMatch(/^perimeter_speed = 450$/m);
    const args = prusaArgs({ stlPath: "m.stl", outPath: "o.gcode", ini: "base.ini", filamentIni: "fil.ini", speedIni: ini, supports: "none", center: { x: 0, y: 0 } });
    const loads = args.flatMap((a, i) => (a === "--load" ? [args[i + 1]] : []));
    expect(loads).toEqual(["base.ini", "fil.ini", ini]); // last one wins
    expect(prusaArgs({ stlPath: "m.stl", outPath: "o", ini: "base.ini", supports: "none", center: { x: 0, y: 0 } }).filter((a) => a === "--load")).toHaveLength(1);
  });

  it("knows how fast the filament can really go", () => {
    expect(filamentSpeedLimit(8, 0.2)).toBe(89); // PETG at 0.2 mm layers
    expect(filamentSpeedLimit(15, 0.1)).toBe(333);
    expect(filamentSpeedLimit(100, 0.1)).toBe(600); // never above the printer
  });
});

describe("first layers: 20 then 30 mm/s, travel at most 100 mm/s", () => {
  it("caps printing per layer and X/Y travel in layers 1-2, leaves retracts, Z and later layers alone", async () => {
    const { capFirstLayers } = await import("@morphix/slicing");
    const g = [
      "G1 X-100 Y-100 E10 F900 ; purge (start G-code)",
      ";LAYER_CHANGE",
      "G1 Z0.2 F7200",              // Z move: untouched
      "G0 X10 Y10 F18000",          // travel 300 mm/s -> 100 mm/s
      "G1 X20 Y10 E0.5 F18000",     // layer 1 printing -> 20 mm/s
      "G1 X30 Y10 E0.9",            // modal F, still 20
      "G1 E-0.8 F2100",             // retract: untouched
      ";LAYER_CHANGE",
      "G1 X40 Y10 E1.2 F6000",      // layer 2 printing -> 30 mm/s
      "G1 X45 Y10 E1.3 F600",       // already slower than 30: kept
      ";LAYER_CHANGE",
      "G0 X0 Y0 F18000",            // layer 3 travel: full speed
      "G1 X60 Y10 E2.0",            // layer 3 printing at the sliced (modal) speed
    ].join("\n");
    const out = capFirstLayers(g).split("\n");
    expect(out[0]).toBe("G1 X-100 Y-100 E10 F900 ; purge (start G-code)");
    expect(out).toContain("G1 Z0.2 F7200");
    expect(out).toContain("G0 X10 Y10 F6000");
    expect(out).toContain("G1 X20 Y10 E0.5 F1200");
    expect(out).toContain("G1 X30 Y10 E0.9");
    expect(out).toContain("G1 E-0.8 F2100");
    expect(out).toContain("G1 X40 Y10 E1.2 F1800");
    expect(out).toContain("G1 X45 Y10 E1.3 F600");
    expect(out).toContain("G0 X0 Y0 F18000");
    expect(out.at(-1)).toBe("G1 X60 Y10 E2.0");
    expect(out.some((l) => /layer speeds 1: 20 mm\/s, 2: 30 mm\/s; travel at most 100 mm\/s/.test(l))).toBe(true);
  });

  it("restores the sliced speed when layer 3 starts with a modal move", async () => {
    const { capFirstLayers } = await import("@morphix/slicing");
    const out = capFirstLayers([";LAYER_CHANGE", "G1 X1 Y1 E1 F6000", ";LAYER_CHANGE", "G1 X2 Y1 E2", ";LAYER_CHANGE", "G1 X3 Y1 E3"].join("\n")).split("\n");
    expect(out).toContain("G1 X1 Y1 E1 F1200");
    expect(out).toContain("G1 X2 Y1 E2 F1800");          // layer 2: 30 mm/s
    expect(out.at(-1)).toBe("G1 X3 Y1 E3 F6000");        // layer 3: the sliced 100 mm/s again
  });

  it("keeps the part fan off in layers 1-2 and turns it on when layer 3 starts", async () => {
    const { capFirstLayers } = await import("@morphix/slicing");
    const out = capFirstLayers([
      "M107", ";LAYER_CHANGE", "M106 S255", "G1 X1 Y1 E1 F1200", ";LAYER_CHANGE", "M106 S128 ; bridge", "G1 X2 Y1 E2",
      ";LAYER_CHANGE", "G1 X3 Y1 E3",
    ].join("\n")).split("\n");
    const layer3 = out.lastIndexOf(";LAYER_CHANGE");
    expect(out.slice(0, layer3).filter((l) => /^M106\b/.test(l))).toEqual([]);
    expect(out[out.indexOf(";LAYER_CHANGE") + 2]).toMatch(/^M107 ; Morphix: part fan off for the first 2 layers/);
    expect(out[layer3 + 1]).toBe("M106 S128 ; Morphix: part fan on after the slow layers");
  });

  it("a fan switched off again in layer 2 stays off at layer 3", async () => {
    const { capFirstLayers } = await import("@morphix/slicing");
    const out = capFirstLayers([";LAYER_CHANGE", "M106 S255", ";LAYER_CHANGE", "M106 S0", ";LAYER_CHANGE", "G1 X3 Y1 E3"].join("\n")).split("\n");
    expect(out.slice(out.lastIndexOf(";LAYER_CHANGE")).some((l) => /^M106 S255/.test(l))).toBe(false);
  });

  it("every filament has the fan off for at least the first 2 layers; the plate is smooth PEI", async () => {
    const { FILAMENT_IDS, filamentProfile, prusaFilamentConfig, orcaFilamentJson, BUILD_PLATE } = await import("@morphix/slicing");
    for (const id of FILAMENT_IDS) {
      const f = filamentProfile(id);
      expect(Number(prusaFilamentConfig(f).disable_fan_first_layers), id).toBeGreaterThanOrEqual(2);
      expect(Number((orcaFilamentJson(f).close_fan_the_first_x_layers as string[])[0]), id).toBeGreaterThanOrEqual(2);
    }
    expect(BUILD_PLATE).toBe("Smooth PEI");
  });

  it("leaves G-code without layer markers unchanged", async () => {
    const { capFirstLayers } = await import("@morphix/slicing");
    expect(capFirstLayers("G1 X1 Y1 E1 F9000")).toBe("G1 X1 Y1 E1 F9000");
  });
});

describe("Z offset from the print page", () => {
  it("writes a z_offset overlay that PrusaSlicer loads last, clamped to -0.5 to 1 mm", async () => {
    const { writePrusaZOffsetIni, prusaArgs, clampZOffset, profileZOffset } = await import("@morphix/slicing");
    const dir = mkdtempSync(join(tmpdir(), "zoff-"));
    const zIni = await writePrusaZOffsetIni(dir, 0.35);
    expect(readFileSync(zIni, "utf8")).toMatch(/^z_offset = 0\.35$/m);
    const args = prusaArgs({ stlPath: "m.stl", outPath: "o", ini: "base.ini", filamentIni: "fil.ini", speedIni: "speed.ini", zIni, supports: "none", center: { x: 0, y: 0 } });
    expect(args.flatMap((a, i) => (a === "--load" ? [args[i + 1]] : []))).toEqual(["base.ini", "fil.ini", "speed.ini", zIni]);
    expect(clampZOffset(5)).toBe(1);
    expect(clampZOffset(-0.3)).toBe(-0.3); // negative lowers the nozzle
    expect(clampZOffset(-5)).toBe(-0.5); // but never driven into the bed
    expect(readFileSync(await writePrusaZOffsetIni(dir, -0.15), "utf8")).toMatch(/^z_offset = -0\.15$/m);
    expect(profileZOffset("layer_height = 0.2\nz_offset = 0.5\n")).toBe(0.5);
    expect(profileZOffset("nothing")).toBeNull();
  });

  it("gives OrcaSlicer a machine profile copy with the chosen z_offset", async () => {
    const { writeOrcaMachineWithZ } = await import("@morphix/slicing");
    const dir = mkdtempSync(join(tmpdir(), "zorca-"));
    const p = await writeOrcaMachineWithZ(dir, JSON.stringify({ name: "QD330", z_offset: "0.5" }), 0.25);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ name: "QD330", z_offset: "0.25" });
  });
});
