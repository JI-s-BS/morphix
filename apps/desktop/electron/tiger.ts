// Tiger Data (TimescaleDB): Print Guardian history — every watch state change and camera
// event — goes into a `guardian_telemetry` hypertable, so print health can be charted over
// time. Off unless TIGER_DATABASE_URL is set; records wait in the guardian's local buffer
// while the database can't be reached.
import { hostname } from "node:os";
import { TIGER_TELEMETRY_SQL, type TelemetryRecord, type TelemetrySink } from "@morphix/guardian";

/** The minimal slice of a `pg` Pool we use (injectable for tests). */
export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/** `pg` is loaded only when Tiger Data is configured. */
async function defaultPool(connectionString: string): Promise<PgPoolLike> {
  const { Pool } = await import("pg");
  return new Pool({ connectionString, max: 2, ssl: /sslmode=disable/.test(connectionString) ? undefined : { rejectUnauthorized: true } });
}

export function createTigerSink(
  databaseUrl: string,
  o: { device?: string; pool?: (url: string) => Promise<PgPoolLike>; log?: (msg: string, extra?: Record<string, unknown>) => void } = {},
): TelemetrySink {
  const device = o.device ?? hostname();
  let ready: Promise<PgPoolLike> | null = null;
  const connect = () =>
    (ready ??= (async () => {
      const pool = await (o.pool ?? defaultPool)(databaseUrl);
      const [table, hyper] = TIGER_TELEMETRY_SQL.split(";").map((s) => s.trim()).filter(Boolean);
      await pool.query(table);
      // Tiger Data has TimescaleDB; on plain Postgres the table still works without it.
      await pool.query(hyper).catch((e: Error) => o.log?.("tiger: hypertable not created", { error: e.message }));
      o.log?.("tiger: connected", { device });
      return pool;
    })().catch((e) => {
      ready = null; // try again on the next flush
      throw e;
    }));
  return {
    async insert(records: TelemetryRecord[]) {
      if (!records.length) return;
      const pool = await connect();
      const values: unknown[] = [];
      const rows = records.map((r, i) => {
        values.push(r.at, device, r.sessionId, r.type, r.kind ?? null, r.state ?? null, r.value ?? null, r.data ? JSON.stringify(r.data) : null);
        const b = i * 8;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
      });
      await pool.query(`INSERT INTO guardian_telemetry (at, device, session_id, type, kind, state, value, data) VALUES ${rows.join(",")}`, values);
    },
  };
}
