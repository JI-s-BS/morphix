// Slicer profiles generated from a catalog PrinterModel: the PrusaSlicer .ini and the
// OrcaSlicer / Bambu Studio machine, process and filament JSON. ALL UNVERIFIED until a print
// on that printer says otherwise.
//
// The start G-code is the catalog's (printer.startGcode) when it has one; otherwise Morphix's
// own: heat, home, wait for the bed, level (LEVEL_MARKER, when the printer has auto-leveling),
// heat the nozzle, purge 2 lines along the front edge at 150 % flow. For the Afinia QD330
// (centre origin, -110..110) this is the start G-code Morphix has always used.
import { findPrinter, type PrinterModel } from "@morphix/catalog";
import { FAN_OFF_FIRST_LAYERS, FILAMENTS, ORCA_BED_TYPE, orcaFilamentJson, prusaFilamentConfig, type FilamentId, type FilamentProfile } from "../filaments";
import { LEVEL_MARKER } from "../leveling";
import { QD330_PLA_DEFAULTS } from "../profiles";
import { clampZOffset, orcaSpeedConfig, QD330_MAX_SPEED_MMS } from "../speed";
import { versionAtLeast, type SupportMode } from "../slicer";

export const DEFAULT_PRINTER_ID = "afinia-qd330";

/** The printer Morphix slices for when none is configured: the Afinia QD330 from the catalog. */
export function defaultPrinter(): PrinterModel {
  const p = findPrinter(DEFAULT_PRINTER_ID);
  if (!p) throw new Error(`printer catalog has no "${DEFAULT_PRINTER_ID}" entry: pass options.printer`);
  return p;
}

/** Per-printer values the catalog has no field for. Everything else comes from the PrinterModel. */
export interface PrinterTuning {
  /** Nozzle height offset in the profile (what "Normal" means on the Prepare page). */
  zOffsetMm: number;
  /** OrcaSlicer / Bambu Studio plate type (decides which bed temperature is used). */
  orcaBedType: string;
}

export const PRINTER_TUNING: Record<string, Partial<PrinterTuning>> = {
  // A first layer that sticks on the QD330's smooth PEI (UNVERIFIED guess, as before).
  "afinia-qd330": { zOffsetMm: -0.05 },
};

export function printerTuning(p: PrinterModel): PrinterTuning {
  return { zOffsetMm: 0, orcaBedType: p.gcodeFlavor === "bambu" ? "Textured PEI Plate" : ORCA_BED_TYPE, ...PRINTER_TUNING[p.id] };
}

/** The profile's Z offset for this printer (SlicerDefaults.zOffsetMm on the Prepare page). */
export const printerZOffsetMm = (p: PrinterModel) => printerTuning(p).zOffsetMm;

/** Fastest print speed Morphix asks of a printer the catalog gives no maximum for. */
export const DEFAULT_MAX_SPEED_MMS = 150;
export const printerMaxSpeed = (p: PrinterModel) => p.maxSpeedMmS ?? (p.id === DEFAULT_PRINTER_ID ? QD330_MAX_SPEED_MMS : DEFAULT_MAX_SPEED_MMS);

/** Print settings every generated profile starts from (the QD330 0.2 mm profile). */
export const PRINT_DEFAULTS = {
  layerHeightMm: QD330_PLA_DEFAULTS.layerHeightMm,
  perimeters: QD330_PLA_DEFAULTS.perimeters,
  topLayers: 4,
  bottomLayers: 3,
  infillPercent: QD330_PLA_DEFAULTS.infillPercent,
  speeds: { perimeter: 40, externalPerimeter: 30, smallPerimeter: 25, infill: 60, solidInfill: 50, topSolidInfill: 30, support: 50, bridge: 30, gapFill: 30, travel: 120, firstLayer: 20 },
} as const;

// ------------------------------------------------------------------ bed ---
type Pt = [number, number];
const r2 = (v: number) => Math.round(v * 100) / 100;
const fmt = (v: number) => String(r2(v));

/** Bed outline in printer coordinates (corner: 0..x, centre: -x/2..x/2; circles as 32 points). */
export function bedShape(p: PrinterModel): Pt[] {
  const c = bedCenter(p);
  if (p.bed.shape === "circle") {
    const r = Math.min(p.bed.x, p.bed.y) / 2;
    return Array.from({ length: 32 }, (_, i) => [r2(c.x + r * Math.cos((i / 32) * 2 * Math.PI)), r2(c.y + r * Math.sin((i / 32) * 2 * Math.PI))] as Pt);
  }
  const x0 = c.x - p.bed.x / 2, y0 = c.y - p.bed.y / 2;
  return [[x0, y0], [x0 + p.bed.x, y0], [x0 + p.bed.x, y0 + p.bed.y], [x0, y0 + p.bed.y]];
}

