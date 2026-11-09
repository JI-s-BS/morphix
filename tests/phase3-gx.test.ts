import { describe, expect, it } from "vitest";
import {
  compareGxHeaders,
  decodeBmp24,
  encodeBmp24,
  GX_BMP_SIZE,
  GX_GCODE_OFFSET,
  GX_LAYOUT_VERIFIED,
  gxFromGcode,
  gxThumbnailBmp,
  readGx,
  renderThumbnail,
  validateGx,
  writeGx,
} from "@morphix/slicing";
import { box, PRUSA_GCODE } from "./phase3-fixtures";

const sample = () =>
  writeGx({
    gcode: PRUSA_GCODE,
    thumbnailBmp: gxThumbnailBmp(box(10, 10, 20)),
    printTimeS: 3723,
    filamentMm: 1234.56,
    layerHeightMm: 0.2,
    shells: 2,
    printSpeedMmS: 60,
    bedTempC: 60,
    extruderTempC: 210,
  });

describe(".gx writer (community xgcode 1.0 layout, UNVERIFIED for Afinia)", () => {
  it("is flagged unverified", () => {
    expect(GX_LAYOUT_VERIFIED).toBe(false);
  });

  it("writes the documented byte layout", () => {
    const gx = sample();
    expect(GX_BMP_SIZE).toBe(14454);
    expect(GX_GCODE_OFFSET).toBe(14512);
    expect(gx.subarray(0, 12).toString("latin1")).toBe("xgcode 1.0\n\0");
    expect(gx.readUInt32LE(0x0c)).toBe(0);
    expect(gx.readUInt32LE(0x10)).toBe(58);
    expect(gx.readUInt32LE(0x14)).toBe(14512);
    expect(gx.readUInt32LE(0x18)).toBe(14512);
    expect(gx.readUInt32LE(0x1c)).toBe(3723);
    expect(gx.readUInt32LE(0x20)).toBe(1235);
    expect(gx.readUInt32LE(0x24)).toBe(0);
    expect(gx.readUInt16LE(0x28)).toBe(11);
    expect(gx.readUInt16LE(0x2a)).toBe(200);
    expect(gx.readUInt16LE(0x2e)).toBe(2);
    expect(gx.readUInt16LE(0x30)).toBe(60);
    expect(gx.readUInt16LE(0x32)).toBe(60);
    expect(gx.readUInt16LE(0x34)).toBe(210);
    expect(gx.readUInt16LE(0x38)).toBe(1);
    expect(gx.subarray(58, 60).toString("latin1")).toBe("BM");
    expect(gx.subarray(14512).toString("utf8")).toBe(PRUSA_GCODE);
    expect(gx.length).toBe(14512 + Buffer.byteLength(PRUSA_GCODE));
  });

  it("round-trips through the reader", () => {
    const f = readGx(sample());
    expect(f.header).toMatchObject({ printTimeS: 3723, filamentMm: 1235, layerHeightUm: 200, shells: 2, bedTempC: 60, extruderTempC: 210, multiExtruderType: 11 });
    expect(f.thumbnailBmp.length).toBe(14454);
    expect(f.gcode.toString("utf8")).toBe(PRUSA_GCODE);
    const bmp = decodeBmp24(f.thumbnailBmp);
    expect([bmp.width, bmp.height, bmp.bitsPerPixel]).toEqual([80, 60, 24]);
  });

  it("validates good files and rejects broken ones", () => {
    const v = validateGx(sample());
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(v.thumbnail).toEqual({ width: 80, height: 60, bitsPerPixel: 24 });
    expect(v.layoutVerifiedAgainstAfinia).toBe(false);

    const badMagic = Buffer.from(sample());
    badMagic.write("ygcode", 0, "latin1");
    expect(validateGx(badMagic).ok).toBe(false);

    const badOffsets = Buffer.from(sample());
    badOffsets.writeUInt32LE(14000, 0x18);
    expect(validateGx(badOffsets).errors.join()).toMatch(/offsets disagree/);

    const noGcode = Buffer.from(sample()).subarray(0, 14512);
    expect(validateGx(noGcode).errors.join()).toMatch(/no G-code/);

    expect(validateGx(Buffer.from("short")).ok).toBe(false);
  });

  it("refuses to write empty G-code", () => {
    expect(() => writeGx({ gcode: "", printTimeS: 0, filamentMm: 0, layerHeightMm: 0.2, bedTempC: 60, extruderTempC: 210 })).toThrow(/empty/);
  });

  it("builds the header from slicer G-code", () => {
    const f = readGx(gxFromGcode(PRUSA_GCODE, gxThumbnailBmp(null)));
    expect(f.header).toMatchObject({ printTimeS: 3723, filamentMm: 1235, layerHeightUm: 200, bedTempC: 60, extruderTempC: 210 });
  });

  it("compares headers with a reference file", () => {
    const ours = sample();
    expect(compareGxHeaders(ours, ours)).toMatchObject({ structuralMatch: true, diffs: [] });
    const ref = Buffer.from(ours);
    ref.writeUInt16LE(5, 0x28); // different multi-extruder type -> structural mismatch
    ref.writeUInt32LE(99, 0x1c); // different print time -> job difference
    const c = compareGxHeaders(ours, ref);
    expect(c.structuralMatch).toBe(false);
    expect(c.diffs.map((d) => [d.field, d.kind])).toEqual([
      ["printTimeS", "job"],
      ["multiExtruderType", "structural"],
    ]);
    expect(c.referenceGcodeHead).toContain("PrusaSlicer");
  });
});

describe("thumbnail", () => {
  it("round-trips BMP pixels", () => {
    const rgb = new Uint8Array(80 * 60 * 3).map((_, i) => i % 251);
    const back = decodeBmp24(encodeBmp24(80, 60, rgb));
    expect(Array.from(back.rgb)).toEqual(Array.from(rgb));
  });

  it("renders the model in grey on white", () => {
    const rgb = renderThumbnail(box(10, 10, 20));
    const grey = rgb.filter((v, i) => i % 3 === 0 && v < 255).length;
    expect(grey).toBeGreaterThan(400);
    expect(rgb[0]).toBe(255); // corner stays background
  });
});
