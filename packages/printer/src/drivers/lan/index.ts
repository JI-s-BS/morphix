// Drivers of family "lan" (docs/GOAL.md). Each driver lives in its own file here and is listed below.
import type { PrinterDriver } from "../types";
import { bambuLanDriver } from "./bambu-lan";
import { crealityK1Driver } from "./creality-k1";
import { elegooSdcpDriver } from "./elegoo-sdcp";
import { flashforgeHttpDriver } from "./flashforge-http";
import { flashforgeTcpDriver } from "./flashforge-tcp";

export const LAN_DRIVERS: PrinterDriver[] = [flashforgeTcpDriver, flashforgeHttpDriver, bambuLanDriver, elegooSdcpDriver, crealityK1Driver];
