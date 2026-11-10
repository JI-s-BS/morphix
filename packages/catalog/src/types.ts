// Printer catalog: every printer Morphix knows how to slice for and talk to.
// One entry per model. Slicer profiles are generated from these fields
// (packages/slicing/src/adapters), and the setup page offers them as a picker.
import type { DriverId } from "@morphix/printer";

export interface PrinterModel {
  /** Stable id, kebab-case: "<brand>-<model>", e.g. "prusa-mk4", "bambu-p1s". */
  id: string;
  brand: string;
  model: string;
  /** Which driver talks to it on the network / USB (see packages/printer/src/drivers/types.ts). */
  driver: DriverId;
  /** Other drivers that also work (e.g. a Creality K1 rooted with Moonraker). */
  altDrivers?: DriverId[];
  /** Build volume in mm. */
  bed: { x: number; y: number; z: number; shape?: "rect" | "circle" };
  /** Where (0,0) is: "corner" (front-left, most printers) or "center" (QD330, deltas). */
  origin: "corner" | "center";
  nozzleMm: number;
  filamentMm: 1.75 | 2.85;
  /** Firmware G-code dialect, for slicer profiles. */
  gcodeFlavor: "marlin" | "marlin2" | "klipper" | "reprapfirmware" | "bambu" | "flashforge";
  /** File the printer wants: plain G-code, FlashForge .gx, Bambu .gcode.3mf, Ultimaker .ufp. */
  fileFormat: "gcode" | "gx" | "gcode.3mf" | "ufp";
  maxSpeedMmS?: number;
  heatedBed: boolean;
  enclosure?: boolean;
  /** Has its own bed probe / auto-leveling, and the command that runs it ("G29", "BED_MESH_CALIBRATE"). */
  autoLevel?: { gcode: string } | false;
  maxNozzleC: number;
  maxBedC: number;
  /** Start / end G-code templates in PrusaSlicer placeholder syntax ([first_layer_temperature] ...). */
  startGcode?: string;
  endGcode?: string;
  /** Slicers with a built-in vendor profile for this model (adapters may prefer it). */
  vendorProfiles?: Partial<Record<"prusaslicer" | "orcaslicer" | "bambustudio", string>>;
  /** docs/printers/<file>.md: how to enable LAN/API access and connect it. */
  setupDoc: string;
  /** "tested" = run end-to-end on real hardware; "protocol" = implemented from the maker's docs, tests use a fake. */
  verified: "tested" | "protocol";
}
