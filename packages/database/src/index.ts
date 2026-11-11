// SQLite (sql.js / WebAssembly, so no native build on any platform). The database
// lives in memory and is flushed atomically to <root>/database/morphix.sqlite.
import initSqlJs, { type Database, type SqlValue } from "sql.js";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Storage } from "@morphix/storage";

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, state TEXT NOT NULL,
  latest_version_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS model_versions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), version INTEGER NOT NULL,
  source TEXT NOT NULL, format TEXT NOT NULL, rel_path TEXT NOT NULL, bytes INTEGER NOT NULL,
  target_height_mm REAL, thumbnail_rel_path TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS generation_tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), provider TEXT NOT NULL,
  kind TEXT NOT NULL, remote_id TEXT, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES model_versions(id), kind TEXT NOT NULL,
  rel_path TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT, source_url TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS printer_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS print_jobs (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), version_id TEXT, state TEXT NOT NULL,
  approved_at TEXT, file_rel_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS printer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS monitoring_sessions (
  id TEXT PRIMARY KEY, print_job_id TEXT, started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE IF NOT EXISTS failure_alerts (
  id TEXT PRIMARY KEY, session_id TEXT, at TEXT NOT NULL, level TEXT NOT NULL,
  kind TEXT NOT NULL, confidence REAL, snapshot_rel_path TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, audio_rel_path TEXT, created_at TEXT NOT NULL);
`;

export type Row = Record<string, SqlValue>;

/** Additive migrations: new columns only, never destructive. */
function migrate(db: Database): void {
  const cols = (table: string) => new Set(db.exec(`PRAGMA table_info(${table})`)[0]?.values.map((r) => String(r[1])) ?? []);
  const add = (table: string, col: string, def: string) => {
    if (!cols(table).has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  add("model_versions", "kind", "TEXT NOT NULL DEFAULT 'demo'");
  add("model_versions", "stl_rel_path", "TEXT");
  add("model_versions", "remote_task_id", "TEXT");
  add("generation_tasks", "parent_version_id", "TEXT");
  add("generation_tasks", "credits", "INTEGER");
  add("print_jobs", "settings_json", "TEXT");
  add("print_jobs", "summary_json", "TEXT");
}

export class MorphixDb {
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  private constructor(private db: Database, private file: string, private storage: Storage) {}

  static async open(storage: Storage, wasmDir?: string): Promise<MorphixDb> {
    const SQL = await initSqlJs(wasmDir ? { locateFile: (f: string) => join(wasmDir, f) } : undefined);
    const file = storage.path("database", "morphix.sqlite");
    const db = existsSync(file) ? new SQL.Database(readFileSync(file)) : new SQL.Database();
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    migrate(db);
    db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
    const m = new MorphixDb(db, file, storage);
    m.flush();
    return m;
  }

  all(sql: string, params: SqlValue[] = []): Row[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows: Row[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(sql: string, params: SqlValue[] = []): Row | undefined {
    return this.all(sql, params)[0];
  }

  run(sql: string, params: SqlValue[] = []): void {
    this.db.run(sql, params);
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 500);
    }
  }

  /** Write the database to disk atomically. */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.storage.writeAtomic(this.file, Buffer.from(this.db.export()));
    this.dirty = false;
  }

  /** Daily copy into database/backups, keeping the newest 7. */
  backup(): void {
    if (!existsSync(this.file)) return;
    const dir = this.storage.path("database", "backups");
    const target = join(dir, `morphix-${new Date().toISOString().slice(0, 10)}.sqlite`);
    if (!existsSync(target)) copyFileSync(this.file, target);
    const old = readdirSync(dir)
      .filter((f) => f.endsWith(".sqlite"))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(7);
    // Backups are copies, not permanent models; pruning old copies is safe.
    for (const { f } of old) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* ignore */
      }
    }
  }

  /** Raw multi-statement exec (schema setup for other packages). */
  exec(sql: string): { columns: string[]; values: unknown[][] }[] {
    const r = this.db.exec(sql);
    this.markDirty();
    return r;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  close(): void {
    if (this.dirty) this.flush();
    this.db.close();
  }

  // ---- settings ----
  getSetting<T>(key: string, fallback: T): T {
    const r = this.get("SELECT value FROM settings WHERE key = ?", [key]);
    return r ? (JSON.parse(String(r.value)) as T) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.run("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", [key, JSON.stringify(value)]);
  }

  /**
   * Called at startup. Demo tasks left running are marked failed; Meshy tasks
   * with a remote id are returned so polling can resume (credits already spent).
   */
  recoverInterruptedTasks(): Row[] {
    const now = new Date().toISOString();
    const rows = this.all("SELECT * FROM generation_tasks WHERE status IN ('queued','running')");
    const resumable = rows.filter((r) => r.provider === "meshy" && r.remote_id);
    for (const r of rows.filter((x) => !resumable.includes(x))) {
      this.run("UPDATE generation_tasks SET status='failed', error='interrupted by restart', updated_at=? WHERE id=?", [now, r.id]);
      this.run("UPDATE projects SET state='failed', updated_at=? WHERE id=? AND state='generating'", [now, r.project_id]);
    }
    return resumable;
  }

  /** Meshy tasks created today (local time), for the daily cost cap. */
  meshyTasksToday(): number {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const r = this.get("SELECT COUNT(*) AS n FROM generation_tasks WHERE provider='meshy' AND created_at >= ?", [start.toISOString()]);
    return Number(r?.n ?? 0);
  }
}
