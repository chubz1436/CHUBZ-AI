import { createHash, randomUUID } from "node:crypto";
import {
  canTransition,
  detectRedactions,
  digestApprovalAction,
  digestWriteScope,
  evaluateAssignmentDispatch,
  parseApprovalAction,
  parseAdapterReadiness,
  parseAssignment,
  parseLease,
  redactText,
  verifyWriteScope,
  type ApprovalAction,
  type Assignment,
  type AdapterReadiness,
  type BlockedContext,
  type CapabilityGrant,
  type Lease,
  type TaskState,
  type TransitionRequest,
  type WriteScope,
} from "@chubz/shared";
import type { ControlPlaneDatabase } from "./database.js";
import { deriveApprovalId, type Clock, Phase1GrantKey, systemClock } from "./grant-engine.js";

export const M4_LIMITS = Object.freeze({
  maxTaskInputBytes: 64 * 1024,
  maxActionBytes: 32 * 1024,
  maxResultBytes: 64 * 1024,
  globalConcurrency: 2,
  projectConcurrency: 1,
  echoWorkerId: "synthetic-echo-worker",
  echoAdapterId: "synthetic-echo-adapter",
  bridgeVerifierId: "local-bridge",
  codexWorkerId: "codex-cli",
  codexAdapterId: "codex-cli-adapter",
} as const);

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CODEX_EVIDENCE_ID = /^evidence\.codex\.sha256\.([0-9a-f]{64})$/u;
const sha256 = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
};
const assertId = (value: string, label: string): void => {
  if (!ID.test(value) || value.includes("..")) throw new M4Error("INVALID_INPUT", `${label} is invalid`);
};
const bounded = (value: unknown, maximum: number, label: string): string => {
  const result = JSON.stringify(value);
  if (result === undefined || Buffer.byteLength(result) > maximum) throw new M4Error("LIMIT_EXCEEDED", `${label} exceeds its bound`);
  return result;
};
const sanitize = (text: string, maximumBytes: number): string => {
  if (Buffer.byteLength(text) > maximumBytes) throw new M4Error("LIMIT_EXCEEDED", "text exceeds its bound");
  const findings = detectRedactions(text);
  if (!findings.ok) throw new M4Error("INVALID_INPUT", "text could not be sanitized");
  const redacted = redactText(text, findings.value);
  if (!redacted.ok) throw new M4Error("INVALID_INPUT", "text could not be sanitized");
  return redacted.value.text;
};
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const degradedCodexFallbackEligible = (readiness: AdapterReadiness, evidence: unknown): boolean => {
  if (readiness.readinessState !== "degraded" || readiness.healthStatus !== "degraded" || readiness.freezeState !== "enabled" || !object(evidence) || evidence.compatibility !== "passed" || !object(evidence.windowsSandbox)) return false;
  const sandbox = evidence.windowsSandbox;
  return sandbox.configuredImplementation === "elevated" && sandbox.selectedImplementation === "unelevated" && sandbox.elevatedProbeResult === "failed" && typeof sandbox.elevatedFailureClassification === "string" && sandbox.fallbackSelected === true && sandbox.fallbackCanaryResult === "passed" && sandbox.assurance === "degraded-bounded-local";
};

export type M4ErrorCode =
  | "INVALID_INPUT" | "LIMIT_EXCEEDED" | "NOT_FOUND" | "CONFLICT" | "STALE_VERSION"
  | "ILLEGAL_TRANSITION" | "STOP_POINT" | "IDEMPOTENCY_CONFLICT" | "QUEUE_EMPTY";
export class M4Error extends Error {
  public constructor(public readonly code: M4ErrorCode, message: string) { super(message); this.name = "M4Error"; }
}

type TaskRow = {
  task_id: string; project_id: string; state: TaskState; attempt_id: string | null;
  blocked_context_json: string | null; version: number; current_operation_id: string | null;
};
type AttemptRow = { attempt_id: string; task_id: string; action_json: string; action_digest: string; input_text: string };
type AssignmentRow = { assignment_id: string; assignment_json: string; status: string; worker_id: string; operation_id: string };
type ApprovalRow = { approval_id: string; owner_id: string; status: string; action_digest: string; scope_hash: string; worker_id: string };
type GrantRow = { grant_id: string; approval_id: string; status: string; grant_json: string; expires_at: string; revoked_at: string | null; consumed_at: string | null; result_ref: string | null };
type LeaseRow = { lease_id: string; status: string; generation: number; lease_json: string };
type ScopeRow = { scope_id: string; scope_hash: string; scope_json: string };

export type DispatchCommand = Readonly<{
  commandId: string;
  taskId: string;
  attemptId: string;
  operationId: string;
  projectId: string;
  ownerId: string;
  workerId: typeof M4_LIMITS.echoWorkerId;
  adapterId: typeof M4_LIMITS.echoAdapterId;
  action: ApprovalAction;
  taskInput: string;
  assignment: Assignment;
  lease: Lease;
  writeScope: WriteScope;
  grant: CapabilityGrant;
}>;

export type CodexDispatchCommand = Readonly<{
  commandId: string;
  taskId: string;
  attemptId: string;
  operationId: string;
  projectId: string;
  ownerId: string;
  workerId: typeof M4_LIMITS.codexWorkerId;
  adapterId: typeof M4_LIMITS.codexAdapterId;
  action: ApprovalAction;
  taskInput: string;
  assignment: Assignment;
  lease: Lease;
  writeScope: WriteScope;
  grant: CapabilityGrant;
  readiness: AdapterReadiness;
}>;

export type BridgeResult = Readonly<{
  operationId: string;
  state: "completed" | "failed" | "cancelled" | "execution-unknown";
  output: string;
  outputTruncated: boolean;
  failureCode: string | null;
  journalRef: string;
  resultRef: string;
}>;

export class M4Orchestrator {
  public constructor(
    private readonly database: ControlPlaneDatabase,
    private readonly grantKey: Phase1GrantKey,
    private readonly clock: Clock = systemClock,
  ) {}

  private now(): string { return this.clock.now().toISOString(); }
  private task(taskId: string): TaskRow {
    const row = this.database.connection.prepare("SELECT task_id,project_id,state,attempt_id,blocked_context_json,version,current_operation_id FROM tasks WHERE task_id=?").get(taskId) as TaskRow | undefined;
    if (!row) throw new M4Error("NOT_FOUND", "task was not found");
    return row;
  }
  private attempt(attemptId: string): AttemptRow {
    const row = this.database.connection.prepare("SELECT attempt_id,task_id,action_json,action_digest,input_text FROM task_attempts WHERE attempt_id=?").get(attemptId) as AttemptRow | undefined;
    if (!row) throw new M4Error("NOT_FOUND", "attempt was not found");
    return row;
  }

  private appendEvent(streamId: string, eventKind: string, subject: Record<string, unknown>): string {
    const db = this.database.connection;
    const eventId = `event-${randomUUID()}`;
    const event = { eventVersion: "1.0", eventId, eventKind, occurredAt: this.now(), subject };
    const payload = bounded(event, M4_LIMITS.maxResultBytes, "event");
    const stream = db.prepare("SELECT head_sequence FROM event_streams WHERE stream_id=?").get(streamId) as { head_sequence: number } | undefined;
    const sequence = (stream?.head_sequence ?? 0) + 1;
    if (stream) db.prepare("UPDATE event_streams SET head_sequence=? WHERE stream_id=?").run(sequence, streamId);
    else db.prepare("INSERT INTO event_streams(stream_id,head_sequence,oldest_retained_sequence) VALUES(?,?,1)").run(streamId, sequence);
    db.prepare("INSERT INTO events(stream_id,sequence,event_id,payload_json,occurred_at) VALUES(?,?,?,?,?)").run(streamId, sequence, eventId, payload, this.now());
    return eventId;
  }

