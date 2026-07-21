import { describe, expect, it } from "vitest";
import * as shared from "../src/index.js";
import {
  ADAPTER_COORDINATION_VERSION,
  AdapterReadinessSchema,
  AssignmentSchema,
  EvidenceRecordSchema,
  EVIDENCE_AUTHORITY_BY_KIND,
  HandoffSchema,
  JournalEntrySchema,
  LeaseSchema,
  LifecycleEventSchema,
  QuotaSnapshotSchema,
  TraceCorrelationSchema,
  WriteScopeSchema,
  classifyJournalReconciliationTarget,
  classifyLifecycleDelivery,
  classifyQuota,
  canTransition,
  digestWriteScope,
  evaluateAdapterContinuation,
  evaluateAssignmentDispatch,
  evaluateCancellationEvidence,
  evaluateEvidenceBinding,
  evaluateHandoff,
  evaluateJournalReconciliation,
  evaluateLease,
  parseAdapterReadiness,
  parseAdapterRun,
  parseAssignment,
  parseEvidenceRecord,
  parseHandoff,
  parseJournalEntry,
  parseLease,
  parseLifecycleEvent,
  parseQuotaSnapshot,
  parseTraceCorrelation,
  parseWriteScope,
  verifyWriteScope,
} from "../src/index.js";

const now = "2026-07-21T01:00:00Z";
const later = "2026-07-21T02:00:00Z";
const readiness = () => ({
  coordinationVersion: ADAPTER_COORDINATION_VERSION, readinessId: "ready-1", adapterId: "codex-cli", workerId: "codex", connectorTier: "cli", providerId: "openai", runtimeId: "node", installedVersion: "1.2.3", executableId: "exec-1", executableHash: "sha256:" + "a".repeat(64), authenticationState: "authenticated", sandboxCapability: "probed", noninteractiveCapability: "validated", structuredOutputCapability: "observed", cancellationCapability: "probed", resumeCapability: "probed", healthStatus: "healthy", quotaVisibility: "observed", freezeState: "enabled", capabilityProbeAt: now, readinessState: "ready", capabilities: [{ capability: "code-edit", assurance: "validated", evidenceRef: "evidence-1" }], evidenceRefs: ["evidence-1"],
});
const scopeCore = () => ({
  scopeVersion: ADAPTER_COORDINATION_VERSION, scopeId: "scope-1", repositoryRootId: "repo-1", worktreeRootId: "worktree-1", taskId: "task-1", attemptId: "attempt-1", operationId: "op-1", allowedExactPaths: ["packages/shared/src/file.ts"], allowedPathPatterns: ["packages/shared/test/*.test.ts"], deniedPathClasses: ["credentials", "production", "infrastructure", "database", "mikrotik", "deployment", "unrelated-repository"], readOnlyPaths: ["pnpm-lock.yaml"], generatedArtifactRoot: "artifacts", permissions: { create: true, modify: true, delete: false }, maxFiles: 10, maxBytes: 10_000,
});
const lease = () => ({ coordinationVersion: ADAPTER_COORDINATION_VERSION, leaseId: "lease-1", resourceId: "scope-1", projectId: "project-1", workspaceId: "worktree-1", taskId: "task-1", attemptId: "attempt-1", operationId: "op-1", holderWorkerId: "codex", holderAdapterId: "codex-cli", issuedAt: now, expiresAt: later, renewalGeneration: 1, status: "active", supersededByLeaseId: null, authoritativeLeaseSnapshotRef: "lease-snapshot-1" });
const quota = () => ({ coordinationVersion: ADAPTER_COORDINATION_VERSION, quotaId: "quota-1", providerId: "openai", adapterId: "codex-cli", workerId: "codex", quotaKind: "requests", remaining: 4, used: 6, limit: 10, resetAt: later, window: "hour", source: "provider-reported", confidence: "validated", observedAt: now, expiresAt: later, rateLimitState: "clear", circuitBreakerState: "closed", authenticationState: "authenticated", evidenceRefs: ["evidence-1"] });

