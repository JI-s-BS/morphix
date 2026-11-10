// Shared slicer primitives: the process runner, the result types and version parsing.
// The slicers themselves (PrusaSlicer, OrcaSlicer, Bambu Studio) live in ./adapters and run
// with execFile (never a shell). Morphix never implements slicing itself.
import { execFile } from "node:child_process";
import type { SlicerId, SlicerInstall } from "./adapters/types";
import type { GcodeEstimates } from "./gcode";

export type SlicerKind = SlicerId;

/** An installed slicer as the advisor and older callers know it (see toSlicerInstall). */
export interface SlicerInfo {
  kind: SlicerKind;
  path: string;
  version: string | null;
  baseArgs?: string[];
  via?: SlicerInstall["via"];
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Injectable process runner (tests pass a fake). Must not use a shell. */
export type ExecFileFn = (file: string, args: string[], opts: { timeoutMs: number; cwd?: string }) => Promise<ExecResult>;

export const defaultExec: ExecFileFn = (file, args, opts) =>
  new Promise((resolveP) => {
    execFile(file, args, { timeout: opts.timeoutMs, cwd: opts.cwd, maxBuffer: 32 * 1024 * 1024, shell: false, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
      resolveP({
        code: e ? (typeof e.code === "number" ? e.code : null) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "") + (e && typeof e.code === "string" ? `\n${e.code}: ${e.message}` : ""),
        timedOut: !!e?.killed && e?.signal === "SIGTERM",
      });
    });
  });

/** Version from a `--help` banner ("PrusaSlicer-2.9.2+linux…", "OrcaSlicer 2.2.0", "BambuStudio-01.10.02.76:"). */
export function parseSlicerVersion(text: string): string | null {
  const m = /(?:PrusaSlicer|OrcaSlicer|Bambu ?Studio)[-\s]v?(\d+\.\d+(?:\.\d+)*[\w.+-]*)/i.exec(text);
  return m ? m[1].replace(/[:.]+$/, "") : null;
}

/** True when `version` is at least `min` ("2.6"). Unknown versions count as new enough. */
export function versionAtLeast(version: string | null | undefined, min: string): boolean {
  if (!version) return true;
  const a = version.split(/[^\d]+/).filter(Boolean).map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0;
    if (x !== b[i]) return x > b[i];
  }
  return true;
}

export function toSlicerInstall(s: SlicerInfo | SlicerInstall): SlicerInstall {
  if ("id" in s) return s;
  return { id: s.kind, path: s.path, baseArgs: s.baseArgs, version: s.version, via: s.via ?? "custom" };
}

export function toSlicerInfo(s: SlicerInstall): SlicerInfo {
  return { kind: s.id, path: s.path, version: s.version, ...(s.baseArgs?.length ? { baseArgs: s.baseArgs } : {}), via: s.via };
}

export type SupportMode = "none" | "auto" | "buildplate";

export type SliceFailureReason = "slicer-not-installed" | "profile-missing" | "slicer-failed" | "timeout" | "no-output";

/** What preparePrint reports about the slicer run (result.slicer). */
export type SliceResult =
  | {
      ok: true;
      slicer: SlicerInfo;
      /** The slicer's own G-code file (before Morphix post-processing); "" for a Bambu .gcode.3mf. */
      gcodePath: string;
      gcode: string;
      estimates: GcodeEstimates;
      args: string[];
      durationMs: number;
      /** Always false: generated profiles are unverified until printed on that printer. */
      profileVerified: false;
      log: string;
    }
  | { ok: false; reason: SliceFailureReason | "unsupported-printer"; message: string; slicer?: SlicerInfo; args?: string[]; log?: string };
