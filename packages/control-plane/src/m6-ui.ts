import { createHash, randomUUID } from "node:crypto";
import {
  detectRedactions,
  digestWriteScope,
  parseAdapterReadiness,
  redactText,
  verifyWriteScope,
  type ApprovalAction,
  type TaskState,
  type WriteScope,
} from "@chubz/shared";
import type { Principal } from "./auth.js";
import type { ControlPlaneDatabase } from "./database.js";
import { deriveApprovalId } from "./grant-engine.js";
import { M4Error, M4Orchestrator, M4_LIMITS } from "./orchestrator.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ALLOWED_MANUAL_ARTIFACT_TYPES = Object.freeze([".txt", ".md", ".json", ".csv", ".tsv", ".patch", ".diff", ".png", ".jpg", ".jpeg", ".webp", ".pdf"]);
const sha256 = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
};
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const json = <T>(value: string | null): T | null => {
  if (value === null) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
};
const safeText = (value: string, maximum = 64 * 1024): string => {
  const bounded = Buffer.from(value, "utf8").subarray(0, maximum).toString("utf8");
  const findings = detectRedactions(bounded);
  if (!findings.ok) return "[redacted]";
  const redacted = redactText(bounded, findings.value);
  return redacted.ok ? redacted.value.text : "[redacted]";
};
const sensitiveKey = (key: string): boolean => /password|secret|token|credential|authorization|cookie|private.?key|authentication.?file|raw.?environment|grant.?json|signature/iu.test(key);
const browserSafe = (value: unknown, depth = 0): unknown => {
  if (depth > 6) return "[bounded]";
  if (typeof value === "string") return safeText(value, 16 * 1024);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => browserSafe(entry, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).slice(0, 100).filter(([key]) => !sensitiveKey(key)).map(([key, entry]) => [key, browserSafe(entry, depth + 1)]));
  return null;
};
const requireId = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !ID.test(value) || value.includes("..")) throw new M6Error("INVALID_REQUEST", `${label} is invalid`);
  return value;
};
const requireIdempotency = (value: unknown): string => {
  if (typeof value !== "string" || !IDEMPOTENCY.test(value)) throw new M6Error("INVALID_REQUEST", "idempotency key is invalid");
  return value;
};
const requireVersion = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new M6Error("INVALID_REQUEST", "task version is invalid");
  return value as number;
};

export type M6ErrorCode = "INVALID_REQUEST" | "NOT_FOUND" | "CONFLICT" | "STALE_STATE" | "UNAVAILABLE";
export class M6Error extends Error {
  public constructor(public readonly code: M6ErrorCode, message: string) { super(message); this.name = "M6Error"; }
}

type TaskRow = {
  task_id: string; project_id: string; state: TaskState; attempt_id: string | null; blocked_context_json: string | null;
  updated_at: string; version: number; created_at: string | null; current_operation_id: string | null; cancellation_requested_at: string | null;
};
type AttemptRow = { attempt_id: string; attempt_sequence: number; action_json: string; action_digest: string; input_text: string; created_at: string };

export class M6UiService {
  public constructor(private readonly database: ControlPlaneDatabase, private readonly orchestrator: M4Orchestrator) {}

  private mutation<T>(scope: string, idempotencyKey: string, request: unknown, execute: () => T): T {
    const requestDigest = sha256(canonical(request));
    const db = this.database.connection;
    return db.transaction(() => {
      const existing = db.prepare("SELECT request_digest,result_json FROM m6_mutations WHERE mutation_scope=? AND idempotency_key=?").get(scope, idempotencyKey) as { request_digest: string; result_json: string | null } | undefined;
      if (existing) {
        if (existing.request_digest !== requestDigest) throw new M6Error("CONFLICT", "idempotency key conflicts with a prior request");
        if (existing.result_json === null) throw new M6Error("CONFLICT", "the original request is still in progress");
        return JSON.parse(existing.result_json) as T;
      }
      db.prepare("INSERT INTO m6_mutations(mutation_scope,idempotency_key,request_digest,result_json,recorded_at) VALUES(?,?,?,?,?)").run(scope, idempotencyKey, requestDigest, null, new Date().toISOString());
      try {
        const result = execute();
        db.prepare("UPDATE m6_mutations SET result_json=? WHERE mutation_scope=? AND idempotency_key=?").run(JSON.stringify(result), scope, idempotencyKey);
        return result;
      } catch (error) {
        db.prepare("DELETE FROM m6_mutations WHERE mutation_scope=? AND idempotency_key=? AND result_json IS NULL").run(scope, idempotencyKey);
        throw error;
      }
    })();
  }

