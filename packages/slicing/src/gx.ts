// FlashForge "xgcode 1.0" (.gx) container: writer, reader, validator, and a header diff
// for comparing our output with an official Afinia-exported .gx.
//
// !!! UNVERIFIED FOR THE AFINIA QD330 !!!
// The layout below comes from community reverse engineering of FlashForge FlashPrint
// output (Finder/Dreamer era), cross-checked between two independent sources:
//   - ronoaldo/FlashforgeFinderIntegration, plugins/GXWriter/gx.py (Cura plugin, 2020)
//   - the `xgcode` Rust crate (maugier, 2022)
// Both agree on every offset. It has NOT been compared with a file exported by the
// official Afinia slicer. Before any real print, run compareGxHeaders() against one of
// the .gx files already stored on the printer (see docs/QD330.md).
//
// Layout (little-endian):
//   0x00  12 B  magic "xgcode 1.0\n\0"
//   0x0C  u32   0 (unknown, always 0 in known files)
//   0x10  u32   thumbnail offset (58)
//   0x14  u32   G-code offset (58 + BMP size = 14512)
//   0x18  u32   G-code offset again
//   0x1C  u32   print time, s
//   0x20  u32   filament used, right/only extruder, mm
//   0x24  u32   filament used, left extruder, mm
//   0x28  u16   multi-extruder type (11 in community writers; meaning unknown)
//   0x2A  u16   layer height, microns
//   0x2C  u16   reserved (0)
//   0x2E  u16   perimeter shells
//   0x30  u16   print speed, mm/s
//   0x32  u16   bed temperature, C
//   0x34  u16   extruder temperature (right/only), C
//   0x36  u16   extruder temperature (left), C
//   0x38  u16   reserved (1 in the Cura writer, purpose unknown)
//   0x3A        80x60 24-bit BMP (14454 bytes)
//   0x38B0      G-code text to end of file
import { decodeBmp24, GX_THUMB_HEIGHT, GX_THUMB_WIDTH, gxThumbnailBmp } from "./thumbnail";

export const GX_MAGIC = Buffer.from("xgcode 1.0\n\0", "latin1");
export const GX_HEADER_SIZE = 58;
export const GX_BMP_SIZE = 54 + GX_THUMB_WIDTH * GX_THUMB_HEIGHT * 3; // 14454
export const GX_GCODE_OFFSET = GX_HEADER_SIZE + GX_BMP_SIZE; // 14512
export const GX_LAYOUT_VERIFIED = false as const;

export interface GxHeader {
  unknown0C: number;
  thumbnailOffset: number;
  gcodeOffset: number;
  gcodeOffset2: number;
  printTimeS: number;
  filamentMm: number;
  filamentLeftMm: number;
  multiExtruderType: number;
  layerHeightUm: number;
  reserved2C: number;
  shells: number;
  printSpeedMmS: number;
  bedTempC: number;
  extruderTempC: number;
  extruderLeftTempC: number;
  reserved38: number;
}

export interface GxWriteInput {
  gcode: string | Uint8Array;
  /** 80x60 24-bit BMP; a blank white one is used when omitted. */
  thumbnailBmp?: Uint8Array;
  printTimeS: number;
  filamentMm: number;
  filamentLeftMm?: number;
  layerHeightMm: number;
  shells?: number;
  printSpeedMmS?: number;
  bedTempC: number;
  extruderTempC: number;
  extruderLeftTempC?: number;
  /** Default 11 (community writers); compare with an official file. */
  multiExtruderType?: number;
  /** Default 1 (community writers); compare with an official file. */
  reserved38?: number;
}

const u16 = (v: number) => Math.max(0, Math.min(0xffff, Math.round(v)));
const u32 = (v: number) => Math.max(0, Math.min(0xffffffff, Math.round(v)));

