// The catalog. Owned by the catalog session (docs/GOAL.md); entries are added here.
// Specs come from the makers' published spec sheets. Every entry except the Afinia QD330 is
// verified: "protocol": implemented from protocol docs, not run on that printer yet.
// Max temperatures are the safe limits Morphix clamps to, never above the maker's figure.
import type { PrinterModel } from "./types";

type Entry = Omit<PrinterModel, "nozzleMm" | "filamentMm" | "origin" | "heatedBed" | "verified" | "setupDoc"> &
  Partial<Pick<PrinterModel, "nozzleMm" | "filamentMm" | "origin" | "heatedBed" | "verified">>;

/** Fills the fields most printers share; `doc` is the docs/printers/<doc>.md file. */
function family(doc: string, shared: Partial<Entry> = {}) {
  return (e: Partial<Entry> & Pick<Entry, "id" | "model" | "bed" | "maxNozzleC" | "maxBedC">): PrinterModel => ({
    nozzleMm: 0.4,
    filamentMm: 1.75,
    origin: "corner",
    heatedBed: true,
    verified: "protocol",
    ...(shared as Entry),
    ...(e as Entry),
    setupDoc: `docs/printers/${doc}.md`,
  });
}

const cube = (n: number, z = n) => ({ x: n, y: n, z });
const circle = (d: number, z: number) => ({ x: d, y: d, z, shape: "circle" as const });

// ---- Start / end G-code templates (PrusaSlicer placeholder syntax, also read by Orca) ----

/** Marlin start: heat the bed, home, level after heating, wait for the nozzle, two purge lines
 *  along the left edge. `level` is the probe command ("G29"), "M420 S1" to load a saved mesh, or "". */
function marlinStart(level: string, purgeLen = 150): string {
  const y1 = 20, y2 = 20 + purgeLen;
  return [
    "G90 ; absolute positioning",
    "M140 S[first_layer_bed_temperature] ; start heating the bed",
    "M104 S150 ; warm the nozzle below oozing temperature",
    "G28 ; home all axes",
    "M190 S[first_layer_bed_temperature] ; wait for the bed",
    ...(level ? [`${level} ; level the bed after it is hot`] : []),
    "M109 S[first_layer_temperature] ; wait for the nozzle",
    "M83 ; relative extrusion for the purge",
    "G1 Z2 F600",
    `G1 X5 Y${y1} F6000 ; move to the purge line`,
    "G1 Z0.3 F600",
    `G1 X5 Y${y2} E${(purgeLen / 10).toFixed(0)} F1500 ; purge line`,
    `G1 X5.4 Y${y2} F6000`,
    `G1 X5.4 Y${y1} E${(purgeLen / 10).toFixed(0)} F1500 ; second purge line`,
    "G1 Z2 F600",
    "G92 E0",
    "{if use_relative_e_distances}M83{else}M82{endif} ; back to the slicer's extrusion mode",
  ].join("\n");
}

const MARLIN_END = [
  "G91 ; relative positioning",
  "G1 E-2 F2700 ; retract",
  "G1 Z10 F600 ; lift the nozzle (soft endstops stop it at the top)",
  "G90 ; absolute positioning",
  "G1 X0 F3000 ; move the head aside",
  "M106 S0 ; part fan off",
  "M104 S0 ; nozzle heater off",
  "M140 S0 ; bed heater off",
  "M84 X Y E ; motors off, keep Z holding",
].join("\n");

/** Klipper start without a vendor macro: same steps as marlinStart, mesh with BED_MESH_CALIBRATE. */
function klipperStart(mesh: boolean): string {
  return marlinStart(mesh ? "BED_MESH_CALIBRATE" : "");
}

const KLIPPER_END = [
  "G91",
  "G1 E-2 F2700 ; retract",
  "G1 Z10 F600 ; lift the nozzle",
  "G90",
  "M106 S0",
  "TURN_OFF_HEATERS",
  "M84",
].join("\n");

/** Voron convention (docs.vorondesign.com): PRINT_START / PRINT_END macros in printer.cfg. */
const VORON_START = "PRINT_START EXTRUDER=[first_layer_temperature] BED=[first_layer_bed_temperature]";
/** RatOS convention: START_PRINT / END_PRINT macros. Creality OS uses the same names. */
const RATOS_START = "START_PRINT EXTRUDER_TEMP=[first_layer_temperature] BED_TEMP=[first_layer_bed_temperature]";

// ---- Families ----

const bambu = family("bambu-lab", {
  brand: "Bambu Lab", driver: "bambu-lan", gcodeFlavor: "bambu", fileFormat: "gcode.3mf",
  autoLevel: { gcode: "G29" },
});
const bambuProfiles = (name: string) => ({
  bambustudio: `Bambu Lab ${name} 0.4 nozzle`, orcaslicer: `Bambu Lab ${name} 0.4 nozzle`,
});

const prusa = family("prusa", {
  brand: "Prusa", driver: "prusalink", gcodeFlavor: "marlin2", fileFormat: "gcode", autoLevel: { gcode: "G29" },
});

const crealityOs = family("creality", {
  brand: "Creality", driver: "creality-k1", altDrivers: ["moonraker"], gcodeFlavor: "klipper", fileFormat: "gcode",
  autoLevel: { gcode: "BED_MESH_CALIBRATE" }, startGcode: RATOS_START, endGcode: "END_PRINT",
});
const crealityMarlin = family("creality", {
  brand: "Creality", driver: "marlin-serial", altDrivers: ["octoprint", "moonraker"], gcodeFlavor: "marlin2",
  fileFormat: "gcode", endGcode: MARLIN_END,
});

