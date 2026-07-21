import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { evaluateJournalReconciliation, parseJournalEntry, type JournalEntry } from "@chubz/shared";

export type OperationStage = "dispatch" | "execution" | "integration";
export type OperationState = "prepared" | "started" | "completed" | "failed" | "execution-unknown" | "reconciled-completed" | "reconciled-failed" | "reconciled-not-executed";
export type OperationIdentityInput = Readonly<{ taskId: string; attemptId: string; stage: OperationStage; intentDigest: string }>;
export type ProcessEvidencePair = Readonly<{ worker: unknown | null; validator: unknown | null }>;
export type OperationRecord = Readonly<{ operationId: string; journalEntryId: string; identity: OperationIdentityInput; state: OperationState; result: unknown | null; failure: string | null; processEvidence: ProcessEvidencePair; updatedAt: string }>;
export type ExecuteResult = Readonly<{ classification: "executed" | "replay" | "in-progress" | "execution-unknown"; record: OperationRecord }>;

class JournalTransitionConflict extends Error {}

const MAX_PAYLOAD_BYTES = 1_048_576;
const LEGAL: Readonly<Record<OperationState, readonly OperationState[]>> = Object.freeze({
  prepared: ["started", "failed"], started: ["completed", "failed", "execution-unknown"], completed: [], failed: [], "execution-unknown": ["reconciled-completed", "reconciled-failed", "reconciled-not-executed"], "reconciled-completed": [], "reconciled-failed": [], "reconciled-not-executed": [],
});

function canonicalIdentity(value: OperationIdentityInput): string {
  if (![value.taskId, value.attemptId, value.intentDigest].every((item) => typeof item === "string" && item.length > 0 && item.length <= 512)) throw new Error("invalid operation identity");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.taskId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.attemptId) || value.taskId.includes("..") || value.attemptId.includes("..")) throw new Error("invalid operation scope identity");
  if (!(value.stage === "dispatch" || value.stage === "execution" || value.stage === "integration")) throw new Error("invalid operation stage");
  if (!/^(sha256:)?[0-9a-f]{64}$/.test(value.intentDigest)) throw new Error("intentDigest must be SHA-256");
  return JSON.stringify({ attemptId: value.attemptId, intentDigest: value.intentDigest.replace(/^sha256:/u, ""), stage: value.stage, taskId: value.taskId });
}

export function deriveOperationId(value: OperationIdentityInput): string {
  return `operation-${createHash("sha256").update(`chubz.m3.operation/v1\n${canonicalIdentity(value)}`).digest("hex")}`;
}

function boundedJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_PAYLOAD_BYTES) throw new Error("journal payload exceeds bound");
  return serialized;
}

export class OperationJournal {
  private readonly database: Database.Database;

