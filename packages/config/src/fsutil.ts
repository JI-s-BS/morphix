// Small file helpers for the config store: atomic writes (temp file + fsync + rename) and
// private directories. Nothing here logs file contents.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Creates `dir` (and parents). With `mode`, an existing dir is tightened to that mode too. */
export async function ensureDir(dir: string, mode?: number): Promise<void> {
  await mkdir(dir, { recursive: true, mode: mode ?? 0o700 });
  if (mode !== undefined) {
    const st = await stat(dir);
    if ((st.mode & 0o777) !== mode) await chmod(dir, mode);
  }
}

/** Writes the whole file or nothing: a crash mid-write leaves the old file in place. */
export async function atomicWrite(file: string, data: string, mode = 0o600): Promise<void> {
  const tmp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fh = await open(tmp, "wx", mode);
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await chmod(tmp, mode); // umask may have narrowed or (with a custom umask) not applied the mode
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  try {
    const dh = await open(dirname(file), "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    // fsync on a directory isn't supported everywhere; the rename itself is still atomic
  }
}

/** File contents, or undefined when it doesn't exist. */
export async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Moves a broken file aside (never deletes it) and returns the new name. */
export async function moveAside(file: string, why: "corrupt" | "invalid", now = new Date()): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let target = `${file}.${why}-${stamp}`;
  for (let i = 1; await exists(target); i++) target = `${file}.${why}-${stamp}-${i}`;
  await rename(file, target);
  return target;
}

export async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Serializes async work (one writer at a time per file). */
export function createQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}