export function writeGx(input: GxWriteInput): Buffer {
  const bmp = input.thumbnailBmp ? Buffer.from(input.thumbnailBmp) : gxThumbnailBmp(null);
  const gcode = typeof input.gcode === "string" ? Buffer.from(input.gcode, "utf8") : Buffer.from(input.gcode);
  if (gcode.length === 0) throw new Error("cannot write .gx: G-code is empty");
  const gcodeOffset = GX_HEADER_SIZE + bmp.length;
  const h = Buffer.alloc(GX_HEADER_SIZE);
  GX_MAGIC.copy(h, 0);
  h.writeUInt32LE(0, 0x0c);
  h.writeUInt32LE(GX_HEADER_SIZE, 0x10);
  h.writeUInt32LE(gcodeOffset, 0x14);
  h.writeUInt32LE(gcodeOffset, 0x18);
  h.writeUInt32LE(u32(input.printTimeS), 0x1c);
  h.writeUInt32LE(u32(input.filamentMm), 0x20);
  h.writeUInt32LE(u32(input.filamentLeftMm ?? 0), 0x24);
  h.writeUInt16LE(u16(input.multiExtruderType ?? 11), 0x28);
  h.writeUInt16LE(u16(input.layerHeightMm * 1000), 0x2a);
  h.writeUInt16LE(0, 0x2c);
  h.writeUInt16LE(u16(input.shells ?? 2), 0x2e);
  h.writeUInt16LE(u16(input.printSpeedMmS ?? 60), 0x30);
  h.writeUInt16LE(u16(input.bedTempC), 0x32);
  h.writeUInt16LE(u16(input.extruderTempC), 0x34);
  h.writeUInt16LE(u16(input.extruderLeftTempC ?? 0), 0x36);
  h.writeUInt16LE(u16(input.reserved38 ?? 1), 0x38);
  return Buffer.concat([h, bmp, gcode]);
}

export interface GxFile {
  header: GxHeader;
  thumbnailBmp: Buffer;
  gcode: Buffer;
}

export class GxFormatError extends Error {}

export function isGx(buf: Uint8Array): boolean {
  return buf.length >= GX_MAGIC.length && Buffer.from(buf.buffer, buf.byteOffset, GX_MAGIC.length).equals(GX_MAGIC);
}

/** Reads a .gx using the offsets stored in its header (not the constants), so unusual files still parse. */
export function readGx(buf: Uint8Array): GxFile {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < GX_HEADER_SIZE) throw new GxFormatError("file shorter than the 58-byte .gx header");
  if (!isGx(b)) throw new GxFormatError(`bad magic: ${JSON.stringify(b.toString("latin1", 0, 12))}`);
  const header: GxHeader = {
    unknown0C: b.readUInt32LE(0x0c),
    thumbnailOffset: b.readUInt32LE(0x10),
    gcodeOffset: b.readUInt32LE(0x14),
    gcodeOffset2: b.readUInt32LE(0x18),
    printTimeS: b.readUInt32LE(0x1c),
    filamentMm: b.readUInt32LE(0x20),
    filamentLeftMm: b.readUInt32LE(0x24),
    multiExtruderType: b.readUInt16LE(0x28),
    layerHeightUm: b.readUInt16LE(0x2a),
    reserved2C: b.readUInt16LE(0x2c),
    shells: b.readUInt16LE(0x2e),
    printSpeedMmS: b.readUInt16LE(0x30),
    bedTempC: b.readUInt16LE(0x32),
    extruderTempC: b.readUInt16LE(0x34),
    extruderLeftTempC: b.readUInt16LE(0x36),
    reserved38: b.readUInt16LE(0x38),
  };
  const { thumbnailOffset: to, gcodeOffset: go } = header;
  if (to < GX_HEADER_SIZE || to > b.length) throw new GxFormatError(`thumbnail offset ${to} out of range`);
  if (go < to || go > b.length) throw new GxFormatError(`G-code offset ${go} out of range`);
  return { header, thumbnailBmp: b.subarray(to, go), gcode: b.subarray(go) };
}

export interface GxValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  header: GxHeader | null;
  thumbnail: { width: number; height: number; bitsPerPixel: number } | null;
  gcodeBytes: number;
  /** Always false until the layout is compared with a real Afinia file. */
  layoutVerifiedAgainstAfinia: typeof GX_LAYOUT_VERIFIED;
}