  private task(taskId: string): TaskRow {
    const task = this.database.connection.prepare("SELECT task_id,project_id,state,attempt_id,blocked_context_json,updated_at,version,created_at,current_operation_id,cancellation_requested_at FROM tasks WHERE task_id=?").get(taskId) as TaskRow | undefined;
    if (!task) throw new M6Error("NOT_FOUND", "task was not found");
    return task;
  }

  private snapshotTask(task: TaskRow): Record<string, unknown> {
    const db = this.database.connection;
    const attempts = db.prepare("SELECT attempt_id,attempt_sequence,action_json,action_digest,input_text,created_at FROM task_attempts WHERE task_id=? ORDER BY attempt_sequence").all(task.task_id) as AttemptRow[];
    const assignments = db.prepare("SELECT assignment_id,attempt_id,operation_id,worker_id,status,assignment_json,created_at,updated_at FROM m4_assignments WHERE task_id=? ORDER BY created_at").all(task.task_id) as Array<Record<string, unknown> & { assignment_json: string }>;
    const approvals = db.prepare("SELECT approval_id,owner_id,attempt_id,operation_id,action_digest,scope_hash,worker_id,status,approved_at,revoked_at,created_at FROM m4_approvals WHERE task_id=? ORDER BY created_at").all(task.task_id) as Array<Record<string, unknown>>;
    const grants = db.prepare("SELECT grant_id,approval_id,attempt_id,operation_id,status,issued_at,expires_at,revoked_at,consumed_at,result_ref FROM m4_grants WHERE task_id=? ORDER BY issued_at").all(task.task_id) as Array<Record<string, unknown>>;
    const leases = db.prepare("SELECT lease_id,attempt_id,operation_id,status,generation,updated_at FROM m4_leases WHERE task_id=? ORDER BY updated_at").all(task.task_id) as Array<Record<string, unknown>>;
    const scopes = db.prepare("SELECT scope_id,attempt_id,operation_id,scope_hash,scope_json,created_at FROM m4_write_scopes WHERE task_id=? ORDER BY created_at").all(task.task_id) as Array<Record<string, unknown> & { scope_json: string }>;
    const results = db.prepare("SELECT result_ref,attempt_id,operation_id,result_json,status,recorded_at FROM m4_results WHERE task_id=? ORDER BY recorded_at").all(task.task_id) as Array<Record<string, unknown> & { result_json: string }>;
    const manualResults = db.prepare("SELECT result_ref,attempt_id,operation_id,result_json,recorded_at FROM m6_manual_results WHERE task_id=? ORDER BY recorded_at").all(task.task_id) as Array<Record<string, unknown> & { result_json: string }>;
    const transitions = db.prepare("SELECT transition_id,attempt_id,from_state,to_state,actor,evidence_json,blocked_context_json,resulting_version,event_id,occurred_at FROM task_state_transitions WHERE task_id=? ORDER BY resulting_version").all(task.task_id) as Array<Record<string, unknown> & { evidence_json: string; blocked_context_json: string | null }>;
    const events = db.prepare("SELECT sequence,event_id,payload_json,occurred_at FROM events WHERE stream_id=? ORDER BY sequence DESC LIMIT 100").all(`task-${task.task_id}`) as Array<{ sequence: number; event_id: string; payload_json: string; occurred_at: string }>;
    const latestAssignment = assignments.at(-1);
    const latestQueue = db.prepare("SELECT status,queue_sequence,enqueued_at,claimed_at FROM m4_dispatch_queue WHERE task_id=? ORDER BY queue_sequence DESC LIMIT 1").get(task.task_id) as Record<string, unknown> | undefined;
    const latestResult = results.at(-1);
    const latestManualResult = manualResults.at(-1);
    const blocked = json<Record<string, unknown>>(task.blocked_context_json);
    return {
      taskId: task.task_id, projectId: task.project_id, state: task.state, version: task.version, attemptId: task.attempt_id,
      operationId: task.current_operation_id, createdAt: task.created_at, updatedAt: task.updated_at, cancellationRequestedAt: task.cancellation_requested_at,
      blockedContext: browserSafe(blocked), executionUnknown: blocked?.["blockedReason"] === "execution-unknown",
      attempts: attempts.map((attempt) => {
        const action = json<ApprovalAction>(attempt.action_json);
        return { attemptId: attempt.attempt_id, sequence: attempt.attempt_sequence, actionDigest: attempt.action_digest, instructions: safeText(attempt.input_text), createdAt: attempt.created_at, operation: action?.operation ?? null, operationId: action?.operationId ?? null, workerId: action?.target.resourceId ?? null, timeoutSec: action?.constraints.timeoutSec ?? null, requiresCleanWorktree: action?.constraints.requiresCleanWorktree ?? null };
      }),
      assignments: assignments.map(({ assignment_json, ...assignment }) => {
        const value = json<Record<string, unknown>>(assignment_json);
        return { ...assignment, adapterId: value?.["adapterId"] ?? null, connectorTier: value?.["permittedConnectorTier"] ?? null, readinessSnapshotRef: value?.["readinessSnapshotRef"] ?? null, expiresAt: value?.["expiresAt"] ?? null, expectedEvidenceRefs: value?.["expectedEvidenceRefs"] ?? [], ownerConfirmed: value?.["kind"] === "owner-confirmed" || value?.["kind"] === "dispatched" };
      }),
      approval: approvals.at(-1) ?? null,
      grant: grants.at(-1) ?? null,
      lease: leases.at(-1) ?? null,
      scopes: scopes.map(({ scope_json, ...scope }) => {
        const value = json<Record<string, unknown>>(scope_json);
        return { ...scope, allowedExactPaths: value?.["allowedExactPaths"] ?? [], allowedPathPatterns: value?.["allowedPathPatterns"] ?? [], deniedPathClasses: value?.["deniedPathClasses"] ?? [], permissions: value?.["permissions"] ?? null, maxFiles: value?.["maxFiles"] ?? null, maxBytes: value?.["maxBytes"] ?? null, policyOutcome: "server-verified" };
      }),
      queue: latestQueue ?? null,
      results: results.map(({ result_json, ...result }) => {
        const value = json<Record<string, unknown>>(result_json);
        return { ...result, state: value?.["state"] ?? result.status, output: safeText(String(value?.["output"] ?? "")), outputTruncated: value?.["outputTruncated"] === true, failureCode: value?.["failureCode"] ?? null, journalRef: value?.["journalRef"] ?? null, provenance: "automated-bridge-report", workerClaim: true };
      }),
      manualResults: manualResults.map(({ result_json, ...result }) => ({ ...result, ...json<Record<string, unknown>>(result_json), text: safeText(String(json<Record<string, unknown>>(result_json)?.["text"] ?? "")) })),
      structuredResult: browserSafe(latestManualResult ? json<unknown>(latestManualResult.result_json) : latestResult ? json<unknown>(latestResult.result_json) : null),
      transitions: transitions.map(({ evidence_json, blocked_context_json, ...transition }) => ({ ...transition, evidence: browserSafe(json<unknown[]>(evidence_json) ?? []), blockedContext: browserSafe(json<Record<string, unknown>>(blocked_context_json)) })),
      events: events.reverse().map((event) => ({ sequence: event.sequence, eventId: event.event_id, occurredAt: event.occurred_at, payload: browserSafe(json<unknown>(event.payload_json)) })),
      actions: {
        canApproveDispatch: task.state === "AWAITING_DISPATCH" && latestAssignment?.["status"] === "pending-approval",
        canCancel: ["DRAFT", "CONTEXT_PREPARING", "AWAITING_DISPATCH", "RUNNING", "RESULT_CAPTURED", "AWAITING_APPROVAL", "APPROVED", "REVISION_REQUESTED"].includes(task.state),
        canDecideResult: task.state === "AWAITING_APPROVAL",
        canSubmitManualText: task.state === "RUNNING" && latestAssignment?.["worker_id"] === "manual-relay" && latestAssignment?.["status"] === "manual-active",
        canRetry: false,
      },
    };
  }

