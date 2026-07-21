import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalizeForDigest } from "./protocol/digest-internal.js";
import { CapabilityGrantSchema } from "./approval-security.js";
import { classifySensitivePath, detectRedactions } from "./redaction.js";
import {
  IdempotencyKeySchema,
  IsoUtcTimestampSchema,
  SafeIdSchema,
  SlugIdSchema,
  displayText,
} from "./protocol/common.js";

/**
 * M1F adapter and coordination contracts.  These are deliberately records,
 * parsers, and classifiers only.  They neither select nor run a worker, take
 * a lease, inspect a filesystem, poll quota, or establish authority.
 */
export const ADAPTER_COORDINATION_VERSION = "1.0" as const;
export const ADAPTER_COORDINATION_LIMITS = Object.freeze({
  maxCapabilities: 32,
  maxReferences: 64,
  maxPathRules: 32,
  maxEvidence: 64,
  maxCanonicalChars: 32_768,
  maxTraceLinks: 16,
  maxNoteLength: 1_000,
  /** A record cannot amplify bounded individual reference arrays into an unbounded aggregate. */
  maxAggregateEntries: 64,
} as const);

const RefSchema = SafeIdSchema;
const safeCoordinationText = (max: number) => displayText(max).refine((value) => {
  const findings = detectRedactions(value);
  return findings.ok && findings.value.length === 0;
}, "must not contain secret-like content");
const NoteSchema = safeCoordinationText(ADAPTER_COORDINATION_LIMITS.maxNoteLength);
const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const OptionalRef = RefSchema.nullable();
const OptionalTime = IsoUtcTimestampSchema.nullable();

export const CONNECTOR_TIERS = Object.freeze(["manual-relay", "cli", "http-api"] as const);
export const ConnectorTierSchema = z.enum(CONNECTOR_TIERS);
export type ConnectorTier = z.infer<typeof ConnectorTierSchema>;

export const ADAPTER_READINESS_STATES = Object.freeze([
  "unprobed", "probing", "ready", "degraded", "manual-only", "blocked", "frozen",
] as const);
export const AdapterReadinessStateSchema = z.enum(ADAPTER_READINESS_STATES);
export type AdapterReadinessState = z.infer<typeof AdapterReadinessStateSchema>;

export const CAPABILITY_ASSURANCE_STATES = Object.freeze([
  "declared", "probed", "observed", "validated", "unavailable", "unknown",
] as const);
export const CapabilityAssuranceStateSchema = z.enum(CAPABILITY_ASSURANCE_STATES);
export type CapabilityAssuranceState = z.infer<typeof CapabilityAssuranceStateSchema>;

export const AUTHENTICATION_STATES = Object.freeze([
  "not-required", "authenticated", "expired", "missing", "unknown",
] as const);
export const AuthenticationStateSchema = z.enum(AUTHENTICATION_STATES);
export type AuthenticationState = z.infer<typeof AuthenticationStateSchema>;

const CapabilityAssessmentSchema = z.strictObject({
  capability: SlugIdSchema,
  assurance: CapabilityAssuranceStateSchema,
  evidenceRef: OptionalRef,
});
export type CapabilityAssessment = z.infer<typeof CapabilityAssessmentSchema>;

/** A non-secret, capability-probe result.  Executable hashes are optional facts, never trust. */
export const AdapterReadinessSchema = z.strictObject({
  coordinationVersion: z.literal(ADAPTER_COORDINATION_VERSION),
  readinessId: RefSchema,
  adapterId: SlugIdSchema,
  workerId: SlugIdSchema,
  connectorTier: ConnectorTierSchema,
  providerId: SlugIdSchema,
  runtimeId: SlugIdSchema,
  installedVersion: z.string().max(64).regex(/^[0-9A-Za-z._+-]+$/),
  executableId: RefSchema.nullable(),
  executableHash: HashSchema.nullable(),
  authenticationState: AuthenticationStateSchema,
  sandboxCapability: CapabilityAssuranceStateSchema,
  noninteractiveCapability: CapabilityAssuranceStateSchema,
  structuredOutputCapability: CapabilityAssuranceStateSchema,
  cancellationCapability: CapabilityAssuranceStateSchema,
  resumeCapability: CapabilityAssuranceStateSchema,
  healthStatus: z.enum(["healthy", "degraded", "unhealthy", "unknown"]),
  quotaVisibility: CapabilityAssuranceStateSchema,
  freezeState: z.enum(["enabled", "disabled", "frozen"]),
  capabilityProbeAt: OptionalTime,
  readinessState: AdapterReadinessStateSchema,
  capabilities: z.array(CapabilityAssessmentSchema).max(ADAPTER_COORDINATION_LIMITS.maxCapabilities),
  evidenceRefs: z.array(RefSchema).max(ADAPTER_COORDINATION_LIMITS.maxReferences),
}).superRefine((value, ctx) => {
  const mandatoryCapabilities = [value.sandboxCapability, value.noninteractiveCapability, value.structuredOutputCapability, value.cancellationCapability, value.resumeCapability];
  if (value.connectorTier === "manual-relay" && value.readinessState === "ready") ctx.addIssue({ code: "custom", path: ["readinessState"], message: "manual relay cannot claim automated ready state" });
  if (value.freezeState !== "enabled" && value.readinessState === "ready") ctx.addIssue({ code: "custom", path: ["readinessState"], message: "disabled or frozen adapters cannot be ready" });
  if (value.capabilityProbeAt === null && ["ready", "degraded"].includes(value.readinessState)) ctx.addIssue({ code: "custom", path: ["capabilityProbeAt"], message: "probed readiness requires a probe timestamp" });
  if (value.readinessState === "ready" && !["authenticated", "not-required"].includes(value.authenticationState)) ctx.addIssue({ code: "custom", path: ["authenticationState"], message: "ready requires current authentication or no authentication requirement" });
  if (value.readinessState === "ready" && value.healthStatus !== "healthy") ctx.addIssue({ code: "custom", path: ["healthStatus"], message: "ready requires healthy status" });
  if (value.readinessState === "ready" && mandatoryCapabilities.some((capability) => !["probed", "observed", "validated"].includes(capability))) ctx.addIssue({ code: "custom", path: ["readinessState"], message: "ready requires every mandatory capability to be probed and available" });
  if (new Set(value.capabilities.map((item) => item.capability)).size !== value.capabilities.length) ctx.addIssue({ code: "custom", path: ["capabilities"], message: "capabilities must be unique" });
  if (value.capabilities.length + value.evidenceRefs.length > ADAPTER_COORDINATION_LIMITS.maxAggregateEntries) ctx.addIssue({ code: "custom", path: ["evidenceRefs"], message: "readiness aggregate entries exceed the M1F bound" });
});
export type AdapterReadiness = z.infer<typeof AdapterReadinessSchema>;

export const ADAPTER_RUN_STATES = Object.freeze([
  "requested", "accepted", "started", "running", "cancellation-requested", "cancelled", "completed", "failed", "interrupted", "execution-unknown",
] as const);
export const AdapterRunStateSchema = z.enum(ADAPTER_RUN_STATES);
export type AdapterRunState = z.infer<typeof AdapterRunStateSchema>;

