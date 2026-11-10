// Print speed chosen on the Prepare page. One speed for every print move up to the QD330's
// maximum, except the first 2 layers (layer 1 at 20 mm/s, layer 2 at 30, travel at most 100;
// gcode.ts capFirstLayers). The filament's melt limit
// (filament_max_volumetric_speed) still caps it inside the slicer, so speedLimits() tells the
// screen what speed the filament really allows.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Afinia QD330 brochure: "Maximum speed 600mm/s" (acceleration 20 000 mm/s²). */
export const QD330_MAX_SPEED_MMS = 600;
export const MIN_PRINT_SPEED_MMS = 20;
/** Typical extrusion width for the 0.4 mm nozzle (mm). */
const LINE_WIDTH_MM = 0.45;

/** Clamps a print speed to 20 mm/s .. the printer's maximum (default the QD330's 600). */
export function clampSpeed(mmS: number, maxMmS = QD330_MAX_SPEED_MMS): number {
  return Math.round(Math.min(maxMmS, Math.max(MIN_PRINT_SPEED_MMS, mmS)));
}

/** PrusaSlicer keys: every print move at `speed`, first layer included; travel at least as fast. */
export function prusaSpeedConfig(speedMmS: number, maxMmS = QD330_MAX_SPEED_MMS): Record<string, number> {
  const v = clampSpeed(speedMmS, maxMmS);
  return {
    perimeter_speed: v,
    external_perimeter_speed: v,
    small_perimeter_speed: v,
    infill_speed: v,
    solid_infill_speed: v,
    top_solid_infill_speed: v,
    gap_fill_speed: v,
    support_material_speed: v,
    support_material_interface_speed: v,
    bridge_speed: v,
    first_layer_speed: Math.min(v, 20), // layer 1 at 20, layer 2 at 30 mm/s (gcode.ts capFirstLayers)
    travel_speed: Math.max(v, Math.min(maxMmS, 150)),
  };
}

/** OrcaSlicer process keys for the same thing. */
export function orcaSpeedConfig(speedMmS: number, maxMmS = QD330_MAX_SPEED_MMS): Record<string, string> {
  const c = clampSpeed(speedMmS, maxMmS);
  const v = String(c);
  const travel = String(Math.max(c, Math.min(maxMmS, 150)));
  return {
    outer_wall_speed: v, inner_wall_speed: v, small_perimeter_speed: v, sparse_infill_speed: v,
    internal_solid_infill_speed: v, top_surface_speed: v, gap_infill_speed: v, support_speed: v,
    support_interface_speed: v, bridge_speed: v, initial_layer_speed: String(Math.min(c, 20)), initial_layer_infill_speed: String(Math.min(c, 20)),
    travel_speed: travel,
  };
}

/** Writes the speed overlay .ini (loaded after the base and filament profiles); returns its path. */
export async function writePrusaSpeedIni(dir: string, speedMmS: number, maxMmS = QD330_MAX_SPEED_MMS): Promise<string> {
  const lines = [`# Morphix print speed ${clampSpeed(speedMmS, maxMmS)} mm/s for every layer (generated; see packages/slicing/src/speed.ts)`];
  for (const [k, val] of Object.entries(prusaSpeedConfig(speedMmS, maxMmS))) lines.push(`${k} = ${val}`);
  const path = join(dir, "morphix-speed.ini");
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  return path;
}

/**
 * What the filament allows at a layer height: the slicer slows any move whose plastic flow
 * would exceed the filament's melt limit (mm³/s ÷ layer height ÷ line width).
 */
export function filamentSpeedLimit(maxVolumetricMm3S: number, layerHeightMm: number, lineWidthMm = LINE_WIDTH_MM, printerMaxMmS = QD330_MAX_SPEED_MMS): number {
  if (!(maxVolumetricMm3S > 0) || !(layerHeightMm > 0)) return printerMaxMmS;
  return Math.min(printerMaxMmS, Math.round(maxVolumetricMm3S / (layerHeightMm * lineWidthMm)));
}

// ------------------------------------------------------------- Z offset ---
/** Z offset (nozzle height above the bed) the Prepare page may choose, in mm. Below 0 lowers the
 * nozzle (for a first layer that doesn't stick); -0.5 keeps it from being driven into the bed. */
export const MIN_Z_OFFSET_MM = -0.5;
export const MAX_Z_OFFSET_MM = 1;

export function clampZOffset(mm: number): number {
  return Math.round(Math.min(MAX_Z_OFFSET_MM, Math.max(MIN_Z_OFFSET_MM, mm)) * 100) / 100;
}

/** The base profile's z_offset (what "Normal" means), or null if it can't be read. */
export function profileZOffset(iniText: string): number | null {
  const m = /^z_offset\s*=\s*(-?\d*\.?\d+)/m.exec(iniText);
  return m ? Number(m[1]) : null;
}

/** Writes the Z offset overlay .ini (loaded last); returns its path. */
export async function writePrusaZOffsetIni(dir: string, zOffsetMm: number): Promise<string> {
  const path = join(dir, "morphix-z-offset.ini");
  await writeFile(path, `# Morphix Z offset chosen on the Prepare page\nz_offset = ${clampZOffset(zOffsetMm)}\n`, "utf8");
  return path;
}
