// Validation of printer commands coming from the browser. Anything unexpected is rejected
// here, so the backend only ever sees well-formed PrinterCommand values.
import type { PrinterCommand } from "./types";

export const TEMPERATURE_LIMITS = { nozzle: 260, bed: 100 } as const;

export function parsePrinterCommand(body: unknown): PrinterCommand | null {
  if (!body || typeof body !== "object") return null;
  const { cmd, args = {} } = body as { cmd?: unknown; args?: any };
  if (typeof args !== "object" || args === null) return null;
  switch (cmd) {
    case "light":
      return typeof args.on === "boolean" ? { cmd, args: { on: args.on } } : null;
    case "fan": {
      const speed = Number(args.speed);
      return Number.isInteger(speed) && speed >= 0 && speed <= 100 ? { cmd, args: { speed } } : null;
    }
    case "home":
    case "pause":
    case "resume":
    case "cancel":
      return { cmd, args: {} };
    case "temperature": {
      const heater = args.heater;
      const celsius = Number(args.celsius);
      if (heater !== "nozzle" && heater !== "bed") return null;
      if (!Number.isInteger(celsius) || celsius < 0 || celsius > TEMPERATURE_LIMITS[heater as "nozzle" | "bed"]) return null;
      return { cmd, args: { heater, celsius } };
    }
    default:
      return null;
  }
}