export const AdapterRunSchema = z.strictObject({
  coordinationVersion: z.literal(ADAPTER_COORDINATION_VERSION),
  adapterRunId: RefSchema,
  taskId: RefSchema,
  attemptId: RefSchema,
  operationId: RefSchema,
  workerId: SlugIdSchema,
  adapterId: SlugIdSchema,
  connectorTier: ConnectorTierSchema,
  readinessSnapshotRef: RefSchema,
  invocationMode: z.enum(["manual-relay", "noninteractive", "interactive"]),
  requestedCapability: SlugIdSchema,
  startedAt: OptionalTime,
  endedAt: OptionalTime,
  structuredOutputState: z.enum(["not-requested", "expected", "received", "malformed", "unavailable"]),
  cancellationState: z.enum(["not-requested", "requested", "confirmed", "unconfirmed"]),
  resumedFromRunId: OptionalRef,
  quotaSnapshotRef: OptionalRef,
  lifecycleState: AdapterRunStateSchema,
  captureRefs: z.array(RefSchema).max(ADAPTER_COORDINATION_LIMITS.maxReferences),
  evidenceRefs: z.array(RefSchema).max(ADAPTER_COORDINATION_LIMITS.maxReferences),
  blockedReason: z.enum(["no-eligible-worker", "stale-lease", "execution-unknown"]).nullable(),
  runtimeProvenanceRefs: z.array(RefSchema).max(ADAPTER_COORDINATION_LIMITS.maxReferences),
  cancellationEvidenceRefs: z.array(RefSchema).max(ADAPTER_COORDINATION_LIMITS.maxEvidence),
}).superRefine((value, ctx) => {
  if (value.invocationMode === "manual-relay" && value.connectorTier !== "manual-relay") ctx.addIssue({ code: "custom", path: ["invocationMode"], message: "manual relay mode requires manual-relay tier" });
  if (value.connectorTier === "manual-relay" && value.invocationMode !== "manual-relay") ctx.addIssue({ code: "custom", path: ["invocationMode"], message: "manual-relay tier cannot claim automated invocation" });
  if (["started", "running", "cancellation-requested", "cancelled", "completed", "failed", "interrupted", "execution-unknown"].includes(value.lifecycleState) && value.startedAt === null) ctx.addIssue({ code: "custom", path: ["startedAt"], message: "post-start lifecycle states require startedAt" });
  if (["cancelled", "completed", "failed", "interrupted", "execution-unknown"].includes(value.lifecycleState) && value.endedAt === null) ctx.addIssue({ code: "custom", path: ["endedAt"], message: "terminal run states require endedAt" });
  if (value.lifecycleState === "cancelled" && value.cancellationState !== "confirmed") ctx.addIssue({ code: "custom", path: ["cancellationState"], message: "cancelled requires confirmed cancellation" });
  if (value.lifecycleState === "cancelled" && value.cancellationEvidenceRefs.length === 0) ctx.addIssue({ code: "custom", path: ["cancellationEvidenceRefs"], message: "cancelled requires termination evidence" });
  if (value.cancellationState === "confirmed" && value.lifecycleState !== "cancelled") ctx.addIssue({ code: "custom", path: ["lifecycleState"], message: "confirmed cancellation must end in cancelled" });
  if (["completed", "failed"].includes(value.lifecycleState) && value.cancellationState !== "not-requested") ctx.addIssue({ code: "custom", path: ["cancellationState"], message: "completed or failed runs cannot carry cancellation state" });
  if (["requested", "accepted", "started", "running"].includes(value.lifecycleState) && value.cancellationState !== "not-requested") ctx.addIssue({ code: "custom", path: ["cancellationState"], message: "only cancellation-requested or interrupted runs can carry pending cancellation" });
  if (value.lifecycleState === "cancellation-requested" && !["requested", "unconfirmed"].includes(value.cancellationState)) ctx.addIssue({ code: "custom", path: ["cancellationState"], message: "cancellation-requested requires requested or unconfirmed state" });
  if (value.resumedFromRunId === value.adapterRunId) ctx.addIssue({ code: "custom", path: ["resumedFromRunId"], message: "run cannot resume itself" });
  if (value.captureRefs.length + value.evidenceRefs.length + value.runtimeProvenanceRefs.length + value.cancellationEvidenceRefs.length > ADAPTER_COORDINATION_LIMITS.maxAggregateEntries) ctx.addIssue({ code: "custom", path: ["runtimeProvenanceRefs"], message: "run aggregate references exceed the M1F bound" });
});
export type AdapterRun = z.infer<typeof AdapterRunSchema>;

export const ADAPTER_CONTINUATION_CODES = Object.freeze(["VALID", "MALFORMED", "NOT_A_RESUME", "WRONG_RUN", "CROSS_SCOPE", "PRIOR_NOT_INTERRUPTED"] as const);
export type AdapterContinuationCode = (typeof ADAPTER_CONTINUATION_CODES)[number];
/** Validates a proposed resume against a separately supplied prior-run record; it never resumes anything. */
export function evaluateAdapterContinuation(rawRun: unknown, rawPriorRun: unknown): { readonly ok: boolean; readonly code: AdapterContinuationCode } {
  const run = parseAdapterRun(rawRun);
  const prior = parseAdapterRun(rawPriorRun);
  if (!run.ok || !prior.ok) return Object.freeze({ ok: false, code: "MALFORMED" });
  if (run.value.resumedFromRunId === null) return Object.freeze({ ok: false, code: "NOT_A_RESUME" });
  if (run.value.resumedFromRunId !== prior.value.adapterRunId) return Object.freeze({ ok: false, code: "WRONG_RUN" });
  if (run.value.taskId !== prior.value.taskId || run.value.attemptId !== prior.value.attemptId || run.value.operationId !== prior.value.operationId || run.value.workerId !== prior.value.workerId || run.value.adapterId !== prior.value.adapterId) return Object.freeze({ ok: false, code: "CROSS_SCOPE" });
  if (!["interrupted", "execution-unknown"].includes(prior.value.lifecycleState)) return Object.freeze({ ok: false, code: "PRIOR_NOT_INTERRUPTED" });
  return Object.freeze({ ok: true, code: "VALID" });
}

