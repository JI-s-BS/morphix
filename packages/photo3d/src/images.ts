// Photo input handling: type sniffing, size limits, data URIs, measurement units.
import { Photo3dError } from "./errors";

export interface PhotoInput {
  /** Declared MIME type; the bytes are sniffed and win when they disagree. */
  mime: string;
  bytes: Uint8Array;
}

export type ImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/heif";

/** Meshy accepts JPG/PNG/WebP only (max 20 MB each). Gemini also reads HEIC/HEIF. */
export const MESHY_IMAGE_MIMES: readonly ImageMime[] = ["image/jpeg", "image/png", "image/webp"];
export const MAX_PHOTOS = 8;
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
/** Gemini inline requests are limited to ~20 MB in total; base64 adds a third. */
export const MAX_INLINE_TOTAL_BYTES = 14 * 1024 * 1024;

export function sniffImageMime(b: Uint8Array): ImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    if (/^(heic|heix|hevc|hevx|heim|heis)$/.test(brand)) return "image/heic";
    if (/^(mif1|msf1)$/.test(brand)) return "image/heif";
  }
  return null;
}

function ascii(b: Uint8Array, s: number, e: number): string {
  return String.fromCharCode(...b.subarray(s, e));
}

export interface CheckedPhoto {
  mime: ImageMime;
  bytes: Uint8Array;
}

/** Validates photos (type, count, size). Throws MX-P3D-001 / MX-P3D-002. */
export function checkPhotos(images: PhotoInput[] | undefined, opts: { allowEmpty?: boolean } = {}): CheckedPhoto[] {
  const list = images ?? [];
  if (list.length === 0 && !opts.allowEmpty) throw new Photo3dError("MX-P3D-001", "At least one photo is needed.");
  if (list.length > MAX_PHOTOS) throw new Photo3dError("MX-P3D-001", `At most ${MAX_PHOTOS} photos can be used (got ${list.length}).`);
  let total = 0;
  const out = list.map((img, i) => {
    const bytes = img?.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Photo3dError("MX-P3D-001", `Photo ${i + 1} is empty.`);
    const mime = sniffImageMime(bytes);
    if (!mime) throw new Photo3dError("MX-P3D-001", `Photo ${i + 1} is not a JPEG, PNG, WebP or HEIC image (declared ${img.mime || "no type"}).`);
    if (bytes.length > MAX_PHOTO_BYTES) throw new Photo3dError("MX-P3D-002", `Photo ${i + 1} is ${(bytes.length / 1048576).toFixed(1)} MB (max 20 MB).`);
    total += bytes.length;
    return { mime, bytes };
  });
  if (total > MAX_INLINE_TOTAL_BYTES) {
    throw new Photo3dError("MX-P3D-002", `The photos total ${(total / 1048576).toFixed(1)} MB; keep them under 14 MB together (resize to ~2000 px).`);
  }
  return out;
}

export function toBase64(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64");
}

export function toDataUri(img: CheckedPhoto): string {
  return `data:${img.mime};base64,${toBase64(img.bytes)}`;
}

// ------------------------------------------------------------------ units

export type LengthUnit = "mm" | "cm" | "m" | "in" | "ft";

export interface Measurement {
  /** What was measured, in the user's words ("height", "hole diameter", "slot width"). */
  label: string;
  value: number;
  unit: LengthUnit | string;
}

const MM_PER: Record<LengthUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

export function normalizeUnit(u: string): LengthUnit | null {
  const s = u.trim().toLowerCase().replace(/\.$/, "");
  if (["mm", "millimeter", "millimeters", "millimetre", "millimetres"].includes(s)) return "mm";
  if (["cm", "centimeter", "centimeters", "centimetre", "centimetres"].includes(s)) return "cm";
  if (["m", "meter", "meters", "metre", "metres"].includes(s)) return "m";
  if (["in", "inch", "inches", '"'].includes(s)) return "in";
  if (["ft", "foot", "feet", "'"].includes(s)) return "ft";
  return null;
}

export function toMm(value: number, unit: string): number | null {
  const u = normalizeUnit(unit);
  return u && Number.isFinite(value) ? value * MM_PER[u] : null;
}

export type Axis = "width" | "depth" | "height";

/** Maps a measurement label to an overall dimension, or null for a feature measurement. */
export function overallAxisOf(label: string): Axis | null {
  const s = label.trim().toLowerCase().replace(/^(overall|total|outer|outside)\s+/, "");
  if (/^(width|wide|x)$/.test(s)) return "width";
  if (/^(depth|deep|length|long|y)$/.test(s)) return "depth";
  if (/^(height|tall|high|z)$/.test(s)) return "height";
  return null;
}

// ------------------------------------------------------------------ metadata

/**
 * Removes EXIF/XMP (APP1), IPTC (APP13) and comment segments from a JPEG so no
 * location or camera data leaves this machine. ICC (APP2) and Adobe (APP14) are kept
 * because they affect colours. Anything that is not a well-formed JPEG is
 * returned unchanged (PNG/WebP from the phone are canvas output without EXIF).
 */
export function stripJpegMetadata(b: Uint8Array): Uint8Array {
  if (sniffImageMime(b) !== "image/jpeg") return b;
  const keep: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return b;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xda) { keep.push(b.subarray(i)); return concat(keep); } // start of scan: rest is image data
    if (marker === 0xd9) { keep.push(b.subarray(i, i + 2)); return concat(keep); }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { keep.push(b.subarray(i, i + 2)); i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return b;
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) keep.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