describe("M1F adapter readiness and runs", () => {
  it("distinguishes declared capability from validated readiness and refuses manual automation", () => {
    expect(parseAdapterReadiness(readiness()).ok).toBe(true);
    expect(parseAdapterReadiness({ ...readiness(), connectorTier: "manual-relay", readinessState: "ready" }).ok).toBe(false);
    expect(parseAdapterReadiness({ ...readiness(), capabilities: [{ capability: "code-edit", assurance: "declared", evidenceRef: null }] }).ok).toBe(true);
  });

  it("keeps run states, cancellation confirmation, resume identity, and malformed output explicit", () => {
    const run = { coordinationVersion: ADAPTER_COORDINATION_VERSION, adapterRunId: "run-1", taskId: "task-1", attemptId: "attempt-1", operationId: "op-1", workerId: "codex", adapterId: "codex-cli", connectorTier: "cli", readinessSnapshotRef: "ready-1", invocationMode: "noninteractive", requestedCapability: "code-edit", startedAt: now, endedAt: later, structuredOutputState: "malformed", cancellationState: "unconfirmed", resumedFromRunId: null, quotaSnapshotRef: "quota-1", lifecycleState: "interrupted", captureRefs: ["capture-1"], evidenceRefs: ["evidence-1"], blockedReason: null, runtimeProvenanceRefs: ["prov-1"], cancellationEvidenceRefs: [] };
    expect(parseAdapterRun(run).ok).toBe(true);
    expect(parseAdapterRun({ ...run, resumedFromRunId: "run-1" }).ok).toBe(false);
    expect(parseAdapterRun({ ...run, lifecycleState: "completed", endedAt: null }).ok).toBe(false);
  });

  it("rejects contradictory ready states and accepts only healthy authenticated probed readiness", () => {
    expect(parseAdapterReadiness(readiness()).ok).toBe(true);
    for (const patch of [{ authenticationState: "expired" }, { authenticationState: "missing" }, { healthStatus: "unhealthy" }, { freezeState: "frozen" }, { noninteractiveCapability: "unavailable" }, { cancellationCapability: "unknown" }]) expect(parseAdapterReadiness({ ...readiness(), ...patch }).ok).toBe(false);
  });

  it("requires confirmed, exact-run cancellation evidence for cancelled runs", () => {
    const run = { coordinationVersion: ADAPTER_COORDINATION_VERSION, adapterRunId: "run-1", taskId: "task-1", attemptId: "attempt-1", operationId: "op-1", workerId: "codex", adapterId: "codex-cli", connectorTier: "cli", readinessSnapshotRef: "ready-1", invocationMode: "noninteractive", requestedCapability: "code-edit", startedAt: now, endedAt: later, structuredOutputState: "received", cancellationState: "confirmed", resumedFromRunId: null, quotaSnapshotRef: null, lifecycleState: "cancelled", captureRefs: [], evidenceRefs: [], blockedReason: null, runtimeProvenanceRefs: [], cancellationEvidenceRefs: ["cancel-1"] };
    const evidence = { coordinationVersion: ADAPTER_COORDINATION_VERSION, evidenceId: "cancel-1", kind: "cancellation-termination", subject: { taskId: "task-1", attemptId: "attempt-1", operationId: "op-1", adapterRunId: "run-1", leaseId: null, artifactId: null }, sourceId: "bridge-1", authority: "observed", requiredBindings: ["task", "attempt", "operation", "adapter-run"], permittedUses: ["reconciliation"], prohibitedTrustElevation: true, reference: "termination-1" };
    expect(parseAdapterRun(run).ok).toBe(true);
    expect(parseAdapterRun({ ...run, cancellationState: "not-requested" }).ok).toBe(false);
    expect(parseAdapterRun({ ...run, cancellationState: "unconfirmed" }).ok).toBe(false);
    expect(parseAdapterRun({ ...run, lifecycleState: "completed" }).ok).toBe(false);
    expect(evaluateCancellationEvidence(run, { evidence: [evidence] }).code).toBe("VALID");
    expect(evaluateCancellationEvidence(run, { evidence: [{ ...evidence, subject: { ...evidence.subject, adapterRunId: "run-2" } }] }).code).toBe("EVIDENCE_MISMATCH");
  });
});

