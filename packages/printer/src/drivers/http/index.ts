// Drivers of family "http" (docs/GOAL.md). Each driver lives in its own file here and is listed below.
// All four are implemented from the printers' published API docs and tested against local fakes
// (./fake/*), not on real hardware: see docs/goal-notes/drivers-http.md.
import type { PrinterDriver } from "../types";
import { duetDriver } from "./duet";
import { moonrakerDriver } from "./moonraker";
import { octoprintDriver } from "./octoprint";
import { prusalinkDriver } from "./prusalink";

export const HTTP_DRIVERS: PrinterDriver[] = [moonrakerDriver, octoprintDriver, prusalinkDriver, duetDriver];

export { moonrakerDriver, octoprintDriver, prusalinkDriver, duetDriver };
