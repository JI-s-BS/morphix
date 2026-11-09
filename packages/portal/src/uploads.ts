// The "Make something" upload form: photos, an optional 3D scan, a description and sizes.
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { FileSink, MemorySink, MultipartError, MultipartParser, boundaryFrom, type PartSink } from "./multipart";
import { sniffImage, sniffScan } from "./sniff";
import { randomToken } from "./session";
import { REFERENCE_OBJECTS, type Measurement, type ReferenceObject, type UploadedImage, type UploadedScan } from "./types";

export interface UploadLimits {
  maxImages: number;
  maxImageBytes: number;
  maxScanBytes: number;
  maxDescriptionChars: number;
  maxMeasurements: number;
}

export const UPLOAD_LIMITS: UploadLimits = {
  maxImages: 6,
  maxImageBytes: 15 * 1024 * 1024,
  maxScanBytes: 100 * 1024 * 1024,
  maxDescriptionChars: 1000,
  maxMeasurements: 10,
};

export function maxUploadBytes(l: UploadLimits = UPLOAD_LIMITS): number {
  return l.maxImages * l.maxImageBytes + l.maxScanBytes + 1024 * 1024; // + form fields and part headers
}

export interface ParsedUpload {
  images: UploadedImage[];
  scan?: UploadedScan;
  description: string;
  measurements: Measurement[];
  referenceObject: ReferenceObject;
}

/** Keep only harmless characters of a client-supplied file name (display only). */
export function cleanFileName(name: string | undefined, fallback: string): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^\p{L}\p{N} ._()-]+/gu, "_").replace(/^\.+/, "").slice(0, 80).trim();
  return clean || fallback;
}

const UNITS = new Set(["mm", "cm", "in"]);

export function parseMeasurements(raw: string, max = UPLOAD_LIMITS.maxMeasurements): Measurement[] {
  if (!raw.trim()) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new MultipartError(400, "bad_measurements", "Sizes could not be read");
  }
  if (!Array.isArray(data) || data.length > max) throw new MultipartError(400, "bad_measurements", `Up to ${max} sizes please`);
  return data.map((m: any) => {
    const label = typeof m?.label === "string" ? m.label.trim().slice(0, 40) : "";
    const value = Number(m?.value);
    const unit = m?.unit;
    if (!label || !Number.isFinite(value) || value <= 0 || value > 10000 || !UNITS.has(unit)) {
      throw new MultipartError(400, "bad_measurements", "Each size needs a name, a number and mm, cm or in");
    }
    return { label, value, unit };
  });
}

/**
 * Parse an upload request body. Images stay in memory (≤ 6 × 15 MB); a scan is streamed
 * to `tmpDir`. On error every temporary file is removed and a MultipartError is thrown.
 */
export async function parseUploadForm(
  body: AsyncIterable<Buffer>,
  contentType: string | undefined,
  tmpDir: string,
  limits: UploadLimits = UPLOAD_LIMITS,
): Promise<ParsedUpload> {
  const boundary = boundaryFrom(contentType);
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const images: { sink: MemorySink; name?: string }[] = [];
  let scan: { sink: FileSink; name?: string } | null = null;
  const fields = new Map<string, MemorySink>();
  const ignore: PartSink = { write() {}, end() {}, abort() {} };

  const parser = new MultipartParser(
    boundary,
    (part) => {
      if (part.filename !== undefined) {
        if (part.name === "images") {
          if (images.length >= limits.maxImages) throw new MultipartError(400, "too_many_images", `Up to ${limits.maxImages} photos please`);
          const sink = new MemorySink(limits.maxImageBytes, "A photo");
          images.push({ sink, name: part.filename });
          return sink;
        }
        if (part.name === "scan") {
          if (scan) throw new MultipartError(400, "too_many_scans", "Only one scan file please");
          const sink = new FileSink(join(tmpDir, `scan-${randomToken(12)}.part`), limits.maxScanBytes, "The scan file");
          scan = { sink, name: part.filename };
          return sink;
        }
        throw new MultipartError(400, "unexpected_file", "Unexpected file in the upload");
      }
      if (!["description", "measurements", "referenceObject"].includes(part.name)) throw new MultipartError(400, "unexpected_field", "Unexpected field in the upload");
      if (fields.has(part.name)) return ignore; // first value wins
      const sink = new MemorySink(8 * 1024, "A text field");
      fields.set(part.name, sink);
      return sink;
    },
    { maxParts: limits.maxImages + 8, maxHeaderBytes: 8 * 1024, maxTotalBytes: maxUploadBytes(limits) },
  );

  const cleanup = () => (scan as { sink: FileSink } | null)?.sink.remove();
  try {
    for await (const chunk of body) await parser.write(chunk);
    await parser.end();

    const text = (k: string) => fields.get(k)?.buffer.toString("utf8") ?? "";
    const description = text("description").replace(/\r\n/g, "\n").trim();
    if ([...description].length > limits.maxDescriptionChars) {
      throw new MultipartError(400, "description_too_long", `Please use at most ${limits.maxDescriptionChars} letters`);
    }
    const measurements = parseMeasurements(text("measurements"), limits.maxMeasurements);
    const refRaw = text("referenceObject").trim() || "none";
    if (!(REFERENCE_OBJECTS as readonly string[]).includes(refRaw)) throw new MultipartError(400, "bad_reference", "Unknown reference object");

    const outImages: UploadedImage[] = [];
    for (const [i, img] of images.entries()) {
      const bytes = img.sink.buffer;
      if (bytes.length === 0) continue; // empty <input type=file> part
      const mime = sniffImage(bytes.subarray(0, 32));
      if (!mime) throw new MultipartError(415, "bad_image", "Photos must be JPEG, PNG, WebP or HEIC");
      outImages.push({ name: cleanFileName(img.name, `photo-${i + 1}`), mime, bytes });
    }

    let outScan: UploadedScan | undefined;
    const s = scan as { sink: FileSink; name?: string } | null;
    if (s && s.sink.size > 0) {
      const format = sniffScan(s.sink.head, s.sink.size);
      if (!format) throw new MultipartError(415, "bad_scan", "Scan files must be OBJ, PLY, STL or GLB");
      const finalPath = s.sink.path.replace(/\.part$/, `.${format}`);
      renameSync(s.sink.path, finalPath);
      s.sink.path = finalPath;
      outScan = { name: cleanFileName(s.name, `scan.${format}`), format, size: s.sink.size, path: finalPath };
    } else s?.sink.remove();

    if (!outImages.length && !outScan) throw new MultipartError(400, "no_photos", "Please add at least one photo or a scan");
    return { images: outImages, scan: outScan, description, measurements, referenceObject: refRaw as ReferenceObject };
  } catch (err) {
    parser.fail();
    cleanup();
    throw err;
  }
}