describe("M1F assignment and scope authority", () => {
  const assignment = () => ({ coordinationVersion: ADAPTER_COORDINATION_VERSION, assignmentId: "assign-1", taskId: "task-1", attemptId: "attempt-1", operationId: "op-1", projectId: "project-1", workerId: "codex", adapterId: "codex-cli", requiredCapabilities: ["code-edit"], permittedConnectorTier: "cli", writeScopeRef: "scope-1", leaseRequired: true, readinessSnapshotRef: "ready-1", quotaSnapshotRef: "quota-1", approvalGrantRef: null, expectedEvidenceRefs: ["evidence-1"], expiresAt: later, rationaleEvidenceRefs: ["evidence-1"] });
  it("separates recommendation, owner confirmation, and dispatch", () => {
    expect(parseAssignment({ ...assignment(), kind: "recommendation" }).ok).toBe(true);
    expect(parseAssignment({ ...assignment(), kind: "owner-confirmed", ownerApprovalRef: "approval-1" }).ok).toBe(true);
    expect(parseAssignment({ ...assignment(), kind: "dispatched", ownerApprovalRef: "approval-1", dispatchEventRef: "event-1", adapterRunId: "run-1" }).ok).toBe(true);
    expect(parseAssignment({ ...assignment(), kind: "recommendation", dispatchEventRef: "event-1" }).ok).toBe(false);
    expect(parseAssignment({ ...assignment(), kind: "owner-confirmed", ownerApprovalRef: "approval-1", leaseRequired: false }).ok).toBe(false);
  });

  it("does not let a recommendation or stale/cross-bound assignment authorize dispatch", () => {
    const digest = digestWriteScope(scopeCore()); if (!digest.ok) throw new Error("fixture digest failed");
    const context = { now, readiness: readiness(), quota: quota(), writeScope: { ...scopeCore(), scopeHash: digest.value }, lease: lease(), approvalGrant: null };
    expect(evaluateAssignmentDispatch({ ...assignment(), kind: "recommendation" }, context).code).toBe("RECOMMENDATION_NOT_AUTHORIZATION");
    const dispatched = { ...assignment(), kind: "dispatched", ownerApprovalRef: "approval-1", dispatchEventRef: "event-1", adapterRunId: "run-1" };
    expect(evaluateAssignmentDispatch(dispatched, context).code).toBe("DISPATCHABLE");
    expect(evaluateAssignmentDispatch({ ...dispatched, taskId: "task-2" }, context).code).toBe("CROSS_SCOPE");
    expect(evaluateAssignmentDispatch({ ...dispatched, expiresAt: now }, context).code).toBe("STALE");
    expect(evaluateAssignmentDispatch(dispatched, { ...context, lease: { ...lease(), status: "released" } }).code).toBe("LEASE_NOT_VALID");
  });

  it("requires validated requested capabilities and a usable snapshot, rather than labels or stale quota", () => {
    const digest = digestWriteScope(scopeCore()); if (!digest.ok) throw new Error("fixture digest failed");
    const dispatched = { ...assignment(), kind: "dispatched", ownerApprovalRef: "approval-1", dispatchEventRef: "event-1", adapterRunId: "run-1" };
    const context = { now, readiness: readiness(), quota: quota(), writeScope: { ...scopeCore(), scopeHash: digest.value }, lease: lease(), approvalGrant: null };
    expect(evaluateAssignmentDispatch(dispatched, { ...context, readiness: { ...readiness(), capabilities: [{ capability: "code-edit", assurance: "declared", evidenceRef: null }] } }).code).toBe("CAPABILITY_NOT_READY");
    expect(evaluateAssignmentDispatch(dispatched, { ...context, quota: { ...quota(), expiresAt: now } }).code).toBe("QUOTA_NOT_USABLE");
  });

  it("hashes canonical portable scopes and fails closed on traversal, wildcard-all, mutation, and hash mismatch", () => {
    const digest = digestWriteScope(scopeCore());
    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    const signed = { ...scopeCore(), scopeHash: digest.value };
    expect(verifyWriteScope(signed).ok).toBe(true);
    expect(verifyWriteScope({ ...signed, maxFiles: 11 }).ok).toBe(false);
    expect(parseWriteScope({ ...signed, allowedExactPaths: ["../secret"] }).ok).toBe(false);
    expect(parseWriteScope({ ...signed, allowedPathPatterns: ["*"] }).ok).toBe(false);
    expect(parseWriteScope({ ...signed, repositoryRootId: "C:/owner-copy" }).ok).toBe(false);
    expect(parseWriteScope({ ...signed, allowedPathPatterns: ["src/**"] }).ok).toBe(false);
    expect(parseWriteScope({ ...signed, allowedExactPaths: ["artifacts/output.txt"] }).ok).toBe(false);
    expect(parseWriteScope({ ...signed, allowedPathPatterns: ["artifacts/*.txt"] }).ok).toBe(false);
  });
});