/** Structural validation plus plausibility checks on header values. */
export function validateGx(buf: Uint8Array): GxValidation {
  const errors: string[] = [], warnings: string[] = [];
  let file: GxFile;
  try {
    file = readGx(buf);
  } catch (e) {
    return { ok: false, errors: [(e as Error).message], warnings, header: null, thumbnail: null, gcodeBytes: 0, layoutVerifiedAgainstAfinia: false };
  }
  const h = file.header;
  if (h.thumbnailOffset !== GX_HEADER_SIZE) warnings.push(`thumbnail offset ${h.thumbnailOffset} != 58 (community layout)`);
  if (h.gcodeOffset !== h.gcodeOffset2) errors.push(`G-code offsets disagree (${h.gcodeOffset} vs ${h.gcodeOffset2})`);
  if (h.unknown0C !== 0) warnings.push(`field 0x0C is ${h.unknown0C}, community files have 0`);
  let thumbnail: GxValidation["thumbnail"] = null;
  try {
    const bmp = decodeBmp24(file.thumbnailBmp);
    thumbnail = { width: bmp.width, height: bmp.height, bitsPerPixel: bmp.bitsPerPixel };
    if (bmp.width !== GX_THUMB_WIDTH || bmp.height !== GX_THUMB_HEIGHT) warnings.push(`thumbnail is ${bmp.width}x${bmp.height}, expected 80x60`);
    if (file.thumbnailBmp.length !== GX_BMP_SIZE) warnings.push(`thumbnail section is ${file.thumbnailBmp.length} bytes, expected ${GX_BMP_SIZE}`);
  } catch (e) {
    errors.push(`thumbnail: ${(e as Error).message}`);
  }
  const text = file.gcode.toString("latin1");
  if (file.gcode.length === 0) errors.push("no G-code payload");
  else if (!/^\s*G[01]\s/m.test(text)) errors.push("G-code payload contains no G0/G1 moves");
  if (file.gcode.includes(0)) warnings.push("G-code payload contains NUL bytes");
  if (h.printTimeS === 0) warnings.push("print time is 0");
  if (h.filamentMm === 0 && h.filamentLeftMm === 0) warnings.push("filament usage is 0");
  if (h.layerHeightUm < 50 || h.layerHeightUm > 600) warnings.push(`layer height ${h.layerHeightUm} um looks implausible`);
  if (h.extruderTempC < 150 || h.extruderTempC > 300) warnings.push(`extruder temperature ${h.extruderTempC} C looks implausible`);
  if (h.bedTempC > 120) warnings.push(`bed temperature ${h.bedTempC} C looks implausible`);
  return { ok: errors.length === 0, errors, warnings, header: h, thumbnail, gcodeBytes: file.gcode.length, layoutVerifiedAgainstAfinia: false };
}

export interface GxHeaderDiff {
  field: keyof GxHeader;
  ours: number;
  reference: number;
  /** "structural" fields must match exactly; "job" fields legitimately differ per print. */
  kind: "structural" | "job";
}

const STRUCTURAL: (keyof GxHeader)[] = ["unknown0C", "thumbnailOffset", "gcodeOffset", "gcodeOffset2", "multiExtruderType", "reserved2C", "reserved38"];

/**
 * Compares our header with an official Afinia .gx. Any "structural" difference means the
 * community layout does not match the QD330 and must be investigated before printing.
 */
export function compareGxHeaders(ours: Uint8Array, reference: Uint8Array): { structuralMatch: boolean; diffs: GxHeaderDiff[]; referenceGcodeHead: string } {
  const a = readGx(ours), b = readGx(reference);
  const diffs: GxHeaderDiff[] = [];
  for (const k of Object.keys(a.header) as (keyof GxHeader)[]) {
    if (a.header[k] !== b.header[k]) diffs.push({ field: k, ours: a.header[k], reference: b.header[k], kind: STRUCTURAL.includes(k) ? "structural" : "job" });
  }
  return {
    structuralMatch: !diffs.some((d) => d.kind === "structural"),
    diffs,
    referenceGcodeHead: b.gcode.subarray(0, 2000).toString("latin1"),
  };
}