const AssignmentBase = {
  coordinationVersion: z.literal(ADAPTER_COORDINATION_VERSION), assignmentId: RefSchema, taskId: RefSchema, attemptId: RefSchema, operationId: RefSchema,
  projectId: SlugIdSchema, workerId: SlugIdSchema, adapterId: SlugIdSchema, requiredCapabilities: z.array(SlugIdSchema).min(1).max(ADAPTER_COORDINATION_LIMITS.maxCapabilities),
  permittedConnectorTier: ConnectorTierSchema, writeScopeRef: RefSchema.nullable(), leaseRequired: z.boolean(), readinessSnapshotRef: RefSchema,
  quotaSnapshotRef: OptionalRef, approvalGrantRef: OptionalRef, expectedEvidenceRefs: z.array(RefSchema).max(ADAPTER_COORDINATION_LIMITS.maxReferences),
  expiresAt: IsoUtcTimestampSchema, rationaleEvidenceRefs: z.array(RefSchema).min(1).max(ADAPTER_COORDINATION_LIMITS.maxReferences),
} as const;
export const RoutingRecommendationSchema = z.strictObject({ ...AssignmentBase, kind: z.literal("recommendation") });
export const OwnerConfirmedAssignmentSchema = z.strictObject({ ...AssignmentBase, kind: z.literal("owner-confirmed"), ownerApprovalRef: RefSchema });
export const DispatchedAssignmentSchema = z.strictObject({ ...AssignmentBase, kind: z.literal("dispatched"), ownerApprovalRef: RefSchema, dispatchEventRef: RefSchema, adapterRunId: RefSchema });
export const AssignmentSchema = z.discriminatedUnion("kind", [RoutingRecommendationSchema, OwnerConfirmedAssignmentSchema, DispatchedAssignmentSchema]).superRefine((value, ctx) => {
  if (new Set(value.requiredCapabilities).size !== value.requiredCapabilities.length) ctx.addIssue({ code: "custom", path: ["requiredCapabilities"], message: "required capabilities must be unique" });
  if (value.leaseRequired && value.writeScopeRef === null) ctx.addIssue({ code: "custom", path: ["writeScopeRef"], message: "write assignments require a scope reference" });
  if (!value.leaseRequired && value.writeScopeRef !== null) ctx.addIssue({ code: "custom", path: ["leaseRequired"], message: "a write scope requires a lease" });
  if (value.requiredCapabilities.length + value.expectedEvidenceRefs.length + value.rationaleEvidenceRefs.length > ADAPTER_COORDINATION_LIMITS.maxAggregateEntries) ctx.addIssue({ code: "custom", path: ["rationaleEvidenceRefs"], message: "assignment aggregate entries exceed the M1F bound" });
});
export type Assignment = z.infer<typeof AssignmentSchema>;

const RelativePathSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._/*-]*$/).refine((value) => !value.includes("..") && !value.includes("//") && !value.includes("**") && !value.includes("*"), "must be a bounded relative exact path without traversal or wildcards");
const RelativePatternSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._/*-]*$/).refine((value) => { const wildcard = value.indexOf("*"); return !value.includes("..") && !value.includes("//") && !value.includes("**") && value !== "*" && value !== "/*" && !value.startsWith("*") && wildcard === value.lastIndexOf("*") && (wildcard === -1 || !value.slice(wildcard).includes("/")); }, "must be a narrow non-recursive relative filename pattern");
const overlapsGeneratedRoot = (path: string, generatedRoot: string): boolean => path === generatedRoot || path.startsWith(`${generatedRoot}/`) || generatedRoot.startsWith(`${path}/`);
const patternOverlapsGeneratedRoot = (pattern: string, generatedRoot: string): boolean => {
  const wildcard = pattern.indexOf("*");
  const fixedPrefix = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
  return overlapsGeneratedRoot(fixedPrefix.replace(/\/$/, ""), generatedRoot) || generatedRoot.startsWith(fixedPrefix);
};
export const WriteScopeCoreSchema = z.strictObject({
  scopeVersion: z.literal(ADAPTER_COORDINATION_VERSION), scopeId: RefSchema, repositoryRootId: RefSchema, worktreeRootId: RefSchema,
  taskId: RefSchema, attemptId: RefSchema, operationId: RefSchema,
  allowedExactPaths: z.array(RelativePathSchema).max(ADAPTER_COORDINATION_LIMITS.maxPathRules),
  allowedPathPatterns: z.array(RelativePatternSchema).max(ADAPTER_COORDINATION_LIMITS.maxPathRules),
  deniedPathClasses: z.array(z.enum(["credentials", "production", "infrastructure", "database", "mikrotik", "deployment", "unrelated-repository", "system"])) .min(1).max(ADAPTER_COORDINATION_LIMITS.maxPathRules),
  readOnlyPaths: z.array(RelativePatternSchema).max(ADAPTER_COORDINATION_LIMITS.maxPathRules),
  generatedArtifactRoot: RelativePathSchema.nullable(),
  permissions: z.strictObject({ create: z.boolean(), modify: z.boolean(), delete: z.boolean() }),
  maxFiles: z.number().int().min(1).max(10_000), maxBytes: z.number().int().min(1).max(1_073_741_824),
}).superRefine((value, ctx) => {
  if (value.allowedExactPaths.length + value.allowedPathPatterns.length === 0) ctx.addIssue({ code: "custom", path: ["allowedExactPaths"], message: "write scope is deny-by-default and requires a bounded allowlist" });
  if (new Set([...value.allowedExactPaths, ...value.allowedPathPatterns]).size !== value.allowedExactPaths.length + value.allowedPathPatterns.length) ctx.addIssue({ code: "custom", path: ["allowedPathPatterns"], message: "path rules must be unique" });
  if (value.allowedExactPaths.length + value.allowedPathPatterns.length + value.deniedPathClasses.length + value.readOnlyPaths.length > ADAPTER_COORDINATION_LIMITS.maxAggregateEntries) ctx.addIssue({ code: "custom", path: ["readOnlyPaths"], message: "write-scope aggregate path rules exceed the M1F bound" });
  for (const path of [...value.allowedExactPaths, ...value.allowedPathPatterns, ...value.readOnlyPaths, ...(value.generatedArtifactRoot === null ? [] : [value.generatedArtifactRoot])]) if (classifySensitivePath(path).disposition !== "safe") ctx.addIssue({ code: "custom", path: ["allowedExactPaths"], message: "sensitive paths cannot enter a portable write scope" });
  if (value.generatedArtifactRoot !== null && ([...value.allowedExactPaths, ...value.readOnlyPaths].some((path) => overlapsGeneratedRoot(path, value.generatedArtifactRoot!)) || value.allowedPathPatterns.some((pattern) => patternOverlapsGeneratedRoot(pattern, value.generatedArtifactRoot!)))) ctx.addIssue({ code: "custom", path: ["generatedArtifactRoot"], message: "generated artifacts must be disjoint from source-write and read-only scope" });
});
export type WriteScopeCore = z.infer<typeof WriteScopeCoreSchema>;
export const WriteScopeSchema = WriteScopeCoreSchema.extend({ scopeHash: HashSchema });
export type WriteScope = z.infer<typeof WriteScopeSchema>;

export function canonicalizeWriteScope(raw: unknown): M1FParseResult<string> { const parsed = parse(WriteScopeCoreSchema, raw, "scopeVersion"); if (!parsed.ok) return parsed; try { const value = canonicalizeForDigest(parsed.value); return value.length <= ADAPTER_COORDINATION_LIMITS.maxCanonicalChars ? ok(value) : fail("MALFORMED_INPUT"); } catch { return fail("MALFORMED_INPUT"); } }
export function digestWriteScope(raw: unknown): M1FParseResult<string> { const canonical = canonicalizeWriteScope(raw); if (!canonical.ok) return canonical; return ok(`sha256:${createHash("sha256").update(`chubz.m1f.write-scope/v1\n${canonical.value}`, "utf8").digest("hex")}`); }
export function verifyWriteScope(raw: unknown): M1FParseResult<WriteScope> { const parsed = parse(WriteScopeSchema, raw, "scopeVersion"); if (!parsed.ok) return parsed; const { scopeHash, ...core } = parsed.value; const digest = digestWriteScope(core); return digest.ok && digest.value === scopeHash ? parsed : fail("HASH_MISMATCH"); }


export const LEASE_STATES = Object.freeze(["active", "released", "revoked", "superseded", "expired"] as const);
export const LeaseStateSchema = z.enum(LEASE_STATES);
export type LeaseState = z.infer<typeof LeaseStateSchema>;
export const LeaseSchema = z.strictObject({
  coordinationVersion: z.literal(ADAPTER_COORDINATION_VERSION), leaseId: RefSchema, resourceId: RefSchema, projectId: SlugIdSchema, workspaceId: RefSchema,
  taskId: RefSchema, attemptId: RefSchema, operationId: RefSchema, holderWorkerId: SlugIdSchema, holderAdapterId: SlugIdSchema,
  issuedAt: IsoUtcTimestampSchema, expiresAt: IsoUtcTimestampSchema, renewalGeneration: z.number().int().min(0).max(1_000_000), status: LeaseStateSchema,
  supersededByLeaseId: OptionalRef, authoritativeLeaseSnapshotRef: RefSchema,
}).superRefine((value, ctx) => { if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "lease expiry must be after issue" }); if (value.status === "superseded" && value.supersededByLeaseId === null) ctx.addIssue({ code: "custom", path: ["supersededByLeaseId"], message: "superseded lease requires replacement reference" }); if (value.supersededByLeaseId === value.leaseId) ctx.addIssue({ code: "custom", path: ["supersededByLeaseId"], message: "lease cannot supersede itself" }); });
export type Lease = z.infer<typeof LeaseSchema>;
export const LEASE_VALIDATION_CODES = Object.freeze(["VALID", "MALFORMED", "EXPIRED", "RELEASED", "REVOKED", "WRONG_HOLDER", "WRONG_ATTEMPT", "SUPERSEDED", "STALE_GENERATION", "CONFLICTING_EXCLUSIVE_LEASE", "RELEASE_BY_NON_HOLDER"] as const);
export type LeaseValidationCode = (typeof LEASE_VALIDATION_CODES)[number];
const LeaseExpectationSchema = z.strictObject({ taskId: RefSchema, attemptId: RefSchema, operationId: RefSchema, workerId: SlugIdSchema, adapterId: SlugIdSchema, now: IsoUtcTimestampSchema, generation: z.number().int().min(0), action: z.enum(["use", "renew", "release"]), concurrentLease: LeaseSchema.optional() });
export function evaluateLease(rawLease: unknown, rawExpectation: unknown): { readonly ok: boolean; readonly code: LeaseValidationCode } { const lease = parseLease(rawLease); const expectation = parse(LeaseExpectationSchema, rawExpectation); if (!lease.ok || !expectation.ok) return Object.freeze({ ok: false, code: "MALFORMED" }); const value = lease.value; const expected = expectation.value; if (value.holderWorkerId !== expected.workerId || value.holderAdapterId !== expected.adapterId) return Object.freeze({ ok: false, code: expected.action === "release" ? "RELEASE_BY_NON_HOLDER" : "WRONG_HOLDER" }); if (value.taskId !== expected.taskId || value.attemptId !== expected.attemptId || value.operationId !== expected.operationId) return Object.freeze({ ok: false, code: "WRONG_ATTEMPT" }); if (value.status === "released") return Object.freeze({ ok: false, code: "RELEASED" }); if (value.status === "revoked") return Object.freeze({ ok: false, code: "REVOKED" }); if (value.status === "superseded") return Object.freeze({ ok: false, code: "SUPERSEDED" }); if (value.status !== "active" || Date.parse(expected.now) >= Date.parse(value.expiresAt)) return Object.freeze({ ok: false, code: "EXPIRED" }); if (value.renewalGeneration !== expected.generation) return Object.freeze({ ok: false, code: "STALE_GENERATION" }); const other = expected.concurrentLease; if (other && other.leaseId !== value.leaseId && other.resourceId === value.resourceId && other.status === "active" && Date.parse(expected.now) < Date.parse(other.expiresAt)) return Object.freeze({ ok: false, code: "CONFLICTING_EXCLUSIVE_LEASE" }); return Object.freeze({ ok: true, code: "VALID" }); }

export const HANDOFF_STATES = Object.freeze(["recommendation", "requested", "owner-approved", "accepted", "completed", "failed", "abandoned"] as const);
export const HandoffStateSchema = z.enum(HANDOFF_STATES);
export const HandoffSchema = z.strictObject({ coordinationVersion: z.literal(ADAPTER_COORDINATION_VERSION), handoffId: RefSchema, taskId: RefSchema, attemptId: RefSchema, operationId: RefSchema, sourceWorkerId: SlugIdSchema, sourceAdapterId: SlugIdSchema, targetWorkerId: SlugIdSchema, targetAdapterId: SlugIdSchema, reason: NoteSchema, evidenceRefs: z.array(RefSchema).max(ADAPTER_COORDINATION_LIMITS.maxEvidence), capturedOutputRefs: z.array(RefSchema).max(ADAPTER_COORDINATION_LIMITS.maxReferences), writeScopeRef: OptionalRef, leaseDisposition: z.enum(["not-required", "release-required", "owner-approved-transfer-required"]), unresolvedRisks: z.array(NoteSchema).max(ADAPTER_COORDINATION_LIMITS.maxReferences), continuationCheckpointRef: OptionalRef, ownerApprovalRequired: z.boolean(), ownerApprovalRef: OptionalRef, manualRelayDowngrade: z.boolean(), state: HandoffStateSchema }).superRefine((value, ctx) => { if (value.sourceWorkerId === value.targetWorkerId && value.sourceAdapterId === value.targetAdapterId) ctx.addIssue({ code: "custom", path: ["targetWorkerId"], message: "handoff target must differ from source" }); if (["owner-approved", "accepted", "completed"].includes(value.state) && value.ownerApprovalRequired && value.ownerApprovalRef === null) ctx.addIssue({ code: "custom", path: ["ownerApprovalRef"], message: "approved handoff requires approval reference" }); if (value.leaseDisposition === "owner-approved-transfer-required" && !value.ownerApprovalRequired) ctx.addIssue({ code: "custom", path: ["ownerApprovalRequired"], message: "lease transfer requires owner approval" }); if (value.leaseDisposition !== "not-required" && value.writeScopeRef === null) ctx.addIssue({ code: "custom", path: ["writeScopeRef"], message: "lease disposition requires write scope" }); if (value.manualRelayDowngrade && value.targetAdapterId !== "manual-relay") ctx.addIssue({ code: "custom", path: ["targetAdapterId"], message: "manual downgrade must target manual relay adapter" }); if (value.evidenceRefs.length + value.capturedOutputRefs.length + value.unresolvedRisks.length > ADAPTER_COORDINATION_LIMITS.maxAggregateEntries) ctx.addIssue({ code: "custom", path: ["unresolvedRisks"], message: "handoff aggregate entries exceed the M1F bound" }); });
export type Handoff = z.infer<typeof HandoffSchema>;

export const HANDOFF_VALIDATION_CODES = Object.freeze(["VALID", "MALFORMED", "CROSS_SCOPE", "LEASE_RELEASE_REQUIRED", "CONCURRENT_EXCLUSIVE_HOLDERS", "TARGET_LEASE_MISMATCH"] as const);
export type HandoffValidationCode = (typeof HANDOFF_VALIDATION_CODES)[number];
const HandoffValidationContextSchema = z.strictObject({ now: IsoUtcTimestampSchema, sourceLease: LeaseSchema.nullable(), targetLease: LeaseSchema.nullable() });
/** Checks lease disposition records only; a future authoritative lease store remains responsible for transfer. */
export function evaluateHandoff(rawHandoff: unknown, rawContext: unknown): { readonly ok: boolean; readonly code: HandoffValidationCode } {
  const handoff = parseHandoff(rawHandoff); const context = parse(HandoffValidationContextSchema, rawContext);
  if (!handoff.ok || !context.ok) return Object.freeze({ ok: false, code: "MALFORMED" });
  const value = handoff.value; const trusted = context.value;
  if (value.writeScopeRef === null || !["accepted", "completed"].includes(value.state)) return Object.freeze({ ok: true, code: "VALID" });
  const source = trusted.sourceLease; const target = trusted.targetLease;
  if (source !== null && (source.taskId !== value.taskId || source.attemptId !== value.attemptId || source.operationId !== value.operationId || source.holderWorkerId !== value.sourceWorkerId || source.holderAdapterId !== value.sourceAdapterId)) return Object.freeze({ ok: false, code: "CROSS_SCOPE" });
  if (target !== null && (target.taskId !== value.taskId || target.attemptId !== value.attemptId || target.operationId !== value.operationId || target.holderWorkerId !== value.targetWorkerId || target.holderAdapterId !== value.targetAdapterId)) return Object.freeze({ ok: false, code: "TARGET_LEASE_MISMATCH" });
  const sourceActive = source !== null && source.status === "active" && Date.parse(trusted.now) < Date.parse(source.expiresAt);
  const targetActive = target !== null && target.status === "active" && Date.parse(trusted.now) < Date.parse(target.expiresAt);
  if (sourceActive && targetActive && source!.resourceId === target!.resourceId) return Object.freeze({ ok: false, code: "CONCURRENT_EXCLUSIVE_HOLDERS" });
  if (value.leaseDisposition !== "not-required" && sourceActive) return Object.freeze({ ok: false, code: "LEASE_RELEASE_REQUIRED" });
  if (value.leaseDisposition === "owner-approved-transfer-required" && !targetActive) return Object.freeze({ ok: false, code: "TARGET_LEASE_MISMATCH" });
  return Object.freeze({ ok: true, code: "VALID" });
}

