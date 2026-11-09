// "Morphix is busy" marker for deploy.sh: while the app itself is working (a Claude or Meshy
// model, slicing, sending a file to the printer), ~/Morphix/run/busy holds the reasons and is
// touched every few seconds; deploy.sh waits for it to go away (or go stale) before restarting
// the app. A print running on the printer is not "busy": it carries on through a restart.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Job } from "@morphix/jobs";

/** Stages the printer runs by itself, or that only wait for the user. */
const NOT_BUSY = new Set(["print", "approval", "done"]);

/** What the app is in the middle of, e.g. ["16 oz Water Bottle: build"]; empty = safe to restart. */
export function busyReasons(jobs: readonly Job[]): string[] {
  const out: string[] = [];
  for (const j of jobs) {
    const s = j.stages.find((x) => x.status === "running");
    if (s && !NOT_BUSY.has(s.key)) out.push(`${j.title}: ${s.key}`);
  }
  return out;
}

/** Keeps `file` up to date from the active jobs; returns a stop function. */
export function startBusyMarker(file: string, activeJobs: () => readonly Job[], everyMs = 5_000): () => void {
  const tick = () => {
    try {
      const reasons = busyReasons(activeJobs());
      if (reasons.length) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${reasons.join("; ")}\n`); // rewritten = fresh mtime (deploy.sh treats > 30 s as stale)
      } else if (existsSync(file)) {
        rmSync(file, { force: true });
      }
    } catch {
      /* never let the marker break the app */
    }
  };
  tick();
  const t = setInterval(tick, everyMs);
  return () => {
    clearInterval(t);
    rmSync(file, { force: true });
  };
}
