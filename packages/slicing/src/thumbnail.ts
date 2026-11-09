// 24-bit BMP encode/decode and a tiny software renderer for the 80x60 .gx thumbnail.
import { computeBounds, triangleCount, type Mesh } from "./mesh";

export const GX_THUMB_WIDTH = 80;
export const GX_THUMB_HEIGHT = 60;

/** Encodes RGB pixels (top-down rows, 3 bytes per pixel) as an uncompressed bottom-up 24-bit BMP. */
export function encodeBmp24(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const imageSize = stride * height;
  const buf = Buffer.alloc(54 + imageSize);
  buf.write("BM", 0, "latin1");
  buf.writeUInt32LE(54 + imageSize, 2);
  buf.writeUInt32LE(54, 10); // pixel data offset
  buf.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // positive = bottom-up
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30); // BI_RGB
  buf.writeUInt32LE(imageSize, 34);
  buf.writeInt32LE(3779, 38); // 96 dpi, matching community sample thumbnails
  buf.writeInt32LE(3779, 42);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      buf[row + x * 3] = rgb[s + 2]; // BGR
      buf[row + x * 3 + 1] = rgb[s + 1];
      buf[row + x * 3 + 2] = rgb[s];
    }
  }
  return buf;
}

export interface DecodedBmp {
  width: number;
  height: number;
  bitsPerPixel: number;
  /** Top-down RGB rows. */
  rgb: Uint8Array;
}

/** Decodes an uncompressed 24-bit BMP (the only kind .gx thumbnails use). */
export function decodeBmp24(buf: Uint8Array): DecodedBmp {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 54 || b.toString("latin1", 0, 2) !== "BM") throw new Error("not a BMP");
  const offset = b.readUInt32LE(10);
  const width = b.readInt32LE(18);
  const rawH = b.readInt32LE(22);
  const bpp = b.readUInt16LE(28);
  const compression = b.readUInt32LE(30);
  if (bpp !== 24 || compression !== 0) throw new Error(`unsupported BMP (${bpp} bpp, compression ${compression})`);
  const height = Math.abs(rawH);
  const stride = Math.ceil((width * 3) / 4) * 4;
  if (offset + stride * height > b.length) throw new Error("BMP pixel data truncated");
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = offset + (rawH > 0 ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 3;
      rgb[d] = b[row + x * 3 + 2];
      rgb[d + 1] = b[row + x * 3 + 1];
      rgb[d + 2] = b[row + x * 3];
    }
  }
  return { width, height, bitsPerPixel: bpp, rgb };
}

/**
 * Renders a grey-shaded isometric view of the mesh (z-buffered, Lambert lighting).
 * Grey-on-white mirrors what community .gx writers produce; FlashPrint's exact style is unknown.
 */
export function renderThumbnail(mesh: Mesh, width = GX_THUMB_WIDTH, height = GX_THUMB_HEIGHT): Uint8Array {
  const rgb = new Uint8Array(width * height * 3).fill(255);
  const n = triangleCount(mesh);
  if (n === 0) return rgb;
  // View: azimuth 45 deg, elevation 30 deg, looking at the model centre.
  const az = Math.PI / 4, el = Math.PI / 6;
  const right = [Math.cos(az), -Math.sin(az), 0];
  const fwd = [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), -Math.sin(el)]; // into screen
  const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  const b = computeBounds(mesh);
  const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2, cz = (b.min.z + b.max.z) / 2;
  const p = mesh.positions;
  const nv = p.length / 3;
  const sx = new Float32Array(nv), sy = new Float32Array(nv), sz = new Float32Array(nv);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < nv; i++) {
    const x = p[i * 3] - cx, y = p[i * 3 + 1] - cy, z = p[i * 3 + 2] - cz;
    sx[i] = x * right[0] + y * right[1] + z * right[2];
    sy[i] = x * up[0] + y * up[1] + z * up[2];
    sz[i] = x * fwd[0] + y * fwd[1] + z * fwd[2];
    minX = Math.min(minX, sx[i]); maxX = Math.max(maxX, sx[i]);
    minY = Math.min(minY, sy[i]); maxY = Math.max(maxY, sy[i]);
  }
  const margin = 4;
  const scale = Math.min((width - 2 * margin) / (maxX - minX || 1), (height - 2 * margin) / (maxY - minY || 1));
  const ox = width / 2 - ((minX + maxX) / 2) * scale;
  const oy = height / 2 + ((minY + maxY) / 2) * scale;
  const px = (i: number) => ox + sx[i] * scale;
  const py = (i: number) => oy - sy[i] * scale;
  const depth = new Float32Array(width * height).fill(Infinity);
  const light = norm([-0.4, -0.6, 1]);
  const idx = mesh.indices;
  for (let t = 0; t < n; t++) {
    const a = idx[t * 3], c1 = idx[t * 3 + 1], c2 = idx[t * 3 + 2];
    const ux = p[c1 * 3] - p[a * 3], uy = p[c1 * 3 + 1] - p[a * 3 + 1], uz = p[c1 * 3 + 2] - p[a * 3 + 2];
    const vx = p[c2 * 3] - p[a * 3], vy = p[c2 * 3 + 1] - p[a * 3 + 1], vz = p[c2 * 3 + 2] - p[a * 3 + 2];
    const nrm = norm([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
    const shade = Math.round(70 + 150 * Math.abs(nrm[0] * light[0] + nrm[1] * light[1] + nrm[2] * light[2]));
    const x0 = px(a), y0 = py(a), x1 = px(c1), y1 = py(c1), x2 = px(c2), y2 = py(c2);
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area === 0) continue;
    const bx0 = Math.max(0, Math.floor(Math.min(x0, x1, x2))), bx1 = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)));
    const by0 = Math.max(0, Math.floor(Math.min(y0, y1, y2))), by1 = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)));
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const qx = x + 0.5, qy = y + 0.5;
        const w0 = ((x1 - qx) * (y2 - qy) - (x2 - qx) * (y1 - qy)) / area;
        const w1 = ((x2 - qx) * (y0 - qy) - (x0 - qx) * (y2 - qy)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * sz[a] + w1 * sz[c1] + w2 * sz[c2];
        const k = y * width + x;
        if (d >= depth[k]) continue;
        depth[k] = d;
        rgb[k * 3] = rgb[k * 3 + 1] = rgb[k * 3 + 2] = shade;
      }
    }
  }
  return rgb;
}

/** 80x60 24-bit grey BMP for the .gx container (always 14454 bytes). */
export function gxThumbnailBmp(mesh: Mesh | null): Buffer {
  const rgb = mesh ? renderThumbnail(mesh) : new Uint8Array(GX_THUMB_WIDTH * GX_THUMB_HEIGHT * 3).fill(255);
  return encodeBmp24(GX_THUMB_WIDTH, GX_THUMB_HEIGHT, rgb);
}

function norm(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