export const QUOTA_SOURCES = Object.freeze(["provider-reported", "cli-observed", "locally-estimated", "owner-entered", "unknown"] as const);
export const QuotaSourceSchema = z.enum(QUOTA_SOURCES);
export const QUOTA_CONFIDENCE = Object.freeze(["validated", "observed", "estimated", "owner-attested", "unknown"] as const);
export const QuotaConfidenceSchema = z.enum(QUOTA_CONFIDENCE);
const QuotaNumberSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const QuotaSnapshotSchema = z.strictObject({ coordinationVersion: z.literal(ADAPTER_COORDINATION_VERSION), quotaId: RefSchema, providerId: SlugIdSchema, adapterId: SlugIdSchema, workerId: SlugIdSchema, quotaKind: z.enum(["requests", "tokens", "credits", "concurrency", "unknown"]), remaining: QuotaNumberSchema.nullable(), used: QuotaNumberSchema.nullable(), limit: QuotaNumberSchema.refine((value) => value > 0, "limit must be positive").nullable(), resetAt: OptionalTime, window: z.enum(["minute", "hour", "day", "month", "unknown"]), source: QuotaSourceSchema, confidence: QuotaConfidenceSchema, observedAt: OptionalTime, expiresAt: OptionalTime, rateLimitState: z.enum(["clear", "limited", "unknown"]), circuitBreakerState: z.enum(["closed", "open", "half-open", "unknown"]), authenticationState: AuthenticationStateSchema, evidenceRefs: z.array(RefSchema).max(ADAPTER_COORDINATION_LIMITS.maxEvidence) }).superRefine((value, ctx) => { if ((value.source === "provider-reported" || value.source === "cli-observed") && !["validated", "observed"].includes(value.confidence)) ctx.addIssue({ code: "custom", path: ["confidence"], message: "observed source needs observed or validated confidence" }); if (value.source === "locally-estimated" && value.confidence !== "estimated") ctx.addIssue({ code: "custom", path: ["confidence"], message: "estimated source cannot claim validation" }); if (value.source === "owner-entered" && value.confidence !== "owner-attested") ctx.addIssue({ code: "custom", path: ["confidence"], message: "owner-entered quota is owner-attested, not provider-validated" }); if (value.source === "unknown" && value.confidence !== "unknown") ctx.addIssue({ code: "custom", path: ["confidence"], message: "unknown source requires unknown confidence" }); if (value.remaining !== null && value.limit !== null && value.remaining > value.limit) ctx.addIssue({ code: "custom", path: ["remaining"], message: "remaining cannot exceed limit" }); if (value.used !== null && value.remaining !== null && value.limit !== null && value.used + value.remaining > value.limit) ctx.addIssue({ code: "custom", path: ["used"], message: "used plus remaining cannot exceed limit" }); });
export type QuotaSnapshot = z.infer<typeof QuotaSnapshotSchema>;
export const QUOTA_USABILITY = Object.freeze(["usable", "insufficient", "stale", "unknown", "rate-limited", "circuit-open", "authentication-expired", "confidence-too-low"] as const);
export type QuotaUsability = (typeof QUOTA_USABILITY)[number];
export function classifyQuota(rawQuota: unknown, rawNow: unknown, minimumConfidence: "observed" | "validated" = "observed"): QuotaUsability { const quota = parseQuotaSnapshot(rawQuota); const now = parse(IsoUtcTimestampSchema, rawNow); if (!quota.ok || !now.ok) return "unknown"; const value = quota.value; if (value.authenticationState === "expired") return "authentication-expired"; if (value.circuitBreakerState === "open") return "circuit-open"; if (value.rateLimitState === "limited") return "rate-limited"; if (value.expiresAt === null || Date.parse(now.value) >= Date.parse(value.expiresAt)) return "stale"; if (value.source === "unknown" || value.remaining === null) return "unknown"; if (minimumConfidence === "validated" && value.confidence !== "validated") return "confidence-too-low"; if (minimumConfidence === "observed" && !["observed", "validated"].includes(value.confidence)) return "confidence-too-low"; return value.remaining <= 0 ? "insufficient" : "usable"; }

