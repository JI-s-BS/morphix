// Shared plumbing for the fake HTTP printers (tests and demos): a node:http server on 127.0.0.1 with a
// request log, routes that can be made to hang (for timeout tests), and a small multipart parser.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

export interface FakeResponse {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export interface FakeHttp {
  url: string;
  port: number;
  /** Every request seen (method + path without query). */
  log: string[];
  /** Paths (without query) that are received but never answered. */
  hang: Set<string>;
  close(): Promise<void>;
}

export async function startFakeHttp(handler: (req: FakeRequest) => FakeResponse | Promise<FakeResponse>): Promise<FakeHttp> {
  const hang = new Set<string>();
  const log: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const fr: FakeRequest = { method: req.method ?? "GET", path: decodeURIComponent(url.pathname), query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks) };
      log.push(`${fr.method} ${url.pathname}`);
      if (hang.has(url.pathname)) return; // never answer
      let out: FakeResponse;
      try {
        out = await handler(fr);
      } catch (e) {
        out = { status: 500, json: { error: String(e) } };
      }
      const headers: Record<string, string> = { ...(out.headers ?? {}) };
      let body = "";
      if (out.json !== undefined) {
        headers["Content-Type"] ??= "application/json";
        body = JSON.stringify(out.json);
      } else if (out.text !== undefined) {
        headers["Content-Type"] ??= "text/plain";
        body = out.text;
      }
      res.writeHead(out.status ?? 200, headers);
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    log,
    hang,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface MultipartPart {
  name: string;
  filename?: string;
  data: Buffer;
}

/** Parses a multipart/form-data body (enough for fetch's FormData). */
export function parseMultipart(body: Buffer, contentType: string | undefined): MultipartPart[] {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  if (!m) return [];
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  const parts: MultipartPart[] = [];
  let pos = body.indexOf(boundary);
  while (pos >= 0) {
    const start = pos + boundary.length;
    if (body.subarray(start, start + 2).toString() === "--") break;
    const next = body.indexOf(boundary, start);
    if (next < 0) break;
    const part = body.subarray(start + 2, next - 2); // skip CRLF after the boundary and before the next one
    const sep = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, sep).toString();
    const disp = /content-disposition:[^\r\n]*/i.exec(head)?.[0] ?? "";
    parts.push({
      name: /\bname="([^"]*)"/i.exec(disp)?.[1] ?? "",
      filename: /\bfilename="([^"]*)"/i.exec(disp)?.[1],
      data: part.subarray(sep + 4),
    });
    pos = next;
  }
  return parts;
}

/** A tiny printer model the fakes share: tests set its fields directly. */
export interface FakePrinterState {
  state: "idle" | "printing" | "paused" | "error" | "complete" | "cancelled" | "busy" | "offline";
  file?: string;
  /** 0..1 */
  progress: number;
  elapsedS: number;
  nozzle: { actual: number; target: number };
  bed: { actual: number; target: number };
  /** Files on the printer: name → contents. */
  files: Map<string, Buffer>;
  /** G-code lines received. */
  gcode: string[];
}

export function newPrinterState(): FakePrinterState {
  return { state: "idle", progress: 0, elapsedS: 0, nozzle: { actual: 25, target: 0 }, bed: { actual: 24, target: 0 }, files: new Map(), gcode: [] };
}

/** Moves a fake print forward: heated, and some progress (call from tests). */
export function startPrinting(p: FakePrinterState, file: string): void {
  p.state = "printing";
  p.file = file;
  p.progress = 0;
  p.elapsedS = 0;
  p.nozzle = { actual: 25, target: 215 };
  p.bed = { actual: 24, target: 60 };
}
