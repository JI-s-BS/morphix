// Drivers of family "serial" (docs/GOAL.md). Each driver lives in its own file here and is listed below.
// marlin-serial: USB G-code streaming; ultimaker, snapmaker: local HTTP APIs with on-screen pairing.
// All three are protocol implementations tested against fakes, not run on real hardware.
import type { PrinterDriver } from "../types";
import { marlinSerialDriver } from "./marlin-serial";
import { snapmakerDriver } from "./snapmaker";
import { ultimakerDriver } from "./ultimaker";

export const SERIAL_DRIVERS: PrinterDriver[] = [marlinSerialDriver, ultimakerDriver, snapmakerDriver];

export { createMarlinSerialDriver, type MarlinSerialOptions } from "./marlin-serial";
export { createUltimakerDriver, type UltimakerOptions } from "./ultimaker";
export { createSnapmakerDriver, discoverSnapmakers, type SnapmakerOptions } from "./snapmaker";
export { isPairable, type Pairing, type PairingResult, type PairableDriver } from "./pairing";
export { listSerialPorts, DIALOUT_HINT, type SerialPortHandle, type OpenSerialPort } from "./marlin-port";