export const ASSIGNMENT_DISPATCH_CODES = Object.freeze(["DISPATCHABLE", "MALFORMED", "RECOMMENDATION_NOT_AUTHORIZATION", "CONFIRMATION_NOT_DISPATCH", "STALE", "UNBOUND_REFERENCE", "CROSS_SCOPE", "READINESS_NOT_READY", "CAPABILITY_NOT_READY", "QUOTA_NOT_USABLE", "LEASE_NOT_VALID", "EXPIRED_APPROVAL_GRANT"] as const);
export type AssignmentDispatchCode = (typeof ASSIGNMENT_DISPATCH_CODES)[number];
const AssignmentValidationContextSchema = z.strictObject({ now: IsoUtcTimestampSchema, readiness: AdapterReadinessSchema, quota: QuotaSnapshotSchema.nullable(), writeScope: WriteScopeSchema.nullable(), lease: LeaseSchema.nullable(), approvalGrant: CapabilityGrantSchema.nullable() });
/** Checks only separately supplied authoritative snapshot shapes and grant freshness/bindings; it never authenticates a grant or dispatches an adapter. */
export function evaluateAssignmentDispatch(rawAssignment: unknown, rawContext: unknown): { readonly ok: boolean; readonly code: AssignmentDispatchCode } {
  const assignment = parseAssignment(rawAssignment); const context = parse(AssignmentValidationContextSchema, rawContext);
  if (!assignment.ok || !context.ok) return Object.freeze({ ok: false, code: "MALFORMED" });
  const value = assignment.value; const trusted = context.value;
  if (value.kind === "recommendation") return Object.freeze({ ok: false, code: "RECOMMENDATION_NOT_AUTHORIZATION" });
  if (value.kind === "owner-confirmed") return Object.freeze({ ok: false, code: "CONFIRMATION_NOT_DISPATCH" });
  if (Date.parse(trusted.now) >= Date.parse(value.expiresAt)) return Object.freeze({ ok: false, code: "STALE" });
  if (trusted.readiness.readinessId !== value.readinessSnapshotRef || trusted.readiness.workerId !== value.workerId || trusted.readiness.adapterId !== value.adapterId || trusted.readiness.connectorTier !== value.permittedConnectorTier) return Object.freeze({ ok: false, code: "CROSS_SCOPE" });
  if (trusted.readiness.readinessState !== "ready" || trusted.readiness.freezeState !== "enabled") return Object.freeze({ ok: false, code: "READINESS_NOT_READY" });
  const readinessCapabilities = new Map(trusted.readiness.capabilities.map((entry) => [entry.capability, entry.assurance]));
  if (value.requiredCapabilities.some((capability) => readinessCapabilities.get(capability) !== "validated")) return Object.freeze({ ok: false, code: "CAPABILITY_NOT_READY" });
  if ((value.quotaSnapshotRef === null) !== (trusted.quota === null) || (value.quotaSnapshotRef !== null && trusted.quota?.quotaId !== value.quotaSnapshotRef)) return Object.freeze({ ok: false, code: "UNBOUND_REFERENCE" });
  if (trusted.quota !== null && classifyQuota(trusted.quota, trusted.now) !== "usable") return Object.freeze({ ok: false, code: "QUOTA_NOT_USABLE" });
  if ((value.writeScopeRef === null) !== (trusted.writeScope === null)) return Object.freeze({ ok: false, code: "UNBOUND_REFERENCE" });
  if (value.writeScopeRef !== null) { const scope = trusted.writeScope!; if (scope.scopeId !== value.writeScopeRef || scope.taskId !== value.taskId || scope.attemptId !== value.attemptId || scope.operationId !== value.operationId || !verifyWriteScope(scope).ok) return Object.freeze({ ok: false, code: "CROSS_SCOPE" }); }
  if (value.leaseRequired) {
    if (trusted.lease === null) return Object.freeze({ ok: false, code: "UNBOUND_REFERENCE" });
    if (trusted.writeScope !== null && trusted.lease.resourceId !== trusted.writeScope.scopeId) return Object.freeze({ ok: false, code: "CROSS_SCOPE" });
    const leaseResult = evaluateLease(trusted.lease, { taskId: value.taskId, attemptId: value.attemptId, operationId: value.operationId, workerId: value.workerId, adapterId: value.adapterId, now: trusted.now, generation: trusted.lease.renewalGeneration, action: "use" });
    if (!leaseResult.ok) return Object.freeze({ ok: false, code: "LEASE_NOT_VALID" });
  } else if (trusted.lease !== null) return Object.freeze({ ok: false, code: "UNBOUND_REFERENCE" });
  if ((value.approvalGrantRef === null) !== (trusted.approvalGrant === null)) return Object.freeze({ ok: false, code: "UNBOUND_REFERENCE" });
  if (value.approvalGrantRef !== null) {
    const grant = trusted.approvalGrant!;
    if (grant.grantId !== value.approvalGrantRef || grant.taskId !== value.taskId || grant.attemptId !== value.attemptId || grant.operationId !== value.operationId) return Object.freeze({ ok: false, code: "UNBOUND_REFERENCE" });
    if (Date.parse(trusted.now) >= Date.parse(grant.expiresAt)) return Object.freeze({ ok: false, code: "EXPIRED_APPROVAL_GRANT" });
  }
  return Object.freeze({ ok: true, code: "DISPATCHABLE" });
}

export const EVIDENCE_KINDS = Object.freeze(["worker-claim", "automated-observation", "automated-validation", "owner-attested-manual-relay", "reviewed-artifact-import", "system-derived-state", "operation-journal", "approval", "runtime-provenance", "health-capability-probe", "quota-observation", "cancellation-termination", "recovery-reconciliation"] as const);
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export const EVIDENCE_AUTHORITY_BY_KIND = Object.freeze({
  "worker-claim": Object.freeze(["claim"]), "automated-observation": Object.freeze(["observed"]), "automated-validation": Object.freeze(["validated"]), "owner-attested-manual-relay": Object.freeze(["owner-attested"]), "reviewed-artifact-import": Object.freeze(["owner-attested"]), "system-derived-state": Object.freeze(["system-derived"]), "operation-journal": Object.freeze(["system-derived"]), "approval": Object.freeze(["owner-attested", "system-derived"]), "runtime-provenance": Object.freeze(["observed"]), "health-capability-probe": Object.freeze(["observed"]), "quota-observation": Object.freeze(["observed"]), "cancellation-termination": Object.freeze(["observed"]), "recovery-reconciliation": Object.freeze(["system-derived"]),
} as const satisfies Record<(typeof EVIDENCE_KINDS)[number], readonly string[]>);
export const EvidenceRecordSchema = z.strictObject({ coordinationVersion: z.literal(ADAPTER_COORDINATION_VERSION), evidenceId: RefSchema, kind: EvidenceKindSchema, subject: z.strictObject({ taskId: RefSchema, attemptId: RefSchema, operationId: RefSchema, adapterRunId: OptionalRef, leaseId: OptionalRef, artifactId: OptionalRef }), sourceId: RefSchema, authority: z.enum(["claim", "observed", "validated", "owner-attested", "system-derived"]), requiredBindings: z.array(z.enum(["task", "attempt", "operation", "adapter-run", "lease", "artifact", "grant", "journal"])).min(3).max(8), permittedUses: z.array(z.enum(["display", "routing", "readiness", "quota", "capture", "reconciliation", "approval-verification"])).min(1).max(7), prohibitedTrustElevation: z.boolean(), reference: RefSchema }).superRefine((value, ctx) => { if (!value.prohibitedTrustElevation) ctx.addIssue({ code: "custom", path: ["prohibitedTrustElevation"], message: "M1F evidence cannot elevate trust by label" }); if (!(EVIDENCE_AUTHORITY_BY_KIND[value.kind] as readonly string[]).includes(value.authority)) ctx.addIssue({ code: "custom", path: ["authority"], message: "evidence kind and authority are incompatible" }); if (value.requiredBindings.includes("adapter-run") && value.subject.adapterRunId === null) ctx.addIssue({ code: "custom", path: ["subject", "adapterRunId"], message: "adapter-run binding requires adapter run identity" }); if (value.requiredBindings.includes("lease") && value.subject.leaseId === null) ctx.addIssue({ code: "custom", path: ["subject", "leaseId"], message: "lease binding requires lease identity" }); if (value.requiredBindings.includes("artifact") && value.subject.artifactId === null) ctx.addIssue({ code: "custom", path: ["subject", "artifactId"], message: "artifact binding requires artifact identity" }); });
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const EVIDENCE_BINDING_CODES = Object.freeze(["VALID", "MALFORMED", "CROSS_SCOPE", "MISSING_REQUIRED_BINDING"] as const);
export type EvidenceBindingCode = (typeof EVIDENCE_BINDING_CODES)[number];
const EvidenceBindingTargetSchema = z.strictObject({ taskId: RefSchema, attemptId: RefSchema, operationId: RefSchema, adapterRunId: OptionalRef, leaseId: OptionalRef, artifactId: OptionalRef });
/** Verifies a claim's declared subject binding only; it does not make the evidence authoritative. */
export function evaluateEvidenceBinding(rawEvidence: unknown, rawTarget: unknown): { readonly ok: boolean; readonly code: EvidenceBindingCode } {
  const evidence = parseEvidenceRecord(rawEvidence); const target = parse(EvidenceBindingTargetSchema, rawTarget);
  if (!evidence.ok || !target.ok) return Object.freeze({ ok: false, code: "MALFORMED" });
  const actual = evidence.value.subject; const expected = target.value;
  if (actual.taskId !== expected.taskId || actual.attemptId !== expected.attemptId || actual.operationId !== expected.operationId) return Object.freeze({ ok: false, code: "CROSS_SCOPE" });
  for (const [binding, field] of [["adapter-run", "adapterRunId"], ["lease", "leaseId"], ["artifact", "artifactId"]] as const) if (evidence.value.requiredBindings.includes(binding) && (actual[field] === null || actual[field] !== expected[field])) return Object.freeze({ ok: false, code: "MISSING_REQUIRED_BINDING" });
  return Object.freeze({ ok: true, code: "VALID" });
}