  public snapshot(principal: Principal): Record<string, unknown> {
    const tasks = this.database.connection.prepare("SELECT task_id,project_id,state,attempt_id,blocked_context_json,updated_at,version,created_at,current_operation_id,cancellation_requested_at FROM tasks ORDER BY updated_at DESC,task_id DESC LIMIT 200").all() as TaskRow[];
    const readinessRows = this.database.connection.prepare("SELECT readiness_id,worker_id,adapter_id,readiness_json,evidence_json,recorded_at FROM m5_adapter_readiness ORDER BY recorded_at DESC").all() as Array<{ readiness_id: string; worker_id: string; adapter_id: string; readiness_json: string; evidence_json: string; recorded_at: string }>;
    const seen = new Set<string>();
    const adapters = readinessRows.flatMap((row) => {
      const identity = `${row.worker_id}:${row.adapter_id}`;
      if (seen.has(identity)) return [];
      seen.add(identity);
      const parsed = parseAdapterReadiness(json<unknown>(row.readiness_json));
      if (!parsed.ok) return [];
      const evidence = json<Record<string, unknown>>(row.evidence_json);
      const windowsSandbox = object(evidence?.["windowsSandbox"]) ? evidence["windowsSandbox"] : null;
      return [{
        readinessId: parsed.value.readinessId, workerId: parsed.value.workerId, adapterId: parsed.value.adapterId, connectorTier: parsed.value.connectorTier,
        providerId: parsed.value.providerId, runtimeId: parsed.value.runtimeId, version: parsed.value.installedVersion, executableId: parsed.value.executableId, executableHash: parsed.value.executableHash,
        authenticationState: parsed.value.authenticationState, readinessState: parsed.value.readinessState, healthStatus: parsed.value.healthStatus, freezeState: parsed.value.freezeState,
        sandboxCapability: parsed.value.sandboxCapability, sandboxAssurance: windowsSandbox?.["assurance"] ?? "unknown", noninteractiveCapability: parsed.value.noninteractiveCapability,
        structuredOutputCapability: parsed.value.structuredOutputCapability, cancellationCapability: parsed.value.cancellationCapability, resumeCapability: parsed.value.resumeCapability,
        quotaConfidence: parsed.value.quotaVisibility, capabilityProbeAt: parsed.value.capabilityProbeAt, recordedAt: row.recorded_at,
        degradedBoundedLocal: windowsSandbox?.["assurance"] === "degraded-bounded-local", drift: evidence?.["drift"] === true,
      }];
    });
    const workerStates = this.database.connection.prepare("SELECT worker_id,state,updated_at FROM m5_worker_states ORDER BY worker_id").all() as Array<Record<string, unknown>>;
    const cursor = this.database.connection.prepare("SELECT head_sequence,oldest_retained_sequence FROM event_streams WHERE stream_id='ui-tasks'").get() as { head_sequence: number; oldest_retained_sequence: number } | undefined;
    return {
      generatedAt: new Date().toISOString(), session: { username: principal.username, role: "sole-administrator" },
      controlPlane: { health: "ok", readiness: this.database.isReady() ? "ready" : "unavailable", localOnly: true },
      bridge: { availability: "unavailable", connected: false, lastSeenAt: null, reason: "No authoritative Bridge heartbeat is connected to this M6 surface." },
      cursor: { streamId: "ui-tasks", lastConsumedSequence: cursor?.head_sequence ?? 0, oldestRetainedSequence: cursor?.oldest_retained_sequence ?? 1 },
      tasks: tasks.map((task) => this.snapshotTask(task)), adapters,
      workers: [...workerStates, { worker_id: "manual-relay", state: "manual-only", updated_at: null, adapter_id: "manual-relay", connector_tier: "manual-relay" }],
      manualRelay: { available: true, provenance: "owner-attested manual relay", assurance: "weaker-manual", automatedExecution: false, artifactTransportAvailable: false, allowedArtifactTypes: ALLOWED_MANUAL_ARTIFACT_TYPES, appliedToProject: false, appliedToWorktree: false },
    };
  }

