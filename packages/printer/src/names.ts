// File-name rules for files stored on the QD330.
// Uploads get a strict, sanitised name. Starting a file that is already on the
// printer (e.g. an official Afinia .gx) only requires that the name cannot break
// the command line; it must also appear in the printer's M661 listing.

export class InvalidFileNameError extends Error {}

export interface FileNameOptions {
  /** Accept plain ".g" files as well as ".gx". Off by default: plain .g stalled at 0% on the real printer. */
  allowPlainGcode?: boolean;
}

export const MAX_FILE_NAME_LENGTH = 64;

function extensionOk(name: string, opts: FileNameOptions): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".gx") || (!!opts.allowPlainGcode && lower.endsWith(".g"));
}

function allowedList(opts: FileNameOptions): string {
  return opts.allowPlainGcode ? ".gx or .g" : ".gx";
}

/**
 * Turns any proposed name into a safe upload name: basename only, ASCII letters,
 * digits, "_", "-" and ".", no leading dot, at most 64 characters, lower-case
 * extension. Throws InvalidFileNameError if the extension is not allowed or
 * nothing usable is left.
 */
export function sanitizeFileName(name: string, opts: FileNameOptions = {}): string {
  if (typeof name !== "string") throw new InvalidFileNameError("file name must be a string");
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) throw new InvalidFileNameError(`file name needs a ${allowedList(opts)} extension: ${JSON.stringify(name)}`);
  const ext = base.slice(dot).toLowerCase();
  if (!extensionOk(ext, opts)) throw new InvalidFileNameError(`only ${allowedList(opts)} files are accepted: ${JSON.stringify(name)}`);
  let stem = base
    .slice(0, dot)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/_{2,}/g, "_")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");
  stem = stem.slice(0, MAX_FILE_NAME_LENGTH - ext.length);
  if (!stem) throw new InvalidFileNameError(`file name has no usable characters: ${JSON.stringify(name)}`);
  return stem + ext;
}

/**
 * Validates a name that should already exist on the printer. Spaces are
 * allowed (official files may have them); path separators, control characters,
 * "~" (command prefix) and leading dots are not.
 */
export function assertStoredFileName(name: string, opts: FileNameOptions = {}): string {
  if (typeof name !== "string" || !name) throw new InvalidFileNameError("file name is required");
  if (name.length > 128) throw new InvalidFileNameError("file name is too long");
  if (/[\u0000-\u001f\u007f~/\\]/.test(name) || name.startsWith(".")) {
    throw new InvalidFileNameError(`unsafe file name: ${JSON.stringify(name)}`);
  }
  if (name !== name.trim()) throw new InvalidFileNameError(`file name has leading/trailing spaces: ${JSON.stringify(name)}`);
  if (!extensionOk(name, opts)) throw new InvalidFileNameError(`only ${allowedList(opts)} files are accepted: ${JSON.stringify(name)}`);
  return name;
}