const elegooKlipper = family("elegoo", {
  brand: "Elegoo", driver: "moonraker", gcodeFlavor: "klipper", fileFormat: "gcode",
  autoLevel: { gcode: "BED_MESH_CALIBRATE" },
});

const anycubicRinkhals = family("anycubic", {
  brand: "Anycubic", driver: "moonraker", gcodeFlavor: "klipper", fileFormat: "gcode",
});
const anycubicMarlin = family("anycubic", {
  brand: "Anycubic", driver: "marlin-serial", altDrivers: ["octoprint"], gcodeFlavor: "marlin2", fileFormat: "gcode",
  autoLevel: { gcode: "G29" }, startGcode: marlinStart("M420 S1"), endGcode: MARLIN_END,
});

const sovolMarlin = family("sovol", {
  brand: "Sovol", driver: "marlin-serial", altDrivers: ["octoprint", "moonraker"], gcodeFlavor: "marlin2",
  fileFormat: "gcode", autoLevel: { gcode: "G29" }, startGcode: marlinStart("G29"), endGcode: MARLIN_END,
});
const sovolKlipper = family("sovol", {
  brand: "Sovol", driver: "moonraker", gcodeFlavor: "klipper", fileFormat: "gcode",
  autoLevel: { gcode: "BED_MESH_CALIBRATE" },
});

const qidi = family("qidi", {
  brand: "QIDI", driver: "moonraker", gcodeFlavor: "klipper", fileFormat: "gcode", enclosure: true,
  autoLevel: { gcode: "BED_MESH_CALIBRATE" },
});

const flashforgeHttp = family("flashforge", {
  brand: "FlashForge", driver: "flashforge-http", gcodeFlavor: "klipper", fileFormat: "gcode",
  autoLevel: { gcode: "G29" },
});
const flashforgeTcp = family("flashforge", {
  brand: "FlashForge", driver: "flashforge-tcp", gcodeFlavor: "flashforge", fileFormat: "gx", origin: "center",
});

const snapmaker = family("snapmaker", {
  brand: "Snapmaker", driver: "snapmaker", gcodeFlavor: "marlin", fileFormat: "gcode", autoLevel: { gcode: "G29" },
});

const ultimaker = family("ultimaker", {
  brand: "Ultimaker", driver: "ultimaker", gcodeFlavor: "marlin", fileFormat: "ufp", filamentMm: 2.85,
});

const voron = family("voron", {
  brand: "Voron", driver: "moonraker", gcodeFlavor: "klipper", fileFormat: "gcode", enclosure: true,
  autoLevel: { gcode: "BED_MESH_CALIBRATE" }, startGcode: VORON_START, endGcode: "PRINT_END",
});

const ratrig = family("ratrig", {
  brand: "RatRig", driver: "moonraker", gcodeFlavor: "klipper", fileFormat: "gcode",
  autoLevel: { gcode: "BED_MESH_CALIBRATE" }, startGcode: RATOS_START, endGcode: "END_PRINT",
});

const artilleryMarlin = family("artillery", {
  brand: "Artillery", driver: "marlin-serial", altDrivers: ["octoprint"], gcodeFlavor: "marlin2", fileFormat: "gcode",
  autoLevel: { gcode: "G29" }, startGcode: marlinStart("G29"), endGcode: MARLIN_END,
});
const artilleryKlipper = family("artillery", {
  brand: "Artillery", driver: "moonraker", gcodeFlavor: "klipper", fileFormat: "gcode",
  autoLevel: { gcode: "BED_MESH_CALIBRATE" },
});

const kingroon = family("kingroon", { brand: "Kingroon", fileFormat: "gcode" });
const twoTrees = family("two-trees", { brand: "Two Trees", fileFormat: "gcode" });

const flsun = family("flsun", {
  brand: "Flsun", driver: "moonraker", gcodeFlavor: "klipper", fileFormat: "gcode", origin: "center",
  autoLevel: { gcode: "BED_MESH_CALIBRATE" },
});

const tronxy = family("tronxy", {
  brand: "Tronxy", driver: "marlin-serial", altDrivers: ["octoprint"], gcodeFlavor: "marlin2", fileFormat: "gcode",
  autoLevel: { gcode: "G29" }, startGcode: marlinStart("G29", 200), endGcode: MARLIN_END,
});

const monoprice = family("monoprice", { brand: "Monoprice", fileFormat: "gcode" });

const geeetech = family("geeetech", {
  brand: "Geeetech", driver: "marlin-serial", altDrivers: ["octoprint"], gcodeFlavor: "marlin2", fileFormat: "gcode",
  endGcode: MARLIN_END,
});

const generic = family("generic", { brand: "Generic", fileFormat: "gcode", autoLevel: false });

