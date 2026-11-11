// Filament profiles. The generic ones are common starting values for each material, NOT tuned
// for a specific brand: the spool's own label wins if it differs. Branded ones (brand set) use
// the maker's published numbers. They were chosen for the QD330 (nozzle 250 °C, bed 100 °C);
// for other printers adapters/profile.ts clamps them to the catalog model's limits. The printer
// profile is generated per printer (adapters/profile.ts); these values are layered on top
// with a second PrusaSlicer --load.
//
// Build plate: smooth PEI. Bed temperatures are the usual smooth-PEI ones for each material.
// The part fan is off for at least the first 2 layers (the slow ones) on every filament.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export type FilamentId = "pla" | "pla-plus" | "petg" | "elegoo-rapid-petg" | "abs" | "asa" | "tpu";

/** Base material, for the slicers' filament_type. */
export type FilamentMaterial = "PLA" | "PETG" | "ABS" | "ASA" | "TPU";

export interface FilamentProfile {
  id: FilamentId;
  /** Short name for buttons ("PETG"). */
  label: string;
  material: FilamentMaterial;
  /** Maker, for a brand-specific profile. Unset = generic. */
  brand?: string;
  /** One kid-friendly line about it. */
  blurb: string;
  nozzleC: number;
  firstLayerNozzleC: number;
  bedC: number;
  firstLayerBedC: number;
  /** Nozzle temperature for loading / unloading this filament. */
  changeC: number;
  /** Part cooling fan range, percent. */
  fanMinPct: number;
  fanMaxPct: number;
  /** Fan off for this many first layers (never fewer than FAN_OFF_FIRST_LAYERS). */
  fanOffLayers: number;
  retractMm: number;
  retractSpeedMmS: number;
  /** Caps flow (and so speed) for materials that can't be pushed fast. mm³/s. */
  maxVolumetricMm3S: number;
  densityGcm3: number;
  /** Shown before printing (e.g. fumes, enclosure). */
  notes: string[];
}

export const FILAMENTS: Record<FilamentId, FilamentProfile> = {
  pla: {
    id: "pla", label: "PLA", material: "PLA", blurb: "Easy and colourful — the best one for most toys.",
    nozzleC: 210, firstLayerNozzleC: 210, bedC: 60, firstLayerBedC: 60, changeC: 220,
    fanMinPct: 100, fanMaxPct: 100, fanOffLayers: 2, retractMm: 1, retractSpeedMmS: 30, maxVolumetricMm3S: 15, densityGcm3: 1.24,
    notes: [],
  },
  "pla-plus": {
    id: "pla-plus", label: "PLA+", material: "PLA", blurb: "Tougher PLA that bends a little before it breaks.",
    nozzleC: 220, firstLayerNozzleC: 225, bedC: 60, firstLayerBedC: 65, changeC: 225,
    fanMinPct: 100, fanMaxPct: 100, fanOffLayers: 2, retractMm: 1, retractSpeedMmS: 30, maxVolumetricMm3S: 14, densityGcm3: 1.24,
    notes: [],
  },
  petg: {
    id: "petg", label: "PETG", material: "PETG", blurb: "Strong and a bit bendy — good for parts that get used a lot.",
    nozzleC: 240, firstLayerNozzleC: 240, bedC: 80, firstLayerBedC: 80, changeC: 240,
    fanMinPct: 30, fanMaxPct: 50, fanOffLayers: 3, retractMm: 1, retractSpeedMmS: 25, maxVolumetricMm3S: 8, densityGcm3: 1.27,
    notes: ["PETG can stick very hard to a smooth bed: let the bed cool before removing the print."],
  },
  // Elegoo's published specs (us.elegoo.com Rapid PETG product page, checked 2026-11-07):
  // nozzle 240-270 °C, bed 65-75 °C, no enclosure needed, glue on the plate recommended,
  // dry 60 ± 5 °C for 8 h before use, density 1.29 g/cm³, rated "< 600 mm/s". Elegoo gives
  // no fan or flow numbers, so those match generic PETG. Nozzle 245 °C stays near the low end
  // of Elegoo's range because the QD330 tops out at 250 °C, and the 8 mm³/s flow cap is the
  // generic PETG one: the QD330 base profile prints at 60 mm/s at most, nowhere near 600.
  "elegoo-rapid-petg": {
    id: "elegoo-rapid-petg", label: "Elegoo Rapid PETG", material: "PETG", brand: "Elegoo",
    blurb: "Elegoo's strong PETG — tough parts that can even go outside.",
    nozzleC: 245, firstLayerNozzleC: 245, bedC: 70, firstLayerBedC: 75, changeC: 245,
    fanMinPct: 30, fanMaxPct: 50, fanOffLayers: 3, retractMm: 1, retractSpeedMmS: 25, maxVolumetricMm3S: 8, densityGcm3: 1.29,
    notes: [
      "Elegoo says to dry Rapid PETG at 60 °C for 8 hours before printing if the spool has been open.",
      "Elegoo recommends a thin layer of glue stick on the bed.",
      "PETG can stick very hard to a smooth bed: let the bed cool before removing the print.",
    ],
  },
  abs: {
    id: "abs", label: "ABS", material: "ABS", blurb: "Tough and heat-proof, but it smells while printing.",
    nozzleC: 245, firstLayerNozzleC: 245, bedC: 100, firstLayerBedC: 100, changeC: 245,
    fanMinPct: 0, fanMaxPct: 15, fanOffLayers: 3, retractMm: 1, retractSpeedMmS: 30, maxVolumetricMm3S: 11, densityGcm3: 1.04,
    notes: ["ABS gives off fumes: keep the printer door closed and the room aired. A grown-up should be nearby."],
  },
  asa: {
    id: "asa", label: "ASA", material: "ASA", blurb: "Like ABS but OK in the sun — for outdoor things.",
    nozzleC: 250, firstLayerNozzleC: 250, bedC: 100, firstLayerBedC: 100, changeC: 250,
    fanMinPct: 10, fanMaxPct: 20, fanOffLayers: 3, retractMm: 1, retractSpeedMmS: 30, maxVolumetricMm3S: 11, densityGcm3: 1.07,
    notes: ["ASA gives off fumes: keep the printer door closed and the room aired. A grown-up should be nearby."],
  },
  tpu: {
    id: "tpu", label: "TPU", material: "TPU", blurb: "Squishy and rubbery — prints slowly.",
    nozzleC: 225, firstLayerNozzleC: 225, bedC: 50, firstLayerBedC: 50, changeC: 230,
    fanMinPct: 50, fanMaxPct: 80, fanOffLayers: 2, retractMm: 0.6, retractSpeedMmS: 20, maxVolumetricMm3S: 3.5, densityGcm3: 1.21,
    notes: ["TPU prints slowly on purpose. Load it gently — it can bend inside the feeder if pushed hard."],
  },
};

