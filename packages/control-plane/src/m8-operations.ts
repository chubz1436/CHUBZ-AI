import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { detectRedactions, redactText } from "@chubz/shared";
import type { Principal } from "./auth.js";
import type { ControlPlaneConfig } from "./config.js";
import type { ControlPlaneDatabase } from "./database.js";
import { M6Error } from "./m6-ui.js";
import type { M4Orchestrator } from "./orchestrator.js";

export const M8_LIMITS = Object.freeze({ maxEvents: 2_048, maxEntriesReturned: 200, maxProjectionBytes: 3 * 1024 * 1024, maxSummaryBytes: 512, maxReasonBytes: 512, maxNotesBytes: 1_024 } as const);
const SCHEMA = "m8.bridge-log/v1" as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const sha256 = (value: string | Buffer): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
};
const canonicalPath = (value: string): string => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
const contained = (root: string, candidate: string): boolean => { const rel = relative(canonicalPath(root), canonicalPath(candidate)); return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const rejectLinks = (target: string): void => {
  const absolute = resolve(target); const parsedRoot = absolute.slice(0, absolute.indexOf(sep) + 1); let cursor = parsedRoot;
  for (const part of absolute.slice(parsedRoot.length).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) throw new M6Error("CONFLICT", "Bridge Log path is not trusted"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
};
const safeId = (value: unknown, label: string): string => { if (typeof value !== "string" || !ID.test(value) || value.includes("..")) throw new M6Error("INVALID_REQUEST", `${label} is invalid`); return value; };
const key = (value: unknown): string => { if (typeof value !== "string" || !IDEMPOTENCY.test(value)) throw new M6Error("INVALID_REQUEST", "idempotency key is invalid"); return value; };
const version = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new M6Error("INVALID_REQUEST", "expected version is invalid"); return Number(value); };
const sanitize = (value: unknown, maximum: number): string => {
  if (typeof value !== "string") throw new M6Error("INVALID_REQUEST", "text is required");
  const bounded = Buffer.from(value.trim(), "utf8").subarray(0, maximum).toString("utf8");
  if (!bounded) throw new M6Error("INVALID_REQUEST", "text is required");
  const findings = detectRedactions(bounded); if (!findings.ok) return "[redacted]";
  const redacted = redactText(bounded, findings.value); if (!redacted.ok) return "[redacted]";
  const printable = Array.from(redacted.value.text, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? " " : character;
  }).join("");
  return printable.replace(/[<>]/gu, "").replace(/\s+/gu, " ").slice(0, maximum);
};
const markdown = (value: string | null): string =>
  Array.from("\\`*_{}[]()#+.!|>-").reduce(
    (escaped, character) => escaped.replaceAll(character, `\\${character}`),
    value ?? "—",
  );
const jsonArray = (value: readonly string[]): string => JSON.stringify(value);

type EventInput = Readonly<{ eventId: string; eventKind: string; ownerId?: string | null; projectId?: string | null; taskId?: string | null; attemptId?: string | null; operationId?: string | null; source: string; actorCategory: string; oldState?: string | null; newState?: string | null; summary: string; details?: Record<string, unknown>; occurredAt: string }>;
type EventRow = { sequence: number; event_id: string; event_kind: string; owner_id: string | null; project_id: string | null; task_id: string | null; attempt_id: string | null; operation_id: string | null; source: string; actor_category: string; old_state: string | null; new_state: string | null; summary: string; details_json: string; event_digest: string; occurred_at: string };
type IncidentRow = { incident_id: string; owner_id: string | null; project_id: string | null; task_id: string | null; attempt_id: string | null; operation_id: string | null; condition: string; evidence_json: string; severity: string; first_detected_at: string; latest_detected_at: string; resolution_state: string; allowed_actions_json: string; blocked_actions_json: string; related_refs_json: string; notes: string; resolution_provenance_json: string | null; version: number };

export class M8OperationsService {
  private readonly root: string;
  private readonly file: string;
  private readonly staging: string;
  private publisher: ((taskId: string, eventKind: string) => void) | undefined;

  public constructor(private readonly database: ControlPlaneDatabase, config: ControlPlaneConfig) {
    const approved = resolve("B:\\AI_Agent_folder");
    if (config.environment !== "test" && !contained(approved, config.dataDirectory)) throw new Error("M8 managed data must remain beneath the approved operational root");
    this.root = resolve(config.dataDirectory, "bridge-log"); this.file = resolve(this.root, "bridge-log.md"); this.staging = resolve(this.root, ".staging");
    if (!contained(config.dataDirectory, this.root) || canonicalPath(config.dataDirectory) === canonicalPath(this.root) || !contained(this.root, this.file) || !contained(this.root, this.staging)) throw new Error("Bridge Log root escaped managed data");
    rejectLinks(config.dataDirectory); mkdirSync(this.root, { recursive: true }); rejectLinks(this.root);
    this.cleanupStaging();
    this.reconcileAfterRestart();
    this.syncAuthoritativeEvents();
    this.project();
  }

