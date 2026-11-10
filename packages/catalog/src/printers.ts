// The catalog. Owned by the catalog session (docs/GOAL.md); entries are added here.
import type { PrinterModel } from "./types";

export const PRINTERS: readonly PrinterModel[] = [
  {
    id: "afinia-qd330", brand: "Afinia", model: "QD330", driver: "flashforge-tcp",
    bed: { x: 220, y: 220, z: 220 }, origin: "center", nozzleMm: 0.4, filamentMm: 1.75,
    gcodeFlavor: "flashforge", fileFormat: "gx", maxSpeedMmS: 600, heatedBed: true, enclosure: true,
    autoLevel: { gcode: "G29" }, maxNozzleC: 250, maxBedC: 100,
    setupDoc: "docs/printers/afinia.md", verified: "tested",
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
