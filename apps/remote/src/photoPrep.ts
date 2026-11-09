// Phone-side photo preparation for "Photo to 3D": apply the camera rotation, shrink to
// <= 1600 px, re-encode as JPEG (which drops EXIF, including GPS) and keep the whole
// upload under Vercel's ~4.5 MB request limit. Pure helpers are exported for tests.

/** Must stay in line with PHOTO_LIMITS in packages/remote. */
export const PHONE_PHOTO_LIMITS = {
  maxPhotos: 4,
  maxSide: 1600,
  /** Per photo, decoded bytes. */
  maxPhotoBytes: 2_400_000,
  /** All photos together as base64 (the JSON body adds a little on top; the Pi allows 4.4 MB). */
  maxTotalBase64: 4_000_000,
} as const;

/** Encoding steps tried in order until the photos fit the budget. */
export const ENCODE_STEPS: readonly { maxSide: number; quality: number }[] = [
  { maxSide: 1600, quality: 0.85 },
  { maxSide: 1600, quality: 0.72 },
  { maxSide: 1280, quality: 0.7 },
  { maxSide: 1024, quality: 0.65 },
];

export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  if (!(width > 0 && height > 0)) return { width: 0, height: 0 };
  const s = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

export const base64Length = (bytes: number) => 4 * Math.ceil(bytes / 3);

/** True when these encoded sizes can be uploaded in one request. */
export function fitsBudget(sizes: number[]): boolean {
  return (
    sizes.length > 0 &&
    sizes.length <= PHONE_PHOTO_LIMITS.maxPhotos &&
    sizes.every((n) => n > 0 && n <= PHONE_PHOTO_LIMITS.maxPhotoBytes) &&
    sizes.reduce((t, n) => t + base64Length(n), 0) <= PHONE_PHOTO_LIMITS.maxTotalBase64
  );
}

export interface PreparedPhoto {
  id: string;
  name: string;
  /** The original file, kept so it can be re-encoded smaller if the set is too big. */
  file: File;
  blob: Blob;
  url: string;
  width: number;
  height: number;
}

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch { /* fall back to <img>, e.g. HEIC on Safari */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(`Couldn't read “${file.name || "this photo"}”. Try a JPEG or PNG photo.`);
  }
}

/** Draws the photo (upright, white behind transparency) into a JPEG of at most maxSide px. */
export async function encodePhoto(file: File, step = ENCODE_STEPS[0]): Promise<{ blob: Blob; width: number; height: number }> {
  const img = await decode(file);
  try {
    const { width, height } = fitWithin(img.width, img.height, step.maxSide);
    if (!width) throw new Error("This photo is empty.");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("This phone can't prepare photos (no canvas).");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, width, height);
    g.imageSmoothingQuality = "high";
    g.drawImage(img.source, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", step.quality));
    if (!blob) throw new Error("Couldn't prepare this photo.");
    return { blob, width, height };
  } finally {
    img.close();
  }
}

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  const out = await encodePhoto(file);
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: (file.name || "photo.jpg").replace(/\.[^.]+$/, "") + ".jpg", file, url: URL.createObjectURL(out.blob), ...out };
}

/** Re-encodes the set smaller until it fits the upload budget. */
export async function shrinkToBudget(photos: PreparedPhoto[]): Promise<PreparedPhoto[]> {
  if (fitsBudget(photos.map((p) => p.blob.size))) return photos;
  for (const step of ENCODE_STEPS.slice(1)) {
    const next = await Promise.all(photos.map(async (p) => ({ ...p, ...(await encodePhoto(p.file, step)) })));
    if (fitsBudget(next.map((p) => p.blob.size))) {
      photos.forEach((p) => URL.revokeObjectURL(p.url));
      return next.map((p) => ({ ...p, url: URL.createObjectURL(p.blob) }));
    }
  }
  throw new Error("These photos are too big to send together. Use fewer photos.");
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