describe("M1F lease and handoff safety", () => {
  it("detects expiry, stale generations, wrong holder, release forgery, and concurrent exclusive holders", () => {
    const expected = { taskId: "task-1", attemptId: "attempt-1", operationId: "op-1", workerId: "codex", adapterId: "codex-cli", now, generation: 1, action: "use" as const };
    expect(evaluateLease(lease(), expected).code).toBe("VALID");
    expect(evaluateLease(lease(), { ...expected, now: later }).code).toBe("EXPIRED");
    expect(evaluateLease(lease(), { ...expected, generation: 0, action: "renew" }).code).toBe("STALE_GENERATION");
    expect(evaluateLease(lease(), { ...expected, workerId: "other", action: "release" }).code).toBe("RELEASE_BY_NON_HOLDER");
    expect(evaluateLease(lease(), { ...expected, adapterId: "other-adapter" }).code).toBe("WRONG_HOLDER");
    expect(evaluateLease({ ...lease(), status: "released" }, expected).code).toBe("RELEASED");
    expect(evaluateLease({ ...lease(), status: "revoked" }, expected).code).toBe("REVOKED");
    expect(evaluateLease({ ...lease(), status: "superseded", supersededByLeaseId: "lease-2" }, expected).code).toBe("SUPERSEDED");
    expect(evaluateLease(lease(), { ...expected, concurrentLease: { ...lease(), leaseId: "lease-2", holderWorkerId: "other" } }).code).toBe("CONFLICTING_EXCLUSIVE_LEASE");
  });

  it("requires a visible lease disposition and owner approval for approved handoffs", () => {
    const handoff = { coordinationVersion: ADAPTER_COORDINATION_VERSION, handoffId: "handoff-1", taskId: "task-1", attemptId: "attempt-1", operationId: "op-1", sourceWorkerId: "codex", sourceAdapterId: "codex-cli", targetWorkerId: "reviewer", targetAdapterId: "manual-relay", reason: "Needs manual review.", evidenceRefs: ["evidence-1"], capturedOutputRefs: ["capture-1"], writeScopeRef: "scope-1", leaseDisposition: "release-required", unresolvedRisks: ["Lease must be released."], continuationCheckpointRef: "checkpoint-1", ownerApprovalRequired: true, ownerApprovalRef: "approval-1", manualRelayDowngrade: true, state: "owner-approved" };
    expect(parseHandoff(handoff).ok).toBe(true);
    expect(parseHandoff({ ...handoff, ownerApprovalRef: null }).ok).toBe(false);
    expect(parseHandoff({ ...handoff, leaseDisposition: "release-required", writeScopeRef: null }).ok).toBe(false);
  });

  it("rejects untransferred leases and concurrent exclusive write holders", () => {
    const handoff = { coordinationVersion: ADAPTER_COORDINATION_VERSION, handoffId: "handoff-1", taskId: "task-1", attemptId: "attempt-1", operationId: "op-1", sourceWorkerId: "codex", sourceAdapterId: "codex-cli", targetWorkerId: "reviewer", targetAdapterId: "manual-relay", reason: "Needs manual review.", evidenceRefs: ["evidence-1"], capturedOutputRefs: ["capture-1"], writeScopeRef: "scope-1", leaseDisposition: "release-required", unresolvedRisks: ["Lease must be released."], continuationCheckpointRef: "checkpoint-1", ownerApprovalRequired: true, ownerApprovalRef: "approval-1", manualRelayDowngrade: true, state: "completed" as const };
    const context = { now, sourceLease: lease(), targetLease: null };
    expect(evaluateHandoff(handoff, context).code).toBe("LEASE_RELEASE_REQUIRED");
    expect(evaluateHandoff(handoff, { ...context, targetLease: { ...lease(), leaseId: "lease-2", holderWorkerId: "reviewer", holderAdapterId: "manual-relay" } }).code).toBe("CONCURRENT_EXCLUSIVE_HOLDERS");
    expect(evaluateHandoff(handoff, { ...context, sourceLease: { ...lease(), status: "released" } }).code).toBe("VALID");
    const transfer = { ...handoff, leaseDisposition: "owner-approved-transfer-required" as const };
    expect(evaluateHandoff(transfer, { ...context, sourceLease: { ...lease(), status: "revoked" }, targetLease: { ...lease(), leaseId: "lease-2", holderWorkerId: "reviewer", holderAdapterId: "manual-relay", status: "revoked" } }).code).toBe("TARGET_LEASE_MISMATCH");
  });
});

