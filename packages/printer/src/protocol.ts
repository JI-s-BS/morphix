// QD330 wire format shared by the observer (index.ts) and the Phase 5 controller.
// Everything here is pure: no sockets, no side effects.
import type { PrinterInfo, PrinterStatus } from "@morphix/shared";

export const READ_ONLY_COMMANDS = new Set([
  "M601 S1", // take the session (required before queries; no physical effect)
  "M602", // release the session
  "M115", // machine info
  "M119", // machine status / endstops
  "M105", // temperatures
  "M114", // position
  "M27", // job progress
]);

export class PrinterCommandRejected extends Error {}

export function assertReadOnly(cmd: string): void {
  if (!READ_ONLY_COMMANDS.has(cmd.trim())) {
    throw new PrinterCommandRejected(`command not allowed in observation mode: ${cmd}`);
  }
}

export function cleanReply(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("CMD ") && l.trim() !== "ok")
    .join("\n");
}

function kv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

export function parseStatus(r: Record<string, string>): PrinterStatus {
  const st = kv(r["M119"] ?? "");
  const temps: PrinterStatus["temps"] = {};
  for (const m of (r["M105"] ?? "").matchAll(/(T0|B):\s*([\d.]+)\s*\/\s*([\d.]+)/g)) {
    temps[m[1] === "T0" ? "nozzle" : "bed"] = { current: Number(m[2]), target: Number(m[3]) };
  }
  const position: Record<string, number> = {};
  for (const m of (r["M114"] ?? "").matchAll(/([XYZ]):\s*(-?[\d.]+)/g)) position[m[1].toLowerCase()] = Number(m[2]);
  const prog = /byte\s+(\d+)\s*\/\s*(\d+)/.exec(r["M27"] ?? "");
  const layer = /Layer:\s*(\d+)\s*\/\s*(\d+)/.exec(r["M27"] ?? "");
  return {
    online: true,
    checkedAt: new Date().toISOString(),
    machine: st["MachineStatus"],
    moveMode: st["MoveMode"],
    currentFile: st["CurrentFile"] || undefined,
    temps,
    position,
    progress: prog ? Math.floor((Number(prog[1]) * 100) / Math.max(Number(prog[2]), 1)) : 0,
    layer: layer ? [Number(layer[1]), Number(layer[2])] : [0, 0],
  };
}

export function parseInfo(text: string): PrinterInfo {
  const k = kv(text);
  return {
    machineType: k["Machine Type"],
    machineName: k["Machine Name"],
    firmware: k["Firmware"],
    serial: k["SN"],
    buildVolume: k["X"] ? `X: ${k["X"]}` : undefined,
  };
}

// ---- framing ---------------------------------------------------------------

/** "M23 0:/user/a.gx" -> "~M23 0:/user/a.gx\r\n" */
export function encodeCommand(cmd: string): string {
  if (/[\r\n~]/.test(cmd)) throw new PrinterCommandRejected(`illegal characters in command: ${JSON.stringify(cmd)}`);
  return `~${cmd}\r\n`;
}

/** First word of a command: "M28 10 0:/user/a.gx" -> "M28". */
export function commandVerb(cmd: string): string {
  return cmd.trim().split(/\s+/)[0].toUpperCase();
}

/** Byte offset just past the reply to `verb` ("CMD <verb> Received." ... "ok"), or -1 if not complete yet. */
export function findReplyEnd(buf: string, verb: string): number {
  const start = buf.indexOf(`CMD ${verb} Received`);
  if (start < 0) return -1;
  const ok = /(?:^|\n)ok\r?\n/.exec(buf.slice(start));
  return ok ? start + ok.index + ok[0].length : -1;
}

/**
 * A reply counts as acknowledged only if it echoes "Received", ends in ok, and
 * reports no error. `fileName` is blanked out first so a file called e.g.
 * "fail_test.gx" is not mistaken for an error message.
 */
export function isAcknowledged(reply: string, verb: string, fileName?: string): boolean {
  let text = cleanReply(reply);
  if (fileName) text = text.split(fileName).join("").split(fileName.replace(/\.(gx|g)$/i, "")).join("");
  return reply.includes(`CMD ${verb} Received`) && /(?:^|\n)ok\r?\n?$/.test(reply) && !REPLY_ERROR.test(text);
}

export const REPLY_ERROR = /error|fail|refus|denied|invalid|crc/i;

// ---- upload ------------------------------------------------------------------
// M28 <size> 0:/user/<name>, then exactly <size> raw bytes (no framing), a short pause, M29.

/** Upload chunk size (progress granularity only; the printer sees one raw byte stream). */
export const PACKET_DATA_SIZE = 4096;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32 (same as zlib.crc32 / Python zlib.crc32). */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function packetCount(size: number): number {
  return Math.ceil(size / PACKET_DATA_SIZE);
}

// ---- M661 stored-file list ---------------------------------------------------

const LIST_HEADER = Buffer.from([0x44, 0xaa, 0xaa, 0x44]); // "D\xaa\xaaD"
const ENTRY_MARK = Buffer.from([0x3a, 0x3a, 0xa3, 0xa3]); // "::\xa3\xa3"

export interface FileListParse {
  complete: boolean;
  /** Full paths as the printer reports them, e.g. "/data/dance.g". */
  paths: string[];
  /** Bytes consumed from the start of the buffer (only meaningful when complete). */
  end: number;
}

/** Parses the binary M661 reply. Incomplete until the header's entry count has been read. */
export function parseFileList(buf: Buffer): FileListParse {
  const h = buf.indexOf(LIST_HEADER);
  if (h < 0 || buf.length < h + 8) return { complete: false, paths: [], end: 0 };
  const count = buf.readUInt32BE(h + 4);
  if (count > 10000) throw new Error(`implausible M661 file count ${count}`);
  const paths: string[] = [];
  let p = h + 8;
  while (paths.length < count) {
    if (buf.length < p + 8) return { complete: false, paths, end: 0 };
    if (!buf.subarray(p, p + 4).equals(ENTRY_MARK)) throw new Error(`malformed M661 entry at byte ${p}`);
    const len = buf.readUInt32BE(p + 4);
    if (len > 1024) throw new Error(`implausible M661 name length ${len}`);
    if (buf.length < p + 8 + len) return { complete: false, paths, end: 0 };
    paths.push(buf.subarray(p + 8, p + 8 + len).toString("utf8"));
    p += 8 + len;
  }
  return { complete: true, paths, end: p };
}

/** Builds an M661 payload (used by the fake printer and tests). */
export function encodeFileList(paths: string[]): Buffer {
  const parts: Buffer[] = [LIST_HEADER, u32(paths.length)];
  for (const name of paths) {
    const b = Buffer.from(name, "utf8");
    parts.push(ENTRY_MARK, u32(b.length), b);
  }
  return Buffer.concat(parts);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