export const CANCELLATION_EVIDENCE_CODES = Object.freeze(["VALID", "MALFORMED", "NOT_CANCELLED", "EVIDENCE_REQUIRED", "EVIDENCE_MISMATCH"] as const);
export type CancellationEvidenceCode = (typeof CANCELLATION_EVIDENCE_CODES)[number];
const CancellationEvidenceContextSchema = z.strictObject({ evidence: z.array(EvidenceRecordSchema).max(ADAPTER_COORDINATION_LIMITS.maxEvidence) });
/** Binds cancellation/termination observations to the exact cancelled run; it never terminates a process. */
export function evaluateCancellationEvidence(rawRun: unknown, rawContext: unknown): { readonly ok: boolean; readonly code: CancellationEvidenceCode } {
  const run = parseAdapterRun(rawRun); const context = parse(CancellationEvidenceContextSchema, rawContext);
  if (!run.ok || !context.ok) return Object.freeze({ ok: false, code: "MALFORMED" });
  if (run.value.lifecycleState !== "cancelled") return Object.freeze({ ok: false, code: "NOT_CANCELLED" });
  const matched = context.value.evidence.filter((entry) => run.value.cancellationEvidenceRefs.includes(entry.evidenceId));
  if (matched.length === 0) return Object.freeze({ ok: false, code: "EVIDENCE_REQUIRED" });
  if (matched.some((entry) => entry.kind !== "cancellation-termination" || entry.subject.taskId !== run.value.taskId || entry.subject.attemptId !== run.value.attemptId || entry.subject.operationId !== run.value.operationId || entry.subject.adapterRunId !== run.value.adapterRunId)) return Object.freeze({ ok: false, code: "EVIDENCE_MISMATCH" });
  return Object.freeze({ ok: true, code: "VALID" });
}

export const LIFECYCLE_EVENT_KINDS = Object.freeze(["readiness-probe", "recommendation", "assignment", "dispatch", "lease-acquired", "lease-renewed", "lease-released", "lease-revoked", "adapter-start", "progress", "checkpoint", "output-capture", "cancellation-request", "cancellation-confirmation", "interruption", "resume", "handoff", "rate-limit", "authentication-expiry", "malformed-output", "partial-artifact", "failure", "execution-unknown", "reconciliation", "completion"] as const);
export const LifecycleEventSchema = z.strictObject({ coordinationVersion: z.literal(ADAPTER_COORDINATION_VERSION), eventId: RefSchema, cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), idempotencyKey: IdempotencyKeySchema, eventKind: z.enum(LIFECYCLE_EVENT_KINDS), taskId: RefSchema, attemptId: RefSchema, operationId: RefSchema, adapterRunId: OptionalRef, leaseId: OptionalRef, workerId: SlugIdSchema, adapterId: SlugIdSchema, occurredAt: IsoUtcTimestampSchema, evidenceRefs: z.array(RefSchema).max(ADAPTER_COORDINATION_LIMITS.maxEvidence), trace: z.strictObject({ traceId: RefSchema, spanId: RefSchema, parentSpanId: OptionalRef }) });
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;
export const EVENT_DELIVERY_CLASSIFICATIONS = Object.freeze(["new", "duplicate", "conflicting-event-id", "conflicting-idempotency", "conflicting-cursor", "out-of-order", "malformed"] as const);
export function classifyLifecycleDelivery(rawIncoming: unknown, rawRecorded: unknown): (typeof EVENT_DELIVERY_CLASSIFICATIONS)[number] { const incoming = parseLifecycleEvent(rawIncoming); const recorded = parseLifecycleEvent(rawRecorded); if (!incoming.ok || !recorded.ok) return "malformed"; if (incoming.value.cursor === recorded.value.cursor && incoming.value.eventId === recorded.value.eventId && incoming.value.idempotencyKey === recorded.value.idempotencyKey) return "duplicate"; if (incoming.value.eventId === recorded.value.eventId) return "conflicting-event-id"; if (incoming.value.cursor < recorded.value.cursor) return "out-of-order"; if (incoming.value.cursor === recorded.value.cursor) return "conflicting-cursor"; if (incoming.value.idempotencyKey === recorded.value.idempotencyKey) return "conflicting-idempotency"; return "new"; }

