// QD330 print defaults (the .gx header and the no-slicer estimates). ALL VALUES UNVERIFIED.

/** UNVERIFIED guesses; adapters/profile.ts generates config/slicer-profiles/qd330-pla-0.2mm.ini from the same numbers. */
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

/** Minimal INI reader for PrusaSlicer config files (key = value, # comments). */
export function parsePrusaIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].trim();
  }
  return out;
}