/** The first 2 layers (printed slowly, gcode.ts capFirstLayers) never have the part fan on. */
export const FAN_OFF_FIRST_LAYERS = 2;
/** The build plate the profiles are for. OrcaSlicer calls smooth PEI "High Temp Plate". */
export const BUILD_PLATE = "Smooth PEI";
export const ORCA_BED_TYPE = "High Temp Plate";

const fanOffLayers = (f: FilamentProfile) => Math.max(FAN_OFF_FIRST_LAYERS, f.fanOffLayers);

export const FILAMENT_IDS = Object.keys(FILAMENTS) as FilamentId[];
export const DEFAULT_FILAMENT: FilamentId = "pla";

export function isFilamentId(v: unknown): v is FilamentId {
  return typeof v === "string" && v in FILAMENTS;
}

export function filamentProfile(id: unknown): FilamentProfile {
  return FILAMENTS[isFilamentId(id) ? id : DEFAULT_FILAMENT];
}

/** Nozzle temperature for swapping from one filament to another (hot enough for both). */
export function changeTemperature(from: unknown, to: unknown): number {
  return Math.max(filamentProfile(from).changeC, filamentProfile(to).changeC);
}

/** PrusaSlicer config keys for this filament (layered over the base profile). */
export function prusaFilamentConfig(f: FilamentProfile, diameterMm = 1.75): Record<string, string | number> {
  return {
    filament_type: f.material === "TPU" ? "FLEX" : f.material,
    filament_settings_id: `Morphix ${f.label} (${f.brand ?? "generic"})`,
    filament_diameter: diameterMm,
    filament_density: f.densityGcm3,
    temperature: f.nozzleC,
    first_layer_temperature: f.firstLayerNozzleC,
    bed_temperature: f.bedC,
    first_layer_bed_temperature: f.firstLayerBedC,
    cooling: 1,
    fan_always_on: f.fanMinPct > 0 ? 1 : 0,
    min_fan_speed: f.fanMinPct,
    max_fan_speed: f.fanMaxPct,
    bridge_fan_speed: Math.max(f.fanMaxPct, f.material === "ABS" || f.material === "ASA" ? 30 : 100),
    disable_fan_first_layers: fanOffLayers(f),
    retract_length: f.retractMm,
    retract_speed: f.retractSpeedMmS,
    filament_max_volumetric_speed: f.maxVolumetricMm3S,
  };
}