  public setPublisher(publisher: (taskId: string, eventKind: string) => void): void { this.publisher = publisher; }
  public reconcileTaskLifecycle(orchestrator: M4Orchestrator): void {
    const rows = this.database.connection.prepare("SELECT task_id,current_operation_id FROM tasks WHERE state='RUNNING' AND current_operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM m4_results WHERE m4_results.task_id=tasks.task_id AND m4_results.operation_id=tasks.current_operation_id)").all() as Array<{ task_id: string; current_operation_id: string }>;
    for (const row of rows) {
      const suffix = createHash("sha256").update(row.current_operation_id).digest("hex").slice(0, 48);
      orchestrator.recordBridgeResult(`m8-restart-unknown-${suffix}`, row.task_id, { operationId: row.current_operation_id, state: "execution-unknown", output: "", outputTruncated: false, failureCode: "EXECUTION_UNKNOWN", journalRef: `recovery-restart-${suffix}`, resultRef: `result-restart-${suffix}` });
      this.database.connection.prepare("UPDATE m8_stop_operations SET cancellation_state='uncertain',updated_at=?,evidence_json=? WHERE operation_id=? AND cancellation_state='requested'").run(new Date().toISOString(), canonical({ restartReconciliation: true, terminationConfirmed: false }), row.current_operation_id);
    }
    if (rows.length > 0) this.project();
  }
  public assertExecutionAllowed(projectId: string): void {
    safeId(projectId, "projectId");
    const active = this.database.connection.prepare("SELECT stop_id FROM m8_emergency_stops WHERE status='active' AND (scope_type='global' OR (scope_type='project' AND project_id=?)) LIMIT 1").get(projectId);
    if (active) throw new M6Error("UNAVAILABLE", "emergency stop blocks external execution");
  }

  private mutation<T>(scope: string, idempotencyKey: string, request: unknown, execute: () => T): T {
    const digest = sha256(canonical(request)); const db = this.database.connection;
    return db.transaction(() => {
      const prior = db.prepare("SELECT request_digest,result_json FROM m8_mutations WHERE mutation_scope=? AND idempotency_key=?").get(scope, idempotencyKey) as { request_digest: string; result_json: string | null } | undefined;
      if (prior) { if (prior.request_digest !== digest) throw new M6Error("CONFLICT", "idempotency key conflicts with a prior request"); if (prior.result_json === null) throw new M6Error("CONFLICT", "the original recovery mutation is in progress"); return JSON.parse(prior.result_json) as T; }
      db.prepare("INSERT INTO m8_mutations(mutation_scope,idempotency_key,request_digest,result_json,recorded_at) VALUES(?,?,?,?,?)").run(scope, idempotencyKey, digest, null, new Date().toISOString());
      try { const result = execute(); db.prepare("UPDATE m8_mutations SET result_json=? WHERE mutation_scope=? AND idempotency_key=?").run(JSON.stringify(result), scope, idempotencyKey); return result; }
      catch (error) { db.prepare("DELETE FROM m8_mutations WHERE mutation_scope=? AND idempotency_key=? AND result_json IS NULL").run(scope, idempotencyKey); throw error; }
    })();
  }

  public record(input: EventInput): void {
    for (const [label, value] of Object.entries({ eventId: input.eventId, eventKind: input.eventKind, source: input.source, actorCategory: input.actorCategory })) safeId(value, label);
    const summary = sanitize(input.summary, M8_LIMITS.maxSummaryBytes); const occurredAt = Number.isFinite(Date.parse(input.occurredAt)) ? input.occurredAt : new Date().toISOString();
    const core = { schemaVersion: SCHEMA, eventId: input.eventId, eventKind: input.eventKind, ownerId: input.ownerId ?? null, projectId: input.projectId ?? null, taskId: input.taskId ?? null, attemptId: input.attemptId ?? null, operationId: input.operationId ?? null, source: input.source, actorCategory: input.actorCategory, oldState: input.oldState ?? null, newState: input.newState ?? null, summary, details: input.details ?? {}, occurredAt };
    const digest = sha256(`chubz.m8.operational-event/v1\n${canonical(core)}`); const db = this.database.connection;
    db.transaction(() => {
      const prior = db.prepare("SELECT event_digest FROM m8_operational_events WHERE event_id=?").get(input.eventId) as { event_digest: string } | undefined;
      if (prior) { if (prior.event_digest !== digest) throw new M6Error("CONFLICT", "operational event identity conflicts with authoritative history"); return; }
      db.prepare("INSERT INTO m8_operational_events(event_id,event_kind,owner_id,project_id,task_id,attempt_id,operation_id,source,actor_category,old_state,new_state,summary,details_json,event_digest,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(input.eventId, input.eventKind, input.ownerId ?? null, input.projectId ?? null, input.taskId ?? null, input.attemptId ?? null, input.operationId ?? null, input.source, input.actorCategory, input.oldState ?? null, input.newState ?? null, summary, canonical(input.details ?? {}), digest, occurredAt);
    })();
  }

