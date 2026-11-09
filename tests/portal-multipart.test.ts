import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemorySink,
  MultipartParser,
  MultipartError,
  boundaryFrom,
  cleanFileName,
  cubeStl,
  parseDisposition,
  parseMeasurements,
  parseUploadForm,
  sniffImage,
  sniffScan,
  UPLOAD_LIMITS,
  type PartInfo,
} from "@morphix/portal";

const B = "----MorphixBoundary7MA4YWxk";
const CT = `multipart/form-data; boundary=${B}`;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 1)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(20)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(20)]);

type Part = { name: string; value?: string | Buffer; filename?: string; type?: string; headers?: string };

function body(parts: Part[], { preamble = "", epilogue = "", close = true } = {}): Buffer {
  const chunks: Buffer[] = [Buffer.from(preamble)];
  for (const p of parts) {
    let head = `--${B}\r\n`;
    head += p.headers ?? `Content-Disposition: form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ""}\r\n`;
    if (p.type) head += `Content-Type: ${p.type}\r\n`;
    head += "\r\n";
    chunks.push(Buffer.from(head), Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value ?? ""), Buffer.from("\r\n"));
  }
  if (close) chunks.push(Buffer.from(`--${B}--\r\n${epilogue}`));
  return Buffer.concat(chunks);
}

async function* chunked(buf: Buffer, size: number): AsyncIterable<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

async function collect(buf: Buffer, chunkSize = buf.length, limits?: ConstructorParameters<typeof MultipartParser>[2]) {
  const parts: { info: PartInfo; data: MemorySink }[] = [];
  const parser = new MultipartParser(
    B,
    (info) => {
      const data = new MemorySink(1 << 20);
      parts.push({ info, data });
      return data;
    },
    limits,
  );
  for await (const c of chunked(buf, chunkSize)) await parser.write(c);
  await parser.end();
  return parts.map((p) => ({ ...p.info, data: p.data.buffer.toString("latin1"), done: p.data.done }));
}

describe("multipart parser", () => {
  it("parses fields and files, ignoring preamble and epilogue", async () => {
    const parts = await collect(
      body(
        [
          { name: "description", value: "a red dragon" },
          { name: "images", filename: "cat.jpg", type: "image/jpeg", value: JPEG },
        ],
        { preamble: "This is a preamble\r\n", epilogue: "trailing junk" },
      ),
    );
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ name: "description", data: "a red dragon", done: true });
    expect(parts[0].filename).toBeUndefined();
    expect(parts[1]).toMatchObject({ name: "images", filename: "cat.jpg", contentType: "image/jpeg" });
    expect(Buffer.from(parts[1].data, "latin1").equals(JPEG)).toBe(true);
  });

  it("gives the same result when fed one byte at a time (boundary split across chunks)", async () => {
    const buf = body([
      { name: "a", value: `line\r\n--${B.slice(0, 10)} not a boundary\r\n` },
      { name: "b", filename: "x.bin", value: Buffer.from([0x0d, 0x0a, 0x2d, 0x2d, 0x00, 0xff]) },
    ]);
    const whole = await collect(buf);
    for (const size of [1, 2, 3, 7, 31]) expect(await collect(buf, size)).toEqual(whole);
    expect(whole[0].data).toBe(`line\r\n--${B.slice(0, 10)} not a boundary\r\n`);
  });

  it("handles empty parts and empty file inputs", async () => {
    const parts = await collect(body([{ name: "description", value: "" }, { name: "images", filename: "", type: "application/octet-stream", value: "" }]));
    expect(parts.map((p) => [p.name, p.data, p.filename])).toEqual([
      ["description", "", undefined],
      ["images", "", ""],
    ]);
  });

  it("reads quoted boundaries and escaped / RFC 5987 file names", async () => {
    expect(boundaryFrom(`multipart/form-data; boundary="${B}"`)).toBe(B);
    expect(boundaryFrom(`Multipart/Form-Data; charset=utf-8; boundary=${B}`)).toBe(B);
    expect(parseDisposition('form-data; name="images"; filename="my \\"best\\" toy.jpg"').params).toEqual({ name: "images", filename: 'my "best" toy.jpg' });
    expect(parseDisposition("form-data; name=scan; filename*=UTF-8''dr%C3%A4che.stl; filename=\"fallback.stl\"").params.filename).toBe("dräche.stl");
  });

  it("rejects bad content types and boundaries", () => {
    expect(() => boundaryFrom("application/json")).toThrow(MultipartError);
    expect(() => boundaryFrom("multipart/form-data")).toThrow(/boundary/);
    expect(() => boundaryFrom(`multipart/form-data; boundary=${"x".repeat(71)}`)).toThrow(/boundary/);
  });

  it("fails on a truncated body", async () => {
    const buf = body([{ name: "description", value: "hello" }], { close: false });
    await expect(collect(buf)).rejects.toMatchObject({ code: "truncated", status: 400 });
    await expect(collect(buf.subarray(0, 20))).rejects.toMatchObject({ code: "truncated" });
  });

  it("fails on parts without form-data disposition and on malformed headers", async () => {
    await expect(collect(body([{ name: "x", headers: "Content-Type: text/plain\r\n", value: "v" }]))).rejects.toMatchObject({ code: "malformed" });
    await expect(collect(body([{ name: "x", headers: 'Content-Disposition: attachment; name="x"\r\n', value: "v" }]))).rejects.toMatchObject({ code: "malformed" });
    await expect(collect(body([{ name: "x", headers: "garbage-without-colon\r\n", value: "v" }]))).rejects.toMatchObject({ code: "malformed" });
    await expect(collect(Buffer.from(`--${B}XX\r\n`))).rejects.toMatchObject({ code: "malformed" });
  });

  it("enforces part count, header size and total size limits", async () => {
    const many = body(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, value: "v" })));
    await expect(collect(many, undefined, { maxParts: 4, maxHeaderBytes: 1024, maxTotalBytes: 1 << 20 })).rejects.toMatchObject({ code: "too_many_parts" });
    const bigHeader = body([{ name: "x", headers: `Content-Disposition: form-data; name="x"\r\nX-Pad: ${"a".repeat(2000)}\r\n`, value: "v" }]);
    await expect(collect(bigHeader, 100, { maxParts: 4, maxHeaderBytes: 1024, maxTotalBytes: 1 << 20 })).rejects.toMatchObject({ code: "header_too_large" });
    const big = body([{ name: "x", value: Buffer.alloc(5000) }]);
    await expect(collect(big, 512, { maxParts: 4, maxHeaderBytes: 1024, maxTotalBytes: 4096 })).rejects.toMatchObject({ code: "too_large", status: 413 });
  });

  it("stops a part that grows past its own limit while streaming", async () => {
    const parser = new MultipartParser(B, () => new MemorySink(100, "A photo"));
    const buf = body([{ name: "images", filename: "a.jpg", value: Buffer.alloc(1000) }]);
    let err: unknown;
    let fed = 0;
    try {
      for await (const c of chunked(buf, 64)) {
        fed += c.length;
        await parser.write(c);
      }
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "part_too_large", status: 413 });
    expect(fed).toBeLessThan(buf.length); // aborted before the whole body was read
  });
});

