// Slicer adapter contract: PrusaSlicer, OrcaSlicer and Bambu Studio behind one interface.
// The server picks an adapter that is installed and supports the printer's file format.
import type { PrinterModel } from "@morphix/catalog";
import type { FilamentId } from "../filaments";
import type { ExecFileFn, SliceFailureReason, SupportMode } from "../slicer";

export type SlicerId = "prusaslicer" | "orcaslicer" | "bambustudio";

export interface SlicerInstall {
  id: SlicerId;
  /** Executable (or "flatpak run <app-id>" split into path + baseArgs). */
  path: string;
  baseArgs?: string[];
  version: string | null;
  via: "path" | "apt" | "flatpak" | "appimage" | "custom";
}

export interface SliceJob {
  /** STL or 3MF model, already placed/scaled. */
  modelPath: string;
  outDir: string;
  printer: PrinterModel;
  filament: FilamentId;
  layerHeightMm?: number;
  infillPercent?: number;
  supports?: SupportMode;
  brimWidthMm?: number;
  perimeters?: number;
  speedMmS?: number;
  zOffsetMm?: number;
  timeoutMs?: number;
}

export type SliceOutput =
  | {
      ok: true;
      /** The file to send to the printer, already in printer.fileFormat (.gcode, .gx, .gcode.3mf, .ufp). */
      printablePath: string;
      format: PrinterModel["fileFormat"];
      /** Plain G-code (for preview / post-processing), when the slicer produced one. */
      gcodePath?: string;
      estimatedTimeS?: number;
      filamentMm?: number;
      warnings: string[];
    }
  | { ok: false; reason: SliceFailureReason | "unsupported-printer"; message: string };

export interface SlicerAdapter {
  id: SlicerId;
  name: string;
  /** Finds an install on this machine (PATH, apt, flatpak, AppImage in ~/Applications or ~/.local/bin, custom path). */
  detect(opts?: { customPath?: string; exec?: ExecFileFn }): Promise<SlicerInstall | null>;
  /** False when this slicer can't make the printer's file (e.g. Bambu .gcode.3mf needs Orca or Bambu Studio). */
  supports(printer: PrinterModel): boolean;
  slice(install: SlicerInstall, job: SliceJob, deps?: { exec?: ExecFileFn }): Promise<SliceOutput>;
  /** One line telling the user how to install it on their distro / arch. */
  installHint(env: { distro?: string; arch?: string }): string;
}
