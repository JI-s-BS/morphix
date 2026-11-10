import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DriverId } from "@morphix/printer";
import { PRINTERS, UNSUPPORTED_PRINTERS, findPrinter, printersByBrand } from "@morphix/catalog";

// A Record keyed by DriverId: typecheck fails if a driver is added to the contract and not here.
const DRIVER_IDS: Record<DriverId, true> = {
  moonraker: true, octoprint: true, prusalink: true, duet: true,
  "bambu-lan": true, "elegoo-sdcp": true, "creality-k1": true, "flashforge-http": true, "flashforge-tcp": true,
  "marlin-serial": true, ultimaker: true, snapmaker: true,
};
const isDriver = (d: string) => Object.prototype.hasOwnProperty.call(DRIVER_IDS, d);

const root = resolve(__dirname, "..");
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// The only printers whose (0,0) is the middle of the bed: deltas, and FlashForge-firmware machines.
const CENTER_ORIGIN = new Set([
  "afinia-qd330", "flashforge-adventurer-3", "flashforge-adventurer-4", "monoprice-voxel",
  "flsun-v400", "flsun-t1-pro", "flsun-s1", "flsun-super-racer",
]);

describe("printer catalog", () => {
  it("has 60-120 models from at least 20 brands plus Generic", () => {
    expect(PRINTERS.length).toBeGreaterThanOrEqual(60);
    expect(PRINTERS.length).toBeLessThanOrEqual(120);
    const brands = [...printersByBrand().keys()].filter((b) => b !== "Generic");
    expect(brands.length).toBeGreaterThanOrEqual(20);
    for (const id of ["generic-marlin", "generic-klipper", "generic-octoprint"]) expect(findPrinter(id)).toBeDefined();
  });

  it("ids are unique kebab-case and start with the brand", () => {
    const ids = PRINTERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PRINTERS) {
      expect(p.id, p.id).toMatch(KEBAB);
      const brandSlug = p.brand.toLowerCase().replace(/[^a-z0-9]+/g, "-").split("-")[0];
      expect(p.id.startsWith(brandSlug), `${p.id} vs brand ${p.brand}`).toBe(true);
    }
  });

  it("brand + model names are unique", () => {
    const names = PRINTERS.map((p) => `${p.brand}|${p.model}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every driver and alt driver is a real DriverId", () => {
    for (const p of PRINTERS) {
      expect(isDriver(p.driver), `${p.id}: ${p.driver}`).toBe(true);
      for (const d of p.altDrivers ?? []) {
        expect(isDriver(d), `${p.id}: alt ${d}`).toBe(true);
        expect(d, `${p.id}: alt repeats main driver`).not.toBe(p.driver);
      }
    }
  });

  it("bed sizes are plausible", () => {
    for (const p of PRINTERS) {
      const { x, y, z, shape } = p.bed;
      for (const v of [x, y, z]) {
        expect(Number.isFinite(v), p.id).toBe(true);
        expect(v, p.id).toBeGreaterThanOrEqual(80);
        expect(v, p.id).toBeLessThanOrEqual(1000);
      }
      if (shape === "circle") expect(x, `${p.id}: round bed has one diameter`).toBe(y);
    }
  });

  it("temperatures and nozzle are sane", () => {
    for (const p of PRINTERS) {
      expect(p.maxNozzleC, p.id).toBeGreaterThanOrEqual(220);
      expect(p.maxNozzleC, p.id).toBeLessThanOrEqual(400);
      if (p.heatedBed) {
        expect(p.maxBedC, p.id).toBeGreaterThanOrEqual(50);
        expect(p.maxBedC, p.id).toBeLessThanOrEqual(150);
      }
      expect(p.nozzleMm, p.id).toBeGreaterThan(0.1);
      expect(p.nozzleMm, p.id).toBeLessThanOrEqual(1.2);
      if (p.maxSpeedMmS !== undefined) {
        expect(p.maxSpeedMmS, p.id).toBeGreaterThan(50);
        expect(p.maxSpeedMmS, p.id).toBeLessThanOrEqual(1500);
      }
    }
  });

  it("center origin only where it is true, and round beds always use it", () => {
    for (const p of PRINTERS) {
      expect(p.origin === "center", p.id).toBe(CENTER_ORIGIN.has(p.id));
      if (p.bed.shape === "circle") expect(p.origin, p.id).toBe("center");
    }
  });

  it("start G-code never uses a corner purge line on a center-origin printer", () => {
    for (const p of PRINTERS.filter((x) => x.origin === "center")) {
      expect(p.startGcode ?? "", p.id).not.toMatch(/X5 Y20/);
    }
  });

  it("file format and G-code flavor fit the driver", () => {
    for (const p of PRINTERS) {
      if (p.driver === "bambu-lan") expect([p.fileFormat, p.gcodeFlavor], p.id).toEqual(["gcode.3mf", "bambu"]);
      if (p.driver === "flashforge-tcp") expect([p.fileFormat, p.gcodeFlavor], p.id).toEqual(["gx", "flashforge"]);
      if (p.driver === "ultimaker") expect([p.fileFormat, p.filamentMm], p.id).toEqual(["ufp", 2.85]);
      if (p.driver === "duet") expect(p.gcodeFlavor, p.id).toBe("reprapfirmware");
      if (p.driver === "moonraker" || p.driver === "creality-k1") expect(p.gcodeFlavor, p.id).toBe("klipper");
      if (p.fileFormat === "gcode.3mf") expect(p.driver, p.id).toBe("bambu-lan");
    }
  });

  it("auto-level commands match the firmware", () => {
    for (const p of PRINTERS) {
      if (!p.autoLevel) continue;
      if (p.gcodeFlavor === "klipper" && p.driver !== "elegoo-sdcp" && p.driver !== "flashforge-http") {
        expect(p.autoLevel.gcode, p.id).toBe("BED_MESH_CALIBRATE");
      }
      if (p.gcodeFlavor.startsWith("marlin")) expect(["G29", "G80"], p.id).toContain(p.autoLevel.gcode);
    }
  });

  it("Marlin start G-code levels only after the bed is hot", () => {
    for (const p of PRINTERS) {
      const g = p.startGcode ?? "";
      const level = g.search(/^(G29|BED_MESH_CALIBRATE)\b/m);
      if (level < 0) continue;
      const heat = g.search(/^M190 /m);
      expect(heat, p.id).toBeGreaterThanOrEqual(0);
      expect(heat, p.id).toBeLessThan(level);
    }
  });

  it("Marlin printers without a probe do not run G29", () => {
    for (const p of PRINTERS.filter((x) => x.autoLevel === false)) {
      expect(p.startGcode ?? "", p.id).not.toMatch(/^(G29|BED_MESH_CALIBRATE)/m);
    }
  });

  it("only the QD330 is hardware-tested", () => {
    expect(PRINTERS.filter((p) => p.verified === "tested").map((p) => p.id)).toEqual(["afinia-qd330"]);
    const qd = findPrinter("afinia-qd330")!;
    expect(qd).toMatchObject({ driver: "flashforge-tcp", origin: "center", fileFormat: "gx", bed: { x: 220, y: 220, z: 220 } });
  });

  it("every setupDoc exists and names the model", () => {
    for (const p of PRINTERS) {
      expect(p.setupDoc, p.id).toMatch(/^docs\/printers\/[a-z0-9-]+\.md$/);
      const file = resolve(root, p.setupDoc);
      expect(existsSync(file), `${p.id}: ${p.setupDoc}`).toBe(true);
      const text = readFileSync(file, "utf8");
      const firstWord = p.model.split(/[ /(]/)[0];
      expect(text.includes(firstWord), `${p.setupDoc} should mention ${p.model}`).toBe(true);
    }
    for (const u of UNSUPPORTED_PRINTERS) expect(existsSync(resolve(root, u.setupDoc)), u.setupDoc).toBe(true);
  });

  it("the README support table lists every brand and unsupported printer", () => {
    const readme = readFileSync(resolve(root, "docs/printers/README.md"), "utf8");
    for (const brand of printersByBrand().keys()) expect(readme, brand).toContain(brand);
    for (const u of UNSUPPORTED_PRINTERS) expect(readme, u.brand).toContain(u.brand);
    expect(readme).toMatch(/not yet (been )?(hardware-)?tested|not hardware-tested/i);
  });

  it("every guide says plainly whether it was tested on hardware", () => {
    for (const doc of new Set(PRINTERS.map((p) => p.setupDoc))) {
      const text = readFileSync(resolve(root, doc), "utf8");
      if (doc.endsWith("afinia.md")) expect(text, doc).toMatch(/tested/i);
      else expect(text, doc).toMatch(/not (yet )?(been )?(hardware-)?tested/i);
    }
  });
});
