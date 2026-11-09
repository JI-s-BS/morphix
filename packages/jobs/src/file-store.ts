// Atomic JSON file persistence for JobManager (write temp file, then rename), so a
// power cut on the Pi never leaves a half-written jobs file.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JobsSnapshot } from "./types";

export interface JobFileStore {
  path: string;
  load(): Promise<JobsSnapshot | null>;
  save(snapshot: JobsSnapshot): Promise<void>;
}

/** e.g. createJobFileStore(join(morphixHome, "data", "jobs.json")). */
export function createJobFileStore(path: string): JobFileStore {
  let chain: Promise<void> = Promise.resolve();
  return {
    path,
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        return parsed && parsed.version === 1 && Array.isArray(parsed.jobs) ? (parsed as JobsSnapshot) : null;
      } catch {
        return null; // missing or corrupt file: start with no jobs
      }
    },
    save(snapshot) {
      // Serialise writes so an older snapshot can never overwrite a newer one.
      const run = chain.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(snapshot));
        await rename(tmp, path);
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
