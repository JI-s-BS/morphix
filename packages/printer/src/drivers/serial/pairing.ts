// Pairing for printers whose API key is granted on the printer's own screen (Ultimaker, Snapmaker).
// Not part of the fixed PrinterDriver contract: drivers that need it carry an extra `pairing`
// property (see docs/goal-notes/drivers-serial.md for how the setup page uses it).
import type { DriverConfig, DriverDeps, PrinterDriver } from "../types";

export interface PairingResult {
  /** waiting: the user still has to confirm on the printer; paired: done; denied: they said no; failed: start again. */
  state: "waiting" | "paired" | "denied" | "failed";
  /** Values to merge into the saved printer config (contain secrets: store them 0600, never log or show them). */
  save?: DriverConfig;
  message: string;
  hint?: string;
}

export interface Pairing {
  /** Asks the printer for credentials; it shows a prompt on its screen. */
  start(config: DriverConfig, deps?: DriverDeps): Promise<PairingResult>;
  /** Call every ~2 s after start() with the config merged with start()'s `save`. */
  check(config: DriverConfig, deps?: DriverDeps): Promise<PairingResult>;
}

export type PairableDriver = PrinterDriver & { pairing: Pairing };

export function isPairable(d: PrinterDriver): d is PairableDriver {
  return typeof (d as Partial<PairableDriver>).pairing?.start === "function";
}