export const JOURNAL_STAGES = Object.freeze(["prepared", "started", "completed", "failed", "interrupted", "execution-unknown", "reconciled-completed", "reconciled-failed", "reconciled-not-executed"] as const);
export const JournalEntrySchema = z.strictObject({ coordinationVersion: z.literal(ADAPTER_COORDINATION_VERSION), journalEntryId: RefSchema, taskId: RefSchema, attemptId: RefSchema, operationId: RefSchema, adapterRunId: OptionalRef, leaseId: OptionalRef, grantId: OptionalRef, stage: z.enum(JOURNAL_STAGES), originalOperationStage: z.enum(["dispatch", "execution", "integration"]), trustedRuntimeEvidenceRef: OptionalRef, ownerReconciliationEvidenceRef: OptionalRef, recordedAt: IsoUtcTimestampSchema }).superRefine((value, ctx) => { if (value.stage.startsWith("reconciled-") && value.ownerReconciliationEvidenceRef === null) ctx.addIssue({ code: "custom", path: ["ownerReconciliationEvidenceRef"], message: "reconciliation requires owner evidence" }); });
export type JournalEntry = z.infer<typeof JournalEntrySchema>;
export const JOURNAL_RECONCILIATION_CODES = Object.freeze(["VALID", "MALFORMED", "WRONG_OPERATION", "WRONG_JOURNAL", "OWNER_EVIDENCE_REQUIRED", "RUNTIME_EVIDENCE_REQUIRED", "BLIND_RETRY_FORBIDDEN", "STAGE_MISMATCH"] as const);
export function evaluateJournalReconciliation(rawOriginal: unknown, rawReconciled: unknown): { readonly ok: boolean; readonly code: (typeof JOURNAL_RECONCILIATION_CODES)[number] } { const original = parseJournalEntry(rawOriginal); const reconciled = parseJournalEntry(rawReconciled); if (!original.ok || !reconciled.ok) return Object.freeze({ ok: false, code: "MALFORMED" }); const before = original.value; const after = reconciled.value; if (before.journalEntryId !== after.journalEntryId) return Object.freeze({ ok: false, code: "WRONG_JOURNAL" }); if (before.taskId !== after.taskId || before.attemptId !== after.attemptId || before.operationId !== after.operationId) return Object.freeze({ ok: false, code: "WRONG_OPERATION" }); if (before.originalOperationStage !== after.originalOperationStage) return Object.freeze({ ok: false, code: "STAGE_MISMATCH" }); if (before.stage !== "execution-unknown") return Object.freeze({ ok: false, code: "BLIND_RETRY_FORBIDDEN" }); if (!after.stage.startsWith("reconciled-")) return Object.freeze({ ok: false, code: "BLIND_RETRY_FORBIDDEN" }); if (after.ownerReconciliationEvidenceRef === null) return Object.freeze({ ok: false, code: "OWNER_EVIDENCE_REQUIRED" }); if (["reconciled-completed", "reconciled-failed"].includes(after.stage) && after.trustedRuntimeEvidenceRef === null) return Object.freeze({ ok: false, code: "RUNTIME_EVIDENCE_REQUIRED" }); return Object.freeze({ ok: true, code: "VALID" }); }

/** Resolution target for the original operation only. A future task store still applies the M1A transition. */
export const JOURNAL_RECONCILIATION_TARGETS = Object.freeze({
  dispatch: Object.freeze({ "reconciled-completed": "RUNNING", "reconciled-failed": "FAILED", "reconciled-not-executed": "AWAITING_DISPATCH" }),
  execution: Object.freeze({ "reconciled-completed": "RESULT_CAPTURED", "reconciled-failed": "FAILED", "reconciled-not-executed": "CONTEXT_PREPARING" }),
  integration: Object.freeze({ "reconciled-completed": "COMPLETED", "reconciled-failed": "FAILED", "reconciled-not-executed": "APPROVED" }),
} as const);
export function classifyJournalReconciliationTarget(rawReconciled: unknown): string | null {
  const parsed = parseJournalEntry(rawReconciled); if (!parsed.ok || !parsed.value.stage.startsWith("reconciled-")) return null;
  return JOURNAL_RECONCILIATION_TARGETS[parsed.value.originalOperationStage][parsed.value.stage as "reconciled-completed" | "reconciled-failed" | "reconciled-not-executed"];
}

export const TraceCorrelationSchema = z.strictObject({ traceVersion: z.literal(ADAPTER_COORDINATION_VERSION), traceId: RefSchema, taskId: RefSchema, attemptId: RefSchema, operationId: RefSchema, adapterRunId: OptionalRef, workerProcessId: OptionalRef, approvalId: OptionalRef, artifactId: OptionalRef, leaseId: OptionalRef, lifecycleEventId: OptionalRef, recoveryEventId: OptionalRef, links: z.array(RefSchema).max(ADAPTER_COORDINATION_LIMITS.maxTraceLinks) });
export type TraceCorrelation = z.infer<typeof TraceCorrelationSchema>;

export const M1F_PARSE_CODES = Object.freeze(["MALFORMED_INPUT", "UNSUPPORTED_VERSION", "HASH_MISMATCH"] as const);
export type M1FParseCode = (typeof M1F_PARSE_CODES)[number];
export type M1FParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: M1FParseCode };
const ok = <T>(value: T): M1FParseResult<T> => Object.freeze({ ok: true, value });
const fail = (code: M1FParseCode): M1FParseResult<never> => Object.freeze({ ok: false, code });
const objectVersion = (raw: unknown, field: string): unknown => { try { return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[field] : undefined; } catch { return undefined; } };
function parse<T>(schema: z.ZodType<T>, raw: unknown, versionField = "coordinationVersion"): M1FParseResult<T> { try { const version = objectVersion(raw, versionField); if (version !== undefined && version !== ADAPTER_COORDINATION_VERSION) return fail("UNSUPPORTED_VERSION"); const result = schema.safeParse(raw); return result.success ? ok(result.data) : fail("MALFORMED_INPUT"); } catch { return fail("MALFORMED_INPUT"); } }
export const parseAdapterReadiness = (raw: unknown) => parse(AdapterReadinessSchema, raw);
export const parseAdapterRun = (raw: unknown) => parse(AdapterRunSchema, raw);
export const parseAssignment = (raw: unknown) => parse(AssignmentSchema, raw);
export const parseWriteScope = (raw: unknown) => parse(WriteScopeSchema, raw, "scopeVersion");
export const parseLease = (raw: unknown) => parse(LeaseSchema, raw);
export const parseHandoff = (raw: unknown) => parse(HandoffSchema, raw);
export const parseQuotaSnapshot = (raw: unknown) => parse(QuotaSnapshotSchema, raw);
export const parseEvidenceRecord = (raw: unknown) => parse(EvidenceRecordSchema, raw);
export const parseLifecycleEvent = (raw: unknown) => parse(LifecycleEventSchema, raw);
export const parseJournalEntry = (raw: unknown) => parse(JournalEntrySchema, raw);
export const parseTraceCorrelation = (raw: unknown) => parse(TraceCorrelationSchema, raw, "traceVersion");

/** M1F-specific blocked-reason policy.  Task transition authority remains M1A. */
export const M1F_BLOCKED_REASON_POLICIES = Object.freeze({
  "no-eligible-worker": Object.freeze({ validSourceStages: Object.freeze(["AWAITING_DISPATCH"]), requiredTrustedContext: Object.freeze(["authoritative-readiness-snapshot", "routing-evidence"]), recoveryPaths: Object.freeze(["owner-confirmed-assignment", "awaiting-dispatch-with-new-operation"]), ownerActionRequired: false, newAttemptRequired: false, newOperationRequired: true, prohibitedAutomatedTransitions: Object.freeze(["dispatch", "running"]) }),
  "stale-lease": Object.freeze({ validSourceStages: Object.freeze(["AWAITING_DISPATCH", "APPROVED"]), requiredTrustedContext: Object.freeze(["authoritative-lease-snapshot"]), recoveryPaths: Object.freeze(["owner-approved-new-lease", "original-stage-with-new-operation"]), ownerActionRequired: true, newAttemptRequired: false, newOperationRequired: true, prohibitedAutomatedTransitions: Object.freeze(["dispatch", "resume", "integration"]) }),
} as const);