export const PRINTERS: readonly PrinterModel[] = [
  // ---- Afinia (the only printer Morphix has run end-to-end on) ----
  {
    id: "afinia-qd330", brand: "Afinia", model: "QD330", driver: "flashforge-tcp",
    bed: { x: 220, y: 220, z: 220 }, origin: "center", nozzleMm: 0.4, filamentMm: 1.75,
    gcodeFlavor: "flashforge", fileFormat: "gx", maxSpeedMmS: 600, heatedBed: true, enclosure: true,
    autoLevel: { gcode: "G29" }, maxNozzleC: 250, maxBedC: 100,
    setupDoc: "docs/printers/afinia.md", verified: "tested",
  },

  // ---- Bambu Lab ----
  bambu({ id: "bambu-x1c", model: "X1 Carbon", bed: cube(256), maxNozzleC: 300, maxBedC: 110, enclosure: true, maxSpeedMmS: 500, vendorProfiles: bambuProfiles("X1 Carbon") }),
  bambu({ id: "bambu-x1e", model: "X1E", bed: cube(256), maxNozzleC: 320, maxBedC: 110, enclosure: true, maxSpeedMmS: 500, vendorProfiles: bambuProfiles("X1E") }),
  bambu({ id: "bambu-p1s", model: "P1S", bed: cube(256), maxNozzleC: 300, maxBedC: 100, enclosure: true, maxSpeedMmS: 500, vendorProfiles: bambuProfiles("P1S") }),
  bambu({ id: "bambu-p1p", model: "P1P", bed: cube(256), maxNozzleC: 300, maxBedC: 100, enclosure: false, maxSpeedMmS: 500, vendorProfiles: bambuProfiles("P1P") }),
  bambu({ id: "bambu-p2s", model: "P2S", bed: cube(256), maxNozzleC: 300, maxBedC: 110, enclosure: true, maxSpeedMmS: 600, vendorProfiles: bambuProfiles("P2S") }),
  bambu({ id: "bambu-a1", model: "A1", bed: cube(256), maxNozzleC: 300, maxBedC: 100, enclosure: false, maxSpeedMmS: 500, vendorProfiles: bambuProfiles("A1") }),
  bambu({ id: "bambu-a1-mini", model: "A1 mini", bed: cube(180), maxNozzleC: 300, maxBedC: 80, enclosure: false, maxSpeedMmS: 500, vendorProfiles: bambuProfiles("A1 mini") }),
  bambu({ id: "bambu-h2d", model: "H2D", bed: { x: 325, y: 320, z: 325 }, maxNozzleC: 350, maxBedC: 120, enclosure: true, maxSpeedMmS: 1000, vendorProfiles: bambuProfiles("H2D") }),
  bambu({ id: "bambu-h2s", model: "H2S", bed: { x: 340, y: 320, z: 340 }, maxNozzleC: 350, maxBedC: 120, enclosure: true, maxSpeedMmS: 1000, vendorProfiles: bambuProfiles("H2S") }),

  // ---- Prusa ----
  prusa({ id: "prusa-mk4s", model: "MK4S", bed: { x: 250, y: 210, z: 220 }, maxNozzleC: 290, maxBedC: 120, vendorProfiles: { prusaslicer: "Original Prusa MK4S", orcaslicer: "Prusa MK4S 0.4 nozzle" } }),
  prusa({ id: "prusa-mk4", model: "MK4", bed: { x: 250, y: 210, z: 220 }, maxNozzleC: 290, maxBedC: 120, vendorProfiles: { prusaslicer: "Original Prusa MK4", orcaslicer: "Prusa MK4 0.4 nozzle" } }),
  prusa({ id: "prusa-mk3-9", model: "MK3.9", bed: { x: 250, y: 210, z: 220 }, maxNozzleC: 290, maxBedC: 120, vendorProfiles: { prusaslicer: "Original Prusa MK3.9" } }),
  prusa({ id: "prusa-core-one", model: "CORE One", bed: { x: 250, y: 220, z: 270 }, maxNozzleC: 290, maxBedC: 120, enclosure: true, vendorProfiles: { prusaslicer: "Prusa CORE One", orcaslicer: "Prusa CORE One 0.4 nozzle" } }),
  prusa({ id: "prusa-mini", model: "MINI+", bed: cube(180), maxNozzleC: 280, maxBedC: 100, vendorProfiles: { prusaslicer: "Original Prusa MINI & MINI+", orcaslicer: "Prusa MINI 0.4 nozzle" } }),
  prusa({ id: "prusa-xl", model: "XL", bed: cube(360), maxNozzleC: 290, maxBedC: 120, vendorProfiles: { prusaslicer: "Original Prusa XL", orcaslicer: "Prusa XL 0.4 nozzle" } }),
  prusa({ id: "prusa-mk3s", model: "MK3S+", driver: "marlin-serial", altDrivers: ["octoprint"], bed: { x: 250, y: 210, z: 210 }, maxNozzleC: 300, maxBedC: 120, autoLevel: { gcode: "G80" }, vendorProfiles: { prusaslicer: "Original Prusa i3 MK3S & MK3S+", orcaslicer: "Prusa MK3S 0.4 nozzle" } }),

  // ---- Creality: Creality OS (Klipper inside) over LAN ----
  crealityOs({ id: "creality-k1", model: "K1", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 300, maxBedC: 100, enclosure: true, maxSpeedMmS: 600, vendorProfiles: { orcaslicer: "Creality K1 (0.4 nozzle)" } }),
  crealityOs({ id: "creality-k1c", model: "K1C", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 300, maxBedC: 100, enclosure: true, maxSpeedMmS: 600, vendorProfiles: { orcaslicer: "Creality K1C 0.4 nozzle" } }),
  crealityOs({ id: "creality-k1-max", model: "K1 Max", bed: cube(300), maxNozzleC: 300, maxBedC: 100, enclosure: true, maxSpeedMmS: 600, vendorProfiles: { orcaslicer: "Creality K1 Max (0.4 nozzle)" } }),
  crealityOs({ id: "creality-k1-se", model: "K1 SE", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 300, maxBedC: 100, enclosure: false, maxSpeedMmS: 600, vendorProfiles: { orcaslicer: "Creality K1 SE 0.4 nozzle" } }),
  crealityOs({ id: "creality-k2-plus", model: "K2 Plus", bed: cube(350), maxNozzleC: 350, maxBedC: 120, enclosure: true, maxSpeedMmS: 600, vendorProfiles: { orcaslicer: "Creality K2 Plus 0.4 nozzle" } }),
  crealityOs({ id: "creality-k2-pro", model: "K2 Pro", bed: cube(300), maxNozzleC: 350, maxBedC: 120, enclosure: true, maxSpeedMmS: 600 }),
  crealityOs({ id: "creality-hi", model: "Hi", bed: { x: 260, y: 260, z: 300 }, maxNozzleC: 300, maxBedC: 100, maxSpeedMmS: 500 }),
  crealityOs({ id: "creality-ender-3-v3", model: "Ender-3 V3", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 300, maxBedC: 110, maxSpeedMmS: 600, vendorProfiles: { orcaslicer: "Creality Ender-3 V3 0.4 nozzle" } }),
  crealityOs({ id: "creality-ender-3-v3-ke", model: "Ender-3 V3 KE", bed: { x: 220, y: 220, z: 240 }, maxNozzleC: 300, maxBedC: 100, maxSpeedMmS: 500, vendorProfiles: { orcaslicer: "Creality Ender-3 V3 KE 0.4 nozzle" } }),
  crealityOs({ id: "creality-cr-10-se", model: "CR-10 SE", bed: { x: 220, y: 220, z: 265 }, maxNozzleC: 300, maxBedC: 100, maxSpeedMmS: 600 }),

  // ---- Creality: Marlin over USB ----
  crealityMarlin({ id: "creality-ender-3-v3-se", model: "Ender-3 V3 SE", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 260, maxBedC: 100, maxSpeedMmS: 250, autoLevel: { gcode: "G29" }, startGcode: marlinStart("G29"), vendorProfiles: { orcaslicer: "Creality Ender-3 V3 SE 0.4 nozzle", prusaslicer: "Creality Ender-3 V3 SE" } }),
  crealityMarlin({ id: "creality-ender-3-s1", model: "Ender-3 S1", bed: { x: 220, y: 220, z: 270 }, maxNozzleC: 260, maxBedC: 100, autoLevel: { gcode: "G29" }, startGcode: marlinStart("M420 S1"), vendorProfiles: { orcaslicer: "Creality Ender-3 S1 0.4 nozzle", prusaslicer: "Creality Ender-3 S1" } }),
  crealityMarlin({ id: "creality-ender-3-s1-pro", model: "Ender-3 S1 Pro", bed: { x: 220, y: 220, z: 270 }, maxNozzleC: 300, maxBedC: 110, autoLevel: { gcode: "G29" }, startGcode: marlinStart("M420 S1"), vendorProfiles: { orcaslicer: "Creality Ender-3 S1 Pro 0.4 nozzle", prusaslicer: "Creality Ender-3 S1 Pro" } }),
  crealityMarlin({ id: "creality-ender-3-v2-neo", model: "Ender-3 V2 Neo", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 250, maxBedC: 100, autoLevel: { gcode: "G29" }, startGcode: marlinStart("M420 S1"), vendorProfiles: { orcaslicer: "Creality Ender-3 V2 Neo 0.4 nozzle" } }),
  crealityMarlin({ id: "creality-ender-3-v2", model: "Ender-3 V2", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 250, maxBedC: 100, autoLevel: false, startGcode: marlinStart(""), vendorProfiles: { orcaslicer: "Creality Ender-3 V2 0.4 nozzle", prusaslicer: "Creality Ender-3 V2" } }),
  crealityMarlin({ id: "creality-ender-3", model: "Ender-3 / Ender-3 Pro", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 250, maxBedC: 100, autoLevel: false, startGcode: marlinStart(""), vendorProfiles: { orcaslicer: "Creality Ender-3 0.4 nozzle", prusaslicer: "Creality Ender-3" } }),
  crealityMarlin({ id: "creality-ender-5-s1", model: "Ender-5 S1", bed: { x: 220, y: 220, z: 280 }, maxNozzleC: 300, maxBedC: 110, autoLevel: { gcode: "G29" }, startGcode: marlinStart("M420 S1"), vendorProfiles: { orcaslicer: "Creality Ender-5 S1 0.4 nozzle", prusaslicer: "Creality Ender-5 S1" } }),

  // ---- Elegoo ----
  family("elegoo", { brand: "Elegoo" })({ id: "elegoo-centauri-carbon", model: "Centauri Carbon", driver: "elegoo-sdcp", gcodeFlavor: "klipper", fileFormat: "gcode", bed: cube(256), maxNozzleC: 320, maxBedC: 110, enclosure: true, maxSpeedMmS: 500, autoLevel: { gcode: "G29" }, vendorProfiles: { orcaslicer: "Elegoo Centauri Carbon 0.4 nozzle" } }),
  elegooKlipper({ id: "elegoo-neptune-4", model: "Neptune 4", bed: { x: 225, y: 225, z: 265 }, maxNozzleC: 300, maxBedC: 110, maxSpeedMmS: 500, vendorProfiles: { orcaslicer: "Elegoo Neptune 4 (0.4 nozzle)" } }),
  elegooKlipper({ id: "elegoo-neptune-4-pro", model: "Neptune 4 Pro", bed: { x: 225, y: 225, z: 265 }, maxNozzleC: 300, maxBedC: 110, maxSpeedMmS: 500, vendorProfiles: { orcaslicer: "Elegoo Neptune 4 Pro (0.4 nozzle)" } }),
  elegooKlipper({ id: "elegoo-neptune-4-plus", model: "Neptune 4 Plus", bed: { x: 320, y: 320, z: 385 }, maxNozzleC: 300, maxBedC: 110, maxSpeedMmS: 500, vendorProfiles: { orcaslicer: "Elegoo Neptune 4 Plus (0.4 nozzle)" } }),
  elegooKlipper({ id: "elegoo-neptune-4-max", model: "Neptune 4 Max", bed: { x: 420, y: 420, z: 480 }, maxNozzleC: 300, maxBedC: 110, maxSpeedMmS: 500, vendorProfiles: { orcaslicer: "Elegoo Neptune 4 Max (0.4 nozzle)" } }),
  elegooKlipper({ id: "elegoo-orangestorm-giga", model: "OrangeStorm Giga", bed: { x: 800, y: 800, z: 1000 }, maxNozzleC: 300, maxBedC: 110, maxSpeedMmS: 300 }),
  family("elegoo", { brand: "Elegoo" })({ id: "elegoo-neptune-3-pro", model: "Neptune 3 Pro", driver: "marlin-serial", altDrivers: ["octoprint"], gcodeFlavor: "marlin2", fileFormat: "gcode", bed: { x: 225, y: 225, z: 280 }, maxNozzleC: 260, maxBedC: 100, autoLevel: { gcode: "G29" }, startGcode: marlinStart("G29"), endGcode: MARLIN_END, vendorProfiles: { orcaslicer: "Elegoo Neptune 3 Pro (0.4 nozzle)" } }),

  // ---- Anycubic (Kobra 2 Pro / 3 / S1 need the community Rinkhals firmware for Moonraker) ----
  anycubicRinkhals({ id: "anycubic-kobra-3", model: "Kobra 3", bed: { x: 250, y: 250, z: 260 }, maxNozzleC: 300, maxBedC: 110, maxSpeedMmS: 600, vendorProfiles: { orcaslicer: "Anycubic Kobra 3 0.4 nozzle" } }),
  anycubicRinkhals({ id: "anycubic-kobra-3-max", model: "Kobra 3 Max", bed: { x: 420, y: 420, z: 500 }, maxNozzleC: 300, maxBedC: 110, maxSpeedMmS: 600 }),
  anycubicRinkhals({ id: "anycubic-kobra-s1", model: "Kobra S1", bed: cube(250), maxNozzleC: 320, maxBedC: 120, enclosure: true, maxSpeedMmS: 600, vendorProfiles: { orcaslicer: "Anycubic Kobra S1 0.4 nozzle" } }),
  anycubicRinkhals({ id: "anycubic-kobra-2-pro", model: "Kobra 2 Pro", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 260, maxBedC: 110, maxSpeedMmS: 500, vendorProfiles: { orcaslicer: "Anycubic Kobra 2 Pro 0.4 nozzle" } }),
  anycubicMarlin({ id: "anycubic-kobra-2-neo", model: "Kobra 2 Neo", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 260, maxBedC: 100, maxSpeedMmS: 250, vendorProfiles: { orcaslicer: "Anycubic Kobra 2 Neo 0.4 nozzle" } }),
  anycubicMarlin({ id: "anycubic-vyper", model: "Vyper", bed: { x: 245, y: 245, z: 260 }, maxNozzleC: 260, maxBedC: 110, vendorProfiles: { orcaslicer: "Anycubic Vyper 0.4 nozzle" } }),

  // ---- Sovol ----
  sovolMarlin({ id: "sovol-sv06", model: "SV06", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 300, maxBedC: 100, vendorProfiles: { orcaslicer: "Sovol SV06 0.4 nozzle", prusaslicer: "Sovol SV06" } }),
  sovolMarlin({ id: "sovol-sv06-plus", model: "SV06 Plus", bed: { x: 300, y: 300, z: 340 }, maxNozzleC: 300, maxBedC: 100, startGcode: marlinStart("G29", 200), vendorProfiles: { orcaslicer: "Sovol SV06 Plus 0.4 nozzle" } }),
  sovolKlipper({ id: "sovol-sv07", model: "SV07", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 300, maxBedC: 100, maxSpeedMmS: 500, vendorProfiles: { orcaslicer: "Sovol SV07 0.4 nozzle" } }),
  sovolKlipper({ id: "sovol-sv08", model: "SV08", bed: { x: 350, y: 350, z: 345 }, maxNozzleC: 300, maxBedC: 100, maxSpeedMmS: 700, vendorProfiles: { orcaslicer: "Sovol SV08 0.4 nozzle" } }),

  // ---- QIDI ----
  qidi({ id: "qidi-x-plus-3", model: "X-Plus 3", bed: { x: 280, y: 280, z: 270 }, maxNozzleC: 350, maxBedC: 120, maxSpeedMmS: 600, vendorProfiles: { orcaslicer: "Qidi X-Plus 3 0.4 nozzle" } }),
  qidi({ id: "qidi-x-max-3", model: "X-Max 3", bed: { x: 325, y: 325, z: 315 }, maxNozzleC: 350, maxBedC: 120, maxSpeedMmS: 600, vendorProfiles: { orcaslicer: "Qidi X-Max 3 0.4 nozzle" } }),
  qidi({ id: "qidi-x-smart-3", model: "X-Smart 3", bed: { x: 175, y: 180, z: 170 }, maxNozzleC: 350, maxBedC: 110, maxSpeedMmS: 500, vendorProfiles: { orcaslicer: "Qidi X-Smart 3 0.4 nozzle" } }),
  qidi({ id: "qidi-q1-pro", model: "Q1 Pro", bed: { x: 245, y: 245, z: 240 }, maxNozzleC: 350, maxBedC: 120, maxSpeedMmS: 600, vendorProfiles: { orcaslicer: "Qidi Q1 Pro 0.4 nozzle" } }),
  qidi({ id: "qidi-plus4", model: "Plus4", bed: { x: 305, y: 305, z: 280 }, maxNozzleC: 370, maxBedC: 120, maxSpeedMmS: 600, vendorProfiles: { orcaslicer: "Qidi Plus4 0.4 nozzle" } }),

  // ---- FlashForge ----
  flashforgeHttp({ id: "flashforge-adventurer-5m", model: "Adventurer 5M", bed: cube(220), maxNozzleC: 280, maxBedC: 110, maxSpeedMmS: 600, vendorProfiles: { orcaslicer: "Flashforge Adventurer 5M 0.4 Nozzle" } }),
  flashforgeHttp({ id: "flashforge-adventurer-5m-pro", model: "Adventurer 5M Pro", bed: cube(220), maxNozzleC: 280, maxBedC: 110, enclosure: true, maxSpeedMmS: 600, vendorProfiles: { orcaslicer: "Flashforge Adventurer 5M Pro 0.4 Nozzle" } }),
  flashforgeHttp({ id: "flashforge-ad5x", model: "AD5X", bed: cube(220), maxNozzleC: 300, maxBedC: 110, maxSpeedMmS: 600, vendorProfiles: { orcaslicer: "Flashforge AD5X 0.4 nozzle" } }),
  flashforgeTcp({ id: "flashforge-adventurer-3", model: "Adventurer 3", bed: cube(150), maxNozzleC: 240, maxBedC: 100, enclosure: true }),
  flashforgeTcp({ id: "flashforge-adventurer-4", model: "Adventurer 4", bed: { x: 220, y: 200, z: 250 }, maxNozzleC: 265, maxBedC: 100, enclosure: true }),

  // ---- Snapmaker ----
  snapmaker({ id: "snapmaker-j1", model: "J1 / J1s (IDEX)", bed: { x: 300, y: 200, z: 200 }, maxNozzleC: 300, maxBedC: 100, enclosure: true, maxSpeedMmS: 350, vendorProfiles: { orcaslicer: "Snapmaker J1 (0.4 nozzle)" } }),
  snapmaker({ id: "snapmaker-artisan", model: "Artisan", bed: cube(400), maxNozzleC: 300, maxBedC: 110, enclosure: true, vendorProfiles: { orcaslicer: "Snapmaker Artisan (0.4 nozzle)" } }),
  snapmaker({ id: "snapmaker-2-a350t", model: "2.0 A350T / F350", bed: { x: 320, y: 350, z: 330 }, maxNozzleC: 275, maxBedC: 100, vendorProfiles: { orcaslicer: "Snapmaker A350 (0.4 nozzle)", prusaslicer: "Snapmaker A350" } }),
  snapmaker({ id: "snapmaker-2-a250t", model: "2.0 A250T / F250", bed: { x: 230, y: 250, z: 235 }, maxNozzleC: 275, maxBedC: 100, vendorProfiles: { orcaslicer: "Snapmaker A250 (0.4 nozzle)", prusaslicer: "Snapmaker A250" } }),

  // ---- Ultimaker (2.85 mm filament, .ufp files) ----
  ultimaker({ id: "ultimaker-s3", model: "S3", bed: { x: 230, y: 190, z: 200 }, maxNozzleC: 280, maxBedC: 120 }),
  ultimaker({ id: "ultimaker-s5", model: "S5", bed: { x: 330, y: 240, z: 300 }, maxNozzleC: 280, maxBedC: 140 }),
  ultimaker({ id: "ultimaker-s7", model: "S7", bed: { x: 330, y: 240, z: 300 }, maxNozzleC: 280, maxBedC: 120 }),

  // ---- Voron (DIY, Klipper; sizes are the standard kit sizes) ----
  voron({ id: "voron-2-4-250", model: "2.4 (250 mm)", bed: cube(250), maxNozzleC: 300, maxBedC: 120, maxSpeedMmS: 500, vendorProfiles: { orcaslicer: "Voron 2.4 250 0.4 nozzle" } }),
  voron({ id: "voron-2-4-300", model: "2.4 (300 mm)", bed: cube(300), maxNozzleC: 300, maxBedC: 120, maxSpeedMmS: 500, vendorProfiles: { orcaslicer: "Voron 2.4 300 0.4 nozzle" } }),
  voron({ id: "voron-2-4-350", model: "2.4 (350 mm)", bed: cube(350), maxNozzleC: 300, maxBedC: 120, maxSpeedMmS: 500, vendorProfiles: { orcaslicer: "Voron 2.4 350 0.4 nozzle" } }),
  voron({ id: "voron-trident-250", model: "Trident (250 mm)", bed: cube(250), maxNozzleC: 300, maxBedC: 120, maxSpeedMmS: 500, vendorProfiles: { orcaslicer: "Voron Trident 250 0.4 nozzle" } }),
  voron({ id: "voron-trident-300", model: "Trident (300 mm)", bed: cube(300, 250), maxNozzleC: 300, maxBedC: 120, maxSpeedMmS: 500, vendorProfiles: { orcaslicer: "Voron Trident 300 0.4 nozzle" } }),
  voron({ id: "voron-trident-350", model: "Trident (350 mm)", bed: cube(350, 250), maxNozzleC: 300, maxBedC: 120, maxSpeedMmS: 500, vendorProfiles: { orcaslicer: "Voron Trident 350 0.4 nozzle" } }),
  voron({ id: "voron-0-2", model: "V0.2", bed: cube(120), maxNozzleC: 300, maxBedC: 110, maxSpeedMmS: 400, autoLevel: false }),
  voron({ id: "voron-switchwire", model: "Switchwire", bed: { x: 250, y: 210, z: 240 }, maxNozzleC: 300, maxBedC: 120, maxSpeedMmS: 400, vendorProfiles: { orcaslicer: "Voron Switchwire 250 0.4 nozzle" } }),

  // ---- RatRig (RatOS = Klipper + Moonraker) ----
  ratrig({ id: "ratrig-v-core-4-300", model: "V-Core 4 (300 mm)", bed: cube(300), maxNozzleC: 300, maxBedC: 120, maxSpeedMmS: 500 }),
  ratrig({ id: "ratrig-v-core-4-400", model: "V-Core 4 (400 mm)", bed: cube(400), maxNozzleC: 300, maxBedC: 120, maxSpeedMmS: 500 }),
  ratrig({ id: "ratrig-v-core-4-500", model: "V-Core 4 (500 mm)", bed: cube(500), maxNozzleC: 300, maxBedC: 120, maxSpeedMmS: 500 }),
  ratrig({ id: "ratrig-v-minion", model: "V-Minion", bed: cube(180), maxNozzleC: 300, maxBedC: 110, maxSpeedMmS: 400 }),

  // ---- Artillery ----
  artilleryMarlin({ id: "artillery-sidewinder-x3-pro", model: "Sidewinder X3 Pro", bed: { x: 240, y: 240, z: 260 }, maxNozzleC: 300, maxBedC: 100, vendorProfiles: { orcaslicer: "Artillery Sidewinder X3 Pro 0.4 nozzle" } }),
  artilleryMarlin({ id: "artillery-sidewinder-x3-plus", model: "Sidewinder X3 Plus", bed: { x: 300, y: 300, z: 400 }, maxNozzleC: 300, maxBedC: 100, startGcode: marlinStart("G29", 200), vendorProfiles: { orcaslicer: "Artillery Sidewinder X3 Plus 0.4 nozzle" } }),
  artilleryMarlin({ id: "artillery-genius-pro", model: "Genius Pro", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 250, maxBedC: 100, vendorProfiles: { orcaslicer: "Artillery Genius Pro 0.4 nozzle" } }),
  artilleryKlipper({ id: "artillery-sidewinder-x4-pro", model: "Sidewinder X4 Pro", bed: { x: 240, y: 240, z: 260 }, maxNozzleC: 300, maxBedC: 100, maxSpeedMmS: 500, vendorProfiles: { orcaslicer: "Artillery Sidewinder X4 Pro 0.4 nozzle" } }),
  artilleryKlipper({ id: "artillery-sidewinder-x4-plus", model: "Sidewinder X4 Plus", bed: { x: 300, y: 300, z: 400 }, maxNozzleC: 300, maxBedC: 100, maxSpeedMmS: 500, vendorProfiles: { orcaslicer: "Artillery Sidewinder X4 Plus 0.4 nozzle" } }),

  // ---- Kingroon ----
  kingroon({ id: "kingroon-klp1", model: "KLP1", driver: "moonraker", gcodeFlavor: "klipper", bed: cube(210), maxNozzleC: 300, maxBedC: 100, maxSpeedMmS: 500, autoLevel: { gcode: "BED_MESH_CALIBRATE" } }),
  kingroon({ id: "kingroon-kp3s-pro-v2", model: "KP3S Pro V2", driver: "marlin-serial", altDrivers: ["octoprint"], gcodeFlavor: "marlin2", bed: cube(200), maxNozzleC: 260, maxBedC: 100, autoLevel: { gcode: "G29" }, startGcode: marlinStart("G29"), endGcode: MARLIN_END }),

  // ---- Two Trees ----
  twoTrees({ id: "two-trees-sk1", model: "SK1", driver: "moonraker", gcodeFlavor: "klipper", bed: cube(256), maxNozzleC: 300, maxBedC: 100, maxSpeedMmS: 700, autoLevel: { gcode: "BED_MESH_CALIBRATE" }, vendorProfiles: { orcaslicer: "Two Trees SK1 0.4 nozzle" } }),
  twoTrees({ id: "two-trees-sapphire-pro", model: "Sapphire Pro", driver: "marlin-serial", altDrivers: ["octoprint"], gcodeFlavor: "marlin2", bed: cube(235), maxNozzleC: 250, maxBedC: 100, autoLevel: false, startGcode: marlinStart(""), endGcode: MARLIN_END }),

  // ---- Flsun (deltas: round bed, (0,0) in the middle) ----
  flsun({ id: "flsun-v400", model: "V400", bed: circle(300, 410), maxNozzleC: 300, maxBedC: 110, maxSpeedMmS: 600, vendorProfiles: { orcaslicer: "FLSun V400 0.4 nozzle" } }),
  flsun({ id: "flsun-t1-pro", model: "T1 / T1 Pro", bed: circle(260, 330), maxNozzleC: 300, maxBedC: 110, maxSpeedMmS: 1000, vendorProfiles: { orcaslicer: "FLSun T1 0.4 nozzle" } }),
  flsun({ id: "flsun-s1", model: "S1 / S1 Pro", bed: circle(320, 430), maxNozzleC: 350, maxBedC: 120, maxSpeedMmS: 1200, vendorProfiles: { orcaslicer: "FLSun S1 0.4 nozzle" } }),
  flsun({ id: "flsun-super-racer", model: "Super Racer (SR)", driver: "marlin-serial", altDrivers: ["octoprint", "moonraker"], gcodeFlavor: "marlin2", bed: circle(260, 330), maxNozzleC: 260, maxBedC: 100, maxSpeedMmS: 200, autoLevel: { gcode: "G29" }, vendorProfiles: { orcaslicer: "FLSun Super Racer 0.4 nozzle" } }),

  // ---- Tronxy ----
  tronxy({ id: "tronxy-x5sa-pro", model: "X5SA Pro", bed: { x: 330, y: 330, z: 400 }, maxNozzleC: 275, maxBedC: 100 }),
  tronxy({ id: "tronxy-x5sa-500-pro", model: "X5SA-500 Pro", bed: { x: 500, y: 500, z: 600 }, maxNozzleC: 275, maxBedC: 100 }),

  // ---- Monoprice ----
  monoprice({ id: "monoprice-select-mini-v2", model: "Select Mini V2", driver: "marlin-serial", altDrivers: ["octoprint"], gcodeFlavor: "marlin", bed: cube(120), maxNozzleC: 250, maxBedC: 60, autoLevel: false, startGcode: marlinStart("", 80), endGcode: MARLIN_END }),
  monoprice({ id: "monoprice-mp10", model: "MP10", driver: "marlin-serial", altDrivers: ["octoprint"], gcodeFlavor: "marlin2", bed: { x: 300, y: 300, z: 400 }, maxNozzleC: 250, maxBedC: 100, autoLevel: { gcode: "G29" }, startGcode: marlinStart("G29", 200), endGcode: MARLIN_END }),
  monoprice({ id: "monoprice-voxel", model: "Voxel", driver: "flashforge-tcp", gcodeFlavor: "flashforge", fileFormat: "gx", origin: "center", bed: cube(150), maxNozzleC: 240, maxBedC: 100, enclosure: true }),

  // ---- Geeetech ----
  geeetech({ id: "geeetech-a10-pro", model: "A10 Pro", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 250, maxBedC: 100, autoLevel: false, startGcode: marlinStart("") }),
  geeetech({ id: "geeetech-a20", model: "A20", bed: cube(250), maxNozzleC: 250, maxBedC: 100, autoLevel: false, startGcode: marlinStart("", 200) }),
  geeetech({ id: "geeetech-mizar-s", model: "Mizar S", bed: { x: 255, y: 255, z: 260 }, maxNozzleC: 260, maxBedC: 100, autoLevel: { gcode: "G29" }, startGcode: marlinStart("G29", 200) }),

  // ---- Generic (the setup page can override the bed size: see withBedOverride) ----
  generic({ id: "generic-marlin", model: "Marlin printer (USB)", driver: "marlin-serial", altDrivers: ["octoprint"], gcodeFlavor: "marlin2", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 260, maxBedC: 100, startGcode: marlinStart(""), endGcode: MARLIN_END }),
  generic({ id: "generic-klipper", model: "Klipper printer (Moonraker)", driver: "moonraker", gcodeFlavor: "klipper", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 280, maxBedC: 110, startGcode: klipperStart(false), endGcode: KLIPPER_END }),
  generic({ id: "generic-octoprint", model: "Any printer on OctoPrint", driver: "octoprint", gcodeFlavor: "marlin2", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 260, maxBedC: 100, startGcode: marlinStart(""), endGcode: MARLIN_END }),
  generic({ id: "generic-duet", model: "RepRapFirmware printer (Duet)", driver: "duet", gcodeFlavor: "reprapfirmware", bed: { x: 220, y: 220, z: 250 }, maxNozzleC: 280, maxBedC: 110, startGcode: marlinStart(""), endGcode: MARLIN_END }),
];

