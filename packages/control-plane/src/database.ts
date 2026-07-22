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
  { version: 2, sql: `
    CREATE TABLE administrator_singleton_guard (id INTEGER PRIMARY KEY CHECK (id = 1));
    INSERT INTO administrator_singleton_guard(id)
      SELECT CASE WHEN COUNT(*) <= 1 THEN 1 ELSE 2 END FROM administrators;
    CREATE TRIGGER administrators_singleton_insert
      BEFORE INSERT ON administrators
      WHEN (SELECT COUNT(*) FROM administrators) >= 1
      BEGIN SELECT RAISE(ABORT, 'administrator singleton invariant'); END;
  ` },
  { version: 3, sql: `
    CREATE INDEX IF NOT EXISTS auth_events_occurred_at_idx ON auth_events(occurred_at, id);
  ` },
  { version: 4, sql: `
    ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN created_at TEXT;
    ALTER TABLE tasks ADD COLUMN current_operation_id TEXT;
    ALTER TABLE tasks ADD COLUMN cancellation_requested_at TEXT;

    CREATE TABLE task_attempts (
      attempt_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_sequence INTEGER NOT NULL,
      action_json TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      input_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, attempt_sequence)
    );
    CREATE TRIGGER task_attempts_immutable_update
      BEFORE UPDATE ON task_attempts BEGIN SELECT RAISE(ABORT, 'task attempt is immutable'); END;
    CREATE TRIGGER task_attempts_immutable_delete
      BEFORE DELETE ON task_attempts BEGIN SELECT RAISE(ABORT, 'task attempt is immutable'); END;

    CREATE TABLE task_state_transitions (
      transition_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      actor TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      blocked_context_json TEXT,
      expected_version INTEGER NOT NULL,
      resulting_version INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      occurred_at TEXT NOT NULL,
      UNIQUE(task_id, resulting_version)
    );

    CREATE TABLE m4_write_scopes (
      scope_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE m4_leases (
      lease_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      status TEXT NOT NULL,
      generation INTEGER NOT NULL,
      lease_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE m4_assignments (
      assignment_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      status TEXT NOT NULL,
      assignment_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(task_id, attempt_id, operation_id)
    );
    CREATE TABLE m4_approvals (
      approval_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      status TEXT NOT NULL,
      approved_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE m4_grants (
      grant_id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL UNIQUE REFERENCES m4_approvals(approval_id),
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      status TEXT NOT NULL,
      grant_json TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      consumed_at TEXT,
      result_ref TEXT
    );
    CREATE TABLE m4_dispatch_queue (
      queue_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      grant_id TEXT NOT NULL REFERENCES m4_grants(grant_id),
      status TEXT NOT NULL,
      enqueued_at TEXT NOT NULL,
      claimed_at TEXT,
      UNIQUE(task_id, attempt_id, operation_id)
    );
    CREATE INDEX m4_dispatch_fifo_idx ON m4_dispatch_queue(status, queue_sequence);
    CREATE TABLE m4_results (
      result_ref TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL UNIQUE,
      result_digest TEXT NOT NULL,
      result_json TEXT NOT NULL,
      status TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE TABLE m4_commands (
      command_scope TEXT NOT NULL,
      command_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      result_json TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(command_scope, command_id)
    );
    CREATE TABLE m4_reconciliations (
      reconciliation_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      owner_evidence_ref TEXT NOT NULL,
      runtime_evidence_ref TEXT,
      recorded_at TEXT NOT NULL
    );
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
      if (known.some((entry, index) => entry.version !== index + 1)) throw new MigrationError();
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