/** Bed centre in printer coordinates (PrusaSlicer --center). */
export function bedCenter(p: PrinterModel): { x: number; y: number } {
  return p.origin === "center" ? { x: 0, y: 0 } : { x: p.bed.x / 2, y: p.bed.y / 2 };
}

/** Largest box the mesh may fill (a circular bed's inscribed square). */
export function printableVolume(p: PrinterModel): { x: number; y: number; z: number } {
  if (p.bed.shape !== "circle") return { x: p.bed.x, y: p.bed.y, z: p.bed.z };
  const side = Math.floor(Math.min(p.bed.x, p.bed.y) / Math.SQRT2);
  return { x: side, y: side, z: p.bed.z };
}

// -------------------------------------------------------------- G-code ---
const tool = (p: PrinterModel) => (p.gcodeFlavor === "flashforge" ? " T0" : "");

/** Morphix's start G-code for a printer without one in the catalog (PrusaSlicer placeholders). */
export function defaultStartGcode(p: PrinterModel): string {
  const c = bedCenter(p);
  // Purge along the front edge, 10 mm in (a circle: inside its inscribed square).
  const half = p.bed.shape === "circle" ? printableVolume(p).x / 2 : p.bed.x / 2;
  const halfY = p.bed.shape === "circle" ? half : p.bed.y / 2;
  const x0 = c.x - half + 10, y0 = c.y - halfY + 10;
  const len = Math.min(200, 2 * half - 20);
  const ePerMm = 0.15 * (p.nozzleMm / 0.4) * (1.75 / p.filamentMm) ** 2; // 150 % flow for a 0.4 nozzle, 1.75 filament
  const e1 = r2(len * ePerMm);
  const lift = Math.min(30, Math.floor(p.bed.z / 5));
  const range = p.origin === "center" ? `centre-origin bed ${fmt(-p.bed.x / 2)}..${fmt(p.bed.x / 2)}` : `corner-origin bed 0..${p.bed.x} x 0..${p.bed.y}`;
  return [
    `; Morphix start G-code for the ${p.brand} ${p.model} (${range}), generated from the printer catalog. UNVERIFIED until printed on this printer`,
    ...(p.heatedBed ? [`M140 S[first_layer_bed_temperature]${tool(p)}`] : []),
    `M104 S[first_layer_temperature]${tool(p)}`,
    "M107",
    "G90",
    "M82",
    "G28",
    `G1 Z${lift} F600`,
    ...(p.heatedBed ? ["M190 S[first_layer_bed_temperature]"] : []),
    ...(p.autoLevel ? [LEVEL_MARKER] : []),
    `M109 S[first_layer_temperature]${tool(p)}`,
    "G92 E0",
    `G1 X${fmt(x0)} Y${fmt(y0)} F3000`,
    `G1 Z${fmt(Math.max(0.3, p.nozzleMm))} F600`,
    `; purge: 2 x ${fmt(len)} mm at 150% flow (${fmt(ePerMm)} mm filament per mm)`,
    `G1 X${fmt(x0 + len)} Y${fmt(y0)} E${fmt(e1)} F600`,
    `G1 Y${fmt(y0 + 0.8)} F600`,
    `G1 X${fmt(x0)} Y${fmt(y0 + 0.8)} E${fmt(2 * e1)} F600`,
    "G92 E0",
  ].join("\n");
}

export function defaultEndGcode(p: PrinterModel): string {
  return ["; Morphix end G-code (UNVERIFIED)", `M104 S0${tool(p)}`, ...(p.heatedBed ? ["M140 S0"] : []), "M107", "G91", "G1 E-2 F1800", "G1 Z10 F600", "G90", "G28 X Y", "M84"].join("\n");
}

/** Start / end G-code for the printer and where they came from. */
export function printerGcode(p: PrinterModel): { start: string; end: string; source: "catalog" | "generated" } {
  return {
    start: p.startGcode ?? defaultStartGcode(p),
    end: p.endGcode ?? defaultEndGcode(p),
    source: p.startGcode ? "catalog" : "generated",
  };
}

