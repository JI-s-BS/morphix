// QD330 print defaults and slicer-profile file locations. ALL VALUES UNVERIFIED.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** UNVERIFIED guesses; mirrored in config/slicer-profiles/qd330-pla-0.2mm.ini. */
export const QD330_PLA_DEFAULTS = {
  verified: false,
  nozzleDiameterMm: 0.4,
  filamentDiameterMm: 1.75,
  filamentDensityGcm3: 1.24,
  nozzleTempC: 210,
  bedTempC: 60,
  layerHeightMm: 0.2,
  infillPercent: 15,
  perimeters: 2,
  /** Representative speed written to the .gx header (infill speed). */
  printSpeedMmS: 60,
  buildVolumeMm: { x: 220, y: 220, z: 220 },
} as const;

export interface SlicerProfilePaths {
  dir: string;
  prusaIni: string;
  orcaMachine: string;
  orcaProcess: string;
  orcaFilament: string;
}

/**
 * Finds config/slicer-profiles. Order: explicit dir, $MORPHIX_SLICER_PROFILES,
 * <cwd>/config/slicer-profiles, then up to 4 parent directories of cwd.
 */
export function resolveProfilePaths(dir?: string): SlicerProfilePaths | null {
  const candidates: string[] = [];
  if (dir) candidates.push(resolve(dir));
  else {
    if (process.env.MORPHIX_SLICER_PROFILES) candidates.push(resolve(process.env.MORPHIX_SLICER_PROFILES));
    let base = process.cwd();
    for (let i = 0; i < 5; i++) {
      candidates.push(join(base, "config", "slicer-profiles"));
      base = resolve(base, "..");
    }
  }
  for (const d of candidates) {
    const p = profilePathsIn(d);
    if (existsSync(p.prusaIni)) return p;
  }
  return null;
}

export function profilePathsIn(dir: string): SlicerProfilePaths {
  return {
    dir,
    prusaIni: join(dir, "qd330-pla-0.2mm.ini"),
    orcaMachine: join(dir, "orcaslicer", "qd330-machine.json"),
    orcaProcess: join(dir, "orcaslicer", "qd330-process-0.2mm.json"),
    orcaFilament: join(dir, "orcaslicer", "qd330-pla.json"),
  };
}

/** Minimal INI reader for PrusaSlicer config files (key = value, # comments). */
export function parsePrusaIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].trim();
  }
  return out;
}