  public createTask(principal: Principal, raw: Record<string, unknown>): Record<string, unknown> {
    const idempotencyKey = requireIdempotency(raw.idempotencyKey);
    const projectId = requireId(raw.projectId, "projectId");
    if (typeof raw.instructions !== "string" || raw.instructions.trim().length < 1 || Buffer.byteLength(raw.instructions) > M4_LIMITS.maxTaskInputBytes) throw new M6Error("INVALID_REQUEST", "instructions are required and bounded");
    const instructions = safeText(raw.instructions.trim(), M4_LIMITS.maxTaskInputBytes);
    const workerId = raw.workerId === "codex-cli" || raw.workerId === "manual-relay" ? raw.workerId : null;
    if (workerId === null) throw new M6Error("INVALID_REQUEST", "an explicitly supported worker is required");
    const timeoutSec = raw.timeoutSec === undefined ? 1_800 : Number(raw.timeoutSec);
    if (!Number.isSafeInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 86_400) throw new M6Error("INVALID_REQUEST", "timeout is invalid");
    const scopeMode = raw.scopeMode === "read-only" ? "read-only" : raw.scopeMode === "workspace-write" ? "workspace-write" : null;
    const allowedPaths = Array.isArray(raw.allowedPaths) ? raw.allowedPaths : [];
    if (workerId === "codex-cli" && (scopeMode === null || allowedPaths.length < 1 || allowedPaths.length > 32 || allowedPaths.some((path) => typeof path !== "string"))) throw new M6Error("INVALID_REQUEST", "Codex requires an explicit bounded scope and at least one allowed path");
    const request = { ownerId: principal.administratorId, projectId, instructions, workerId, scopeMode, allowedPaths, timeoutSec };
    return this.mutation(`task.create:${principal.administratorId}`, idempotencyKey, request, () => {
      const suffix = randomUUID(); const taskId = `task-${suffix}`; const attemptId = `attempt-${suffix}`; const operationId = `operation-${suffix}`;
      const action: ApprovalAction = {
        actionVersion: "1.0", taskId, attemptId, operationId, operation: "worker.dispatch", policyClass: "worker-execution",
        target: { kind: "worker", resourceId: workerId },
        parameters: { projectId, workspaceId: `workspace-${suffix}`, worker: { manifestId: workerId, manifestVersion: "1.0.0" }, instructionDigest: sha256(instructions), contextArtifactIds: [] },
        constraints: { timeoutSec, requiresCleanWorktree: true, expectedArtifactId: null },
      };
      this.orchestrator.createTask(`m6-create-${suffix}`, { taskId, projectId });
      if (workerId === "manual-relay") this.orchestrator.createManualAttempt(`m6-attempt-${suffix}`, { taskId, attemptId, action, taskInput: instructions });
      else this.orchestrator.createCodexAttempt(`m6-attempt-${suffix}`, { taskId, attemptId, action, taskInput: instructions });
      const activated = this.orchestrator.activateAttempt(taskId, principal.administratorId);
      if (workerId === "manual-relay") {
        const started = this.orchestrator.startManualRelay(`m6-manual-${suffix}`, { taskId, attemptId, assignmentId: `assignment-${suffix}`, ownerId: principal.administratorId, expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() });
        return { taskId, attemptId, operationId, state: started.state, version: started.version, workerId, replayed: false };
      }
      const readiness = this.database.connection.prepare("SELECT readiness_id FROM m5_adapter_readiness WHERE worker_id=? AND adapter_id=? ORDER BY recorded_at DESC LIMIT 1").get(M4_LIMITS.codexWorkerId, M4_LIMITS.codexAdapterId) as { readiness_id: string } | undefined;
      if (!readiness) {
        const blocked = this.orchestrator.transition(taskId, activated.version, { to: "BLOCKED", actor: "control-plane", proposedBlockedContext: { blockedFrom: "AWAITING_DISPATCH", blockedOperation: "worker-dispatch", blockedReason: "no-eligible-worker", attemptId, operationId } });
        return { taskId, attemptId, operationId, state: blocked.state, version: blocked.version, workerId, degraded: true, reason: "no-eligible-worker", replayed: false };
      }
      const core = {
        scopeVersion: "1.0" as const, scopeId: `scope-${suffix}`, repositoryRootId: `repository-${projectId}`, worktreeRootId: `worktree-${suffix}`,
        taskId, attemptId, operationId, allowedExactPaths: allowedPaths as string[], allowedPathPatterns: [],
        deniedPathClasses: ["credentials", "production", "infrastructure", "database", "mikrotik", "deployment", "unrelated-repository", "system"] as const,
        readOnlyPaths: [], generatedArtifactRoot: null, permissions: { create: scopeMode === "workspace-write", modify: scopeMode === "workspace-write", delete: false }, maxFiles: 100, maxBytes: 16 * 1024 * 1024,
      };
      const scopeDigest = digestWriteScope(core);
      if (!scopeDigest.ok) throw new M6Error("INVALID_REQUEST", "write scope is invalid");
      const writeScope: WriteScope = { ...core, deniedPathClasses: [...core.deniedPathClasses], scopeHash: scopeDigest.value };
      if (!verifyWriteScope(writeScope).ok) throw new M6Error("INVALID_REQUEST", "write scope is invalid");
      this.orchestrator.assignCodex(`m6-assign-${suffix}`, { taskId, attemptId, assignmentId: `assignment-${suffix}`, leaseId: `lease-${suffix}`, ownerAssignmentRef: `owner-${principal.administratorId}`, leaseExpiresAt: new Date(Date.now() + Math.min(timeoutSec * 1_000 + 300_000, 86_400_000)).toISOString(), readinessSnapshotRef: readiness.readiness_id, writeScope });
      return { taskId, attemptId, operationId, state: "AWAITING_DISPATCH", version: activated.version, workerId, replayed: false };
    });
  }