describe("M1F quota, evidence, lifecycle, and journal contracts", () => {
  it("never upgrades estimated or owner-entered quota and classifies operational uncertainty", () => {
    expect(parseQuotaSnapshot(quota()).ok).toBe(true);
    expect(classifyQuota(quota(), now)).toBe("usable");
    expect(classifyQuota({ ...quota(), remaining: 0 }, now)).toBe("insufficient");
    expect(classifyQuota({ ...quota(), expiresAt: now }, now)).toBe("stale");
    expect(classifyQuota({ ...quota(), rateLimitState: "limited" }, now)).toBe("rate-limited");
    expect(classifyQuota({ ...quota(), source: "owner-entered", confidence: "owner-attested" }, now)).toBe("confidence-too-low");
    expect(parseQuotaSnapshot({ ...quota(), source: "owner-entered", confidence: "validated" }).ok).toBe(false);
    expect(parseQuotaSnapshot({ ...quota(), used: 7, remaining: 4 }).ok).toBe(false);
    expect(parseQuotaSnapshot({ ...quota(), remaining: 1.5 }).ok).toBe(false);
    expect(parseQuotaSnapshot({ ...quota(), used: -1 }).ok).toBe(false);
  });

  it("prevents manual relay and worker claims from being labeled as automated validation", () => {
    const evidence = { coordinationVersion: ADAPTER_COORDINATION_VERSION, evidenceId: "evidence-1", kind: "owner-attested-manual-relay", subject: { taskId: "task-1", attemptId: "attempt-1", operationId: "op-1", adapterRunId: null, leaseId: null, artifactId: null }, sourceId: "owner-1", authority: "owner-attested", requiredBindings: ["task", "attempt", "operation"], permittedUses: ["display"], prohibitedTrustElevation: true, reference: "capture-1" };
    expect(parseEvidenceRecord(evidence).ok).toBe(true);
    expect(parseEvidenceRecord({ ...evidence, authority: "validated" }).ok).toBe(false);
    expect(parseEvidenceRecord({ ...evidence, kind: "worker-claim", authority: "validated" }).ok).toBe(false);
    expect(evaluateEvidenceBinding(evidence, { ...evidence.subject, taskId: "task-2" }).code).toBe("CROSS_SCOPE");
    expect(parseEvidenceRecord({ ...evidence, requiredBindings: ["task", "attempt", "operation", "lease"] }).ok).toBe(false);
    for (const [kind, authorities] of Object.entries(EVIDENCE_AUTHORITY_BY_KIND)) expect(parseEvidenceRecord({ ...evidence, evidenceId: `ev-${kind}`, kind, authority: authorities[0] }).ok).toBe(true);
    expect(parseEvidenceRecord({ ...evidence, kind: "reviewed-artifact-import", authority: "validated" }).ok).toBe(false);
    expect(parseEvidenceRecord({ ...evidence, kind: "approval", authority: "validated" }).ok).toBe(false);
  });

  it("distinguishes duplicate delivery from conflicting cursor and idempotency reuse", () => {
    const event = { coordinationVersion: ADAPTER_COORDINATION_VERSION, eventId: "event-1", cursor: 1, idempotencyKey: "event-key-1", eventKind: "dispatch", taskId: "task-1", attemptId: "attempt-1", operationId: "op-1", adapterRunId: "run-1", leaseId: "lease-1", workerId: "codex", adapterId: "codex-cli", occurredAt: now, evidenceRefs: ["evidence-1"], trace: { traceId: "trace-1", spanId: "span-1", parentSpanId: null } };
    expect(parseLifecycleEvent(event).ok).toBe(true);
    expect(classifyLifecycleDelivery(event, event)).toBe("duplicate");
    expect(classifyLifecycleDelivery({ ...event, eventId: "event-2" }, event)).toBe("conflicting-cursor");
    expect(classifyLifecycleDelivery({ ...event, cursor: 2 }, event)).toBe("conflicting-event-id");
    expect(classifyLifecycleDelivery({ ...event, eventId: "event-2", idempotencyKey: "event-key-2", cursor: 0 }, event)).toBe("out-of-order");
    expect(classifyLifecycleDelivery({ ...event, eventId: "event-2", idempotencyKey: "event-key-2", cursor: 2 }, event)).toBe("new");
    expect(classifyLifecycleDelivery({ ...event, eventId: "event-2", extra: "no" }, event)).toBe("malformed");
  });

  it("requires owner plus trusted runtime evidence for execution-unknown reconciliation and preserves original operation", () => {
    const unknown = { coordinationVersion: ADAPTER_COORDINATION_VERSION, journalEntryId: "journal-1", taskId: "task-1", attemptId: "attempt-1", operationId: "op-1", adapterRunId: "run-1", leaseId: "lease-1", grantId: null, stage: "execution-unknown", originalOperationStage: "execution", trustedRuntimeEvidenceRef: "runtime-1", ownerReconciliationEvidenceRef: null, recordedAt: now };
    const reconciled = { ...unknown, stage: "reconciled-completed", ownerReconciliationEvidenceRef: "owner-1", recordedAt: later };
    expect(parseJournalEntry(unknown).ok).toBe(true);
    expect(evaluateJournalReconciliation(unknown, reconciled).code).toBe("VALID");
    expect(evaluateJournalReconciliation(unknown, { ...reconciled, trustedRuntimeEvidenceRef: null }).code).toBe("RUNTIME_EVIDENCE_REQUIRED");
    expect(evaluateJournalReconciliation(unknown, { ...reconciled, operationId: "op-2" }).code).toBe("WRONG_OPERATION");
    expect(evaluateJournalReconciliation({ ...unknown, stage: "started" }, reconciled).code).toBe("BLIND_RETRY_FORBIDDEN");
    expect(classifyJournalReconciliationTarget(reconciled)).toBe("RESULT_CAPTURED");
    expect(classifyJournalReconciliationTarget({ ...reconciled, originalOperationStage: "integration" })).toBe("COMPLETED");
  });

  it("binds a resume to the exact interrupted run, attempt, operation, worker, and adapter", () => {
    const prior = { coordinationVersion: ADAPTER_COORDINATION_VERSION, adapterRunId: "run-1", taskId: "task-1", attemptId: "attempt-1", operationId: "op-1", workerId: "codex", adapterId: "codex-cli", connectorTier: "cli", readinessSnapshotRef: "ready-1", invocationMode: "noninteractive", requestedCapability: "code-edit", startedAt: now, endedAt: later, structuredOutputState: "received", cancellationState: "not-requested", resumedFromRunId: null, quotaSnapshotRef: "quota-1", lifecycleState: "interrupted", captureRefs: [], evidenceRefs: [], blockedReason: null, runtimeProvenanceRefs: [], cancellationEvidenceRefs: [] };
    const resumed = { ...prior, adapterRunId: "run-2", resumedFromRunId: "run-1", lifecycleState: "running", endedAt: null };
    expect(evaluateAdapterContinuation(resumed, prior).code).toBe("VALID");
    expect(evaluateAdapterContinuation({ ...resumed, attemptId: "attempt-2" }, prior).code).toBe("CROSS_SCOPE");
    expect(evaluateAdapterContinuation({ ...resumed, resumedFromRunId: "run-x" }, prior).code).toBe("WRONG_RUN");
  });
});