  private command<T>(scope: string, commandId: string, request: unknown, execute: () => T): T {
    assertId(commandId, "commandId");
    const db = this.database.connection;
    const requestDigest = sha256(canonical(request));
    const existing = db.prepare("SELECT request_digest,result_json FROM m4_commands WHERE command_scope=? AND command_id=?").get(scope, commandId) as { request_digest: string; result_json: string | null } | undefined;
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new M4Error("IDEMPOTENCY_CONFLICT", "command identity conflicts with a prior request");
      if (existing.result_json === null) throw new M4Error("CONFLICT", "the original command is still in progress");
      return JSON.parse(existing.result_json) as T;
    }
    db.prepare("INSERT INTO m4_commands(command_scope,command_id,request_digest,result_json,recorded_at) VALUES(?,?,?,?,?)").run(scope, commandId, requestDigest, null, this.now());
    try {
      const result = execute();
      db.prepare("UPDATE m4_commands SET result_json=? WHERE command_scope=? AND command_id=?").run(bounded(result, M4_LIMITS.maxResultBytes, "command result"), scope, commandId);
      return result;
    } catch (error) {
      db.prepare("DELETE FROM m4_commands WHERE command_scope=? AND command_id=? AND result_json IS NULL").run(scope, commandId);
      throw error;
    }
  }

  public createTask(commandId: string, input: Readonly<{ taskId: string; projectId: string }>): Readonly<{ taskId: string; state: "DRAFT"; version: 0 }> {
    assertId(input.taskId, "taskId"); assertId(input.projectId, "projectId");
    return this.database.connection.transaction(() => this.command("task.create", commandId, input, () => {
      const at = this.now();
      this.database.connection.prepare("INSERT INTO tasks(task_id,project_id,state,attempt_id,blocked_context_json,updated_at,version,created_at) VALUES(?,?,'DRAFT',NULL,NULL,?,0,?)").run(input.taskId, input.projectId, at, at);
      this.appendEvent(`task-${input.taskId}`, "task.created", { taskId: input.taskId, projectId: input.projectId, state: "DRAFT", version: 0 });
      return Object.freeze({ taskId: input.taskId, state: "DRAFT" as const, version: 0 as const });
    }))();
  }

  public createAttempt(commandId: string, input: Readonly<{ taskId: string; attemptId: string; action: unknown; taskInput: string }>): Readonly<{ attemptId: string; actionDigest: string }> {
    assertId(input.taskId, "taskId"); assertId(input.attemptId, "attemptId");
    const parsedAction = parseApprovalAction(input.action);
    if (!parsedAction.ok) throw new M4Error("INVALID_INPUT", "approval action is invalid");
    const actionJson = bounded(parsedAction.value, M4_LIMITS.maxActionBytes, "action");
    const digest = digestApprovalAction(parsedAction.value);
    if (!digest.ok) throw new M4Error("INVALID_INPUT", "approval action is invalid");
    const safeInput = sanitize(input.taskInput, M4_LIMITS.maxTaskInputBytes);
    if (parsedAction.value.operation !== "worker.dispatch" || parsedAction.value.taskId !== input.taskId || parsedAction.value.attemptId !== input.attemptId || parsedAction.value.target.resourceId !== M4_LIMITS.echoWorkerId || parsedAction.value.parameters.worker.manifestId !== M4_LIMITS.echoWorkerId || parsedAction.value.parameters.worker.manifestVersion !== "1.0.0" || parsedAction.value.parameters.instructionDigest !== sha256(safeInput)) {
      throw new M4Error("STOP_POINT", "only the exact bounded synthetic echo action is authorized for M4");
    }
    return this.database.connection.transaction(() => this.command("attempt.create", commandId, { taskId: input.taskId, attemptId: input.attemptId, actionDigest: digest.value, taskInputDigest: sha256(safeInput) }, () => {
      const task = this.task(input.taskId);
      if (task.state !== "DRAFT" || task.attempt_id !== null) throw new M4Error("CONFLICT", "task cannot accept this initial attempt");
      this.database.connection.prepare("INSERT INTO task_attempts(attempt_id,task_id,attempt_sequence,action_json,action_digest,input_text,created_at) VALUES(?,?,1,?,?,?,?)").run(input.attemptId, input.taskId, actionJson, digest.value, safeInput, this.now());
      const updated = this.database.connection.prepare("UPDATE tasks SET attempt_id=?,current_operation_id=?,updated_at=? WHERE task_id=? AND attempt_id IS NULL").run(input.attemptId, parsedAction.value.operationId, this.now(), input.taskId);
      if (updated.changes !== 1) throw new M4Error("CONFLICT", "attempt was created concurrently");
      this.appendEvent(`task-${input.taskId}`, "attempt.created", { taskId: input.taskId, attemptId: input.attemptId, actionDigest: digest.value });
      return Object.freeze({ attemptId: input.attemptId, actionDigest: digest.value });
    }))();
  }

  public registerCodexReadiness(commandId: string, input: Readonly<{ readiness: unknown; evidence: unknown }>): Readonly<{ readinessId: string; state: string }> {
    const parsed = parseAdapterReadiness(input.readiness);
    if (!parsed.ok || parsed.value.workerId !== M4_LIMITS.codexWorkerId || parsed.value.adapterId !== M4_LIMITS.codexAdapterId || parsed.value.connectorTier !== "cli") throw new M4Error("INVALID_INPUT", "Codex readiness is invalid");
    const evidenceId = object(input.evidence) && typeof input.evidence.evidenceId === "string" ? input.evidence.evidenceId : "";
    const evidenceIdMatch = CODEX_EVIDENCE_ID.exec(evidenceId);
    if (!evidenceIdMatch || parsed.value.readinessId !== `readiness.codex.sha256.${evidenceIdMatch[1]}` || !parsed.value.evidenceRefs.includes(evidenceId) || parsed.value.capabilities.some((capability) => capability.evidenceRef !== null && capability.evidenceRef !== evidenceId)) throw new M4Error("INVALID_INPUT", "Codex readiness evidence identity is invalid");
    const readinessJson = bounded(parsed.value, 64 * 1024, "readiness");
    const evidenceJson = bounded(input.evidence, 64 * 1024, "readiness evidence");
    const findings = detectRedactions(evidenceJson);
    if (!findings.ok || findings.value.length !== 0) throw new M4Error("INVALID_INPUT", "readiness evidence contains secret-like content");
    return this.database.connection.transaction(() => this.command("m5.readiness", commandId, { readinessId: parsed.value.readinessId, readinessDigest: sha256(readinessJson), evidenceDigest: sha256(evidenceJson) }, () => {
      const worker = this.database.connection.prepare("SELECT state FROM m5_worker_states WHERE worker_id=?").get(M4_LIMITS.codexWorkerId) as { state: string } | undefined;
      if (!worker) throw new M4Error("STOP_POINT", "Codex worker state is unavailable");
      this.database.connection.prepare("INSERT INTO m5_adapter_readiness(readiness_id,worker_id,adapter_id,readiness_state,freeze_state,readiness_json,evidence_json,recorded_at) VALUES(?,?,?,?,?,?,?,?)").run(parsed.value.readinessId, parsed.value.workerId, parsed.value.adapterId, parsed.value.readinessState, parsed.value.freezeState, readinessJson, evidenceJson, this.now());
      this.appendEvent("adapter-codex-cli", "adapter.readiness-recorded", { readinessId: parsed.value.readinessId, workerId: parsed.value.workerId, adapterId: parsed.value.adapterId, readinessState: parsed.value.readinessState, freezeState: parsed.value.freezeState });
      return Object.freeze({ readinessId: parsed.value.readinessId, state: parsed.value.readinessState });
    }))();
  }

  public setM5WorkerState(workerId: "codex-cli" | "manual-relay", state: "enabled" | "disabled" | "frozen"): void {
    this.database.connection.prepare("UPDATE m5_worker_states SET state=?,updated_at=? WHERE worker_id=?").run(state, this.now(), workerId);
  }

  public createCodexAttempt(commandId: string, input: Readonly<{ taskId: string; attemptId: string; action: unknown; taskInput: string }>): Readonly<{ attemptId: string; actionDigest: string }> {
    assertId(input.taskId, "taskId"); assertId(input.attemptId, "attemptId");
    const parsedAction = parseApprovalAction(input.action);
    if (!parsedAction.ok) throw new M4Error("INVALID_INPUT", "approval action is invalid");
    const actionJson = bounded(parsedAction.value, M4_LIMITS.maxActionBytes, "action");
    const digest = digestApprovalAction(parsedAction.value);
    if (!digest.ok) throw new M4Error("INVALID_INPUT", "approval action is invalid");
    const safeInput = sanitize(input.taskInput, M4_LIMITS.maxTaskInputBytes);
    if (parsedAction.value.operation !== "worker.dispatch" || parsedAction.value.taskId !== input.taskId || parsedAction.value.attemptId !== input.attemptId || parsedAction.value.target.resourceId !== M4_LIMITS.codexWorkerId || parsedAction.value.parameters.worker.manifestId !== M4_LIMITS.codexWorkerId || parsedAction.value.parameters.worker.manifestVersion !== "1.0.0" || parsedAction.value.parameters.instructionDigest !== sha256(safeInput)) throw new M4Error("STOP_POINT", "only the exact bounded Codex action is authorized for this attempt");
    return this.database.connection.transaction(() => this.command("m5.codex.attempt", commandId, { taskId: input.taskId, attemptId: input.attemptId, actionDigest: digest.value, taskInputDigest: sha256(safeInput) }, () => {
      const task = this.task(input.taskId);
      if (task.state !== "DRAFT" || task.attempt_id !== null) throw new M4Error("CONFLICT", "task cannot accept this initial attempt");
      this.database.connection.prepare("INSERT INTO task_attempts(attempt_id,task_id,attempt_sequence,action_json,action_digest,input_text,created_at) VALUES(?,?,1,?,?,?,?)").run(input.attemptId, input.taskId, actionJson, digest.value, safeInput, this.now());
      const updated = this.database.connection.prepare("UPDATE tasks SET attempt_id=?,current_operation_id=?,updated_at=? WHERE task_id=? AND attempt_id IS NULL").run(input.attemptId, parsedAction.value.operationId, this.now(), input.taskId);
      if (updated.changes !== 1) throw new M4Error("CONFLICT", "attempt was created concurrently");
      this.appendEvent(`task-${input.taskId}`, "attempt.created", { taskId: input.taskId, attemptId: input.attemptId, actionDigest: digest.value, workerId: M4_LIMITS.codexWorkerId });
      return Object.freeze({ attemptId: input.attemptId, actionDigest: digest.value });
    }))();
  }

  public transition(taskId: string, expectedVersion: number, request: TransitionRequest): Readonly<{ state: TaskState; version: number }> {
    assertId(taskId, "taskId");
    return this.database.connection.transaction(() => {
      const current = this.task(taskId);
      if (current.version !== expectedVersion) throw new M4Error("STALE_VERSION", "task version is stale");
      const blockedContext = current.blocked_context_json === null ? undefined : JSON.parse(current.blocked_context_json) as BlockedContext;
      const decision = canTransition({ current: { state: current.state, attemptId: current.attempt_id ?? undefined, blockedContext }, request });
      if (!decision.allowed) throw new M4Error("ILLEGAL_TRANSITION", decision.code);
      const version = current.version + 1;
      const nextAttemptId = request.nextAttemptId ?? current.attempt_id;
      const nextBlocked = request.to === "BLOCKED" ? request.proposedBlockedContext ?? null : null;
      const updated = this.database.connection.prepare("UPDATE tasks SET state=?,attempt_id=?,blocked_context_json=?,current_operation_id=COALESCE(?,current_operation_id),version=?,updated_at=? WHERE task_id=? AND version=?").run(request.to, nextAttemptId, nextBlocked === null ? null : bounded(nextBlocked, 16_384, "blocked context"), request.nextOperationId ?? null, version, this.now(), taskId, expectedVersion);
      if (updated.changes !== 1) throw new M4Error("STALE_VERSION", "task version changed concurrently");
      const eventId = this.appendEvent(`task-${taskId}`, "task.transitioned", { taskId, attemptId: nextAttemptId, from: current.state, to: request.to, actor: request.actor, evidence: request.evidence ?? [], blockedContext: nextBlocked, version });
      this.database.connection.prepare("INSERT INTO task_state_transitions(transition_id,task_id,attempt_id,from_state,to_state,actor,evidence_json,blocked_context_json,expected_version,resulting_version,event_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(`transition-${randomUUID()}`, taskId, nextAttemptId, current.state, request.to, request.actor, bounded(request.evidence ?? [], 8_192, "transition evidence"), nextBlocked === null ? null : bounded(nextBlocked, 16_384, "blocked context"), expectedVersion, version, eventId, this.now());
      return Object.freeze({ state: request.to, version });
    })();
  }

  public activateAttempt(taskId: string, ownerId: string): Readonly<{ state: "AWAITING_DISPATCH"; version: number }> {
    assertId(ownerId, "ownerId");
    const first = this.task(taskId);
    const prepared = this.transition(taskId, first.version, { to: "CONTEXT_PREPARING", actor: "owner" });
    return this.transition(taskId, prepared.version, { to: "AWAITING_DISPATCH", actor: "control-plane" }) as Readonly<{ state: "AWAITING_DISPATCH"; version: number }>;
  }

  public assignEcho(commandId: string, input: Readonly<{ taskId: string; attemptId: string; assignmentId: string; scopeId: string; leaseId: string; ownerAssignmentRef: string; leaseExpiresAt: string }>): Readonly<{ assignmentId: string; leaseId: string; scopeId: string; scopeHash: string }> {
    for (const [label, value] of Object.entries(input)) if (label !== "leaseExpiresAt") assertId(value, label);
    return this.database.connection.transaction(() => this.command("echo.assign", commandId, input, () => {
      const task = this.task(input.taskId); const attempt = this.attempt(input.attemptId);
      if (task.state !== "AWAITING_DISPATCH" || task.attempt_id !== input.attemptId || attempt.task_id !== input.taskId) throw new M4Error("STOP_POINT", "task is not at the dispatch assignment point");
      const action = JSON.parse(attempt.action_json) as ApprovalAction;
      if (action.operation !== "worker.dispatch") throw new M4Error("STOP_POINT", "only synthetic worker dispatch can be assigned");
      const core = {
        scopeVersion: "1.0" as const, scopeId: input.scopeId, repositoryRootId: "synthetic-repository", worktreeRootId: "synthetic-worktree",
        taskId: input.taskId, attemptId: input.attemptId, operationId: action.operationId,
        allowedExactPaths: ["synthetic/echo-output.txt"], allowedPathPatterns: [],
        deniedPathClasses: ["credentials", "production", "infrastructure", "database", "mikrotik", "deployment", "unrelated-repository", "system"] as const,
        readOnlyPaths: [], generatedArtifactRoot: null,
        permissions: { create: false, modify: false, delete: false }, maxFiles: 1, maxBytes: 1,
      };
      const scopeDigest = digestWriteScope(core); if (!scopeDigest.ok) throw new M4Error("INVALID_INPUT", "synthetic write scope is invalid");
      const scope: WriteScope = { ...core, deniedPathClasses: [...core.deniedPathClasses], scopeHash: scopeDigest.value };
      if (!verifyWriteScope(scope).ok) throw new M4Error("INVALID_INPUT", "synthetic write scope is invalid");
      const issuedAt = this.now();
      const lease: Lease = {
        coordinationVersion: "1.0", leaseId: input.leaseId, resourceId: input.scopeId, projectId: task.project_id, workspaceId: action.parameters.workspaceId,
        taskId: input.taskId, attemptId: input.attemptId, operationId: action.operationId,
        holderWorkerId: M4_LIMITS.echoWorkerId, holderAdapterId: M4_LIMITS.echoAdapterId,
        issuedAt, expiresAt: input.leaseExpiresAt, renewalGeneration: 0, status: "active", supersededByLeaseId: null, authoritativeLeaseSnapshotRef: `snapshot-${input.leaseId}`,
      };
      if (!parseLease(lease).ok || Date.parse(input.leaseExpiresAt) <= Date.parse(issuedAt)) throw new M4Error("INVALID_INPUT", "lease is invalid");
      const assignment: Assignment = {
        coordinationVersion: "1.0", kind: "owner-confirmed", assignmentId: input.assignmentId, taskId: input.taskId, attemptId: input.attemptId, operationId: action.operationId,
        projectId: task.project_id, workerId: M4_LIMITS.echoWorkerId, adapterId: M4_LIMITS.echoAdapterId,
        requiredCapabilities: ["synthetic-echo"], permittedConnectorTier: "cli", writeScopeRef: input.scopeId, leaseRequired: true,
        readinessSnapshotRef: `readiness-${input.assignmentId}`, quotaSnapshotRef: null, approvalGrantRef: null,
        expectedEvidenceRefs: ["bridge-dispatch-ack", "bridge-execution-report"], expiresAt: input.leaseExpiresAt,
        rationaleEvidenceRefs: [`rationale-${input.assignmentId}`], ownerApprovalRef: input.ownerAssignmentRef,
      };
      if (!parseAssignment(assignment).ok) throw new M4Error("INVALID_INPUT", "assignment is invalid");
      const at = this.now(); const db = this.database.connection;
      db.prepare("INSERT INTO m4_write_scopes(scope_id,task_id,attempt_id,operation_id,scope_hash,scope_json,created_at) VALUES(?,?,?,?,?,?,?)").run(input.scopeId, input.taskId, input.attemptId, action.operationId, scope.scopeHash, bounded(scope, 32_768, "scope"), at);
      db.prepare("INSERT INTO m4_leases(lease_id,task_id,attempt_id,operation_id,status,generation,lease_json,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(input.leaseId, input.taskId, input.attemptId, action.operationId, "active", 0, bounded(lease, 32_768, "lease"), at);
      db.prepare("INSERT INTO m4_assignments(assignment_id,task_id,attempt_id,operation_id,worker_id,status,assignment_json,created_at,updated_at) VALUES(?,?,?,?,?,'pending-approval',?,?,?)").run(input.assignmentId, input.taskId, input.attemptId, action.operationId, M4_LIMITS.echoWorkerId, bounded(assignment, 32_768, "assignment"), at, at);
      this.appendEvent(`task-${input.taskId}`, "assignment.recorded", { taskId: input.taskId, attemptId: input.attemptId, operationId: action.operationId, assignmentId: input.assignmentId, workerId: M4_LIMITS.echoWorkerId, scopeHash: scope.scopeHash, leaseId: input.leaseId });
      return Object.freeze({ assignmentId: input.assignmentId, leaseId: input.leaseId, scopeId: input.scopeId, scopeHash: scope.scopeHash });
    }))();
  }

  public assignCodex(commandId: string, input: Readonly<{ taskId: string; attemptId: string; assignmentId: string; leaseId: string; ownerAssignmentRef: string; leaseExpiresAt: string; readinessSnapshotRef: string; writeScope: unknown }>): Readonly<{ assignmentId: string; leaseId: string; scopeId: string; scopeHash: string }> {
    for (const [label, value] of Object.entries(input)) if (label !== "leaseExpiresAt" && label !== "writeScope") assertId(String(value), label);
    const verifiedScope = verifyWriteScope(input.writeScope);
    if (!verifiedScope.ok) throw new M4Error("INVALID_INPUT", "Codex write scope is invalid");
    return this.database.connection.transaction(() => this.command("m5.codex.assign", commandId, { ...input, writeScope: verifiedScope.value }, () => {
      const task = this.task(input.taskId); const attempt = this.attempt(input.attemptId);
      if (task.state !== "AWAITING_DISPATCH" || task.attempt_id !== input.attemptId || attempt.task_id !== input.taskId) throw new M4Error("STOP_POINT", "task is not at the Codex assignment point");
      const action = JSON.parse(attempt.action_json) as ApprovalAction;
      if (action.operation !== "worker.dispatch" || action.target.resourceId !== M4_LIMITS.codexWorkerId || action.parameters.worker.manifestId !== M4_LIMITS.codexWorkerId) throw new M4Error("STOP_POINT", "attempt is not assigned to Codex");
      const scope = verifiedScope.value;
      if (scope.taskId !== input.taskId || scope.attemptId !== input.attemptId || scope.operationId !== action.operationId) throw new M4Error("STOP_POINT", "Codex scope binding mismatch");
      const readinessRow = this.database.connection.prepare("SELECT readiness_json,evidence_json,readiness_state,freeze_state FROM m5_adapter_readiness WHERE readiness_id=? AND worker_id=? AND adapter_id=?").get(input.readinessSnapshotRef, M4_LIMITS.codexWorkerId, M4_LIMITS.codexAdapterId) as { readiness_json: string; evidence_json: string; readiness_state: string; freeze_state: string } | undefined;
      const worker = this.database.connection.prepare("SELECT state FROM m5_worker_states WHERE worker_id=?").get(M4_LIMITS.codexWorkerId) as { state: string } | undefined;
      const readiness = readinessRow === undefined ? null : parseAdapterReadiness(JSON.parse(readinessRow.readiness_json));
      const evidence = readinessRow === undefined ? null : JSON.parse(readinessRow.evidence_json) as unknown;
      const eligible = readiness?.ok === true && (readiness.value.readinessState === "ready" || degradedCodexFallbackEligible(readiness.value, evidence));
      if (!readinessRow || !eligible || readinessRow.freeze_state !== "enabled" || worker?.state !== "enabled") throw new M4Error("STOP_POINT", "Codex readiness or worker state is not eligible");
      const issuedAt = this.now();
      const lease: Lease = {
        coordinationVersion: "1.0", leaseId: input.leaseId, resourceId: scope.scopeId, projectId: task.project_id, workspaceId: action.parameters.workspaceId,
        taskId: input.taskId, attemptId: input.attemptId, operationId: action.operationId, holderWorkerId: M4_LIMITS.codexWorkerId, holderAdapterId: M4_LIMITS.codexAdapterId,
        issuedAt, expiresAt: input.leaseExpiresAt, renewalGeneration: 0, status: "active", supersededByLeaseId: null, authoritativeLeaseSnapshotRef: `snapshot-${input.leaseId}`,
      };
      if (!parseLease(lease).ok || Date.parse(input.leaseExpiresAt) <= Date.parse(issuedAt)) throw new M4Error("INVALID_INPUT", "lease is invalid");
      const writeCapable = scope.permissions.create || scope.permissions.modify || scope.permissions.delete;
      const assignment: Assignment = {
        coordinationVersion: "1.0", kind: "owner-confirmed", assignmentId: input.assignmentId, taskId: input.taskId, attemptId: input.attemptId, operationId: action.operationId,
        projectId: task.project_id, workerId: M4_LIMITS.codexWorkerId, adapterId: M4_LIMITS.codexAdapterId,
        requiredCapabilities: [writeCapable ? "code-write" : "review"], permittedConnectorTier: "cli", writeScopeRef: scope.scopeId, leaseRequired: true,
        readinessSnapshotRef: input.readinessSnapshotRef, quotaSnapshotRef: null, approvalGrantRef: null,
        expectedEvidenceRefs: ["bridge-dispatch-ack", "bridge-execution-report", "bridge-worktree-inspection"], expiresAt: input.leaseExpiresAt,
        rationaleEvidenceRefs: [`rationale-${input.assignmentId}`], ownerApprovalRef: input.ownerAssignmentRef,
      };
      if (!parseAssignment(assignment).ok) throw new M4Error("INVALID_INPUT", "Codex assignment is invalid");
      const at = this.now(); const db = this.database.connection;
      db.prepare("INSERT INTO m4_write_scopes(scope_id,task_id,attempt_id,operation_id,scope_hash,scope_json,created_at) VALUES(?,?,?,?,?,?,?)").run(scope.scopeId, input.taskId, input.attemptId, action.operationId, scope.scopeHash, bounded(scope, 32_768, "scope"), at);
      db.prepare("INSERT INTO m4_leases(lease_id,task_id,attempt_id,operation_id,status,generation,lease_json,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(input.leaseId, input.taskId, input.attemptId, action.operationId, "active", 0, bounded(lease, 32_768, "lease"), at);
      db.prepare("INSERT INTO m4_assignments(assignment_id,task_id,attempt_id,operation_id,worker_id,status,assignment_json,created_at,updated_at) VALUES(?,?,?,?,?,'pending-approval',?,?,?)").run(input.assignmentId, input.taskId, input.attemptId, action.operationId, M4_LIMITS.codexWorkerId, bounded(assignment, 32_768, "assignment"), at, at);
      this.appendEvent(`task-${input.taskId}`, "assignment.recorded", { taskId: input.taskId, attemptId: input.attemptId, operationId: action.operationId, assignmentId: input.assignmentId, workerId: M4_LIMITS.codexWorkerId, scopeHash: scope.scopeHash, leaseId: input.leaseId, readinessSnapshotRef: input.readinessSnapshotRef });
      return Object.freeze({ assignmentId: input.assignmentId, leaseId: input.leaseId, scopeId: scope.scopeId, scopeHash: scope.scopeHash });
    }))();
  }

  public approveAndIssue(commandId: string, input: Readonly<{ taskId: string; attemptId: string; ownerId: string; approvalId: string; grantId: string; issuerId: string; lifetimeMs: number }>): Readonly<{ approvalId: string; grant: CapabilityGrant }> {
    for (const [label, value] of Object.entries(input)) if (label !== "lifetimeMs") assertId(String(value), label);
    const task = this.task(input.taskId); const attempt = this.attempt(input.attemptId);
    if (task.state !== "AWAITING_DISPATCH" || task.attempt_id !== input.attemptId || attempt.task_id !== input.taskId) throw new M4Error("STOP_POINT", "task is not awaiting dispatch approval");
    const assignmentRow = this.database.connection.prepare("SELECT assignment_id,assignment_json,status,worker_id,operation_id FROM m4_assignments WHERE task_id=? AND attempt_id=?").get(input.taskId, input.attemptId) as AssignmentRow | undefined;
    const scopeRow = this.database.connection.prepare("SELECT scope_id,scope_hash,scope_json FROM m4_write_scopes WHERE task_id=? AND attempt_id=?").get(input.taskId, input.attemptId) as ScopeRow | undefined;
    if (!assignmentRow || !scopeRow || assignmentRow.worker_id !== M4_LIMITS.echoWorkerId) throw new M4Error("STOP_POINT", "valid assignment and scope are required");
    const action = JSON.parse(attempt.action_json) as ApprovalAction;
    const expectedApprovalId = deriveApprovalId({ ownerId: input.ownerId, taskId: input.taskId, attemptId: input.attemptId, operationId: action.operationId, actionDigest: attempt.action_digest, scopeHash: scopeRow.scope_hash, workerId: M4_LIMITS.echoWorkerId, adapterId: M4_LIMITS.echoAdapterId });
    if (input.approvalId !== expectedApprovalId) throw new M4Error("STOP_POINT", "approval identity does not match the exact owner, action, worker, and scope");
    const grant = this.grantKey.issue({ grantId: input.grantId, taskId: input.taskId, attemptId: input.attemptId, operationId: action.operationId, actionDigest: attempt.action_digest as `sha256:${string}`, issuerId: input.issuerId, approvalId: input.approvalId, intendedVerifier: M4_LIMITS.bridgeVerifierId, lifetimeMs: input.lifetimeMs }, this.clock);
    return this.database.connection.transaction(() => this.command("grant.issue", commandId, { ...input, actionDigest: attempt.action_digest, scopeHash: scopeRow.scope_hash }, () => {
      const freshTask = this.task(input.taskId);
      const freshAssignment = this.database.connection.prepare("SELECT assignment_id,assignment_json,status,worker_id,operation_id FROM m4_assignments WHERE assignment_id=?").get(assignmentRow.assignment_id) as AssignmentRow;
      if (freshTask.state !== "AWAITING_DISPATCH" || freshTask.attempt_id !== input.attemptId || freshAssignment.status !== "pending-approval") throw new M4Error("CONFLICT", "approval point changed concurrently");
      const oldAssignment = JSON.parse(freshAssignment.assignment_json) as Extract<Assignment, { kind: "owner-confirmed" }>;
      const dispatched: Assignment = { ...oldAssignment, kind: "dispatched", approvalGrantRef: grant.grantId, dispatchEventRef: `dispatch-${input.grantId}`, adapterRunId: `run-${input.grantId}` };
      if (!parseAssignment(dispatched).ok) throw new M4Error("INVALID_INPUT", "dispatched assignment is invalid");
      const at = this.now(); const db = this.database.connection;
      db.prepare("INSERT INTO m4_approvals(approval_id,owner_id,task_id,attempt_id,operation_id,action_digest,scope_hash,worker_id,status,approved_at,created_at) VALUES(?,?,?,?,?,?,?,?, 'approved',?,?)").run(input.approvalId, input.ownerId, input.taskId, input.attemptId, action.operationId, attempt.action_digest, scopeRow.scope_hash, M4_LIMITS.echoWorkerId, at, at);
      db.prepare("INSERT INTO m4_grants(grant_id,approval_id,task_id,attempt_id,operation_id,action_digest,status,grant_json,issued_at,expires_at) VALUES(?,?,?,?,?,?,'issued',?,?,?)").run(grant.grantId, input.approvalId, input.taskId, input.attemptId, action.operationId, attempt.action_digest, bounded(grant, 32_768, "grant"), grant.issuedAt, grant.expiresAt);
      db.prepare("UPDATE m4_assignments SET status='dispatchable',assignment_json=?,updated_at=? WHERE assignment_id=? AND status='pending-approval'").run(bounded(dispatched, 32_768, "assignment"), at, assignmentRow.assignment_id);
      db.prepare("INSERT INTO m4_dispatch_queue(task_id,attempt_id,operation_id,grant_id,status,enqueued_at) VALUES(?,?,?,?,'queued',?)").run(input.taskId, input.attemptId, action.operationId, grant.grantId, at);
      this.appendEvent(`task-${input.taskId}`, "grant.issued", { taskId: input.taskId, attemptId: input.attemptId, operationId: action.operationId, approvalId: input.approvalId, grantId: grant.grantId, actionDigest: attempt.action_digest, scopeHash: scopeRow.scope_hash, workerId: M4_LIMITS.echoWorkerId, expiresAt: grant.expiresAt });
      return Object.freeze({ approvalId: input.approvalId, grant });
    }))();
  }

  public approveAndIssueCodex(commandId: string, input: Readonly<{ taskId: string; attemptId: string; ownerId: string; approvalId: string; grantId: string; issuerId: string; lifetimeMs: number }>): Readonly<{ approvalId: string; grant: CapabilityGrant }> {
    for (const [label, value] of Object.entries(input)) if (label !== "lifetimeMs") assertId(String(value), label);
    const task = this.task(input.taskId); const attempt = this.attempt(input.attemptId);
    if (task.state !== "AWAITING_DISPATCH" || task.attempt_id !== input.attemptId || attempt.task_id !== input.taskId) throw new M4Error("STOP_POINT", "task is not awaiting Codex dispatch approval");
    const assignmentRow = this.database.connection.prepare("SELECT assignment_id,assignment_json,status,worker_id,operation_id FROM m4_assignments WHERE task_id=? AND attempt_id=?").get(input.taskId, input.attemptId) as AssignmentRow | undefined;
    const scopeRow = this.database.connection.prepare("SELECT scope_id,scope_hash,scope_json FROM m4_write_scopes WHERE task_id=? AND attempt_id=?").get(input.taskId, input.attemptId) as ScopeRow | undefined;
    if (!assignmentRow || !scopeRow || assignmentRow.worker_id !== M4_LIMITS.codexWorkerId) throw new M4Error("STOP_POINT", "valid Codex assignment and scope are required");
    const action = JSON.parse(attempt.action_json) as ApprovalAction;
    const expectedApprovalId = deriveApprovalId({ ownerId: input.ownerId, taskId: input.taskId, attemptId: input.attemptId, operationId: action.operationId, actionDigest: attempt.action_digest, scopeHash: scopeRow.scope_hash, workerId: M4_LIMITS.codexWorkerId, adapterId: M4_LIMITS.codexAdapterId });
    if (input.approvalId !== expectedApprovalId) throw new M4Error("STOP_POINT", "approval identity does not match the exact owner, action, Codex worker, and scope");
    const grant = this.grantKey.issue({ grantId: input.grantId, taskId: input.taskId, attemptId: input.attemptId, operationId: action.operationId, actionDigest: attempt.action_digest as `sha256:${string}`, issuerId: input.issuerId, approvalId: input.approvalId, intendedVerifier: M4_LIMITS.bridgeVerifierId, lifetimeMs: input.lifetimeMs }, this.clock);
    return this.database.connection.transaction(() => this.command("m5.codex.grant.issue", commandId, { ...input, actionDigest: attempt.action_digest, scopeHash: scopeRow.scope_hash }, () => {
      const freshTask = this.task(input.taskId);
      const freshAssignment = this.database.connection.prepare("SELECT assignment_id,assignment_json,status,worker_id,operation_id FROM m4_assignments WHERE assignment_id=?").get(assignmentRow.assignment_id) as AssignmentRow;
      if (freshTask.state !== "AWAITING_DISPATCH" || freshTask.attempt_id !== input.attemptId || freshAssignment.status !== "pending-approval") throw new M4Error("CONFLICT", "Codex approval point changed concurrently");
      const oldAssignment = JSON.parse(freshAssignment.assignment_json) as Extract<Assignment, { kind: "owner-confirmed" }>;
      const dispatched: Assignment = { ...oldAssignment, kind: "dispatched", approvalGrantRef: grant.grantId, dispatchEventRef: `dispatch-${input.grantId}`, adapterRunId: `run-${input.grantId}` };
      if (!parseAssignment(dispatched).ok) throw new M4Error("INVALID_INPUT", "dispatched Codex assignment is invalid");
      const at = this.now(); const db = this.database.connection;
      db.prepare("INSERT INTO m4_approvals(approval_id,owner_id,task_id,attempt_id,operation_id,action_digest,scope_hash,worker_id,status,approved_at,created_at) VALUES(?,?,?,?,?,?,?,?, 'approved',?,?)").run(input.approvalId, input.ownerId, input.taskId, input.attemptId, action.operationId, attempt.action_digest, scopeRow.scope_hash, M4_LIMITS.codexWorkerId, at, at);
      db.prepare("INSERT INTO m4_grants(grant_id,approval_id,task_id,attempt_id,operation_id,action_digest,status,grant_json,issued_at,expires_at) VALUES(?,?,?,?,?,?,'issued',?,?,?)").run(grant.grantId, input.approvalId, input.taskId, input.attemptId, action.operationId, attempt.action_digest, bounded(grant, 32_768, "grant"), grant.issuedAt, grant.expiresAt);
      db.prepare("UPDATE m4_assignments SET status='dispatchable',assignment_json=?,updated_at=? WHERE assignment_id=? AND status='pending-approval'").run(bounded(dispatched, 32_768, "assignment"), at, assignmentRow.assignment_id);
      db.prepare("INSERT INTO m4_dispatch_queue(task_id,attempt_id,operation_id,grant_id,status,enqueued_at) VALUES(?,?,?,?,'queued',?)").run(input.taskId, input.attemptId, action.operationId, grant.grantId, at);
      this.appendEvent(`task-${input.taskId}`, "grant.issued", { taskId: input.taskId, attemptId: input.attemptId, operationId: action.operationId, approvalId: input.approvalId, grantId: grant.grantId, actionDigest: attempt.action_digest, scopeHash: scopeRow.scope_hash, workerId: M4_LIMITS.codexWorkerId, expiresAt: grant.expiresAt });
      return Object.freeze({ approvalId: input.approvalId, grant });
    }))();
  }

  private dispatchGate(queue: { task_id: string; attempt_id: string; operation_id: string; grant_id: string }, now: string): DispatchCommand {
    const task = this.task(queue.task_id); const attempt = this.attempt(queue.attempt_id);
    if (task.state !== "AWAITING_DISPATCH" || task.attempt_id !== queue.attempt_id || task.current_operation_id !== queue.operation_id) throw new M4Error("STOP_POINT", "task identity or state does not permit dispatch");
    const assignmentRow = this.database.connection.prepare("SELECT assignment_id,assignment_json,status,worker_id,operation_id FROM m4_assignments WHERE task_id=? AND attempt_id=? AND operation_id=?").get(queue.task_id, queue.attempt_id, queue.operation_id) as AssignmentRow | undefined;
    const approval = this.database.connection.prepare("SELECT approval_id,owner_id,status,action_digest,scope_hash,worker_id FROM m4_approvals WHERE task_id=? AND attempt_id=? AND operation_id=?").get(queue.task_id, queue.attempt_id, queue.operation_id) as ApprovalRow | undefined;
    const grantRow = this.database.connection.prepare("SELECT grant_id,approval_id,status,grant_json,expires_at,revoked_at,consumed_at,result_ref FROM m4_grants WHERE grant_id=?").get(queue.grant_id) as GrantRow | undefined;
    const leaseRow = this.database.connection.prepare("SELECT lease_id,status,generation,lease_json FROM m4_leases WHERE task_id=? AND attempt_id=? AND operation_id=?").get(queue.task_id, queue.attempt_id, queue.operation_id) as LeaseRow | undefined;
    const scopeRow = this.database.connection.prepare("SELECT scope_id,scope_hash,scope_json FROM m4_write_scopes WHERE task_id=? AND attempt_id=? AND operation_id=?").get(queue.task_id, queue.attempt_id, queue.operation_id) as ScopeRow | undefined;
    if (!assignmentRow || !approval || !grantRow || !leaseRow || !scopeRow) throw new M4Error("STOP_POINT", "dispatch authority is incomplete");
    if (assignmentRow.status !== "dispatchable" || approval.status !== "approved" || grantRow.status !== "issued" || grantRow.revoked_at !== null || grantRow.consumed_at !== null || leaseRow.status !== "active") throw new M4Error("STOP_POINT", "dispatch authority is inactive");
    if (approval.action_digest !== attempt.action_digest || approval.scope_hash !== scopeRow.scope_hash || approval.worker_id !== M4_LIMITS.echoWorkerId || assignmentRow.worker_id !== M4_LIMITS.echoWorkerId || Date.parse(now) >= Date.parse(grantRow.expires_at)) throw new M4Error("STOP_POINT", "dispatch bindings do not match");
    const action = JSON.parse(attempt.action_json) as ApprovalAction;
    const assignment = JSON.parse(assignmentRow.assignment_json) as Assignment;
    const grant = JSON.parse(grantRow.grant_json) as CapabilityGrant;
    const lease = JSON.parse(leaseRow.lease_json) as Lease;
    const writeScope = JSON.parse(scopeRow.scope_json) as WriteScope;
    const readiness = {
      coordinationVersion: "1.0", readinessId: assignment.readinessSnapshotRef, workerId: M4_LIMITS.echoWorkerId, adapterId: M4_LIMITS.echoAdapterId,
      connectorTier: "cli", providerId: "synthetic-provider", runtimeId: "synthetic-runtime", installedVersion: "1.0.0",
      executableId: null, executableHash: null, authenticationState: "not-required",
      sandboxCapability: "validated", noninteractiveCapability: "validated", structuredOutputCapability: "validated",
      cancellationCapability: "validated", resumeCapability: "validated", healthStatus: "healthy", quotaVisibility: "unknown",
      readinessState: "ready", freezeState: "enabled", capabilityProbeAt: now,
      capabilities: [{ capability: "synthetic-echo", assurance: "validated", evidenceRef: "synthetic-capability-evidence" }],
      evidenceRefs: ["synthetic-readiness-evidence"],
    };
    const dispatchable = evaluateAssignmentDispatch(assignment, { now, readiness, quota: null, writeScope, lease, approvalGrant: grant });
    if (!dispatchable.ok) throw new M4Error("STOP_POINT", `assignment is not dispatchable (${dispatchable.code})`);
    return Object.freeze({ commandId: `dispatch-${queue.grant_id}`, taskId: queue.task_id, attemptId: queue.attempt_id, operationId: queue.operation_id, projectId: task.project_id, ownerId: approval.owner_id, workerId: M4_LIMITS.echoWorkerId, adapterId: M4_LIMITS.echoAdapterId, action, taskInput: attempt.input_text, assignment, lease, writeScope, grant });
  }

  public claimNextDispatch(): DispatchCommand {
    return this.database.connection.transaction(() => {
      const rows = this.database.connection.prepare("SELECT q.task_id,q.attempt_id,q.operation_id,q.grant_id,q.queue_sequence FROM m4_dispatch_queue q JOIN m4_assignments a ON a.task_id=q.task_id AND a.attempt_id=q.attempt_id AND a.operation_id=q.operation_id WHERE q.status='queued' AND a.worker_id=? ORDER BY q.queue_sequence").all(M4_LIMITS.echoWorkerId) as Array<{ task_id: string; attempt_id: string; operation_id: string; grant_id: string; queue_sequence: number }>;
      const global = this.database.connection.prepare("SELECT COUNT(*) AS count FROM tasks WHERE state='RUNNING'").get() as { count: number };
      const claimedGlobal = this.database.connection.prepare("SELECT COUNT(*) AS count FROM m4_dispatch_queue WHERE status='claimed'").get() as { count: number };
      if (global.count + claimedGlobal.count >= M4_LIMITS.globalConcurrency) throw new M4Error("QUEUE_EMPTY", "global concurrency limit is full");
      const now = this.now();
      for (const row of rows) {
        const task = this.task(row.task_id);
        const runningProject = this.database.connection.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id=? AND state='RUNNING'").get(task.project_id) as { count: number };
        const claimedProject = this.database.connection.prepare("SELECT COUNT(*) AS count FROM m4_dispatch_queue q JOIN tasks t ON t.task_id=q.task_id WHERE q.status='claimed' AND t.project_id=?").get(task.project_id) as { count: number };
        if (runningProject.count + claimedProject.count >= M4_LIMITS.projectConcurrency) continue;
        const command = this.dispatchGate(row, now);
        const claimed = this.database.connection.prepare("UPDATE m4_dispatch_queue SET status='claimed',claimed_at=? WHERE queue_sequence=? AND status='queued'").run(now, row.queue_sequence);
        if (claimed.changes !== 1) continue;
        this.appendEvent(`task-${row.task_id}`, "dispatch.claimed", { taskId: row.task_id, attemptId: row.attempt_id, operationId: row.operation_id, grantId: row.grant_id, workerId: M4_LIMITS.echoWorkerId });
        return command;
      }
      throw new M4Error("QUEUE_EMPTY", "no queued task is eligible");
    })();
  }

  private codexDispatchGate(queue: { task_id: string; attempt_id: string; operation_id: string; grant_id: string }, now: string): CodexDispatchCommand {
    const task = this.task(queue.task_id); const attempt = this.attempt(queue.attempt_id);
    if (task.state !== "AWAITING_DISPATCH" || task.attempt_id !== queue.attempt_id || task.current_operation_id !== queue.operation_id) throw new M4Error("STOP_POINT", "task identity or state does not permit Codex dispatch");
    const assignmentRow = this.database.connection.prepare("SELECT assignment_id,assignment_json,status,worker_id,operation_id FROM m4_assignments WHERE task_id=? AND attempt_id=? AND operation_id=?").get(queue.task_id, queue.attempt_id, queue.operation_id) as AssignmentRow | undefined;
    const approval = this.database.connection.prepare("SELECT approval_id,owner_id,status,action_digest,scope_hash,worker_id FROM m4_approvals WHERE task_id=? AND attempt_id=? AND operation_id=?").get(queue.task_id, queue.attempt_id, queue.operation_id) as ApprovalRow | undefined;
    const grantRow = this.database.connection.prepare("SELECT grant_id,approval_id,status,grant_json,expires_at,revoked_at,consumed_at,result_ref FROM m4_grants WHERE grant_id=?").get(queue.grant_id) as GrantRow | undefined;
    const leaseRow = this.database.connection.prepare("SELECT lease_id,status,generation,lease_json FROM m4_leases WHERE task_id=? AND attempt_id=? AND operation_id=?").get(queue.task_id, queue.attempt_id, queue.operation_id) as LeaseRow | undefined;
    const scopeRow = this.database.connection.prepare("SELECT scope_id,scope_hash,scope_json FROM m4_write_scopes WHERE task_id=? AND attempt_id=? AND operation_id=?").get(queue.task_id, queue.attempt_id, queue.operation_id) as ScopeRow | undefined;
    if (!assignmentRow || !approval || !grantRow || !leaseRow || !scopeRow) throw new M4Error("STOP_POINT", "Codex dispatch authority is incomplete");
    const assignment = JSON.parse(assignmentRow.assignment_json) as Assignment;
    const readinessRow = this.database.connection.prepare("SELECT readiness_json,evidence_json,readiness_state,freeze_state FROM m5_adapter_readiness WHERE readiness_id=? AND worker_id=? AND adapter_id=?").get(assignment.readinessSnapshotRef, M4_LIMITS.codexWorkerId, M4_LIMITS.codexAdapterId) as { readiness_json: string; evidence_json: string; readiness_state: string; freeze_state: string } | undefined;
    const worker = this.database.connection.prepare("SELECT state FROM m5_worker_states WHERE worker_id=?").get(M4_LIMITS.codexWorkerId) as { state: string } | undefined;
    const readinessParsed = readinessRow === undefined ? null : parseAdapterReadiness(JSON.parse(readinessRow.readiness_json));
    const readinessEvidence = readinessRow === undefined ? null : JSON.parse(readinessRow.evidence_json) as unknown;
    const degradedEligible = readinessParsed?.ok === true && degradedCodexFallbackEligible(readinessParsed.value, readinessEvidence);
    if (!readinessRow || !worker || worker.state !== "enabled" || readinessParsed?.ok !== true || (readinessParsed.value.readinessState !== "ready" && !degradedEligible) || readinessRow.freeze_state !== "enabled") throw new M4Error("STOP_POINT", "Codex is disabled, frozen, degraded, or unprobed");
    if (assignmentRow.status !== "dispatchable" || approval.status !== "approved" || grantRow.status !== "issued" || grantRow.revoked_at !== null || grantRow.consumed_at !== null || leaseRow.status !== "active") throw new M4Error("STOP_POINT", "Codex dispatch authority is inactive");
    if (approval.action_digest !== attempt.action_digest || approval.scope_hash !== scopeRow.scope_hash || approval.worker_id !== M4_LIMITS.codexWorkerId || assignmentRow.worker_id !== M4_LIMITS.codexWorkerId || Date.parse(now) >= Date.parse(grantRow.expires_at)) throw new M4Error("STOP_POINT", "Codex dispatch bindings do not match");
    const action = JSON.parse(attempt.action_json) as ApprovalAction;
    const grant = JSON.parse(grantRow.grant_json) as CapabilityGrant;
    const lease = JSON.parse(leaseRow.lease_json) as Lease;
    const writeScope = JSON.parse(scopeRow.scope_json) as WriteScope;
    // The generic M1F gate only understands fully-ready snapshots. This derived value is used solely
    // after the persisted degraded fallback and its evidence have passed the stricter M5 checks above.
    const readinessForGenericGate: AdapterReadiness = degradedEligible ? { ...readinessParsed.value, readinessState: "ready", healthStatus: "healthy" } : readinessParsed.value;
    const dispatchable = evaluateAssignmentDispatch(assignment, { now, readiness: readinessForGenericGate, quota: null, writeScope, lease, approvalGrant: grant });
    if (!dispatchable.ok) throw new M4Error("STOP_POINT", `Codex assignment is not dispatchable (${dispatchable.code})`);
    return Object.freeze({ commandId: `dispatch-${queue.grant_id}`, taskId: queue.task_id, attemptId: queue.attempt_id, operationId: queue.operation_id, projectId: task.project_id, ownerId: approval.owner_id, workerId: M4_LIMITS.codexWorkerId, adapterId: M4_LIMITS.codexAdapterId, action, taskInput: attempt.input_text, assignment, lease, writeScope, grant, readiness: readinessParsed.value });
  }

  public claimNextCodexDispatch(): CodexDispatchCommand {
    return this.database.connection.transaction(() => {
      const rows = this.database.connection.prepare("SELECT q.task_id,q.attempt_id,q.operation_id,q.grant_id,q.queue_sequence FROM m4_dispatch_queue q JOIN m4_assignments a ON a.task_id=q.task_id AND a.attempt_id=q.attempt_id AND a.operation_id=q.operation_id WHERE q.status='queued' AND a.worker_id=? ORDER BY q.queue_sequence").all(M4_LIMITS.codexWorkerId) as Array<{ task_id: string; attempt_id: string; operation_id: string; grant_id: string; queue_sequence: number }>;
      const global = this.database.connection.prepare("SELECT COUNT(*) AS count FROM tasks WHERE state='RUNNING'").get() as { count: number };
      const claimedGlobal = this.database.connection.prepare("SELECT COUNT(*) AS count FROM m4_dispatch_queue WHERE status='claimed'").get() as { count: number };
      if (global.count + claimedGlobal.count >= M4_LIMITS.globalConcurrency) throw new M4Error("QUEUE_EMPTY", "global concurrency limit is full");
      const now = this.now();
      for (const row of rows) {
        const task = this.task(row.task_id);
        const runningProject = this.database.connection.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id=? AND state='RUNNING'").get(task.project_id) as { count: number };
        const claimedProject = this.database.connection.prepare("SELECT COUNT(*) AS count FROM m4_dispatch_queue q JOIN tasks t ON t.task_id=q.task_id WHERE q.status='claimed' AND t.project_id=?").get(task.project_id) as { count: number };
        if (runningProject.count + claimedProject.count >= M4_LIMITS.projectConcurrency) continue;
        const command = this.codexDispatchGate(row, now);
        const claimed = this.database.connection.prepare("UPDATE m4_dispatch_queue SET status='claimed',claimed_at=? WHERE queue_sequence=? AND status='queued'").run(now, row.queue_sequence);
        if (claimed.changes !== 1) continue;
        this.appendEvent(`task-${row.task_id}`, "dispatch.claimed", { taskId: row.task_id, attemptId: row.attempt_id, operationId: row.operation_id, grantId: row.grant_id, workerId: M4_LIMITS.codexWorkerId });
        return command;
      }
      throw new M4Error("QUEUE_EMPTY", "no queued Codex task is eligible");
    })();
  }

  public acknowledgeDispatch(taskId: string, operationId: string): Readonly<{ state: TaskState; version: number }> {
    const task = this.task(taskId);
    if (task.current_operation_id !== operationId) throw new M4Error("CONFLICT", "dispatch acknowledgment has the wrong operation");
    return this.transition(taskId, task.version, { to: "RUNNING", actor: "control-plane", evidence: ["bridge-dispatch-ack"] });
  }

  public recordBridgeResult(commandId: string, taskId: string, result: BridgeResult): Readonly<{ state: TaskState; version: number; resultRef: string }> {
    assertId(result.operationId, "operationId"); assertId(result.journalRef, "journalRef"); assertId(result.resultRef, "resultRef");
    const output = sanitize(result.output, M4_LIMITS.maxResultBytes);
    return this.database.connection.transaction(() => this.command("bridge.result", commandId, { taskId, ...result, output }, () => {
      const task = this.task(taskId);
      if (task.current_operation_id !== result.operationId || task.attempt_id === null) throw new M4Error("CONFLICT", "result does not match the active attempt");
      const resultBody = { ...result, output };
      this.database.connection.prepare("INSERT INTO m4_results(result_ref,task_id,attempt_id,operation_id,result_digest,result_json,status,recorded_at) VALUES(?,?,?,?,?,?,?,?)").run(result.resultRef, taskId, task.attempt_id, result.operationId, sha256(canonical(resultBody)), bounded(resultBody, M4_LIMITS.maxResultBytes, "result"), result.state, this.now());
      this.database.connection.prepare("UPDATE m4_grants SET status='consumed',consumed_at=COALESCE(consumed_at,?),result_ref=? WHERE task_id=? AND attempt_id=? AND operation_id=?").run(this.now(), result.resultRef, taskId, task.attempt_id, result.operationId);
      this.database.connection.prepare("UPDATE m4_dispatch_queue SET status='done' WHERE task_id=? AND attempt_id=? AND operation_id=?").run(taskId, task.attempt_id, result.operationId);
      let transitioned: Readonly<{ state: TaskState; version: number }>;
      if (result.state === "completed") transitioned = this.transition(taskId, task.version, { to: "RESULT_CAPTURED", actor: "control-plane", evidence: ["bridge-execution-report"] });
      else if (result.state === "failed") transitioned = this.transition(taskId, task.version, { to: "FAILED", actor: "control-plane", evidence: ["bridge-execution-report"] });
      else if (result.state === "cancelled") {
        if (task.state !== "CANCELLING") throw new M4Error("ILLEGAL_TRANSITION", "cancellation result requires CANCELLING state");
        transitioned = this.transition(taskId, task.version, { to: "CANCELLED", actor: "control-plane", evidence: ["bridge-kill-confirmation"] });
      } else {
        if (task.state !== "RUNNING" && task.state !== "AWAITING_DISPATCH") throw new M4Error("ILLEGAL_TRANSITION", "execution-unknown is incompatible with the current task state");
        const blocked: BlockedContext = {
          blockedFrom: task.state,
          blockedOperation: task.state === "RUNNING" ? "worker-execution" : "worker-dispatch",
          blockedReason: "execution-unknown", attemptId: task.attempt_id, operationId: result.operationId, journalRef: result.journalRef,
        };
        transitioned = this.transition(taskId, task.version, { to: "BLOCKED", actor: "system-recovery", proposedBlockedContext: blocked });
      }
      this.appendEvent(`task-${taskId}`, "operation.completed", { taskId, attemptId: task.attempt_id, operationId: result.operationId, resultRef: result.resultRef, state: result.state, outputTruncated: result.outputTruncated, failureCode: result.failureCode });
      return Object.freeze({ ...transitioned, resultRef: result.resultRef });
    }))();
  }

  public advanceCapturedResult(taskId: string): Readonly<{ state: "AWAITING_APPROVAL"; version: number }> {
    const task = this.task(taskId);
    return this.transition(taskId, task.version, { to: "AWAITING_APPROVAL", actor: "control-plane" }) as Readonly<{ state: "AWAITING_APPROVAL"; version: number }>;
  }

  public cancel(taskId: string): Readonly<{ state: TaskState; version: number }> {
    return this.database.connection.transaction(() => {
      const task = this.task(taskId);
      let result: Readonly<{ state: TaskState; version: number }>;
      if (["DRAFT", "CONTEXT_PREPARING", "RESULT_CAPTURED", "AWAITING_APPROVAL", "REVISION_REQUESTED"].includes(task.state)) {
        result = this.transition(taskId, task.version, { to: "CANCELLED", actor: "owner" });
      } else if (["AWAITING_DISPATCH", "RUNNING", "APPROVED"].includes(task.state)) {
        result = this.transition(taskId, task.version, { to: "CANCELLING", actor: "owner" });
      } else throw new M4Error("ILLEGAL_TRANSITION", "task cannot be cancelled from its current state");
      this.database.connection.prepare("UPDATE tasks SET cancellation_requested_at=? WHERE task_id=?").run(this.now(), taskId);
      this.database.connection.prepare("UPDATE m4_approvals SET status='revoked',revoked_at=? WHERE task_id=? AND status='approved'").run(this.now(), taskId);
      this.database.connection.prepare("UPDATE m4_grants SET status='revoked',revoked_at=? WHERE task_id=? AND status='issued' AND consumed_at IS NULL").run(this.now(), taskId);
      this.database.connection.prepare("UPDATE m4_leases SET status='revoked',lease_json=json_set(lease_json,'$.status','revoked'),updated_at=? WHERE task_id=? AND status='active'").run(this.now(), taskId);
      this.database.connection.prepare("UPDATE m4_dispatch_queue SET status='cancelled' WHERE task_id=? AND status='queued'").run(taskId);
      this.appendEvent(`task-${taskId}`, "cancellation.requested", { taskId, state: result.state });
      return result;
    })();
  }

  public confirmNoExecutionCancellation(taskId: string): Readonly<{ state: "CANCELLED"; version: number }> {
    const task = this.task(taskId);
    if (task.state !== "CANCELLING") throw new M4Error("ILLEGAL_TRANSITION", "task is not cancelling");
    const consumed = this.database.connection.prepare("SELECT COUNT(*) AS count FROM m4_grants WHERE task_id=? AND consumed_at IS NOT NULL").get(taskId) as { count: number };
    if (consumed.count !== 0) throw new M4Error("STOP_POINT", "consumed work requires Bridge termination evidence");
    return this.transition(taskId, task.version, { to: "CANCELLED", actor: "control-plane", evidence: ["bridge-kill-confirmation"] }) as Readonly<{ state: "CANCELLED"; version: number }>;
  }

  public revokeGrant(grantId: string): "revoked" | "already-consumed" {
    assertId(grantId, "grantId");
    return this.database.connection.transaction(() => {
      const grant = this.database.connection.prepare("SELECT grant_id,approval_id,status,grant_json,expires_at,revoked_at,consumed_at,result_ref FROM m4_grants WHERE grant_id=?").get(grantId) as GrantRow | undefined;
      if (!grant) throw new M4Error("NOT_FOUND", "grant was not found");
      if (grant.consumed_at !== null) return "already-consumed" as const;
      this.database.connection.prepare("UPDATE m4_grants SET status='revoked',revoked_at=? WHERE grant_id=? AND consumed_at IS NULL").run(this.now(), grantId);
      this.database.connection.prepare("UPDATE m4_approvals SET status='revoked',revoked_at=? WHERE approval_id=?").run(this.now(), grant.approval_id);
      return "revoked" as const;
    })();
  }

  public getTask(taskId: string): Readonly<{ taskId: string; projectId: string; state: TaskState; attemptId: string | null; version: number; blockedContext: BlockedContext | null }> {
    const task = this.task(taskId);
    return Object.freeze({ taskId: task.task_id, projectId: task.project_id, state: task.state, attemptId: task.attempt_id, version: task.version, blockedContext: task.blocked_context_json === null ? null : JSON.parse(task.blocked_context_json) as BlockedContext });
  }
}
