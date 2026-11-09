// File type detection from content (magic bytes), never from the browser's Content-Type.
import type { UploadedImage, UploadedScan } from "./types";

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

export function sniffImage(head: Buffer): UploadedImage["mime"] | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp" && HEIF_BRANDS.has(head.toString("latin1", 8, 12))) return "image/heic";
  return null;
}

function looksLikeText(head: Buffer): boolean {
  for (const b of head) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) return false;
  }
  return true;
}

/**
 * Detect a 3D scan format. `head` is the first bytes of the file (4 KiB is plenty),
 * `size` the full file size (needed to recognise binary STL).
 */
export function sniffScan(head: Buffer, size: number): UploadedScan["format"] | null {
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "glTF" && head.readUInt32LE(4) === 2) return "glb";
  if (/^ply\r?\n/.test(head.toString("latin1", 0, 5))) return "ply";
  if (size >= 84 && head.length >= 84 && 84 + 50 * head.readUInt32LE(80) === size) return "stl";
  if (!looksLikeText(head)) return null;
  const text = head.toString("utf8");
  if (/^\s*solid\b/.test(text) && /\bfacet\b|\bendsolid\b/.test(text)) return "stl";
  if (/^(v|vn|vt|f|o|g|mtllib|usemtl)\s/m.test(text)) return "obj";
  return null;
}