/** Printers people ask about that Morphix cannot talk to yet, and why (shown on the setup page). */
export interface UnsupportedPrinter { brand: string; model: string; reason: string; setupDoc: string }

export const UNSUPPORTED_PRINTERS: readonly UnsupportedPrinter[] = [
  {
    brand: "AnkerMake", model: "M5 / M5C",
    reason: "No documented local protocol: printing goes through Anker's cloud and app. Not supported.",
    setupDoc: "docs/printers/README.md",
  },
  {
    brand: "Raise3D", model: "Pro2 / Pro3 / E2",
    reason: "Uses Raise3D's own RaiseTouch API, which Morphix has no driver for yet.",
    setupDoc: "docs/printers/README.md",
  },
  {
    brand: "Bambu Lab", model: "Cloud mode (without LAN mode)",
    reason: "Morphix only talks to Bambu printers in LAN mode. Turn on LAN mode (see the Bambu Lab guide).",
    setupDoc: "docs/printers/bambu-lab.md",
  },
];

export function findPrinter(id: string): PrinterModel | undefined {
  return PRINTERS.find((p) => p.id === id);
}

export function printersByBrand(): Map<string, PrinterModel[]> {
  const m = new Map<string, PrinterModel[]>();
  for (const p of PRINTERS) m.set(p.brand, [...(m.get(p.brand) ?? []), p]);
  return m;
}
