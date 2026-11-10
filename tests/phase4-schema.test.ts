import { describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { applyGuardianSchema, GUARDIAN_COLUMN_MIGRATIONS } from "@morphix/guardian";

const PHASE1 = `
CREATE TABLE monitoring_sessions (id TEXT PRIMARY KEY, print_job_id TEXT, started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE failure_alerts (id TEXT PRIMARY KEY, session_id TEXT, at TEXT NOT NULL, level TEXT NOT NULL,
  kind TEXT NOT NULL, confidence REAL, snapshot_rel_path TEXT, detail TEXT);
INSERT INTO monitoring_sessions VALUES ('old', NULL, '2026-11-01', NULL);
INSERT INTO failure_alerts VALUES ('a0', 'old', '2026-11-01', 'warning', 'spaghetti', 0.5, NULL, NULL);`;

const columns = (db: { exec(sql: string): { values: unknown[][] }[] }, t: string) =>
  (db.exec(`PRAGMA table_info(${t})`)[0]?.values ?? []).map((r) => String(r[1]));

describe("proposed guardian SQLite schema", () => {
  it("creates all tables on a fresh database and is idempotent", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec("PRAGMA foreign_keys = ON;");
    applyGuardianSchema(db);
    applyGuardianSchema(db);
    for (const t of ["monitoring_sessions", "failure_alerts", "guardian_evidence", "alert_transitions"]) expect(columns(db, t).length).toBeGreaterThan(0);
    for (const [t, c] of GUARDIAN_COLUMN_MIGRATIONS) expect(columns(db, t)).toContain(c);
    db.run("INSERT INTO monitoring_sessions (id, started_at) VALUES ('s1', 'now')");
    db.run("INSERT INTO failure_alerts (id, session_id, at, level, kind, state) VALUES ('a1', 's1', 'now', 'critical', 'spaghetti', 'pause_requested')");
    db.run("INSERT INTO guardian_evidence (id, session_id, alert_id, at, label, kind, rel_path) VALUES ('e1', 's1', 'a1', 'now', 'confirmed', 'spaghetti', 'snapshots/s1/x.jpg')");
    db.run("INSERT INTO alert_transitions (alert_id, at, from_state, to_state, reason) VALUES ('a1', 'now', 'confirmed_failure', 'pause_requested', 'operator')");
    expect(() => db.run("INSERT INTO guardian_evidence (id, session_id, at, label, rel_path) VALUES ('e2', 'missing', 'now', 'suspect', 'x')")).toThrow();
  });

  it("migrates a Phase 1 database without losing rows", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(PHASE1);
    applyGuardianSchema(db);
    const row = db.exec("SELECT id, level, state FROM failure_alerts")[0].values[0];
    expect(row).toEqual(["a0", "warning", "possible_failure"]);
    expect(columns(db, "monitoring_sessions")).toContain("worker_restarts");
  });
});