/** Writes the filament overlay .ini next to the slice output and returns its path. */
export async function writePrusaFilamentIni(dir: string, id: FilamentId, f: FilamentProfile = FILAMENTS[id], diameterMm = 1.75): Promise<string> {
  const lines = [`# Morphix ${f.brand ? "" : "generic "}${f.label} profile (generated; see packages/slicing/src/filaments.ts)`];
  for (const [k, v] of Object.entries(prusaFilamentConfig(f, diameterMm))) lines.push(`${k} = ${v}`);
  const path = join(dir, `filament-${id}.ini`);
  await writeFile(path, lines.join("\n") + "\n");
  return path;
}

/** OrcaSlicer / Bambu Studio filament JSON. */
export function orcaFilamentJson(f: FilamentProfile, diameterMm = 1.75): Record<string, unknown> {
  const s = (v: number) => [String(v)];
  return {
    type: "filament",
    name: `Morphix ${f.label} (${f.brand ?? "generic"})`,
    from: "User",
    instantiation: "true",
    filament_type: [f.material],
    filament_diameter: s(diameterMm),
    filament_density: s(f.densityGcm3),
    nozzle_temperature: s(f.nozzleC),
    nozzle_temperature_initial_layer: s(f.firstLayerNozzleC),
    // Smooth PEI is OrcaSlicer's "High Temp Plate"; the other plates get the same values.
    hot_plate_temp: s(f.bedC),
    hot_plate_temp_initial_layer: s(f.firstLayerBedC),
    textured_plate_temp: s(f.bedC),
    textured_plate_temp_initial_layer: s(f.firstLayerBedC),
    cool_plate_temp: s(f.bedC),
    cool_plate_temp_initial_layer: s(f.firstLayerBedC),
    fan_min_speed: s(f.fanMinPct),
    fan_max_speed: s(f.fanMaxPct),
    close_fan_the_first_x_layers: s(fanOffLayers(f)),
    filament_retraction_length: s(f.retractMm),
    filament_retraction_speed: s(f.retractSpeedMmS),
    filament_max_volumetric_speed: s(f.maxVolumetricMm3S),
  };
}

export type FilamentChange = "load" | "unload";

/** File name the printer stores the filament job under (re-used each time). */
export const filamentJobFileName = (kind: FilamentChange) => `morphix-filament-${kind}.gx`;
export const isFilamentJobFile = (name: string | undefined) => /morphix-filament-(load|unload)\.gx$/i.test(name ?? "");

/**
 * A tiny "print" that heats the nozzle and runs the feeder. The QD330 ignores extruder
 * moves sent over the network but runs them from a print file, so loading and unloading
 * go through the normal upload + start path.
 *
 * The firmware opened a bare 400-byte file but never ran it (stuck at "byte 0/100, Layer
 * 0/0" after its own start routine), while PrusaSlicer files run fine. So this file is laid
 * out like one: slicer-style header comments, ;TYPE:Custom, M140 first, a ;LAYER_CHANGE
 * block, a config footer and a normal size. Absolute extrusion only (M82 + G92 E0).
 */
export function filamentChangeGcode(kind: FilamentChange, tempC: number, label = "filament"): string {
  const t = Math.round(tempC);
  const lines = [
    `; generated by Morphix filament ${kind} (PrusaSlicer-style layout) for ${label} at ${t} C`,
    ";",
    "; external perimeters extrusion width = 0.45mm",
    "; first layer extrusion width = 0.40mm",
    "",
    ";TYPE:Custom",
    "M140 S0 T0",
    `M104 S${t} T0`,
    "M107",
    "G90",
    "M82",
    "G28",
    "G1 Z30 F600",
    `M109 S${t} T0`,
    "G92 E0",
    ";LAYER_CHANGE",
    ";Z:30",
    ";HEIGHT:0.2",
    ...(kind === "load"
      ? [
          "G4 P5000 ; 5 s to get the filament end ready",
          "G1 E60 F180 ; feed slowly through the feeder (about 20 s)",
          "G1 E100 F120 ; purge until clean plastic comes out (about 20 s)",
          "G1 E99 F1800 ; small pull back so it doesn't ooze",
        ]
      : [
          "G1 E8 F300 ; push a little to soften the tip",
          "G1 E-2 F2400 ; snap back",
          "G1 E-80 F1200 ; pull the filament out of the feeder",
        ]),
    "G92 E0",
    "M107",
    "M400",
    `; filament used [mm] = ${kind === "load" ? 100 : 10}`,
    "; estimated printing time (normal mode) = 2m 30s",
    "",
    "; prusaslicer_config = begin",
    `; filament_type = ${label}`,
    `; temperature = ${t}`,
    "; layer_height = 0.2",
  ];
  // Pad to a normal small-print size; some firmware reads files in large blocks.
  while (lines.join("\n").length < 24_000) lines.push("; morphix padding: this file only loads or unloads filament");
  lines.push("; prusaslicer_config = end", "");
  return lines.join("\n");
}