  public syncAuthoritativeEvents(): void {
    const db = this.database.connection;
    const owner = (db.prepare("SELECT id FROM administrators ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id ?? null;
    const add = (input: EventInput) => this.record(input);
    for (const row of db.prepare("SELECT task_id,project_id,created_at,updated_at FROM tasks ORDER BY created_at,task_id").all() as Array<Record<string, unknown>>) add({ eventId: `m8-task-${row["task_id"]}`, eventKind: "task-created", ownerId: owner, projectId: String(row["project_id"]), taskId: String(row["task_id"]), source: "tasks", actorCategory: "owner", newState: "DRAFT", summary: "Authoritative task created.", occurredAt: String(row["created_at"] ?? row["updated_at"]) });
    for (const row of db.prepare("SELECT a.attempt_id,a.task_id,a.created_at,t.project_id FROM task_attempts a JOIN tasks t ON t.task_id=a.task_id ORDER BY a.created_at,a.attempt_id").all() as Array<Record<string, unknown>>) add({ eventId: `m8-attempt-${row["attempt_id"]}`, eventKind: "attempt-created", ownerId: owner, projectId: String(row["project_id"]), taskId: String(row["task_id"]), attemptId: String(row["attempt_id"]), source: "task_attempts", actorCategory: "owner", summary: "Immutable task attempt created.", occurredAt: String(row["created_at"]) });
    for (const row of db.prepare("SELECT x.transition_id,x.task_id,x.attempt_id,x.from_state,x.to_state,x.actor,x.occurred_at,t.project_id,t.current_operation_id FROM task_state_transitions x JOIN tasks t ON t.task_id=x.task_id ORDER BY x.occurred_at,x.transition_id").all() as Array<Record<string, unknown>>) add({ eventId: `m8-transition-${row["transition_id"]}`, eventKind: "task-transition", ownerId: owner, projectId: String(row["project_id"]), taskId: String(row["task_id"]), attemptId: row["attempt_id"] as string | null, operationId: row["current_operation_id"] as string | null, source: "task_state_transitions", actorCategory: String(row["actor"]), oldState: String(row["from_state"]), newState: String(row["to_state"]), summary: `Task state changed from ${String(row["from_state"])} to ${String(row["to_state"])}.`, occurredAt: String(row["occurred_at"]) });
    for (const row of db.prepare("SELECT g.grant_id,g.task_id,g.attempt_id,g.operation_id,g.status,g.issued_at,g.consumed_at,t.project_id FROM m4_grants g JOIN tasks t ON t.task_id=g.task_id ORDER BY g.issued_at,g.grant_id").all() as Array<Record<string, unknown>>) add({ eventId: `m8-grant-${row["grant_id"]}-${row["status"]}`, eventKind: row["consumed_at"] ? "grant-consumed" : "grant-issued", ownerId: owner, projectId: String(row["project_id"]), taskId: String(row["task_id"]), attemptId: String(row["attempt_id"]), operationId: String(row["operation_id"]), source: "m4_grants", actorCategory: "control-plane", newState: String(row["status"]), summary: row["consumed_at"] ? "Single-use capability grant consumed." : "Single-use capability grant issued; secret material omitted.", occurredAt: String(row["consumed_at"] ?? row["issued_at"]) });
    for (const row of db.prepare("SELECT r.result_ref,r.task_id,r.attempt_id,r.operation_id,r.status,r.recorded_at,t.project_id FROM m4_results r JOIN tasks t ON t.task_id=r.task_id ORDER BY r.recorded_at,r.result_ref").all() as Array<Record<string, unknown>>) add({ eventId: `m8-result-${row["result_ref"]}`, eventKind: `operation-${String(row["status"])}`, ownerId: owner, projectId: String(row["project_id"]), taskId: String(row["task_id"]), attemptId: String(row["attempt_id"]), operationId: String(row["operation_id"]), source: "m4_results", actorCategory: "local-bridge", newState: String(row["status"]), summary: `Operation reached ${String(row["status"])}; worker output omitted.`, occurredAt: String(row["recorded_at"]) });
    for (const row of db.prepare("SELECT capture_id,owner_id,project_id,task_id,attempt_id,operation_id,status,updated_at FROM m7_capture_requests ORDER BY updated_at,capture_id").all() as Array<Record<string, unknown>>) add({ eventId: `m8-capture-${row["capture_id"]}-${row["status"]}`, eventKind: `evidence-${String(row["status"])}`, ownerId: String(row["owner_id"]), projectId: String(row["project_id"]), taskId: String(row["task_id"]), attemptId: String(row["attempt_id"]), operationId: String(row["operation_id"]), source: "m7_capture_requests", actorCategory: "control-plane", newState: String(row["status"]), summary: `Evidence capture is ${String(row["status"])}.`, occurredAt: String(row["updated_at"]) });
    for (const row of db.prepare("SELECT package_id,owner_id,project_id,task_id,attempt_id,status,finalized_at FROM m7_review_packages ORDER BY finalized_at,package_id").all() as Array<Record<string, unknown>>) add({ eventId: `m8-package-${row["package_id"]}`, eventKind: "review-package-generated", ownerId: String(row["owner_id"]), projectId: String(row["project_id"]), taskId: String(row["task_id"]), attemptId: String(row["attempt_id"]), source: "m7_review_packages", actorCategory: "control-plane", newState: String(row["status"]), summary: "Sanitized M7 review package generated.", occurredAt: String(row["finalized_at"]) });
  }

  private cleanupStaging(): void {
    rejectLinks(this.root);
    for (const entry of readdirSync(this.root, { withFileTypes: true })) if (entry.name.startsWith(".staging")) { const target = resolve(this.root, entry.name); if (!contained(this.root, target) || entry.isSymbolicLink()) throw new Error("unsafe Bridge Log staging entry"); rmSync(target, { recursive: true, force: true }); }
  }

  private render(rows: readonly EventRow[]): string {
    const first = rows.at(0)?.sequence ?? 0; const last = rows.at(-1)?.sequence ?? 0;
    const blocks = rows.map((row) => [`## ${String(row.sequence).padStart(10, "0")} · ${markdown(row.event_kind)}`, `- Event ID: \`${markdown(row.event_id)}\``, `- Cursor: ${row.sequence}`, `- Timestamp: ${markdown(row.occurred_at)}`, `- Source: ${markdown(row.source)}`, `- Actor: ${markdown(row.actor_category)}`, `- Project / task / attempt / operation: ${[row.project_id,row.task_id,row.attempt_id,row.operation_id].map(markdown).join(" / ")}`, `- State: ${markdown(row.old_state)} → ${markdown(row.new_state)}`, `- Summary: ${markdown(row.summary)}`, `- Authoritative digest: \`${row.event_digest}\``].join("\n"));
    const content = [`# CHUBZ AI Bridge Log`, ``, `> Non-authoritative, read-only projection. Control Plane SQLite state and the operation journal remain authoritative. Manual edits are discarded during repair.`, ``, `- Projection schema: \`${SCHEMA}\``, `- Projected cursor: ${last}`, `- Retained projection range: ${first}–${last}`, `- Entry count: ${rows.length}`, ``, ...blocks].join("\n\n") + "\n";
    if (Buffer.byteLength(content) > M8_LIMITS.maxProjectionBytes) throw new M6Error("CONFLICT", "Bridge Log projection exceeds its size bound");
    return content;
  }

  public verify(): Record<string, unknown> {
    this.syncAuthoritativeEvents();
    const state = this.database.connection.prepare("SELECT * FROM m8_projection_state WHERE projection_id=1").get() as Record<string, unknown>;
    const rows = this.database.connection.prepare("SELECT * FROM m8_operational_events ORDER BY sequence").all() as EventRow[];
    const internalGap = rows.some((row, index) => index > 0 && row.sequence !== rows[index - 1]!.sequence + 1);
    const badDigest = rows.some((row) => {
      const core = { schemaVersion: SCHEMA, eventId: row.event_id, eventKind: row.event_kind, ownerId: row.owner_id, projectId: row.project_id, taskId: row.task_id, attemptId: row.attempt_id, operationId: row.operation_id, source: row.source, actorCategory: row.actor_category, oldState: row.old_state, newState: row.new_state, summary: row.summary, details: JSON.parse(row.details_json) as unknown, occurredAt: row.occurred_at };
      return row.event_digest !== sha256(`chubz.m8.operational-event/v1\n${canonical(core)}`);
    });
    if (internalGap || badDigest || Number(state["cursor_sequence"]) !== (rows.at(-1)?.sequence ?? 0)) { this.projectionProblem("projection-cursor-gap", "gap", badDigest ? "Authoritative event digest verification failed." : "Projection cursor does not match contiguous authoritative events."); return this.status(); }
    try {
      rejectLinks(this.file); const bytes = readFileSync(this.file); const actual = sha256(bytes);
      if (state["file_digest"] !== actual) { this.projectionProblem("projection-tampering", "tampered", "Bridge Log file was edited, removed, or corrupted."); return this.status(); }
      this.database.connection.prepare("UPDATE m8_projection_state SET status='current',verified_at=?,failure_reason=NULL,version=version+1 WHERE projection_id=1").run(new Date().toISOString());
    } catch { this.projectionProblem("projection-tampering", "tampered", "Bridge Log file is missing or unreadable."); }
    return this.status();
  }

  public project(): Record<string, unknown> {
    this.syncAuthoritativeEvents(); this.cleanupStaging(); rejectLinks(this.root);
    const rows = this.database.connection.prepare("SELECT * FROM m8_operational_events ORDER BY sequence DESC LIMIT ?").all(M8_LIMITS.maxEvents).reverse() as EventRow[];
    const content = this.render(rows); const bytes = Buffer.from(content, "utf8"); const digest = sha256(bytes); const at = new Date().toISOString();
    writeFileSync(this.staging, bytes, { flag: "wx", mode: 0o600 }); renameSync(this.staging, this.file);
    this.database.connection.prepare("UPDATE m8_projection_state SET cursor_sequence=?,projected_event_count=?,status='current',file_digest=?,verified_at=?,rebuilt_at=?,failure_reason=NULL,version=version+1 WHERE projection_id=1").run(rows.at(-1)?.sequence ?? 0, rows.length, digest, at, at);
    return this.status();
  }

  public rebuild(principal: Principal, raw: Record<string, unknown>): Record<string, unknown> {
    const idempotencyKey = key(raw["idempotencyKey"]); const expectedVersion = version(raw["expectedVersion"]);
    return this.mutation(`projection.rebuild:${principal.administratorId}`, idempotencyKey, { expectedVersion }, () => {
      const current = this.database.connection.prepare("SELECT version FROM m8_projection_state WHERE projection_id=1").get() as { version: number };
      if (current.version !== expectedVersion) throw new M6Error("STALE_STATE", "projection state is stale");
      this.database.connection.prepare("UPDATE m8_projection_state SET status='rebuilding',version=version+1 WHERE projection_id=1").run();
      const result = this.project(); this.record({ eventId: `m8-projection-rebuilt-${idempotencyKey}`, eventKind: "projection-rebuilt", ownerId: principal.administratorId, source: "m8_projection_state", actorCategory: "owner", summary: "Owner rebuilt the Bridge Log from authoritative events.", occurredAt: new Date().toISOString() }); this.project();
      return { ...result, replayed: false };
    });
  }

  public verifyProtected(principal: Principal, raw: Record<string, unknown>): Record<string, unknown> {
    const idempotencyKey = key(raw["idempotencyKey"]); const expectedVersion = version(raw["expectedVersion"]);
    return this.mutation(`projection.verify:${principal.administratorId}`, idempotencyKey, { expectedVersion }, () => {
      const current = this.database.connection.prepare("SELECT version FROM m8_projection_state WHERE projection_id=1").get() as { version: number };
      if (current.version !== expectedVersion) throw new M6Error("STALE_STATE", "projection state is stale");
      return { ...this.verify(), replayed: false };
    });
  }

  private projectionProblem(condition: "projection-cursor-gap" | "projection-tampering", status: "gap" | "tampered", note: string): void {
    this.database.connection.prepare("UPDATE m8_projection_state SET status=?,failure_reason=?,verified_at=?,version=version+1 WHERE projection_id=1").run(status, note, new Date().toISOString());
    this.upsertIncident({ condition, severity: "high", evidence: { projectionFile: "bridge-log.md", authoritative: "m8_operational_events" }, allowedActions: ["acknowledge","rebuild-projection"], notes: note });
  }

  private upsertIncident(input: Readonly<{ condition: string; ownerId?: string | null; projectId?: string | null; taskId?: string | null; attemptId?: string | null; operationId?: string | null; severity: "info" | "warning" | "high" | "critical"; evidence: Record<string, unknown>; allowedActions: readonly string[]; notes: string; relatedRefs?: readonly string[] }>): string {
    const binding = { condition: input.condition, projectId: input.projectId ?? null, taskId: input.taskId ?? null, attemptId: input.attemptId ?? null, operationId: input.operationId ?? null };
    const incidentId = `incident-${createHash("sha256").update(`chubz.m8.incident/v1\n${canonical(binding)}`).digest("hex").slice(0, 48)}`; const at = new Date().toISOString(); const notes = sanitize(input.notes, M8_LIMITS.maxNotesBytes);
    this.database.connection.prepare(`INSERT INTO m8_recovery_incidents(incident_id,owner_id,project_id,task_id,attempt_id,operation_id,condition,evidence_json,severity,first_detected_at,latest_detected_at,resolution_state,allowed_actions_json,blocked_actions_json,related_refs_json,notes,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?,0) ON CONFLICT(incident_id) DO UPDATE SET latest_detected_at=excluded.latest_detected_at,evidence_json=excluded.evidence_json,severity=excluded.severity,allowed_actions_json=excluded.allowed_actions_json,notes=excluded.notes,version=m8_recovery_incidents.version+1`).run(incidentId, input.ownerId ?? null, input.projectId ?? null, input.taskId ?? null, input.attemptId ?? null, input.operationId ?? null, input.condition, canonical(input.evidence), input.severity, at, at, jsonArray(input.allowedActions), jsonArray(["automatic-rerun","force-success","journal-rewrite","database-override","owner-project-mutation"]), jsonArray(input.relatedRefs ?? []), notes);
    return incidentId;
  }

  public reconcileAfterRestart(): void {
    const db = this.database.connection; const at = new Date().toISOString(); const runId = "reconciliation-control-plane-start";
    db.prepare("INSERT OR IGNORE INTO m8_reconciliation_runs(run_id,trigger_kind,status,started_at,summary_json) VALUES(?,'control-plane-start','running',?,'{}')").run(runId, at);
    let incidents = 0;
    for (const row of db.prepare("SELECT q.task_id,q.attempt_id,q.operation_id,t.project_id FROM m4_dispatch_queue q JOIN tasks t ON t.task_id=q.task_id WHERE q.status='claimed' AND t.state='AWAITING_DISPATCH'").all() as Array<{ task_id: string; attempt_id: string; operation_id: string; project_id: string }>) { this.upsertIncident({ condition: "operation-reserved-not-started", projectId: row.project_id, taskId: row.task_id, attemptId: row.attempt_id, operationId: row.operation_id, severity: "high", evidence: { queueState: "claimed", taskState: "AWAITING_DISPATCH" }, allowedActions: ["acknowledge","create-new-attempt"], notes: "Dispatch was reserved before restart but execution start is not authoritative." }); incidents += 1; }
    for (const row of db.prepare("SELECT t.task_id,t.attempt_id,t.current_operation_id,t.project_id,t.state FROM tasks t WHERE t.state IN ('RUNNING','CANCELLING') AND NOT EXISTS(SELECT 1 FROM m4_results r WHERE r.task_id=t.task_id AND r.operation_id=t.current_operation_id)").all() as Array<{ task_id: string; attempt_id: string; current_operation_id: string; project_id: string; state: string }>) {
      this.upsertIncident({ condition: row.state === "CANCELLING" ? "cancellation-outcome-uncertain" : "operation-started-completion-unknown", projectId: row.project_id, taskId: row.task_id, attemptId: row.attempt_id, operationId: row.current_operation_id, severity: "critical", evidence: { taskState: row.state, terminalResult: false }, allowedActions: ["acknowledge","mark-reviewed"], notes: "Execution may have started and has no authoritative terminal result; automatic retry is blocked." });
      if (row.state === "CANCELLING") db.prepare("UPDATE m8_stop_operations SET cancellation_state='uncertain',updated_at=?,evidence_json=? WHERE operation_id=? AND cancellation_state='requested'").run(at, canonical({ restartReconciliation: true, terminationConfirmed: false }), row.current_operation_id);
      incidents += 1;
    }
    for (const row of db.prepare("SELECT capture_id,owner_id,project_id,task_id,attempt_id,operation_id FROM m7_capture_requests WHERE status='incomplete' AND failure_reason='capture interrupted by restart'").all() as Array<{ capture_id: string; owner_id: string; project_id: string; task_id: string; attempt_id: string; operation_id: string }>) { this.upsertIncident({ condition: "capture-interrupted", ownerId: row.owner_id, projectId: row.project_id, taskId: row.task_id, attemptId: row.attempt_id, operationId: row.operation_id, severity: "warning", evidence: { captureId: row.capture_id, status: "incomplete" }, allowedActions: ["acknowledge","non-executing-evidence-verification"], relatedRefs: [row.capture_id], notes: "M7 evidence capture was interrupted and remains incomplete." }); incidents += 1; }
    const summary = { incidents, activeStops: (db.prepare("SELECT COUNT(*) AS n FROM m8_emergency_stops WHERE status='active'").get() as { n: number }).n, automaticExecutionRetries: 0 };
    db.prepare("UPDATE m8_reconciliation_runs SET status=?,completed_at=?,summary_json=?,run_digest=? WHERE run_id=?").run(incidents ? "completed-with-incidents" : "completed", at, canonical(summary), sha256(canonical(summary)), runId);
    if (!db.prepare("SELECT 1 FROM m8_operational_events WHERE event_id='m8-reconciliation-control-plane-start'").get()) this.record({ eventId: "m8-reconciliation-control-plane-start", eventKind: "reconciliation-completed", source: "m8_reconciliation_runs", actorCategory: "system-recovery", summary: `Control Plane restart reconciliation completed with ${incidents} incident(s) and no automatic execution retry.`, occurredAt: at });
  }

  private scopeVersion(scopeKey: string): number {
    const at = new Date().toISOString(); this.database.connection.prepare("INSERT OR IGNORE INTO m8_emergency_state(scope_key,version,updated_at) VALUES(?,0,?)").run(scopeKey, at);
    return (this.database.connection.prepare("SELECT version FROM m8_emergency_state WHERE scope_key=?").get(scopeKey) as { version: number }).version;
  }

  public activateStop(principal: Principal, raw: Record<string, unknown>): Record<string, unknown> {
    const scopeType = raw["scopeType"] === "global" ? "global" : raw["scopeType"] === "project" ? "project" : null; if (!scopeType) throw new M6Error("INVALID_REQUEST", "emergency-stop scope is invalid");
    const projectId = scopeType === "project" ? safeId(raw["projectId"], "projectId") : null; const reason = sanitize(raw["reason"], M8_LIMITS.maxReasonBytes); const expectedVersion = version(raw["expectedVersion"]); const idempotencyKey = key(raw["idempotencyKey"]); const scopeKey = projectId === null ? "global" : `project:${projectId}`;
    if (projectId !== null && !this.database.connection.prepare("SELECT 1 FROM tasks WHERE project_id=? LIMIT 1").get(projectId)) throw new M6Error("NOT_FOUND", "project was not found");
    return this.mutation(`emergency.activate:${principal.administratorId}:${scopeKey}`, idempotencyKey, { scopeType, projectId, reason, expectedVersion }, () => this.database.connection.transaction(() => {
      if (this.scopeVersion(scopeKey) !== expectedVersion) throw new M6Error("STALE_STATE", "emergency-stop state is stale");
      const active = this.database.connection.prepare("SELECT stop_id FROM m8_emergency_stops WHERE status='active' AND scope_type=? AND project_id IS ?").get(scopeType, projectId) as { stop_id: string } | undefined; if (active) throw new M6Error("CONFLICT", "an emergency stop is already active for this scope");
      const at = new Date().toISOString(); const stopId = `stop-${randomUUID()}`;
      this.database.connection.prepare("INSERT INTO m8_emergency_stops(stop_id,scope_type,project_id,owner_id,reason,status,activated_at) VALUES(?,?,?,?,?,'active',?)").run(stopId, scopeType, projectId, principal.administratorId, reason, at);
      this.database.connection.prepare("UPDATE m8_emergency_state SET version=version+1,updated_at=? WHERE scope_key=?").run(at, scopeKey);
      const predicate = projectId === null ? "1=1" : "project_id=@projectId";
      const tasks = (projectId === null ? this.database.connection.prepare(`SELECT task_id,project_id,current_operation_id,state FROM tasks WHERE ${predicate} AND current_operation_id IS NOT NULL AND state IN ('AWAITING_DISPATCH','RUNNING','CANCELLING')`).all() : this.database.connection.prepare(`SELECT task_id,project_id,current_operation_id,state FROM tasks WHERE ${predicate} AND current_operation_id IS NOT NULL AND state IN ('AWAITING_DISPATCH','RUNNING','CANCELLING')`).all({ projectId })) as Array<{ task_id: string; project_id: string; current_operation_id: string; state: string }>;
      for (const task of tasks) {
        const cancellationState = task.state === "AWAITING_DISPATCH" ? "blocked-before-start" : "requested";
        this.database.connection.prepare("INSERT INTO m8_stop_operations(stop_id,operation_id,task_id,cancellation_state,requested_at,updated_at,evidence_json) VALUES(?,?,?,?,?,?,?)").run(stopId, task.current_operation_id, task.task_id, cancellationState, cancellationState === "requested" ? at : null, at, canonical({ priorTaskState: task.state, bridgeConfirmation: null }));
      }
      if (projectId === null) {
        this.database.connection.prepare("UPDATE m4_dispatch_queue SET status='emergency-blocked' WHERE status='queued'").run();
        this.database.connection.prepare("UPDATE m4_grants SET status='revoked',revoked_at=? WHERE status='issued' AND consumed_at IS NULL").run(at);
      } else {
        this.database.connection.prepare("UPDATE m4_dispatch_queue SET status='emergency-blocked' WHERE status='queued' AND task_id IN (SELECT task_id FROM tasks WHERE project_id=@projectId)").run({ projectId });
        this.database.connection.prepare("UPDATE m4_grants SET status='revoked',revoked_at=@at WHERE status='issued' AND consumed_at IS NULL AND task_id IN (SELECT task_id FROM tasks WHERE project_id=@projectId)").run({ at, projectId });
      }
      this.record({ eventId: `m8-stop-activated-${stopId}`, eventKind: "emergency-stop-activated", ownerId: principal.administratorId, projectId, source: "m8_emergency_stops", actorCategory: "owner", newState: "active", summary: `${scopeType === "global" ? "Global" : "Project"} emergency stop activated.`, details: { stopId, scopeType, cancellationRequests: tasks.filter((task) => task.state !== "AWAITING_DISPATCH").length }, occurredAt: at });
      for (const task of tasks) this.publisher?.(task.task_id, "emergency-stop.blocked"); this.project();
      return { stopId, scopeType, projectId, ownerId: principal.administratorId, reason, status: "active", activatedAt: at, version: expectedVersion + 1, cancellations: tasks.map((task) => ({ taskId: task.task_id, operationId: task.current_operation_id, state: task.state === "AWAITING_DISPATCH" ? "blocked-before-start" : "requested", confirmed: false })), replayed: false };
    })());
  }

  public releaseStop(principal: Principal, stopIdRaw: unknown, raw: Record<string, unknown>): Record<string, unknown> {
    const stopId = safeId(stopIdRaw, "stopId"); const expectedVersion = version(raw["expectedVersion"]); const idempotencyKey = key(raw["idempotencyKey"]);
    return this.mutation(`emergency.release:${principal.administratorId}:${stopId}`, idempotencyKey, { stopId, expectedVersion }, () => this.database.connection.transaction(() => {
      const stop = this.database.connection.prepare("SELECT * FROM m8_emergency_stops WHERE stop_id=? AND owner_id=?").get(stopId, principal.administratorId) as Record<string, unknown> | undefined; if (!stop) throw new M6Error("NOT_FOUND", "emergency stop was not found"); if (stop["status"] !== "active") throw new M6Error("CONFLICT", "emergency stop is not active");
      const scopeKey = stop["scope_type"] === "global" ? "global" : `project:${String(stop["project_id"])}`; if (this.scopeVersion(scopeKey) !== expectedVersion) throw new M6Error("STALE_STATE", "emergency-stop state is stale");
      const at = new Date().toISOString(); this.database.connection.prepare("UPDATE m8_emergency_stops SET status='released',released_at=?,released_by=?,version=version+1 WHERE stop_id=? AND status='active'").run(at, principal.administratorId, stopId); this.database.connection.prepare("UPDATE m8_emergency_state SET version=version+1,updated_at=? WHERE scope_key=?").run(at, scopeKey);
      this.record({ eventId: `m8-stop-released-${stopId}`, eventKind: "emergency-stop-released", ownerId: principal.administratorId, projectId: stop["project_id"] as string | null, source: "m8_emergency_stops", actorCategory: "owner", oldState: "active", newState: "released", summary: "Emergency stop released; blocked work was not resumed or retried.", details: { stopId, autoResumed: false }, occurredAt: at }); this.project();
      return { stopId, status: "released", releasedAt: at, version: expectedVersion + 1, autoResumed: false, replayed: false };
    })());
  }

  public acknowledgeIncident(principal: Principal, incidentIdRaw: unknown, raw: Record<string, unknown>): Record<string, unknown> {
    const incidentId = safeId(incidentIdRaw, "incidentId"); const expectedVersion = version(raw["expectedVersion"]); const idempotencyKey = key(raw["idempotencyKey"]);
    return this.mutation(`incident.acknowledge:${principal.administratorId}:${incidentId}`, idempotencyKey, { incidentId, expectedVersion }, () => {
      const row = this.database.connection.prepare("SELECT * FROM m8_recovery_incidents WHERE incident_id=? AND (owner_id IS NULL OR owner_id=?)").get(incidentId, principal.administratorId) as IncidentRow | undefined; if (!row) throw new M6Error("NOT_FOUND", "recovery incident was not found"); if (row.version !== expectedVersion) throw new M6Error("STALE_STATE", "incident state is stale"); if (["resolved","closed"].includes(row.resolution_state)) throw new M6Error("CONFLICT", "incident is already resolved");
      const at = new Date().toISOString(); this.database.connection.prepare("UPDATE m8_recovery_incidents SET resolution_state='acknowledged',resolution_provenance_json=?,version=version+1 WHERE incident_id=? AND version=?").run(canonical({ ownerId: principal.administratorId, action: "acknowledge", at }), incidentId, expectedVersion); this.record({ eventId: `m8-incident-ack-${incidentId}-${expectedVersion}`, eventKind: "recovery-incident-acknowledged", ownerId: principal.administratorId, projectId: row.project_id, taskId: row.task_id, attemptId: row.attempt_id, operationId: row.operation_id, source: "m8_recovery_incidents", actorCategory: "owner", oldState: row.resolution_state, newState: "acknowledged", summary: "Owner acknowledged a recovery incident without changing authoritative task outcome.", occurredAt: at }); this.project();
      return { incidentId, resolutionState: "acknowledged", version: expectedVersion + 1, replayed: false };
    });
  }

  public closeIncident(principal: Principal, incidentIdRaw: unknown, raw: Record<string, unknown>): Record<string, unknown> {
    const incidentId = safeId(incidentIdRaw, "incidentId"); const expectedVersion = version(raw["expectedVersion"]); const idempotencyKey = key(raw["idempotencyKey"]);
    return this.mutation(`incident.close:${principal.administratorId}:${incidentId}`, idempotencyKey, { incidentId, expectedVersion }, () => {
      const row = this.database.connection.prepare("SELECT * FROM m8_recovery_incidents WHERE incident_id=? AND (owner_id IS NULL OR owner_id=?)").get(incidentId, principal.administratorId) as IncidentRow | undefined; if (!row) throw new M6Error("NOT_FOUND", "recovery incident was not found"); if (row.version !== expectedVersion) throw new M6Error("STALE_STATE", "incident state is stale");
      const stillActive = row.condition.startsWith("projection-") ? (this.database.connection.prepare("SELECT status FROM m8_projection_state WHERE projection_id=1").get() as { status: string }).status !== "current" : row.condition === "capture-interrupted" ? this.database.connection.prepare("SELECT 1 FROM m7_capture_requests WHERE capture_id IN (SELECT value FROM json_each(?)) AND status='incomplete'").get(row.related_refs_json) !== undefined : row.operation_id !== null && this.database.connection.prepare("SELECT 1 FROM tasks WHERE task_id=? AND current_operation_id=? AND state IN ('RUNNING','CANCELLING') AND NOT EXISTS(SELECT 1 FROM m4_results WHERE operation_id=?)").get(row.task_id, row.operation_id, row.operation_id) !== undefined;
      if (stillActive) throw new M6Error("CONFLICT", "authoritative evidence does not support closing this incident");
      const at = new Date().toISOString(); this.database.connection.prepare("UPDATE m8_recovery_incidents SET resolution_state='closed',resolution_provenance_json=?,version=version+1 WHERE incident_id=? AND version=?").run(canonical({ ownerId: principal.administratorId, action: "close-after-authoritative-verification", at }), incidentId, expectedVersion);
      this.record({ eventId: `m8-incident-closed-${incidentId}-${expectedVersion}`, eventKind: "recovery-incident-closed", ownerId: principal.administratorId, projectId: row.project_id, taskId: row.task_id, attemptId: row.attempt_id, operationId: row.operation_id, source: "m8_recovery_incidents", actorCategory: "owner", oldState: row.resolution_state, newState: "closed", summary: "Owner closed a recovery incident after authoritative evidence no longer showed the condition.", occurredAt: at }); this.project();
      return { incidentId, resolutionState: "closed", version: expectedVersion + 1, replayed: false };
    });
  }

  public status(): Record<string, unknown> {
    const projection = this.database.connection.prepare("SELECT * FROM m8_projection_state WHERE projection_id=1").get() as Record<string, unknown>;
    const bridge = this.database.connection.prepare("SELECT bridge_id,connection_state,last_seen_at,updated_at,version FROM m8_bridge_state WHERE bridge_id='local-bridge'").get() as Record<string, unknown>;
    const stops = this.database.connection.prepare("SELECT s.*,e.version AS scope_version FROM m8_emergency_stops s JOIN m8_emergency_state e ON e.scope_key=CASE WHEN s.scope_type='global' THEN 'global' ELSE 'project:'||s.project_id END WHERE s.status='active' ORDER BY s.scope_type,s.project_id").all() as Array<Record<string, unknown>>;
    const incidents = this.database.connection.prepare("SELECT * FROM m8_recovery_incidents WHERE resolution_state!='closed' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,latest_detected_at DESC LIMIT ?").all(M8_LIMITS.maxEntriesReturned) as IncidentRow[];
    const entries = this.database.connection.prepare("SELECT sequence,event_id,event_kind,project_id,task_id,attempt_id,operation_id,source,actor_category,old_state,new_state,summary,event_digest,occurred_at FROM m8_operational_events ORDER BY sequence DESC LIMIT ?").all(M8_LIMITS.maxEntriesReturned) as Array<Record<string, unknown>>;
    const reconciliation = this.database.connection.prepare("SELECT * FROM m8_reconciliation_runs ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    const scopeVersions = this.database.connection.prepare("SELECT scope_key,version FROM m8_emergency_state ORDER BY scope_key").all() as Array<{ scope_key: string; version: number }>;
    return { projection: { schemaVersion: projection["schema_version"], cursor: projection["cursor_sequence"], entryCount: projection["projected_event_count"], status: projection["status"], verifiedAt: projection["verified_at"], rebuiltAt: projection["rebuilt_at"], failureReason: projection["failure_reason"], version: projection["version"], authoritative: false, editable: false }, bridge: { id: bridge["bridge_id"], availability: bridge["connection_state"], connected: bridge["connection_state"] === "connected", lastSeenAt: bridge["last_seen_at"], updatedAt: bridge["updated_at"], failClosed: bridge["connection_state"] !== "connected" }, emergency: { active: stops.length > 0, scopeVersions: Object.fromEntries(scopeVersions.map((row) => [row.scope_key, row.version])), stops: stops.map((stop) => ({ stopId: stop["stop_id"], scopeType: stop["scope_type"], projectId: stop["project_id"], ownerId: stop["owner_id"], reason: stop["reason"], status: stop["status"], activatedAt: stop["activated_at"], version: stop["scope_version"], cancellation: this.database.connection.prepare("SELECT task_id,operation_id,cancellation_state,requested_at,updated_at FROM m8_stop_operations WHERE stop_id=? ORDER BY task_id").all(stop["stop_id"]) })) }, incidents: incidents.map((row) => ({ incidentId: row.incident_id, projectId: row.project_id, taskId: row.task_id, attemptId: row.attempt_id, operationId: row.operation_id, condition: row.condition, severity: row.severity, firstDetectedAt: row.first_detected_at, latestDetectedAt: row.latest_detected_at, resolutionState: row.resolution_state, allowedActions: JSON.parse(row.allowed_actions_json), blockedActions: JSON.parse(row.blocked_actions_json), relatedRefs: JSON.parse(row.related_refs_json), notes: row.notes, evidence: JSON.parse(row.evidence_json), version: row.version })), entries: entries.reverse().map((row) => ({ sequence: row["sequence"], eventId: row["event_id"], eventKind: row["event_kind"], projectId: row["project_id"], taskId: row["task_id"], attemptId: row["attempt_id"], operationId: row["operation_id"], source: row["source"], actorCategory: row["actor_category"], oldState: row["old_state"], newState: row["new_state"], summary: row["summary"], eventDigest: row["event_digest"], occurredAt: row["occurred_at"], projectionSchemaVersion: SCHEMA })), reconciliation: reconciliation ? { runId: reconciliation["run_id"], triggerKind: reconciliation["trigger_kind"], status: reconciliation["status"], startedAt: reconciliation["started_at"], completedAt: reconciliation["completed_at"], summary: JSON.parse(String(reconciliation["summary_json"])) } : null };
  }
}