  public approveDispatch(principal: Principal, taskIdRaw: unknown, raw: Record<string, unknown>): Record<string, unknown> {
    const taskId = requireId(taskIdRaw, "taskId"); const idempotencyKey = requireIdempotency(raw["idempotencyKey"]); const expectedVersion = requireVersion(raw["expectedVersion"]);
    return this.mutation(`dispatch.approve:${taskId}`, idempotencyKey, { ownerId: principal.administratorId, taskId, expectedVersion }, () => {
      const task = this.task(taskId);
      if (task.version !== expectedVersion) throw new M6Error("STALE_STATE", "task version is stale");
      if (task.state !== "AWAITING_DISPATCH" || task.attempt_id === null || task.current_operation_id === null) throw new M6Error("CONFLICT", "task is not awaiting dispatch approval");
      const binding = this.database.connection.prepare("SELECT a.assignment_id,a.worker_id,a.status,a.assignment_json,s.scope_hash FROM m4_assignments a JOIN m4_write_scopes s ON s.task_id=a.task_id AND s.attempt_id=a.attempt_id AND s.operation_id=a.operation_id WHERE a.task_id=? AND a.attempt_id=? AND a.operation_id=?").get(taskId, task.attempt_id, task.current_operation_id) as { assignment_id: string; worker_id: string; status: string; assignment_json: string; scope_hash: string } | undefined;
      const attempt = this.database.connection.prepare("SELECT action_digest FROM task_attempts WHERE attempt_id=?").get(task.attempt_id) as { action_digest: string } | undefined;
      if (!binding || !attempt || binding.status !== "pending-approval" || binding.worker_id !== M4_LIMITS.codexWorkerId) throw new M6Error("CONFLICT", "the dispatch approval point is unavailable");
      const approvalId = deriveApprovalId({ ownerId: principal.administratorId, taskId, attemptId: task.attempt_id, operationId: task.current_operation_id, actionDigest: attempt.action_digest, scopeHash: binding.scope_hash, workerId: M4_LIMITS.codexWorkerId, adapterId: M4_LIMITS.codexAdapterId });
      const keyHash = createHash("sha256").update(`${taskId}\n${idempotencyKey}`).digest("hex");
      const issued = this.orchestrator.approveAndIssueCodex(`m6-approve-${keyHash.slice(0, 48)}`, { taskId, attemptId: task.attempt_id, ownerId: principal.administratorId, approvalId, grantId: `grant-${keyHash.slice(0, 48)}`, issuerId: "control-plane", lifetimeMs: 5 * 60_000 });
      return { taskId, state: task.state, version: task.version, approvalId: issued.approvalId, grant: { grantId: issued.grant.grantId, status: "issued", issuedAt: issued.grant.issuedAt, expiresAt: issued.grant.expiresAt, singleUse: true } };
    });
  }