const ORCA_PLACEHOLDERS: [RegExp, string][] = [
  [/\bfirst_layer_bed_temperature\b/g, "bed_temperature_initial_layer_single"],
  [/\bfirst_layer_temperature\b/g, "nozzle_temperature_initial_layer"],
  [/\bbed_temperature\b/g, "bed_temperature_initial_layer_single"],
  [/(?<![\w])temperature\b/g, "nozzle_temperature"],
];

/** PrusaSlicer placeholders ([first_layer_temperature] …) to the OrcaSlicer / Bambu Studio names. */
export function toOrcaPlaceholders(gcode: string): string {
  return gcode.replace(/\[([^\]\n]+)\]|\{([^}\n]+)\}/g, (all) => ORCA_PLACEHOLDERS.reduce((s, [re, to]) => s.replace(re, to), all));
}

// ------------------------------------------------------------- filament ---
/** The filament with its temperatures clamped to what this printer allows. */
export function filamentFor(p: PrinterModel, id: FilamentId): { filament: FilamentProfile; warnings: string[] } {
  const base = FILAMENTS[id] ?? FILAMENTS.pla;
  const warnings: string[] = [];
  const f: FilamentProfile = { ...base };
  const nozzle = (k: "nozzleC" | "firstLayerNozzleC") => {
    if (f[k] > p.maxNozzleC) f[k] = p.maxNozzleC;
  };
  nozzle("nozzleC");
  nozzle("firstLayerNozzleC");
  if (f.nozzleC !== base.nozzleC || f.firstLayerNozzleC !== base.firstLayerNozzleC) warnings.push(`${base.label}: nozzle limited to the ${p.model}'s ${p.maxNozzleC} °C`);
  if (!p.heatedBed) {
    f.bedC = 0;
    f.firstLayerBedC = 0;
    if (base.material !== "PLA" && base.material !== "TPU") warnings.push(`${base.label} usually needs a heated bed, and the ${p.model} has none: expect warping`);
  } else if (base.bedC > p.maxBedC || base.firstLayerBedC > p.maxBedC) {
    f.bedC = Math.min(f.bedC, p.maxBedC);
    f.firstLayerBedC = Math.min(f.firstLayerBedC, p.maxBedC);
    warnings.push(`${base.label}: bed limited to the ${p.model}'s ${p.maxBedC} °C`);
  }
  return { filament: f, warnings };
}

// ---------------------------------------------------------- PrusaSlicer ---
const PRUSA_FLAVOR: Record<PrinterModel["gcodeFlavor"], string> = {
  // Debian / Raspberry Pi OS ship PrusaSlicer 2.5, which has no "klipper" flavor; Marlin 2
  // G-code is what Klipper expects anyway.
  marlin: "marlin", marlin2: "marlin2", klipper: "marlin2", reprapfirmware: "reprapfirmware", flashforge: "marlin", bambu: "marlin",
};

type Kv = [string, string | number];

/** Printer keys (bed, nozzle, flavor, G-code). Left out when the vendor's printer profile is used. */
export function prusaPrinterKeys(p: PrinterModel): Kv[] {
  const g = printerGcode(p);
  return [
    ["printer_technology", "FFF"],
    ["bed_shape", bedShape(p).map(([x, y]) => `${fmt(x)}x${fmt(y)}`).join(",")],
    ["max_print_height", p.bed.z],
    ["nozzle_diameter", p.nozzleMm],
    ["gcode_flavor", PRUSA_FLAVOR[p.gcodeFlavor]],
    ["use_relative_e_distances", 0],
    ["use_firmware_retraction", 0],
    ["retract_length", 1],
    ["retract_speed", 30],
    ["retract_lift", 0],
    ["z_offset", printerZOffsetMm(p)],
    ["start_gcode", g.start],
    ["end_gcode", g.end],
  ];
}

