import { describe, expect, it } from "vitest";
import {
  BED_LIMITS, PRINTERS, brands, findPrinter, isGeneric, printersByDriver, searchPrinters, withBedOverride,
} from "@morphix/catalog";

const ids = (list: { id: string }[]) => list.map((p) => p.id);

describe("searchPrinters", () => {
  it("returns everything for an empty query", () => {
    expect(searchPrinters("  ")).toHaveLength(PRINTERS.length);
  });

  it("ignores case and punctuation", () => {
    expect(ids(searchPrinters("ender3 v2"))).toContain("creality-ender-3-v2");
    expect(ids(searchPrinters("ENDER-3 V2"))).toContain("creality-ender-3-v2");
    expect(ids(searchPrinters("x1c"))).toEqual(["bambu-x1c"]);
  });

  it("needs every word to match", () => {
    const r = searchPrinters("prusa mk4");
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((p) => p.brand === "Prusa" && p.model.includes("MK4"))).toBe(true);
    expect(searchPrinters("prusa kobra")).toEqual([]);
  });

  it("puts exact model matches first", () => {
    expect(searchPrinters("K1")[0].id).toBe("creality-k1");
    expect(searchPrinters("bambu lab p1s")[0].id).toBe("bambu-p1s");
  });

  it("finds by brand and by driver name", () => {
    expect(searchPrinters("qidi").every((p) => p.brand === "QIDI")).toBe(true);
    expect(searchPrinters("bambu-lan").length).toBe(PRINTERS.filter((p) => p.driver === "bambu-lan").length);
  });

  it("searches a given list", () => {
    const list = [findPrinter("voron-0-2")!];
    expect(searchPrinters("voron", list)).toEqual(list);
  });
});

describe("printersByDriver", () => {
  it("includes alt drivers by default", () => {
    const moon = ids(printersByDriver("moonraker"));
    expect(moon).toContain("voron-2-4-300");
    expect(moon).toContain("creality-k1"); // altDrivers
    expect(ids(printersByDriver("moonraker", { includeAlt: false }))).not.toContain("creality-k1");
  });

  it("returns only matching printers", () => {
    for (const p of printersByDriver("prusalink")) expect(p.driver).toBe("prusalink");
    expect(ids(printersByDriver("flashforge-tcp"))).toContain("afinia-qd330");
  });
});

describe("brands", () => {
  it("is sorted with Generic last", () => {
    const b = brands();
    expect(b[b.length - 1]).toBe("Generic");
    const rest = b.slice(0, -1);
    expect(rest).toEqual([...rest].sort((x, y) => x.localeCompare(y)));
    expect(new Set(b).size).toBe(b.length);
  });
});

describe("withBedOverride", () => {
  const marlin = findPrinter("generic-marlin")!;
  const klipper = findPrinter("generic-klipper")!;

  it("changes only the bed of a generic model and leaves the catalog alone", () => {
    const m = withBedOverride(marlin, { x: 300, y: 300, z: 400 });
    expect(m.bed).toEqual({ x: 300, y: 300, z: 400, shape: "rect" });
    expect(m.origin).toBe("corner");
    expect(m.driver).toBe(marlin.driver);
    expect(findPrinter("generic-marlin")!.bed).toEqual({ x: 220, y: 220, z: 250 });
  });

  it("keeps axes not given", () => {
    expect(withBedOverride(marlin, { z: 180 }).bed).toMatchObject({ x: 220, y: 220, z: 180 });
  });

  it("a round bed uses one diameter and the center origin", () => {
    const d = withBedOverride(klipper, { shape: "circle", x: 260, z: 330 });
    expect(d.bed).toEqual({ x: 260, y: 260, z: 330, shape: "circle" });
    expect(d.origin).toBe("center");
    expect(() => withBedOverride(klipper, { shape: "circle", x: 260, origin: "corner" })).toThrow(/center/);
  });

  it("allows a center origin on a rectangle (e.g. a FlashForge-style machine)", () => {
    expect(withBedOverride(marlin, { origin: "center" }).origin).toBe("center");
  });

  it("rejects sizes outside the limits with a plain reason", () => {
    expect(() => withBedOverride(marlin, { x: BED_LIMITS.min - 1 })).toThrow(/between 50 and 2000 mm/);
    expect(() => withBedOverride(marlin, { y: BED_LIMITS.max + 1 })).toThrow(RangeError);
    expect(() => withBedOverride(marlin, { z: Number.NaN })).toThrow(RangeError);
  });

  it("refuses to change a named model", () => {
    const p = findPrinter("prusa-mk4")!;
    expect(isGeneric(p)).toBe(false);
    expect(() => withBedOverride(p, { x: 300 })).toThrow(/fixed build size/);
  });
});
