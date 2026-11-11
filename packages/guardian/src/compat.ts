// Compile-only stand-ins for the removed Swarms / Tiger Data integrations, kept so
// apps/desktop/electron (printing.ts, tiger.ts) still builds until its wiring is
// dropped. They do nothing. Delete this file then (see docs/goal-notes/cleanup.md).

/** @deprecated Swarms review was removed; always undefined. */
export function swarmsFromEnv(_env?: Record<string, string | undefined>): undefined {
  return undefined;
}

/** @deprecated Tiger Data telemetry was removed; always undefined. */
export function telemetryFromEnv(_env?: Record<string, string | undefined>, _sink?: TelemetrySink): undefined {
  return undefined;
}

/** @deprecated */
export interface TelemetryRecord {
  at: string;
  sessionId: string | null;
  type: string;
  kind?: string;
  state?: string;
  value?: number;
  data?: Record<string, unknown>;
}

/** @deprecated */
export interface TelemetrySink {
  insert(records: TelemetryRecord[]): Promise<void>;
}

/** @deprecated */
export const TIGER_TELEMETRY_SQL = "";
