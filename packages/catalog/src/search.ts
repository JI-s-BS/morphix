// Catalog helpers for the setup page: text search, filter by driver, and the bed-size override
// for the Generic models (the user types their own printer's size).
import type { DriverId } from "@morphix/printer";
import type { PrinterModel } from "./types";
import { PRINTERS } from "./printers";

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Every way a user might type this printer: "Ender-3 V2", "ender3v2", "creality", "moonraker" ... */
function haystack(p: PrinterModel): string {
  const text = words([p.id, p.brand, p.model, p.driver, ...(p.altDrivers ?? [])].join(" "));
  return `${text} ${text.replace(/ /g, "")}`;
}

/**
 * Finds printers whose brand, model, id or driver contain every word of `query` (case and
 * punctuation ignored, so "ender3 v2" finds "Ender-3 V2"). Exact id or model matches come first.
 * An empty query returns the whole catalog.
 */
export function searchPrinters(query: string, list: readonly PrinterModel[] = PRINTERS): PrinterModel[] {
  const q = words(query);
  if (!q) return [...list];
  const tokens = q.split(" ");
  const score = (p: PrinterModel): number => {
    const h = haystack(p);
    if (!tokens.every((t) => h.includes(t))) return -1;
    const model = words(p.model), brandModel = words(`${p.brand} ${p.model}`);
    if (words(p.id) === q || model === q || brandModel === q) return 3;
    if (model.startsWith(q) || brandModel.startsWith(q)) return 2;
    return 1;
  };
  return list
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.p.brand.localeCompare(b.p.brand) || a.p.model.localeCompare(b.p.model))
    .map((x) => x.p);
}

/** Printers that use `driver`; with `includeAlt` (default) also those listing it in altDrivers. */
export function printersByDriver(
  driver: DriverId,
  opts: { includeAlt?: boolean } = {},
  list: readonly PrinterModel[] = PRINTERS,
): PrinterModel[] {
  const alt = opts.includeAlt ?? true;
  return list.filter((p) => p.driver === driver || (alt && (p.altDrivers ?? []).includes(driver)));
}

/** Brand names, sorted, with "Generic" last. */
export function brands(list: readonly PrinterModel[] = PRINTERS): string[] {
  const b = [...new Set(list.map((p) => p.brand))].filter((x) => x !== "Generic").sort((a, c) => a.localeCompare(c));
  return list.some((p) => p.brand === "Generic") ? [...b, "Generic"] : b;
}

export function isGeneric(p: PrinterModel): boolean {
  return p.brand === "Generic";
}

export interface BedOverride {
  x?: number;
  y?: number;
  z?: number;
  shape?: "rect" | "circle";
  /** Defaults to "center" for a round bed (deltas) and "corner" for a rectangle. */
  origin?: "corner" | "center";
}

/** Smallest and largest build size (mm) the setup page accepts. */
export const BED_LIMITS = { min: 50, max: 2000 } as const;

/**
 * Returns a copy of a Generic model with the user's own bed size. Only Generic models can be
 * changed: a named model's size comes from the maker. Throws RangeError with a plain reason.
 */
export function withBedOverride(model: PrinterModel, o: BedOverride): PrinterModel {
  if (!isGeneric(model)) {
    throw new RangeError(`${model.brand} ${model.model} has a fixed build size. Pick a Generic printer to enter your own.`);
  }
  const shape = o.shape ?? model.bed.shape ?? "rect";
  const bed = { x: o.x ?? model.bed.x, y: o.y ?? model.bed.y, z: o.z ?? model.bed.z };
  for (const [axis, v] of Object.entries(bed)) {
    if (!Number.isFinite(v) || v < BED_LIMITS.min || v > BED_LIMITS.max) {
      throw new RangeError(`Build size ${axis.toUpperCase()} must be between ${BED_LIMITS.min} and ${BED_LIMITS.max} mm.`);
    }
  }
  if (shape === "circle") {
    // A round bed is given by its diameter: one number for X and Y.
    const d = o.x ?? o.y ?? bed.x;
    bed.x = d;
    bed.y = d;
  }
  const origin = o.origin ?? (shape === "circle" ? "center" : "corner");
  if (shape === "circle" && origin !== "center") {
    throw new RangeError("A round bed (delta printer) has (0,0) in the middle: origin must be center.");
  }
  return { ...model, bed: { ...bed, shape }, origin };
}