describe("M1F hostile-input and export boundary behavior", () => {
  it("returns bounded failures for hostile getters, proxies, iterators, coercion, unknown fields, values, versions, and aggregate limits", () => {
    const hostile = Object.defineProperty({}, "coordinationVersion", { get() { throw new Error("nope"); } });
    expect(parseAdapterReadiness(hostile).ok).toBe(false);
    const proxy = new Proxy({}, { ownKeys() { throw new Error("nope"); } });
    expect(parseAdapterReadiness(proxy).ok).toBe(false);
    const hostileIterator = { get [Symbol.iterator]() { throw new Error("nope"); } };
    expect(parseAdapterReadiness({ ...readiness(), evidenceRefs: hostileIterator }).ok).toBe(false);
    expect(parseAdapterReadiness({ ...readiness(), installedVersion: { toString() { throw new Error("nope"); } } }).ok).toBe(false);
    expect(parseAdapterReadiness({ ...readiness(), extra: "no" }).ok).toBe(false);
    expect(parseHandoff({ coordinationVersion: ADAPTER_COORDINATION_VERSION, handoffId: "handoff-1", taskId: "task-1", attemptId: "attempt-1", operationId: "op-1", sourceWorkerId: "codex", sourceAdapterId: "codex-cli", targetWorkerId: "reviewer", targetAdapterId: "manual-relay", reason: "api_key=super-secret-value", evidenceRefs: [], capturedOutputRefs: [], writeScopeRef: null, leaseDisposition: "not-required", unresolvedRisks: [], continuationCheckpointRef: null, ownerApprovalRequired: false, ownerApprovalRef: null, manualRelayDowngrade: true, state: "requested" }).ok).toBe(false);
    expect(parseLease({ ...lease(), status: "owned-forever" }).ok).toBe(false);
    expect(parseQuotaSnapshot({ ...quota(), coordinationVersion: "2.0" }).ok).toBe(false);
    expect(parseLifecycleEvent({ ...({ coordinationVersion: ADAPTER_COORDINATION_VERSION, eventId: "event-1", cursor: 1, idempotencyKey: "event-key-1", eventKind: "dispatch", taskId: "task-1", attemptId: "attempt-1", operationId: "op-1", adapterRunId: null, leaseId: null, workerId: "codex", adapterId: "codex-cli", occurredAt: now, evidenceRefs: [], trace: { traceId: "trace-1", spanId: "span-1", parentSpanId: null } }), evidenceRefs: Array.from({ length: 65 }, (_, i) => `ev-${i}`) }).ok).toBe(false);
    expect(parseAdapterRun({ coordinationVersion: ADAPTER_COORDINATION_VERSION, adapterRunId: "run-1", taskId: "task-1", attemptId: "attempt-1", operationId: "op-1", workerId: "codex", adapterId: "codex-cli", connectorTier: "cli", readinessSnapshotRef: "ready-1", invocationMode: "noninteractive", requestedCapability: "code-edit", startedAt: now, endedAt: later, structuredOutputState: "received", cancellationState: "not-requested", resumedFromRunId: null, quotaSnapshotRef: null, lifecycleState: "completed", captureRefs: Array.from({ length: 32 }, (_, i) => `capture-${i}`), evidenceRefs: Array.from({ length: 32 }, (_, i) => `evidence-${i}`), blockedReason: null, runtimeProvenanceRefs: ["provenance-1"], cancellationEvidenceRefs: [] }).ok).toBe(false);
  });

  it("exports only pure schema/parser/evaluator contracts", () => {
    expect(AdapterReadinessSchema).toBeDefined(); expect(AssignmentSchema).toBeDefined(); expect(WriteScopeSchema).toBeDefined(); expect(LeaseSchema).toBeDefined(); expect(HandoffSchema).toBeDefined(); expect(QuotaSnapshotSchema).toBeDefined(); expect(EvidenceRecordSchema).toBeDefined(); expect(LifecycleEventSchema).toBeDefined(); expect(JournalEntrySchema).toBeDefined(); expect(TraceCorrelationSchema).toBeDefined();
    for (const forbidden of ["executeAdapter", "spawnWorker", "acquireLease", "pollQuota", "createTelemetryExporter", "readWorkspace", "writeWorkspace"]) expect(forbidden in shared).toBe(false);
  });
});