  public cancel(principal: Principal, taskIdRaw: unknown, raw: Record<string, unknown>): Record<string, unknown> {
    const taskId = requireId(taskIdRaw, "taskId"); const idempotencyKey = requireIdempotency(raw["idempotencyKey"]); const expectedVersion = requireVersion(raw["expectedVersion"]);
    return this.mutation(`task.cancel:${taskId}`, idempotencyKey, { ownerId: principal.administratorId, taskId, expectedVersion }, () => {
      const task = this.task(taskId);
      if (task.version !== expectedVersion) throw new M6Error("STALE_STATE", "task version is stale");
      const result = this.orchestrator.cancel(taskId);
      return { taskId, state: result.state, version: result.version, cancellationConfirmed: result.state === "CANCELLED" };
    });
  }

  public decideResult(principal: Principal, taskIdRaw: unknown, raw: Record<string, unknown>): Record<string, unknown> {
    const taskId = requireId(taskIdRaw, "taskId"); const idempotencyKey = requireIdempotency(raw["idempotencyKey"]); const expectedVersion = requireVersion(raw["expectedVersion"]);
    const decision = raw["decision"] === "approve" ? "APPROVED" : raw["decision"] === "reject" ? "REJECTED" : null;
    if (decision === null) throw new M6Error("INVALID_REQUEST", "decision is invalid");
    return this.mutation(`result.decide:${taskId}`, idempotencyKey, { ownerId: principal.administratorId, taskId, expectedVersion, decision }, () => {
      const task = this.task(taskId);
      if (task.version !== expectedVersion) throw new M6Error("STALE_STATE", "task version is stale");
      if (task.state !== "AWAITING_APPROVAL") throw new M6Error("CONFLICT", "task is not awaiting an owner result decision");
      const result = this.orchestrator.transition(taskId, task.version, { to: decision, actor: "owner" });
      return { taskId, state: result.state, version: result.version, decision: decision === "APPROVED" ? "approve" : "reject" };
    });
  }

