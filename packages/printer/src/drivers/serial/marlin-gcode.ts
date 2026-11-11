// Marlin serial wire format: line numbers + checksums, and parsing of what the firmware prints back.
// Pure functions, no I/O. Written from the Marlin / RepRap G-code documentation (marlinfw.org,
// reprap.org/wiki/G-code); exercised against an in-memory fake, NOT run on real hardware.
import type { Temp } from "../types";

/** XOR of every byte of the line before the "*" (RepRap checksum). */
export function checksum(line: string): number {
  let cs = 0;
  for (let i = 0; i < line.length; i++) cs ^= line.charCodeAt(i) & 0xff;
  return cs & 0xff;
}

/** "N12 G1 X5*87": what goes on the wire for command `cmd` as line `n`. */
export function numberedLine(n: number, cmd: string): string {
  const body = `N${n} ${cmd}`;
  return `${body}*${checksum(body)}`;
}

/** Strips comments and whitespace; returns "" for lines with no command. */
export function cleanGcodeLine(raw: string): string {
  let line = raw;
  const semi = line.indexOf(";");
  if (semi >= 0) line = line.slice(0, semi);
  // "*" would end the line early on the wire; a stray one in a file is never a real command.
  const star = line.indexOf("*");
  if (star >= 0) line = line.slice(0, star);
  return line.trim();
}

/** Splits a G-code file into the commands to stream. */
export function gcodeCommands(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const c = cleanGcodeLine(raw);
    // M110 would reset our line numbers mid-stream; the sender manages numbering itself.
    if (c && !/^M110\b/i.test(c)) out.push(c);
  }
  return out;
}

/** User-entered G-code from a one-line form field: real newlines or a literal "\n" separate commands. */
export function userGcode(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return text
    .split(/\\n|\r?\n/)
    .map(cleanGcodeLine)
    .filter(Boolean);
}

export interface Temps { nozzle?: Temp; bed?: Temp; chamber?: Temp }

function temp(line: string, re: RegExp): Temp | undefined {
  const m = re.exec(line);
  if (!m) return undefined;
  const actual = Number(m[1]);
  if (!Number.isFinite(actual)) return undefined;
  const target = m[2] !== undefined ? Number(m[2]) : undefined;
  return target !== undefined && Number.isFinite(target) ? { actual, target } : { actual };
}

/**
 * Temperatures from an M105 reply ("ok T:210.0 /210.0 B:60.0 /60.0 @:127 B@:0"), an M155 auto-report
 * (" T:21.4 /0.0 B:20.9 /0.0 @:0 B@:0") or a heating wait (" T:190.3 E:0 W:?"). Undefined if none.
 */
export function parseTemps(line: string): Temps | undefined {
  // "T:" or "T0:" (first extruder); the lookbehind keeps "B@:" / "@:" from matching.
  const nozzle = temp(line, /(?:^|\s|ok)T0?:\s*(-?\d+(?:\.\d+)?)(?:\s*\/\s*(-?\d+(?:\.\d+)?))?/);
  const bed = temp(line, /(?:^|\s)B:\s*(-?\d+(?:\.\d+)?)(?:\s*\/\s*(-?\d+(?:\.\d+)?))?/);
  const chamber = temp(line, /(?:^|\s)C:\s*(-?\d+(?:\.\d+)?)(?:\s*\/\s*(-?\d+(?:\.\d+)?))?/);
  if (!nozzle && !bed && !chamber) return undefined;
  const out: Temps = {};
  if (nozzle) out.nozzle = nozzle;
  if (bed) out.bed = bed;
  if (chamber) out.chamber = chamber;
  return out;
}

/** Line number the firmware asks for again ("Resend: 12", "Resend:12", "rs N12"), or undefined. */
export function parseResend(line: string): number | undefined {
  const m = /^(?:Resend|rs)\s*:?\s*N?\s*(\d+)/i.exec(line.trim());
  return m ? Number(m[1]) : undefined;
}

export function isOk(line: string): boolean {
  return /^ok\b/i.test(line.trim());
}

/** "echo:busy: processing" / "busy: paused for user": the firmware is alive but still working. */
export function isBusy(line: string): boolean {
  return /^(?:echo:)?\s*busy:/i.test(line.trim());
}

// "Error:" lines that only announce a resend (followed by "Resend: N" + "ok"); not fatal.
const RESEND_ERRORS = /checksum mismatch|line number is not|no line number|no checksum|missing checksum|format error/i;

/**
 * A line that means the firmware stopped (halted, kill(), thermal runaway, MINTEMP/MAXTEMP).
 * Returns the reason to show the user, or undefined for anything else.
 */
export function fatalError(line: string): string | undefined {
  const t = line.trim();
  if (/printer halted|kill\(\) called|system stopped/i.test(t)) return t.replace(/^(?:error|!!)\s*:?\s*/i, "");
  if (/^!!/.test(t)) return t.replace(/^!!\s*/, "") || "Firmware reported a fatal error";
  const m = /^error\s*:\s*(.*)$/i.exec(t);
  if (!m) return undefined;
  if (RESEND_ERRORS.test(m[1]) || /unknown command/i.test(m[1])) return undefined;
  return m[1] || "Firmware reported an error";
}

export interface FirmwareInfo { firmware?: string; machine?: string; uuid?: string; extruders?: number; autoReportTemp: boolean }

/** Parses the M115 reply ("FIRMWARE_NAME:Marlin 2.1.2 (...) SOURCE_CODE_URL:... MACHINE_TYPE:Ender-3 ..." + "Cap:" lines). */
export function parseM115(lines: string[]): FirmwareInfo {
  const info: FirmwareInfo = { autoReportTemp: false };
  const keys = /\s+(?=[A-Z_]{4,}:)/;
  for (const raw of lines) {
    const line = raw.trim();
    const cap = /^Cap:([A-Z_]+):(\d)/.exec(line);
    if (cap) {
      if (cap[1] === "AUTOREPORT_TEMP" && cap[2] === "1") info.autoReportTemp = true;
      continue;
    }
    if (!line.includes("FIRMWARE_NAME:")) continue;
    for (const part of line.slice(line.indexOf("FIRMWARE_NAME:")).split(keys)) {
      const i = part.indexOf(":");
      const k = part.slice(0, i);
      const v = part.slice(i + 1).trim();
      if (k === "FIRMWARE_NAME") info.firmware = v;
      else if (k === "MACHINE_TYPE") info.machine = v;
      else if (k === "UUID") info.uuid = v;
      else if (k === "EXTRUDER_COUNT" && Number(v) >= 1) info.extruders = Math.min(8, Math.floor(Number(v)));
    }
  }
  return info;
}

/** M27 reply: "SD printing byte 1234/56789" → [done, total]; "Not SD printing" → null; else undefined. */
export function parseSdProgress(line: string): [number, number] | null | undefined {
  if (/not sd printing/i.test(line)) return null;
  const m = /sd printing byte\s+(\d+)\s*\/\s*(\d+)/i.exec(line);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}