describe("M1F blocked-state integration", () => {
  const noEligible = { blockedFrom: "AWAITING_DISPATCH" as const, blockedOperation: "worker-dispatch" as const, blockedReason: "no-eligible-worker" as const, attemptId: "attempt-1", operationId: "op-1" };
  const staleLease = { blockedFrom: "APPROVED" as const, blockedOperation: "integration" as const, blockedReason: "stale-lease" as const, attemptId: "attempt-1", operationId: "op-1" };
  it("allows only compatible source stages and requires a fresh operation for new M1F blockers", () => {
    expect(canTransition({ current: { state: "AWAITING_DISPATCH", attemptId: "attempt-1" }, request: { to: "BLOCKED", actor: "control-plane", proposedBlockedContext: noEligible } }).allowed).toBe(true);
    expect(canTransition({ current: { state: "RUNNING", attemptId: "attempt-1" }, request: { to: "BLOCKED", actor: "system-recovery", proposedBlockedContext: { ...noEligible, blockedFrom: "RUNNING", blockedOperation: "worker-execution" } } }).allowed).toBe(false);
    expect(canTransition({ current: { state: "BLOCKED", attemptId: "attempt-1", blockedContext: noEligible }, request: { to: "AWAITING_DISPATCH", actor: "control-plane" } }).allowed).toBe(false);
    expect(canTransition({ current: { state: "BLOCKED", attemptId: "attempt-1", blockedContext: noEligible }, request: { to: "AWAITING_DISPATCH", actor: "control-plane", nextOperationId: "op-2" } }).allowed).toBe(true);
    expect(canTransition({ current: { state: "BLOCKED", attemptId: "attempt-1", blockedContext: staleLease }, request: { to: "APPROVED", actor: "control-plane", nextOperationId: "op-2" } }).allowed).toBe(false);
    expect(canTransition({ current: { state: "BLOCKED", attemptId: "attempt-1", blockedContext: staleLease }, request: { to: "APPROVED", actor: "owner", nextOperationId: "op-2" } }).allowed).toBe(true);
  });
});