  public manualText(principal: Principal, taskIdRaw: unknown, raw: Record<string, unknown>): Record<string, unknown> {
    const taskId = requireId(taskIdRaw, "taskId"); const idempotencyKey = requireIdempotency(raw["idempotencyKey"]); const expectedVersion = requireVersion(raw["expectedVersion"]);
    const responseType = raw["responseType"] === "text" || raw["responseType"] === "review" || raw["responseType"] === "design" ? raw["responseType"] : null;
    if (responseType === null || typeof raw["text"] !== "string" || raw["attested"] !== true) throw new M6Error("INVALID_REQUEST", "an owner-attested bounded manual response is required");
    if (Buffer.byteLength(raw["text"]) > M4_LIMITS.maxResultBytes) throw new M6Error("INVALID_REQUEST", "manual response exceeds its bound");
    const text = safeText(raw["text"], M4_LIMITS.maxResultBytes);
    return this.mutation(`manual.text:${taskId}`, idempotencyKey, { ownerId: principal.administratorId, taskId, expectedVersion, responseType, text, attested: true }, () => {
      const task = this.task(taskId);
      if (task.attempt_id === null || task.current_operation_id === null) throw new M6Error("CONFLICT", "manual relay attempt is unavailable");
      const digest = createHash("sha256").update(`${taskId}\n${idempotencyKey}\n${text}`).digest("hex");
      return this.orchestrator.recordManualTextResult(`m6-manual-result-${digest.slice(0, 40)}`, { taskId, attemptId: task.attempt_id, operationId: task.current_operation_id, expectedVersion, ownerId: principal.administratorId, resultRef: `manual-result-${digest.slice(0, 48)}`, responseType, text, attestationId: `attestation-${digest.slice(0, 48)}` });
    });
  }

  public artifactUnavailable(raw: Record<string, unknown>): never {
    requireIdempotency(raw["idempotencyKey"]);
    throw new M6Error("UNAVAILABLE", "artifact import requires the outbound Local Bridge; no inbound or simulated artifact path is available");
  }
}

export function mapM6Error(error: unknown): Readonly<{ status: number; code: string }> {
  if (error instanceof M6Error) return { status: error.code === "NOT_FOUND" ? 404 : error.code === "UNAVAILABLE" ? 503 : error.code === "STALE_STATE" || error.code === "CONFLICT" ? 409 : 400, code: error.code };
  if (error instanceof M4Error) return { status: error.code === "NOT_FOUND" ? 404 : error.code === "STALE_VERSION" || error.code === "CONFLICT" || error.code === "IDEMPOTENCY_CONFLICT" ? 409 : 400, code: error.code === "STALE_VERSION" ? "STALE_STATE" : error.code };
  return { status: 400, code: "INVALID_REQUEST" };
}

export const m6LooksSensitive = (value: string): boolean => {
  const findings = detectRedactions(value);
  return !findings.ok || findings.value.length > 0 || SHA256.test(value) && value.length > 100;
};
