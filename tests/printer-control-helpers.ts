// Helpers for the machine-control tests (home, light, fan, temperatures, motors,
// emergency stop). Built on the Phase 5 rig: fake printer on 127.0.0.1 only.
import type { QD330Controller, QD330ControllerOptions, UnverifiedCommandFlags } from "@morphix/printer";
import type { Rig } from "./phase5-helpers";

export const ALL_UNVERIFIED: UnverifiedCommandFlags = { light: true, fan: true, temperatures: true, motors: true };

const QUERIES = new Set(["M601 S1", "M602", "M115", "M119", "M105", "M114", "M27", "M661"]);
/** Everything the fake received except session handling and read-only queries. */
export const machineSent = (received: string[]) => received.filter((c) => !QUERIES.has(c));

/** A controller with every unverified command enabled and no debounce, disposed after the test. */
export function machineController(rig: Rig, cleanup: (fn: () => Promise<void>) => void, extra: Partial<QD330ControllerOptions> = {}): QD330Controller {
  const c = rig.controller({ allowUnverified: ALL_UNVERIFIED, minCommandIntervalMs: 0, ...extra });
  cleanup(async () => c.dispose());
  return c;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits until `check` is true or fails after `timeoutMs`. */
export async function until(check: () => boolean, timeoutMs = 2000, what = "condition"): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