describe("file type sniffing", () => {
  it("detects images by magic bytes", () => {
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(WEBP)).toBe("image/webp");
    expect(sniffImage(HEIC)).toBe("image/heic");
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(Buffer.from("GIF89a......"))).toBeNull();
  });

  it("detects 3D scan formats", () => {
    const tris = 3;
    const binStl = Buffer.alloc(84 + 50 * tris);
    binStl.write("solid but actually binary", 0);
    binStl.writeUInt32LE(tris, 80);
    expect(sniffScan(binStl.subarray(0, 4096), binStl.length)).toBe("stl");
    const ascii = Buffer.from(cubeStl());
    expect(sniffScan(ascii, ascii.length)).toBe("stl");
    const obj = Buffer.from("# Polycam export\nmtllib a.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
    expect(sniffScan(obj, obj.length)).toBe("obj");
    const ply = Buffer.from("ply\nformat binary_little_endian 1.0\nelement vertex 3\n");
    expect(sniffScan(ply, 1000)).toBe("ply");
    const glb = Buffer.alloc(20);
    glb.write("glTF", 0);
    glb.writeUInt32LE(2, 4);
    expect(sniffScan(glb, 20)).toBe("glb");
    expect(sniffScan(Buffer.from("MZ\x90\x00\x03\x00binary"), 12)).toBeNull();
    expect(sniffScan(Buffer.from("hello there, just text"), 22)).toBeNull();
  });
});

