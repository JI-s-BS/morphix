// Input checks for everything the setup page and the config file can contain. Each check returns
// a plain-English problem (for the UI) or null. Error text never repeats the value it rejected,
// so a secret pasted into the wrong box can't end up in a response or a log.
import { isIP } from "node:net";

export class InputError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "InputError";
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function checkText(v: unknown, label: string, opts: { min?: number; max?: number } = {}): string | null {
  const min = opts.min ?? 0;
  const max = opts.max ?? 200;
  if (typeof v !== "string") return `${label} must be text.`;
  if (CONTROL.test(v)) return `${label} can't contain line breaks or control characters.`;
  if (v.trim().length < min) return min <= 1 ? `${label} is required.` : `${label} needs at least ${min} characters.`;
  if (v.length > max) return `${label} can be at most ${max} characters.`;
  return null;
}

const LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;

/** An IPv4/IPv6 address or a DNS / mDNS host name. No scheme, port or path. */
export function checkHost(v: unknown, label = "Host"): string | null {
  if (typeof v !== "string" || v.trim() === "") return `${label} is required.`;
  const s = v.trim();
  if (s.length > 253) return `${label} is too long.`;
  if (isIP(s)) return null;
  const bare = s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : null;
  if (bare && isIP(bare) === 6) return null;
  if (/^[a-z]+:\/\//i.test(s) || s.includes("/")) return `${label}: enter just the address (like 192.168.1.50 or printer.local), without http:// or a path.`;
  if (s.includes(":")) return `${label}: enter the port in its own box, not after the address.`;
  const name = s.endsWith(".") ? s.slice(0, -1) : s;
  if (!name.split(".").every((l) => LABEL.test(l))) return `${label} isn't a valid IP address or host name.`;
  if (/^[0-9.]+$/.test(name)) return `${label} isn't a valid IP address.`;
  return null;
}

export function checkPort(v: unknown, label = "Port"): string | null {
  const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 65535) return `${label} must be a whole number from 1 to 65535.`;
  return null;
}

/** A serial device path like /dev/ttyUSB0 or /dev/serial/by-id/usb-Prusa_MK3-if00. */
export function checkSerialPort(v: unknown, label = "Serial port"): string | null {
  if (typeof v !== "string" || !/^\/dev\/[A-Za-z0-9._:+@-]+(\/[A-Za-z0-9._:+@-]+)*$/.test(v) || v.length > 200 || v.split("/").includes("..")) {
    return `${label} must be a device path like /dev/ttyUSB0.`;
  }
  return null;
}

/** API keys and tokens: one line of visible ASCII, no spaces. */
export function checkApiKey(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return "Paste the key first.";
  const s = v.trim();
  if (s.length < 8) return "That key looks too short; copy the whole key.";
  if (s.length > 512) return "That key is too long; copy just the key.";
  if (!/^[\x21-\x7e]+$/.test(s)) return "That key contains spaces or characters a key can't have; copy just the key.";
  return null;
}

export const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
export function checkUsername(v: unknown): string | null {
  if (typeof v !== "string" || !USERNAME.test(v)) return "User name: 1 to 32 letters, digits, dots, dashes or underscores.";
  return null;
}

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;
export function checkPassword(v: unknown): string | null {
  if (typeof v !== "string") return "Password is required.";
  if (v.length < PASSWORD_MIN) return `Password needs at least ${PASSWORD_MIN} characters.`;
  if (v.length > PASSWORD_MAX) return `Password can be at most ${PASSWORD_MAX} characters.`;
  if (CONTROL.test(v)) return "Password can't contain line breaks or control characters.";
  return null;
}

/** Absolute executable path for a custom slicer location. */
export function checkExecPath(v: unknown, label = "Path"): string | null {
  if (typeof v !== "string" || !v.startsWith("/") || v.length > 512 || CONTROL.test(v) || v.split("/").includes("..")) {
    return `${label} must be a full path like /usr/bin/prusa-slicer.`;
  }
  return null;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function must(problem: string | null, field?: string): void {
  if (problem) throw new InputError(problem, field);
}