/** Print keys (layers, walls, infill, supports, skirt, speeds), shared by every printer. */
export function prusaPrintKeys(p: PrinterModel): Kv[] {
  const d = PRINT_DEFAULTS, s = d.speeds, max = printerMaxSpeed(p);
  const v = (x: number) => Math.min(x, max);
  return [
    ["layer_height", d.layerHeightMm],
    ["first_layer_height", d.layerHeightMm],
    ["perimeters", d.perimeters],
    ["top_solid_layers", d.topLayers],
    ["bottom_solid_layers", d.bottomLayers],
    ["fill_density", `${d.infillPercent}%`],
    ["fill_pattern", "grid"],
    ["infill_every_layers", 1],
    ["seam_position", "aligned"],
    ["support_material", 0],
    ["support_material_auto", 1],
    ["support_material_threshold", 45],
    ["support_material_buildplate_only", 0],
    ["skirts", 1],
    ["skirt_distance", 6],
    ["skirt_height", 1],
    ["brim_width", 0],
    ["perimeter_speed", v(s.perimeter)],
    ["external_perimeter_speed", v(s.externalPerimeter)],
    ["small_perimeter_speed", v(s.smallPerimeter)],
    ["infill_speed", v(s.infill)],
    ["solid_infill_speed", v(s.solidInfill)],
    ["top_solid_infill_speed", v(s.topSolidInfill)],
    ["support_material_speed", v(s.support)],
    ["bridge_speed", v(s.bridge)],
    ["gap_fill_speed", v(s.gapFill)],
    ["travel_speed", v(s.travel)],
    ["first_layer_speed", v(s.firstLayer)],
    ["complete_objects", 0],
    ["gcode_comments", 0],
    ["gcode_label_objects", "disabled"],
    ["output_filename_format", "{input_filename_base}.gcode"],
  ];
}

/** Default (PLA) filament keys in the base profile; the filament overlay replaces them. */
function prusaBaseFilamentKeys(p: PrinterModel): Kv[] {
  const f = filamentFor(p, "pla").filament;
  return [
    ["filament_type", "PLA"],
    ["filament_diameter", p.filamentMm],
    ["filament_density", f.densityGcm3],
    ["extrusion_multiplier", 1],
    ["temperature", f.nozzleC],
    ["first_layer_temperature", f.firstLayerNozzleC],
    ["bed_temperature", f.bedC],
    ["first_layer_bed_temperature", f.firstLayerBedC],
    ["cooling", 1],
    ["fan_always_on", 1],
    ["min_fan_speed", f.fanMinPct],
    ["max_fan_speed", f.fanMaxPct],
    ["disable_fan_first_layers", FAN_OFF_FIRST_LAYERS],
  ];
}

const iniValue = (v: string | number) => String(v).replace(/\r?\n/g, "\\n");
const iniLines = (kv: Kv[]) => kv.map(([k, v]) => `${k} = ${iniValue(v)}`);

/**
 * The whole PrusaSlicer profile for a printer (`--load` it first). With `vendor`, only the
 * print and filament keys: the vendor's printer profile supplies the rest.
 */
export function prusaProfileIni(p: PrinterModel, opts: { vendor?: string; slicerVersion?: string | null } = {}): string {
  const head = [
    `# Morphix PrusaSlicer profile for the ${p.brand} ${p.model} (${p.id}), generated from the printer catalog`,
    "# by packages/slicing/src/adapters/profile.ts. Do not edit: change the catalog or the generator.",
    "# !!! UNVERIFIED !!! Nothing here has been checked against a print on this printer.",
    ...(opts.vendor ? [`# Printer settings come from PrusaSlicer's vendor profile "${opts.vendor}".`] : []),
  ];
  // Vendor printer profiles (Prusa MK4, XL, …) turn on binary G-code (PrusaSlicer 2.7+); Morphix sends plain G-code.
  const plain: Kv[] = opts.vendor && opts.slicerVersion && versionAtLeast(opts.slicerVersion, "2.7") ? [["binary_gcode", 0]] : [];
  const sections = opts.vendor ? [[...prusaPrintKeys(p), ...plain]] : [prusaPrinterKeys(p).slice(0, -2), prusaBaseFilamentKeys(p), prusaPrintKeys(p), prusaPrinterKeys(p).slice(-2)];
  return [...head, ...sections.flatMap((s) => ["", ...iniLines(s)])].join("\n") + "\n";
}

/** The filament overlay for this printer (clamped temperatures, the printer's filament diameter). */
export function prusaFilamentIni(p: PrinterModel, f: FilamentProfile): string {
  return [`# Morphix ${f.brand ? "" : "generic "}${f.label} for the ${p.brand} ${p.model} (generated)`, ...iniLines(Object.entries(prusaFilamentConfig(f, p.filamentMm)))].join("\n") + "\n";
}