describe("upload form", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "portal-upload-"));

  it("parses photos, scan, description, sizes and reference object", async () => {
    const dir = tmp();
    const obj = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
    const form = await parseUploadForm(
      chunked(
        body([
          { name: "images", filename: "../../etc/passwd.jpg", type: "image/png", value: JPEG }, // name & type are not trusted
          { name: "images", filename: "b.png", value: PNG },
          { name: "images", filename: "", value: "" },
          { name: "scan", filename: "room.obj", value: obj },
          { name: "description", value: "  My toy car\r\nas a keychain  " },
          { name: "measurements", value: JSON.stringify([{ label: "Length", value: 7.5, unit: "cm" }]) },
          { name: "referenceObject", value: "credit-card" },
        ]),
        1000,
      ),
      CT,
      dir,
    );
    expect(form.images.map((i) => [i.name, i.mime, i.bytes.length])).toEqual([
      ["passwd.jpg", "image/jpeg", JPEG.length],
      ["b.png", "image/png", PNG.length],
    ]);
    expect(form.description).toBe("My toy car\nas a keychain");
    expect(form.measurements).toEqual([{ label: "Length", value: 7.5, unit: "cm" }]);
    expect(form.referenceObject).toBe("credit-card");
    expect(form.scan).toMatchObject({ name: "room.obj", format: "obj", size: obj.length });
    expect(form.scan!.path.startsWith(dir)).toBe(true);
    expect(form.scan!.path.endsWith(".obj")).toBe(true);
    expect(readFileSync(form.scan!.path, "utf8")).toBe(obj);
  });

  it("allows at most 6 photos", async () => {
    const parts = Array.from({ length: 7 }, (_, i) => ({ name: "images", filename: `${i}.jpg`, value: JPEG }));
    await expect(parseUploadForm(chunked(body(parts), 4096), CT, tmp())).rejects.toMatchObject({ code: "too_many_images", status: 400 });
  });

  it("rejects photos over 15 MB while streaming", async () => {
    const big = Buffer.alloc(UPLOAD_LIMITS.maxImageBytes + 1, 1);
    JPEG.copy(big);
    await expect(parseUploadForm(chunked(body([{ name: "images", filename: "big.jpg", value: big }]), 1 << 16), CT, tmp())).rejects.toMatchObject({ code: "part_too_large", status: 413 });
  });

  it("rejects files that are not really images, whatever the browser says", async () => {
    const svg = Buffer.from("<svg onload=alert(1)>");
    await expect(parseUploadForm(chunked(body([{ name: "images", filename: "x.jpg", type: "image/jpeg", value: svg }]), 99), CT, tmp())).rejects.toMatchObject({ code: "bad_image", status: 415 });
  });

  it("rejects bad scan files and removes the temporary file", async () => {
    const dir = tmp();
    await expect(parseUploadForm(chunked(body([{ name: "scan", filename: "evil.stl", value: Buffer.from([0, 1, 2, 3, 4, 5]) }]), 99), CT, dir)).rejects.toMatchObject({ code: "bad_scan" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("removes the partial scan file when the upload is cut off", async () => {
    const dir = tmp();
    const buf = body([{ name: "scan", filename: "a.obj", value: "v 0 0 0\n".repeat(1000) }], { close: false });
    await expect(parseUploadForm(chunked(buf, 512), CT, dir)).rejects.toMatchObject({ code: "truncated" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("checks description length, sizes, reference object and unexpected fields", async () => {
    const dir = tmp();
    const img = { name: "images", filename: "a.jpg", value: JPEG };
    const run = (parts: Part[]) => parseUploadForm(chunked(body([img, ...parts]), 512), CT, dir);
    await expect(run([{ name: "description", value: "x".repeat(1001) }])).rejects.toMatchObject({ code: "description_too_long" });
    await expect(run([{ name: "description", value: "😀".repeat(1000) }])).resolves.toBeTruthy(); // counts characters, not bytes
    await expect(run([{ name: "referenceObject", value: "banana" }])).rejects.toMatchObject({ code: "bad_reference" });
    await expect(run([{ name: "measurements", value: "{not json" }])).rejects.toMatchObject({ code: "bad_measurements" });
    await expect(run([{ name: "isAdmin", value: "true" }])).rejects.toMatchObject({ code: "unexpected_field" });
    await expect(run([{ name: "avatar", filename: "a.jpg", value: JPEG }])).rejects.toMatchObject({ code: "unexpected_file" });
    await expect(parseUploadForm(chunked(body([{ name: "description", value: "no photos" }]), 512), CT, dir)).rejects.toMatchObject({ code: "no_photos" });
  });

  it("validates measurements", () => {
    expect(parseMeasurements("")).toEqual([]);
    expect(() => parseMeasurements(JSON.stringify([{ label: "", value: 1, unit: "cm" }]))).toThrow();
    expect(() => parseMeasurements(JSON.stringify([{ label: "h", value: -1, unit: "cm" }]))).toThrow();
    expect(() => parseMeasurements(JSON.stringify([{ label: "h", value: 1, unit: "furlong" }]))).toThrow();
    expect(() => parseMeasurements(JSON.stringify(Array.from({ length: 11 }, () => ({ label: "h", value: 1, unit: "mm" }))))).toThrow();
    expect(parseMeasurements(JSON.stringify([{ label: "Height", value: "12", unit: "mm" }]))).toEqual([{ label: "Height", value: 12, unit: "mm" }]);
  });

  it("cleans file names", () => {
    expect(cleanFileName("C:\\Users\\kid\\photo<script>.jpg", "x")).toBe("photo_script_.jpg");
    expect(cleanFileName("...hidden", "x")).toBe("hidden");
    expect(cleanFileName("", "fallback")).toBe("fallback");
  });
});
