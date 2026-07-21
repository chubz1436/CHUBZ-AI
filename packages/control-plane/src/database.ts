import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { ControlPlaneConfig } from "./config.js";

type Migration = Readonly<{ version: number; sql: string }>;
const migrations: readonly Migration[] = [
  { version: 1, sql: `
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE administrators (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, disabled_at TEXT);
    CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, administrator_id TEXT NOT NULL REFERENCES administrators(id), csrf_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, idle_expires_at TEXT NOT NULL, revoked_at TEXT, last_seen_at TEXT NOT NULL);
    CREATE INDEX sessions_active_idx ON sessions(administrator_id, expires_at, idle_expires_at);
    CREATE TABLE auth_events (id INTEGER PRIMARY KEY, event_kind TEXT NOT NULL, administrator_id TEXT REFERENCES administrators(id), occurred_at TEXT NOT NULL, request_id TEXT NOT NULL);
    CREATE TABLE idempotency_records (scope_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_digest TEXT NOT NULL, first_message_id TEXT NOT NULL, response_ref TEXT, recorded_at TEXT NOT NULL, PRIMARY KEY(scope_key, idempotency_key));
    CREATE TABLE event_streams (stream_id TEXT PRIMARY KEY, head_sequence INTEGER NOT NULL DEFAULT 0, oldest_retained_sequence INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE events (stream_id TEXT NOT NULL REFERENCES event_streams(stream_id), sequence INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL, PRIMARY KEY(stream_id, sequence));
    CREATE TABLE tasks (task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, state TEXT NOT NULL, attempt_id TEXT, blocked_context_json TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  ` },
];
const checksum = (sql: string): string => createHash("sha256").update(sql).digest("hex");
export class MigrationError extends Error { constructor() { super("Control Plane database migration failed."); this.name = "MigrationError"; } }

export class ControlPlaneDatabase {
  readonly connection: Database.Database;
  constructor(config: ControlPlaneConfig) {
    this.connection = new Database(config.databasePath);
    this.connection.pragma("journal_mode = WAL");
    this.connection.pragma("foreign_keys = ON");
    this.connection.pragma("busy_timeout = 5000");
    try { this.migrate(); } catch (error) { this.connection.close(); throw error; }
  }
  migrate(): void {
    const db = this.connection;
    try {
      db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
      const known = db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all() as Array<{ version: number; checksum: string }>;
      for (const record of known) {
        const migration = migrations.find((entry) => entry.version === record.version);
        if (migration === undefined || checksum(migration.sql) !== record.checksum) throw new MigrationError();
      }
      const apply = db.transaction(() => {
        for (const migration of migrations) {
          if (known.some((entry) => entry.version === migration.version)) continue;
          db.exec(migration.sql);
          db.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)").run(migration.version, checksum(migration.sql), new Date().toISOString());
        }
      });
      apply();
    } catch (error) { if (error instanceof MigrationError) throw error; throw new MigrationError(); }
  }
  isReady(): boolean { try { return this.connection.prepare("SELECT 1 AS ok").get() !== undefined; } catch { return false; } }
  close(): void { this.connection.close(); }
}