  public constructor(path: string) {
    this.database = new Database(path);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY, journal_entry_id TEXT NOT NULL UNIQUE,
        identity_json TEXT NOT NULL, state TEXT NOT NULL,
        result_json TEXT, failure TEXT, worker_evidence_json TEXT, validator_evidence_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operation_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL,
        state TEXT NOT NULL, recorded_at TEXT NOT NULL,
        FOREIGN KEY(operation_id) REFERENCES operations(operation_id)
      );
    `);
  }

  public close(): void { this.database.close(); }

  private row(operationId: string): OperationRecord | null {
    const row = this.database.prepare("SELECT * FROM operations WHERE operation_id=?").get(operationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const identity = JSON.parse(String(row["identity_json"])) as OperationIdentityInput;
    return Object.freeze({ operationId, journalEntryId: String(row["journal_entry_id"]), identity, state: String(row["state"]) as OperationState, result: row["result_json"] === null ? null : JSON.parse(String(row["result_json"])), failure: row["failure"] === null ? null : String(row["failure"]), processEvidence: Object.freeze({ worker: row["worker_evidence_json"] === null ? null : JSON.parse(String(row["worker_evidence_json"])), validator: row["validator_evidence_json"] === null ? null : JSON.parse(String(row["validator_evidence_json"])) }), updatedAt: String(row["updated_at"]) });
  }

  public get(operationId: string): OperationRecord | null { return this.row(operationId); }

  private prepare(identity: OperationIdentityInput): Readonly<{ record: OperationRecord; inserted: boolean }> {
    const operationId = deriveOperationId(identity);
    return this.database.transaction(() => {
      const current = this.row(operationId);
      if (current) {
        if (canonicalIdentity(current.identity) !== canonicalIdentity(identity)) throw new Error("operation identity collision");
        return Object.freeze({ record: current, inserted: false });
      }
      const now = new Date().toISOString();
      const journalEntryId = `journal-${operationId.slice("operation-".length)}`;
      const inserted = this.database.prepare("INSERT OR IGNORE INTO operations(operation_id,journal_entry_id,identity_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(operationId, journalEntryId, canonicalIdentity(identity), "prepared", now, now);
      if (inserted.changes === 0) {
        const duplicate = this.row(operationId);
        if (!duplicate || canonicalIdentity(duplicate.identity) !== canonicalIdentity(identity)) throw new Error("operation identity collision");
        return Object.freeze({ record: duplicate, inserted: false });
      }
      this.database.prepare("INSERT INTO operation_history(operation_id,state,recorded_at) VALUES(?,?,?)").run(operationId, "prepared", now);
      return Object.freeze({ record: this.row(operationId)!, inserted: true });
    })();
  }

  private transition(operationId: string, next: OperationState, values: Readonly<{ result?: unknown; failure?: string }> = {}): OperationRecord {
    return this.database.transaction(() => {
      const current = this.row(operationId);
      if (!current) throw new Error("unknown operation");
      if (!LEGAL[current.state].includes(next)) throw new Error(`illegal journal transition ${current.state} -> ${next}`);
      const now = new Date().toISOString();
      const result = values.result === undefined ? null : boundedJson(values.result);
      const failure = values.failure === undefined ? null : values.failure.slice(0, 4_096);
      const updated = this.database.prepare("UPDATE operations SET state=?,result_json=?,failure=?,updated_at=? WHERE operation_id=? AND state=?").run(next, result, failure, now, operationId, current.state);
      if (updated.changes !== 1) throw new JournalTransitionConflict("journal state changed concurrently");
      this.database.prepare("INSERT INTO operation_history(operation_id,state,recorded_at) VALUES(?,?,?)").run(operationId, next, now);
      return this.row(operationId)!;
    })();
  }

  public async execute(identity: OperationIdentityInput, executor: () => Promise<unknown>): Promise<ExecuteResult> {
    const prepared = this.prepare(identity);
    if (!prepared.inserted) {
      if (["completed", "failed", "reconciled-completed", "reconciled-failed", "reconciled-not-executed"].includes(prepared.record.state)) return Object.freeze({ classification: "replay", record: prepared.record });
      if (prepared.record.state === "execution-unknown") return Object.freeze({ classification: "execution-unknown", record: prepared.record });
      if (prepared.record.state === "started") return Object.freeze({ classification: "in-progress", record: prepared.record });
    }
    let started: OperationRecord;
    try { started = this.transition(prepared.record.operationId, "started"); }
    catch (error) {
      if (!(error instanceof JournalTransitionConflict)) throw error;
      const current = this.row(prepared.record.operationId);
      if (!current) throw new Error("operation disappeared during claim");
      if (current.state === "execution-unknown") return Object.freeze({ classification: "execution-unknown", record: current });
      if (["completed", "failed", "reconciled-completed", "reconciled-failed", "reconciled-not-executed"].includes(current.state)) return Object.freeze({ classification: "replay", record: current });
      return Object.freeze({ classification: "in-progress", record: current });
    }
    let result: unknown;
    try {
      result = await executor();
    } catch (error) {
      const failure = error instanceof Error ? `operation executor failed (${error.name})` : "operation executor failed";
      try { return Object.freeze({ classification: "executed", record: this.transition(started.operationId, "failed", { failure }) }); }
      catch (transitionError) {
        if (!(transitionError instanceof JournalTransitionConflict)) throw transitionError;
        const current = this.row(started.operationId); if (!current) throw new Error("operation disappeared after execution failure");
        return Object.freeze({ classification: current.state === "execution-unknown" ? "execution-unknown" : "replay", record: current });
      }
    }
    try { return Object.freeze({ classification: "executed", record: this.transition(started.operationId, "completed", { result }) }); }
    catch (error) {
      if (!(error instanceof JournalTransitionConflict)) throw error;
      const current = this.row(started.operationId); if (!current) throw new Error("operation disappeared after execution");
      return Object.freeze({ classification: current.state === "execution-unknown" ? "execution-unknown" : "replay", record: current });
    }
  }

  public recordProcessEvidence(operationId: string, role: "worker" | "validator", evidence: unknown): OperationRecord {
    boundedJson(evidence);
    this.database.prepare(`UPDATE operations SET ${role === "worker" ? "worker_evidence_json" : "validator_evidence_json"}=?,updated_at=? WHERE operation_id=?`).run(JSON.stringify(evidence), new Date().toISOString(), operationId);
    const record = this.row(operationId);
    if (!record) throw new Error("unknown operation");
    return record;
  }

  public reconcileAfterRestart(resolver: (record: OperationRecord) => Readonly<{ outcome: "completed" | "failed" | "unknown"; evidence?: unknown }>): readonly OperationRecord[] {
    const rows = this.database.prepare("SELECT operation_id FROM operations WHERE state IN ('prepared','started') ORDER BY created_at, operation_id").all() as Array<{ operation_id: string }>;
    return rows.map(({ operation_id: operationId }) => {
      const record = this.row(operationId)!;
      if (record.state === "prepared") return this.transition(operationId, "failed", { failure: "restart-before-execution" });
      const resolution = resolver(record);
      if (resolution.outcome === "completed") return this.transition(operationId, "completed", { result: { reconciled: true, evidence: resolution.evidence ?? null } });
      if (resolution.outcome === "failed") return this.transition(operationId, "failed", { failure: "trusted restart reconciliation proved failure" });
      return this.transition(operationId, "execution-unknown", { failure: "execution outcome is ambiguous after restart" });
    });
  }

  public ownerReconcile(operationId: string, entry: JournalEntry): OperationRecord {
    const current = this.row(operationId);
    if (!current || current.state !== "execution-unknown") throw new Error("only execution-unknown operations can be owner-reconciled");
    const original: JournalEntry = { coordinationVersion: "1.0", journalEntryId: current.journalEntryId, taskId: current.identity.taskId, attemptId: current.identity.attemptId, operationId, adapterRunId: null, leaseId: null, grantId: null, stage: "execution-unknown", originalOperationStage: current.identity.stage, trustedRuntimeEvidenceRef: null, ownerReconciliationEvidenceRef: null, recordedAt: current.updatedAt };
    if (!parseJournalEntry(entry).ok || !evaluateJournalReconciliation(original, entry).ok) throw new Error("invalid owner reconciliation");
    return this.transition(operationId, entry.stage as OperationState, { result: entry });
  }

  public history(operationId: string): readonly string[] { return (this.database.prepare("SELECT state FROM operation_history WHERE operation_id=? ORDER BY sequence").all(operationId) as Array<{ state: string }>).map((row) => row.state); }
}
