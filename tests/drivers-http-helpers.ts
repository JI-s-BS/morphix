// Helpers for tests/drivers-http-*.test.ts.
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { DriverDeps } from "../packages/printer/src/drivers/types";

/** A localhost port that nothing listens on (connection refused). */
export async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Captures everything a driver logs, to check no secret ever appears. */
export function captureLog(): { deps: DriverDeps; text: () => string } {
  const lines: string[] = [];
  return {
    deps: { log: (level, message, data) => lines.push(`${level} ${message} ${JSON.stringify(data ?? {})}`) },
    text: () => lines.join("\n"),
  };
}

export const gcode = (s = "G28\nG1 X10 Y10\n") => Buffer.from(s);
