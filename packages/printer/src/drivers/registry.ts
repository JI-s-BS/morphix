import type { DriverId, PrinterDriver } from "./types";
import { HTTP_DRIVERS } from "./http";
import { LAN_DRIVERS } from "./lan";
import { SERIAL_DRIVERS } from "./serial";

export const DRIVERS: readonly PrinterDriver[] = [...HTTP_DRIVERS, ...LAN_DRIVERS, ...SERIAL_DRIVERS];

export function getDriver(id: DriverId | string): PrinterDriver | undefined {
  return DRIVERS.find((d) => d.id === id);
}
