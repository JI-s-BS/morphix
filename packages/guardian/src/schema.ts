// SQLite schema for the guardian. This package does not open the app database
// itself; the app runs applyGuardianSchema() on it at startup.
//
// packages/database already creates monitoring_sessions and failure_alerts with a
// small set of columns, so this schema is additive:
//   1. GUARDIAN_SCHEMA_SQL: CREATE TABLE IF NOT EXISTS for all guardian tables
//      (the two base tables are repeated with their ORIGINAL columns only,
//      so the statement is a no-op on existing databases).
//   2. GUARDIAN_COLUMN_MIGRATIONS: [table, column, definition] triples in the
//      same shape as packages/database's add(table, col, def) helper.
// applyGuardianSchema() shows the intended order and is what the tests run.

export const GUARDIAN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS monitoring_sessions (
  id TEXT PRIMARY KEY, print_job_id TEXT, started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE IF NOT EXISTS failure_alerts (
  id TEXT PRIMARY KEY, session_id TEXT, at TEXT NOT NULL, level TEXT NOT NULL,
  kind TEXT NOT NULL, confidence REAL, snapshot_rel_path TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS guardian_evidence (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES monitoring_sessions(id),
  alert_id TEXT REFERENCES failure_alerts(id),
  at TEXT NOT NULL,
  label TEXT NOT NULL,              -- suspect | confirmed
  kind TEXT,                        -- spaghetti | detachment | stalled
  rel_path TEXT NOT NULL,           -- relative to the storage root (snapshots/<session>/...)
  bytes INTEGER,
  sent_to_ai INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS alert_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id TEXT NOT NULL REFERENCES failure_alerts(id),
  at TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT);
CREATE INDEX IF NOT EXISTS idx_failure_alerts_session ON failure_alerts(session_id, at);
CREATE INDEX IF NOT EXISTS idx_guardian_evidence_alert ON guardian_evidence(alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_transitions_alert ON alert_transitions(alert_id, id);
`;

export const GUARDIAN_COLUMN_MIGRATIONS: ReadonlyArray<readonly [table: string, column: string, definition: string]> = [
  ["monitoring_sessions", "snapshot_url", "TEXT"],
  ["monitoring_sessions", "evidence_rel_dir", "TEXT"],
  ["monitoring_sessions", "end_reason", "TEXT"],
  ["monitoring_sessions", "worker_restarts", "INTEGER NOT NULL DEFAULT 0"],
  // failure_alerts.level keeps its original meaning (a short severity string);
  // state holds the full guardian AlertState.
  ["failure_alerts", "state", "TEXT NOT NULL DEFAULT 'possible_failure'"],
  ["failure_alerts", "score", "REAL"],
  ["failure_alerts", "updated_at", "TEXT"],
  ["failure_alerts", "confirmed_at", "TEXT"],
  ["failure_alerts", "pause_source", "TEXT"],
  ["failure_alerts", "pause_delivery", "TEXT"],
  ["failure_alerts", "pause_requested_at", "TEXT"],
  ["failure_alerts", "pause_confirmed_at", "TEXT"],
  ["failure_alerts", "pause_confirmed_by", "TEXT"],
  ["failure_alerts", "closed_at", "TEXT"],
  ["failure_alerts", "resolution", "TEXT"],
  ["failure_alerts", "ai_problem", "TEXT"],
  ["failure_alerts", "ai_confidence", "REAL"],
  ["failure_alerts", "ai_explanation", "TEXT"],
  ["failure_alerts", "ai_model", "TEXT"],
  ["failure_alerts", "review_json", "TEXT"],
];

/** Minimal surface of sql.js' Database used here. */
export interface SqlExec {
  exec(sql: string): { columns: string[]; values: unknown[][] }[];
}

export function applyGuardianSchema(db: SqlExec): void {
  db.exec(GUARDIAN_SCHEMA_SQL);
  const cols = (table: string) => new Set((db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []).map((r) => String(r[1])));
  for (const [table, col, def] of GUARDIAN_COLUMN_MIGRATIONS) {
    if (!cols(table).has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}
