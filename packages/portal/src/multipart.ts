// Small streaming multipart/form-data parser (RFC 7578). Parts are handed to sinks as they
// arrive, so files can go straight to disk and size limits are enforced while reading.
import { createWriteStream, rmSync, type WriteStream } from "node:fs";
import { once } from "node:events";

export class MultipartError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PartInfo {
  name: string;
  /** Present for file parts (may be ""). */
  filename?: string;
  contentType?: string;
}

export interface PartSink {
  write(chunk: Buffer): void | Promise<void>;
  end(): void | Promise<void>;
  abort(): void;
}

export interface MultipartLimits {
  maxParts: number;
  maxHeaderBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_MULTIPART_LIMITS: MultipartLimits = { maxParts: 32, maxHeaderBytes: 8 * 1024, maxTotalBytes: 200 * 1024 * 1024 };

export function boundaryFrom(contentType: string | undefined): string {
  const m = /^multipart\/form-data\s*(?:;(.*))?$/i.exec(contentType ?? "");
  if (!m) throw new MultipartError(415, "not_multipart", "Expected multipart/form-data");
  const b = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(m[1] ?? "");
  const boundary = b?.[1] ?? b?.[2];
  if (!boundary || boundary.length > 70 || !/^[0-9A-Za-z'()+_,\-./:=? ]+$/.test(boundary)) {
    throw new MultipartError(400, "bad_boundary", "Missing or invalid multipart boundary");
  }
  return boundary;
}

/** Parse `form-data; name="a"; filename="b.jpg"` (quoted strings with \-escapes, filename*=UTF-8''...). */
export function parseDisposition(value: string): { type: string; params: Record<string, string> } {
  const semi = value.indexOf(";");
  const type = (semi < 0 ? value : value.slice(0, semi)).trim().toLowerCase();
  const params: Record<string, string> = {};
  const re = /;\s*([^=;\s]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const key = m[1].toLowerCase();
    let v = m[2].trim();
    if (v.startsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    if (key.endsWith("*")) {
      const ext = /^utf-8'[^']*'(.*)$/i.exec(v);
      if (ext) {
        try {
          params[key.slice(0, -1)] = decodeURIComponent(ext[1]);
        } catch {
          /* ignore bad encoding */
        }
      }
      continue;
    }
    if (!(key in params)) params[key] = v;
  }
  return { type, params };
}

type State = "preamble" | "after-delimiter" | "headers" | "body" | "done";
const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

export class MultipartParser {
  private readonly delim: Buffer;
  private buf: Buffer = Buffer.from("\r\n"); // lets the first delimiter look like every other one
  private state: State = "preamble";
  private sink: PartSink | null = null;
  private parts = 0;
  private total = 0;
  private failed = false;

  constructor(
    boundary: string,
    private readonly onPart: (info: PartInfo) => PartSink,
    private readonly limits: MultipartLimits = DEFAULT_MULTIPART_LIMITS,
  ) {
    this.delim = Buffer.from(`\r\n--${boundary}`);
  }

  get finished(): boolean {
    return this.state === "done";
  }

  async write(chunk: Buffer): Promise<void> {
    if (this.failed) return;
    this.total += chunk.length;
    try {
      if (this.total > this.limits.maxTotalBytes) throw new MultipartError(413, "too_large", "The upload is too big");
      if (this.state === "done") return; // epilogue is ignored
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      await this.process();
    } catch (err) {
      this.fail();
      throw err;
    }
  }

  /** Call after the last chunk. Throws if the body ended early. */
  async end(): Promise<void> {
    if (this.failed) return;
    if (this.state !== "done") {
      this.fail();
      throw new MultipartError(400, "truncated", "The upload ended too early");
    }
  }

  /** Abort the current part (e.g. the client went away). */
  fail(): void {
    this.failed = true;
    this.sink?.abort();
    this.sink = null;
  }

  private async process(): Promise<void> {
    for (;;) {
      switch (this.state) {
        case "preamble": {
          const idx = this.buf.indexOf(this.delim);
          if (idx < 0) {
            this.buf = this.buf.subarray(Math.max(0, this.buf.length - (this.delim.length - 1)));
            return;
          }
          this.buf = this.buf.subarray(idx + this.delim.length);
          this.state = "after-delimiter";
          break;
        }
        case "after-delimiter": {
          if (this.buf.length < 2) return;
          if (this.buf[0] === 0x2d && this.buf[1] === 0x2d) {
            this.state = "done";
            this.buf = Buffer.alloc(0);
            return;
          }
          let i = 0;
          while (i < this.buf.length && (this.buf[i] === 0x20 || this.buf[i] === 0x09)) i++; // transport padding
          if (i + 2 > this.buf.length) {
            if (i > 64) throw new MultipartError(400, "malformed", "Malformed multipart body");
            return;
          }
          if (this.buf[i] !== 0x0d || this.buf[i + 1] !== 0x0a) throw new MultipartError(400, "malformed", "Malformed multipart body");
          this.buf = this.buf.subarray(i + 2);
          this.state = "headers";
          break;
        }
        case "headers": {
          let headerText: string;
          if (this.buf.length >= 2 && this.buf.subarray(0, 2).equals(CRLF)) {
            headerText = "";
            this.buf = this.buf.subarray(2);
          } else {
            const idx = this.buf.indexOf(HEADER_END);
            if (idx < 0) {
              if (this.buf.length > this.limits.maxHeaderBytes) throw new MultipartError(400, "header_too_large", "Part headers are too large");
              return;
            }
            if (idx > this.limits.maxHeaderBytes) throw new MultipartError(400, "header_too_large", "Part headers are too large");
            headerText = this.buf.toString("utf8", 0, idx);
            this.buf = this.buf.subarray(idx + 4);
          }
          if (++this.parts > this.limits.maxParts) throw new MultipartError(400, "too_many_parts", "Too many parts in the upload");
          this.sink = this.onPart(this.partInfo(headerText));
          this.state = "body";
          break;
        }
        case "body": {
          const idx = this.buf.indexOf(this.delim);
          if (idx < 0) {
            const keep = this.delim.length - 1;
            if (this.buf.length > keep) {
              const out = this.buf.subarray(0, this.buf.length - keep);
              this.buf = this.buf.subarray(this.buf.length - keep);
              await this.sink!.write(out);
            }
            return;
          }
          if (idx > 0) await this.sink!.write(this.buf.subarray(0, idx));
          const sink = this.sink!;
          this.sink = null;
          await sink.end();
          this.buf = this.buf.subarray(idx + this.delim.length);
          this.state = "after-delimiter";
          break;
        }
        case "done":
          return;
      }
    }
  }

  private partInfo(headerText: string): PartInfo {
    const headers: Record<string, string> = {};
    for (const line of headerText.split("\r\n")) {
      if (!line) continue;
      const colon = line.indexOf(":");
      if (colon <= 0) throw new MultipartError(400, "malformed", "Malformed part header");
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const cd = headers["content-disposition"];
    if (!cd) throw new MultipartError(400, "malformed", "Part has no Content-Disposition");
    const { type, params } = parseDisposition(cd);
    if (type !== "form-data" || !params.name) throw new MultipartError(400, "malformed", "Part is not form-data");
    return { name: params.name, filename: params.filename, contentType: headers["content-type"] };
  }
}

/** Collects a part in memory, failing once it grows past `max` bytes. */
export class MemorySink implements PartSink {
  private chunks: Buffer[] = [];
  size = 0;
  done = false;

  constructor(
    private readonly max: number,
    private readonly what = "This part",
  ) {}

  write(chunk: Buffer): void {
    this.size += chunk.length;
    if (this.size > this.max) throw new MultipartError(413, "part_too_large", `${this.what} is too big`);
    this.chunks.push(Buffer.from(chunk)); // copy: the parser reuses its buffer
  }
  end(): void {
    this.done = true;
  }
  abort(): void {
    this.chunks = [];
  }
  get buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Streams a part to a new file (mode 0600), keeping the first `headBytes` for type sniffing. */
export class FileSink implements PartSink {
  private ws: WriteStream;
  size = 0;
  head = Buffer.alloc(0);
  done = false;

  constructor(
    public path: string,
    private readonly max: number,
    private readonly what = "This file",
    private readonly headBytes = 4096,
  ) {
    this.ws = createWriteStream(path, { flags: "wx", mode: 0o600 });
    this.ws.on("error", () => {}); // surfaced through write/end
  }

  async write(chunk: Buffer): Promise<void> {
    this.size += chunk.length;
    if (this.size > this.max) throw new MultipartError(413, "part_too_large", `${this.what} is too big`);
    if (this.head.length < this.headBytes) this.head = Buffer.concat([this.head, chunk.subarray(0, this.headBytes - this.head.length)]);
    if (!this.ws.write(Buffer.from(chunk))) await once(this.ws, "drain");
  }
  async end(): Promise<void> {
    this.ws.end();
    await once(this.ws, "finish");
    this.done = true;
  }
  abort(): void {
    this.ws.destroy();
    this.remove();
  }
  remove(): void {
    rmSync(this.path, { force: true });
  }
}
