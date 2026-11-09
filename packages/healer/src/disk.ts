// Disk-space self-heal: delete old, re-creatable files only (temp dirs, intermediate G-code,
// old logs, cache). Models, .gx files, the database, recordings and backups are never touched.
import { readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";

export interface CleanTarget {
  dir: string;
  /** Entry names to consider (matched against the basename). */
  match: RegExp;
  olderThanMs: number;
  /** 1 = direct children of dir; 2 = children of its sub-directories. Default 1. */
  depth?: 1 | 2;
  /** Delete matching directories too (recursively). Default false = files only. */
  dirs?: boolean;
  /** Sub-directory names to skip at depth 2. */
  skip?: string[];
}

export interface CleanReport {
  removed: number;
  freedBytes: number;
  errors: number;
}

const DAY = 24 * 3600 * 1000;

function sizeOf(p: string): number {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    return readdirSync(p).reduce((n, e) => n + sizeOf(join(p, e)), 0);
  } catch {
    return 0;
  }
}

/** Directories never cleaned, whatever the target says: "/", the home dir, top-level dirs (except the OS temp dir). */
export function isUnsafeCleanRoot(dir: string): boolean {
  const d = resolve(dir);
  if (d === resolve(tmpdir())) return false;
  return d === sep || d === resolve(homedir()) || d.split(sep).filter(Boolean).length < 2;
}

export function cleanOldFiles(targets: readonly CleanTarget[], now = Date.now()): CleanReport {
  const report: CleanReport = { removed: 0, freedBytes: 0, errors: 0 };
  const visit = (dir: string, t: CleanTarget) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!t.match.test(name)) continue;
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (now - st.mtimeMs < t.olderThanMs) continue;
        if (st.isDirectory() && !t.dirs) continue;
        const bytes = st.isDirectory() ? sizeOf(p) : st.size;
        rmSync(p, { recursive: st.isDirectory(), force: true });
        report.removed++;
        report.freedBytes += bytes;
      } catch {
        report.errors++;
      }
    }
  };
  for (const t of targets) {
    if (isUnsafeCleanRoot(t.dir)) continue;
    if ((t.depth ?? 1) === 1) {
      visit(t.dir, t);
      continue;
    }
    let subs: string[] = [];
    try {
      subs = readdirSync(t.dir).filter((s) => !(t.skip ?? []).includes(s));
    } catch {
      continue;
    }
    for (const s of subs) {
      const p = join(t.dir, s);
      try {
        if (statSync(p).isDirectory()) visit(p, t);
      } catch {
        /* vanished */
      }
    }
  }
  return report;
}

/** What Morphix may delete when the disk is nearly full (storageRoot = ~/Morphix). */
export function defaultCleanTargets(storageRoot: string, tmp = tmpdir()): CleanTarget[] {
  return [
    // Temporary prepare/slicer/test dirs (mkdtemp "morphix-…").
    { dir: tmp, match: /^morphix-/, olderThanMs: DAY, dirs: true },
    // Intermediate G-code next to each prepared .gx (the .gx keeps the print; re-preparing recreates it).
    { dir: join(storageRoot, "prints"), match: /\.gcode$/i, olderThanMs: 14 * DAY, depth: 2 },
    // Daily logs older than 30 days.
    { dir: join(storageRoot, "logs"), match: /^morphix-\d{4}-\d{2}-\d{2}\.log$/, olderThanMs: 30 * DAY },
    // Cache files (not the voice recordings folder).
    { dir: join(storageRoot, "cache"), match: /^(?!recordings$).+/, olderThanMs: 14 * DAY },
  ];
}
