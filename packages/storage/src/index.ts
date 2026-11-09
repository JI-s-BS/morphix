// Permanent local storage under the Morphix root (default /home/jd/Morphix).
// Files are written atomically (temp file + rename) and never auto-deleted.
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync, statfsSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

export const SUBDIRS = [
  "models",
  "previews",
  "prints",
  "timelapses",
  "snapshots",
  "logs",
  "database",
  "database/backups",
  "cache",
  "cache/recordings",
  "config",
] as const;

export type Subdir = (typeof SUBDIRS)[number];

/** Refuse new writes when less than this much space is free. */
export const MIN_FREE_BYTES = 512 * 1024 * 1024;

export class StorageError extends Error {}

export class Storage {
  readonly root: string;

  constructor(root = process.env.MORPHIX_ROOT || join(homedir(), "Morphix")) {
    this.root = resolve(root);
  }

  init(): void {
    for (const d of SUBDIRS) mkdirSync(join(this.root, d), { recursive: true });
  }

  /** Resolve a path inside the root; throws on traversal attempts. */
  path(...parts: string[]): string {
    const p = resolve(this.root, ...parts);
    if (p !== this.root && !p.startsWith(this.root + sep)) throw new StorageError(`path escapes storage root: ${p}`);
    return p;
  }

  relative(absPath: string): string {
    return relative(this.root, absPath).split(sep).join("/");
  }

  disk(): { freeBytes: number; totalBytes: number } {
    const s = statfsSync(this.root);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  }

  ensureSpace(bytes: number): void {
    const { freeBytes } = this.disk();
    if (freeBytes - bytes < MIN_FREE_BYTES) {
      throw new StorageError(`not enough disk space (${Math.round(freeBytes / 1e6)} MB free)`);
    }
  }

  writeAtomic(absPath: string, data: Buffer | string): void {
    const target = this.path(relative(this.root, absPath));
    this.ensureSpace(typeof data === "string" ? Buffer.byteLength(data) : data.length);
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, target);
  }

  exists(absPath: string): boolean {
    return existsSync(absPath);
  }

  read(absPath: string): Buffer {
    return readFileSync(this.path(relative(this.root, absPath)));
  }

  modelDir(projectId: string, versionId: string): string {
    return this.path("models", safeId(projectId), safeId(versionId));
  }
}

export function safeId(id: string): string {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new StorageError(`unsafe id: ${id}`);
  return id;
}

export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 100);
  return cleaned || "file";
}

/** Daily JSON-lines logger in <root>/logs. */
export class Logger {
  constructor(private storage: Storage) {}

  file(date = new Date()): string {
    return this.storage.path("logs", `morphix-${date.toISOString().slice(0, 10)}.log`);
  }

  write(level: "info" | "warn" | "error", message: string, extra?: unknown): void {
    const line = JSON.stringify({ t: new Date().toISOString(), level, message, ...(extra ? { extra } : {}) });
    try {
      appendFileSync(this.file(), line + "\n");
    } catch {
      // logging must never crash the app
    }
    (level === "error" ? console.error : console.log)(line);
  }

  tail(lines = 200): string[] {
    try {
      const all = readFileSync(this.file(), "utf8").trimEnd().split("\n");
      return all.slice(-lines);
    } catch {
      return [];
    }
  }
}