// ------------------------------------------------- OrcaSlicer / Bambu Studio ---
const ORCA_FLAVOR: Record<PrinterModel["gcodeFlavor"], string> = {
  marlin: "marlin", marlin2: "marlin2", klipper: "klipper", reprapfirmware: "reprapfirmware", flashforge: "marlin", bambu: "marlin",
};

const str = (v: number) => String(r2(v));

/**
 * Machine profile. With `vendor` it only names the slicer's bundled printer ("inherits"),
 * which the CLI resolves from its system presets; Morphix adds just the Z offset.
 */
export function orcaMachineJson(p: PrinterModel, opts: { vendor?: string; zOffsetMm?: number } = {}): Record<string, unknown> {
  const z = opts.zOffsetMm !== undefined ? clampZOffset(opts.zOffsetMm) : printerZOffsetMm(p);
  const name = `Morphix ${p.brand} ${p.model} ${p.nozzleMm} nozzle (UNVERIFIED)`;
  if (opts.vendor) {
    return {
      type: "machine", name, from: "User", inherits: opts.vendor, instantiation: "true",
      ...(opts.zOffsetMm !== undefined ? { z_offset: str(z) } : {}),
    };
  }
  const g = printerGcode(p);
  return {
    _comment: `UNVERIFIED profile for the ${p.brand} ${p.model}, generated from the printer catalog by packages/slicing/src/adapters/profile.ts.`,
    type: "machine",
    name,
    from: "User",
    instantiation: "true",
    printer_technology: "FFF",
    gcode_flavor: ORCA_FLAVOR[p.gcodeFlavor],
    z_offset: str(z),
    printable_area: bedShape(p).map(([x, y]) => `${fmt(x)}x${fmt(y)}`),
    printable_height: str(p.bed.z),
    nozzle_diameter: [str(p.nozzleMm)],
    retraction_length: ["1"],
    retraction_speed: ["30"],
    use_relative_e_distances: "0",
    machine_start_gcode: toOrcaPlaceholders(g.start) + "\n",
    machine_end_gcode: toOrcaPlaceholders(g.end) + "\n",
  };
}

export interface ProcessChoices {
  supports?: SupportMode;
  layerHeightMm?: number;
  infillPercent?: number;
  brimWidthMm?: number;
  perimeters?: number;
  speedMmS?: number;
}

export function orcaProcessJson(p: PrinterModel, c: ProcessChoices = {}): Record<string, unknown> {
  const d = PRINT_DEFAULTS, s = d.speeds, max = printerMaxSpeed(p);
  const v = (x: number) => String(Math.min(x, max));
  const supports = c.supports ?? "none";
  const layer = c.layerHeightMm ?? d.layerHeightMm;
  const json: Record<string, unknown> = {
    _comment: `UNVERIFIED process for the ${p.brand} ${p.model}, generated by packages/slicing/src/adapters/profile.ts.`,
    type: "process",
    name: `Morphix ${p.model} ${layer}mm (UNVERIFIED)`,
    from: "User",
    instantiation: "true",
    curr_bed_type: printerTuning(p).orcaBedType,
    layer_height: String(layer),
    initial_layer_print_height: String(layer),
    wall_loops: String(c.perimeters ?? d.perimeters),
    top_shell_layers: String(d.topLayers),
    bottom_shell_layers: String(d.bottomLayers),
    sparse_infill_density: `${c.infillPercent ?? d.infillPercent}%`,
    sparse_infill_pattern: "grid",
    enable_support: supports === "none" ? "0" : "1",
    support_type: "normal(auto)",
    support_threshold_angle: "45",
    support_on_build_plate_only: supports === "buildplate" ? "1" : "0",
    skirt_loops: "1",
    skirt_distance: "6",
    brim_type: c.brimWidthMm ? "outer_only" : "no_brim",
    ...(c.brimWidthMm !== undefined ? { brim_width: String(c.brimWidthMm) } : {}),
    outer_wall_speed: v(s.externalPerimeter),
    inner_wall_speed: v(s.perimeter),
    sparse_infill_speed: v(s.infill),
    internal_solid_infill_speed: v(s.solidInfill),
    top_surface_speed: v(s.topSolidInfill),
    travel_speed: v(s.travel),
    initial_layer_speed: v(s.firstLayer),
  };
  if (c.speedMmS) Object.assign(json, orcaSpeedConfig(c.speedMmS, max));
  return json;
}

export function orcaFilamentFor(p: PrinterModel, f: FilamentProfile): Record<string, unknown> {
  return orcaFilamentJson(f, p.filamentMm);
}
