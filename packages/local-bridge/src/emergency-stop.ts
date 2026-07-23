import Database from "better-sqlite3";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface EmergencyStopGate {
  assertAllowed(projectId: string): void;
  runBeforeSpawn<T>(projectId: string, operationId: string, spawn: () => T): T;
  close(): void;
}

/**
 * Bridge-side defense in depth over the authoritative Control Plane database.
 * BEGIN IMMEDIATE serializes this final check with stop activation. If spawn wins
 * the lock it begins before activation can become authoritative; after activation
 * commits, every later spawn observes the stop and is refused.
 */
export class SqliteEmergencyStopGate implements EmergencyStopGate {
  private readonly database: Database.Database;
  private closed = false;

  public constructor(databasePath: string) {
    this.database = new Database(databasePath, { fileMustExist: true });
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("foreign_keys = ON");
  }

  private validate(projectId: string, operationId?: string): void {
    if (!ID.test(projectId) || projectId.includes("..") || operationId !== undefined && (!ID.test(operationId) || operationId.includes(".."))) throw new Error("emergency-stop scope identity is invalid");
    if (this.closed) throw new Error("emergency-stop authority is unavailable");
  }

  private stopped(projectId: string): boolean {
    try { return this.database.prepare("SELECT 1 FROM m8_emergency_stops WHERE status='active' AND (scope_type='global' OR (scope_type='project' AND project_id=?)) LIMIT 1").get(projectId) !== undefined; }
    catch { throw new Error("authoritative emergency-stop state is unavailable"); }
  }

  public assertAllowed(projectId: string): void {
    this.validate(projectId);
    if (this.stopped(projectId)) throw new Error("external execution blocked by authoritative emergency stop");
  }

  public runBeforeSpawn<T>(projectId: string, operationId: string, spawn: () => T): T {
    this.validate(projectId, operationId);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.stopped(projectId)) throw new Error("external process spawn blocked by authoritative emergency stop");
      const result = spawn();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public close(): void { if (!this.closed) { this.database.close(); this.closed = true; } }
}
