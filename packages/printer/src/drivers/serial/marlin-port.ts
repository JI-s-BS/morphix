// USB serial port access with no npm dependency: `stty` configures the tty (baud, raw, no echo),
// then node:fs streams read and write it. Discovery lists /dev/serial/by-id (readable names) plus
// any /dev/ttyUSB* / /dev/ttyACM* not already listed.
// Written from the Linux tty / stty documentation; NOT run against a real printer. Tests replace
// this module with an in-memory fake Marlin through the SerialPortHandle interface.
import { execFile } from "node:child_process";
import { constants, createReadStream, createWriteStream, promises as fsp } from "node:fs";
import { basename, join } from "node:path";
import { DriverError } from "../types";

/** What the G-code sender needs from a port. Tests implement it with a fake Marlin. */
export interface SerialPortHandle {
  write(data: string): Promise<void>;
  onData(listener: (chunk: string) => void): void;
  /** Called once when the port goes away (unplugged, closed, read error). */
  onClose(listener: (err?: Error) => void): void;
  close(): Promise<void>;
}

export type OpenSerialPort = (path: string, baud: number) => Promise<SerialPortHandle>;

export interface SerialPortInfo { path: string; name: string }
export type ListSerialPorts = () => Promise<SerialPortInfo[]>;

export const DIALOUT_HINT =
  "The user running Morphix needs the 'dialout' group: run `sudo usermod -aG dialout $USER`, then log out and back in (or restart the Morphix service).";

export const SUPPORTED_BAUDS = [115200, 250000] as const;

/** Only real serial device paths: never let a form value point stty / fs at an arbitrary file. */
export function isSerialPath(path: string): boolean {
  return /^\/dev\/(?:tty(?:USB|ACM|AMA|S)\d+|serial\/by-(?:id|path)\/[\w.:+@-]+)$/.test(path);
}

/** Maps an open() failure to a DriverError with a plain hint (EACCES → the dialout group). */
export function serialOpenError(err: unknown, path: string): DriverError {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM") {
    return new DriverError("auth", `No permission to open ${path}`, DIALOUT_HINT);
  }
  if (code === "ENOENT" || code === "ENXIO" || code === "ENODEV") {
    return new DriverError("unreachable", `Serial port ${path} not found`,
      "Check the USB cable and that the printer is on, then pick the port again from the list.");
  }
  if (code === "EBUSY") {
    return new DriverError("busy", `Serial port ${path} is in use by another program`,
      "Close OctoPrint, Cura, Pronterface or `screen` if they are connected to this printer.");
  }
  return new DriverError("protocol", `Could not open ${path}: ${(err as Error)?.message ?? String(err)}`,
    "Unplug and replug the USB cable, then try again.");
}

function stty(path: string, baud: number): Promise<void> {
  // raw: no line editing / CR translation, VMIN=1 VTIME=0; -echo*: the tty must not echo our lines back.
  const args = ["-F", path, String(baud), "raw", "-echo", "-echoe", "-echok", "-echoctl", "-echoke",
    "cs8", "-cstopb", "-parenb", "-crtscts", "-ixon", "-ixoff", "min", "1", "time", "0"];
  return new Promise((resolve, reject) => {
    execFile("stty", args, { timeout: 5000 }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      if (/permission denied/i.test(String(stderr))) return reject(Object.assign(new Error("EACCES"), { code: "EACCES" }));
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return reject(new DriverError("unsupported", "The `stty` command is missing",
          "Install coreutils (it provides stty), then try again."));
      }
      reject(new Error(String(stderr).trim() || err.message));
    });
  });
}

/** Opens and configures a real serial port. Throws DriverError (EACCES → "auth" with the dialout hint). */
export const openSerialPort: OpenSerialPort = async (path, baud) => {
  if (!isSerialPath(path)) {
    throw new DriverError("rejected", `${path} is not a serial port`,
      "Pick the printer's port from the list (it looks like /dev/serial/by-id/usb-... or /dev/ttyUSB0).");
  }
  let fh: fsp.FileHandle;
  try {
    // Open first: a clean EACCES / ENOENT here gives the best hint. O_NOCTTY: never become our controlling tty.
    fh = await fsp.open(path, constants.O_RDWR | constants.O_NOCTTY);
  } catch (e) {
    throw serialOpenError(e, path);
  }
  try {
    await stty(path, baud);
  } catch (e) {
    await fh.close().catch(() => {});
    throw e instanceof DriverError ? e : serialOpenError(e, path);
  }
  const fd = fh.fd;
  const input = createReadStream("", { fd, autoClose: false, highWaterMark: 1024, encoding: "latin1" });
  const output = createWriteStream("", { fd, autoClose: false });
  const closeListeners: Array<(err?: Error) => void> = [];
  let closed = false;
  const finish = (err?: Error) => {
    if (closed) return;
    closed = true;
    input.destroy();
    output.destroy();
    // A pending blocking read keeps one libuv worker until data arrives; the sender sends M105 before
    // closing so the firmware's reply releases it. Then the fd is closed.
    void fh.close().catch(() => {});
    for (const l of closeListeners) l(err);
  };
  input.on("error", (e) => finish(e));
  input.on("end", () => finish(new Error("serial port closed")));
  output.on("error", (e) => finish(e));
  return {
    write: (data) =>
      new Promise((resolve, reject) => {
        if (closed) return reject(new DriverError("unreachable", "Serial port is closed"));
        output.write(data, "latin1", (err) => (err ? reject(err) : resolve()));
      }),
    onData: (l) => input.on("data", (chunk) => l(String(chunk))),
    onClose: (l) => closeListeners.push(l),
    close: async () => finish(),
  };
};

/** "usb-1a86_USB_Serial-if00-port0" → "1a86 USB Serial"; "usb-Prusa_Research__prusa3d.com__Original_Prusa_i3_MK3_CZPX-if00" → "Prusa Research (prusa3d.com) Original Prusa i3 MK3 CZPX". */
export function readablePortName(byIdName: string): string {
  return byIdName
    .replace(/^usb-/, "")
    .replace(/-if\d+(?:-port\d+)?$/, "")
    .replace(/__([^_]+)__/g, " ($1) ")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const listSerialPorts: ListSerialPorts = async () => {
  const out: SerialPortInfo[] = [];
  const seen = new Set<string>();
  const byId = "/dev/serial/by-id";
  for (const entry of await fsp.readdir(byId).catch(() => [] as string[])) {
    const path = join(byId, entry);
    const target = await fsp.realpath(path).catch(() => undefined);
    if (target) seen.add(target);
    out.push({ path, name: `${readablePortName(entry)}${target ? ` (${basename(target)})` : ""}` });
  }
  for (const entry of await fsp.readdir("/dev").catch(() => [] as string[])) {
    if (!/^tty(?:USB|ACM)\d+$/.test(entry)) continue;
    const path = join("/dev", entry);
    if (!seen.has(path)) out.push({ path, name: `USB serial device (${entry})` });
  }
  return out;
};
