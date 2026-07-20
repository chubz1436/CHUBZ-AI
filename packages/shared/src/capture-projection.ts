import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalizeForDigest } from "./protocol/digest-internal.js";
import { IsoUtcTimestampSchema, SafeIdSchema, SlugIdSchema, displayText } from "./protocol/common.js";
import { detectRedactions } from "./redaction.js";
import { ProvenanceModeSchema } from "./worker-manifest.js";

/**
 * Pure M1E claims, projections, and authoritative-snapshot shape checks.
 * No runtime loading, persistence, capture, or authority is implemented here.
 * A successful shape parse is never proof that a caller supplied authority.
 */
export const CAPTURE_PROJECTION_VERSION = "1.0" as const;
export const CAPTURE_LIMITS = Object.freeze({ maxArtifacts: 64, maxCaptures: 64, maxNotes: 32, maxProvenanceEvidence: 64, maxBytes: 1_073_741_824, maxCanonicalChars: 131_072 } as const);

const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be canonical sha256");
const OptionalId = SafeIdSchema.nullable();
const EvidenceRefSchema = SafeIdSchema;
const AutomatedConnectorSchema = z.enum(["cli-headless", "http-api", "local-process", "browser-controlled"]);
const safeProjectionText = (max: number) => displayText(max).refine((value) => { const found = detectRedactions(value); return found.ok && found.value.length === 0; }, "must not contain secret-like content");
const SafeNoteSchema = safeProjectionText(256);

const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
/** Portable, secret-screened display filename; never a path authority. */
export const LogicalArtifactNameSchema = safeProjectionText(128).regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/, "must use portable filename characters")
  .refine((v) => v === v.trim(), "must not have leading or trailing spaces")
  .refine((v) => !v.endsWith("."), "must not end with a dot")
  .refine((v) => !v.includes(".."), "must not contain traversal-like segments")
  .refine((v) => !WINDOWS_DEVICE_RE.test(v), "must not be a Windows device name");
/** Display-only, bounded, secret-screened, and never a path authority. */
export const ArtifactDisplayLabelSchema = safeProjectionText(256).refine((v) => !/[\\/]/.test(v), "must be display text, not a path");

export const ArtifactStateSchema = z.enum(["complete", "truncated", "incomplete", "failed", "quarantined"]);
export const ArtifactKindSchema = z.enum(["response", "command", "file", "diff", "patch", "test", "log", "review", "manifest", "redacted", "derived"]);
export const RedactionStateSchema = z.enum(["not-required", "redacted", "required", "failed"]);
export const RetentionClassSchema = z.enum(["ephemeral", "task", "review", "hold"]);

const AutomatedProvenanceSchema = z.strictObject({
  mode: z.literal("automated"), connectorType: AutomatedConnectorSchema, workerId: SlugIdSchema,
  adapterId: SafeIdSchema, adapterVersion: SafeIdSchema, adapterRunId: OptionalId,
  executableId: SafeIdSchema.nullable(), executableVersion: SafeIdSchema.nullable(), executableHash: HashSchema.nullable(),
  runtime: safeProjectionText(128), invocationMode: z.enum(["headless", "api", "local-process", "browser-controlled"]),
  authenticationMode: z.enum(["none", "owner-managed", "runtime-managed", "unknown"]), structuredOutput: z.boolean(), isolation: z.enum(["attested", "not-attested", "unknown"]),
});
const ManualProvenanceSchema = z.strictObject({
  mode: z.literal("owner-attested"), connectorType: z.literal("manual-relay"), workerId: SlugIdSchema,
  importMode: z.enum(["text-only", "reviewed-artifact-import"]), ownerAttestedAt: IsoUtcTimestampSchema,
  guarantees: z.strictObject({ cryptographicIdentity: z.literal(false), commandCapture: z.literal(false), processSupervision: z.literal(false), filesystemEnforcement: z.literal(false) }),
});
export const WorkerProvenanceSchema = z.discriminatedUnion("mode", [AutomatedProvenanceSchema, ManualProvenanceSchema]);
export type WorkerProvenance = z.infer<typeof WorkerProvenanceSchema>;

const CaptureBase = {
  captureVersion: z.literal(CAPTURE_PROJECTION_VERSION), captureId: SafeIdSchema, taskId: SafeIdSchema, attemptId: SafeIdSchema,
  operationId: OptionalId, approvalId: OptionalId, capturedAt: IsoUtcTimestampSchema, artifactId: SafeIdSchema, contentHash: HashSchema,
} as const;
const AutomatedKindSchema = z.enum(["worker-output", "command", "artifact", "diff", "test", "failure", "checkpoint"]);
const WorkerClaimSchema = z.strictObject({ ...CaptureBase, kind: AutomatedKindSchema, evidenceClass: z.literal("worker-claim"), provenance: AutomatedProvenanceSchema, claimEvidenceIds: z.array(EvidenceRefSchema).max(CAPTURE_LIMITS.maxProvenanceEvidence) });
const ObservationRequestSchema = z.strictObject({ ...CaptureBase, kind: AutomatedKindSchema, evidenceClass: z.literal("observation-request"), provenance: AutomatedProvenanceSchema, requestedObserverId: SafeIdSchema, evidenceRef: EvidenceRefSchema, observationMethod: z.enum(["connector", "adapter", "runtime"]) });
const ValidationRequestSchema = z.strictObject({ ...CaptureBase, kind: AutomatedKindSchema, evidenceClass: z.literal("validation-request"), provenance: AutomatedProvenanceSchema, requestedValidatorId: SafeIdSchema, validatedCaptureId: SafeIdSchema, evidenceRef: EvidenceRefSchema, validationResult: z.enum(["passed", "failed", "inconclusive"]), validationMethod: z.enum(["independent-validation", "owner-review"]) });
const DerivedCaptureSchema = z.strictObject({ ...CaptureBase, kind: z.literal("checkpoint"), evidenceClass: z.literal("derived"), provenance: AutomatedProvenanceSchema, sourceCaptureIds: z.array(SafeIdSchema).min(1).max(CAPTURE_LIMITS.maxCaptures), derivation: z.enum(["projection", "summary"]) }).superRefine((v, ctx) => { if (v.sourceCaptureIds.includes(v.captureId)) ctx.addIssue({ code: "custom", path: ["sourceCaptureIds"], message: "derived capture cannot source itself" }); });
const ManualImportRequestSchema = z.strictObject({ ...CaptureBase, kind: z.literal("manual-import"), evidenceClass: z.literal("manual-import-request"), provenance: ManualProvenanceSchema, evidenceRef: EvidenceRefSchema }).superRefine((v, ctx) => { if (v.provenance.importMode !== "reviewed-artifact-import") ctx.addIssue({ code: "custom", path: ["provenance", "importMode"], message: "text-only manual relay cannot claim an artifact" }); });
/** Externally supplied records contain claims and opaque references only; parse success is never authority. */
export const CaptureRecordSchema = z.discriminatedUnion("evidenceClass", [WorkerClaimSchema, ObservationRequestSchema, ValidationRequestSchema, DerivedCaptureSchema, ManualImportRequestSchema]);
export type CaptureRecord = z.infer<typeof CaptureRecordSchema>;

const AutomatedSnapshotProvenanceSchema = z.strictObject({ mode: z.literal("automated"), connectorType: AutomatedConnectorSchema, workerId: SlugIdSchema, adapterId: SafeIdSchema, adapterRunId: OptionalId });
const ManualSnapshotProvenanceSchema = z.strictObject({ mode: z.literal("owner-attested"), connectorType: z.literal("manual-relay"), workerId: SlugIdSchema });
const SnapshotProvenanceSchema = z.discriminatedUnion("mode", [AutomatedSnapshotProvenanceSchema, ManualSnapshotProvenanceSchema]);
type SnapshotProvenance = z.infer<typeof SnapshotProvenanceSchema>;
const SnapshotSubjectSchema = z.strictObject({
  taskId: SafeIdSchema, attemptId: SafeIdSchema, operationId: OptionalId, artifactId: SafeIdSchema, captureId: SafeIdSchema,
  reviewId: OptionalId, contentHash: HashSchema, sourceProvenance: SnapshotProvenanceSchema,
});
type SnapshotSubject = z.infer<typeof SnapshotSubjectSchema>;
const TrustedObservationSchema = z.strictObject({ evidenceId: EvidenceRefSchema, kind: z.literal("observed"), subject: SnapshotSubjectSchema, observerId: SafeIdSchema, observationMethod: z.enum(["connector", "adapter", "runtime"]) }).refine((v) => v.subject.reviewId === null, "capture observations cannot be review-scoped");
const TrustedValidationSchema = z.strictObject({ evidenceId: EvidenceRefSchema, kind: z.literal("validated"), subject: SnapshotSubjectSchema, validatorId: SafeIdSchema, validatedCaptureId: SafeIdSchema, validationResult: z.enum(["passed", "failed", "inconclusive"]) });
const TrustedManualImportSchema = z.strictObject({ evidenceId: EvidenceRefSchema, kind: z.literal("manual-import"), subject: SnapshotSubjectSchema, ownerAttestationId: SafeIdSchema, importMode: z.literal("reviewed-artifact-import") }).refine((v) => v.subject.reviewId === null && v.subject.sourceProvenance.mode === "owner-attested", "manual imports must bind owner-attested artifact provenance");
const TrustedProducerSchema = z.strictObject({ evidenceId: EvidenceRefSchema, kind: z.literal("producer"), subject: SnapshotSubjectSchema, producerCaptureId: SafeIdSchema }).refine((v) => v.subject.reviewId === null, "producer evidence cannot be review-scoped");
const TrustedInclusionSchema = z.strictObject({ evidenceId: EvidenceRefSchema, kind: z.literal("inclusion"), subject: SnapshotSubjectSchema, sourceEvidenceId: EvidenceRefSchema }).refine((v) => v.subject.reviewId !== null, "inclusion evidence must bind one review package");
export const TrustedEvidenceSnapshotSchema = z.discriminatedUnion("kind", [TrustedObservationSchema, TrustedValidationSchema, TrustedManualImportSchema, TrustedProducerSchema, TrustedInclusionSchema]);
type TrustedEvidenceSnapshot = z.infer<typeof TrustedEvidenceSnapshotSchema>;

const TrustedQuotaPolicySchema = z.strictObject({
  policyId: SafeIdSchema, policyVersion: SafeIdSchema, authority: z.enum(["owner", "system"]), taskId: SafeIdSchema,
  attemptId: SafeIdSchema, operationId: OptionalId, artifactId: OptionalId,
  perArtifactLimitBytes: z.number().int().min(0).max(CAPTURE_LIMITS.maxBytes), taskLimitBytes: z.number().int().min(0).max(CAPTURE_LIMITS.maxBytes),
  retentionClass: RetentionClassSchema, expiresAt: IsoUtcTimestampSchema.nullable(),
}).superRefine((v, ctx) => { if ((v.retentionClass === "hold") !== (v.expiresAt === null)) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "retention expiry conflicts with class" }); });
const TrustedQuotaObservationSchema = z.strictObject({
  observationId: SafeIdSchema, evidenceId: EvidenceRefSchema, policyId: SafeIdSchema, policyVersion: SafeIdSchema,
  source: z.enum(["connector", "adapter", "runtime", "owner-accounting"]), confidence: z.enum(["observed", "validated"]),
  taskId: SafeIdSchema, attemptId: SafeIdSchema, operationId: OptionalId, artifactId: SafeIdSchema, captureId: SafeIdSchema, contentHash: HashSchema,
  artifactBytes: z.number().int().min(0).max(CAPTURE_LIMITS.maxBytes), taskBytes: z.number().int().min(0).max(CAPTURE_LIMITS.maxBytes), taskArtifactCount: z.number().int().min(0).max(CAPTURE_LIMITS.maxArtifacts),
});
const subjectKey = (subject: SnapshotSubject): string => [subject.taskId, subject.attemptId, subject.operationId ?? "", subject.artifactId, subject.captureId, subject.reviewId ?? "", subject.contentHash, subject.sourceProvenance.mode, subject.sourceProvenance.workerId, subject.sourceProvenance.connectorType, subject.sourceProvenance.mode === "automated" ? subject.sourceProvenance.adapterId : "", subject.sourceProvenance.mode === "automated" ? subject.sourceProvenance.adapterRunId ?? "" : ""].join("\u0001");
/**
 * Shape only. A future authoritative runtime store must load and vouch for it
 * independently; callers must not treat this parser as an authority grant.
 */
export const AuthoritativeM1ESnapshotShapeSchema = z.strictObject({
  contextVersion: z.literal(CAPTURE_PROJECTION_VERSION),
  evidence: z.array(TrustedEvidenceSnapshotSchema).max(CAPTURE_LIMITS.maxProvenanceEvidence),
  quotaPolicies: z.array(TrustedQuotaPolicySchema).max(CAPTURE_LIMITS.maxArtifacts),
  quotaObservations: z.array(TrustedQuotaObservationSchema).max(CAPTURE_LIMITS.maxArtifacts),
}).superRefine((value, ctx) => {
  const evidenceIds = new Set<string>(); const evidenceFacts = new Set<string>();
  for (const [index, evidence] of value.evidence.entries()) {
    if (evidenceIds.has(evidence.evidenceId)) ctx.addIssue({ code: "custom", path: ["evidence", index, "evidenceId"], message: "evidence ids must be unique" });
    evidenceIds.add(evidence.evidenceId);
    const fact = `${evidence.kind}\u0001${subjectKey(evidence.subject)}`;
    if (evidenceFacts.has(fact)) ctx.addIssue({ code: "custom", path: ["evidence", index], message: "conflicting duplicate evidence facts are not allowed" });
    evidenceFacts.add(fact);
  }
  const policies = new Set<string>();
  for (const [index, policy] of value.quotaPolicies.entries()) { if (policies.has(policy.policyId)) ctx.addIssue({ code: "custom", path: ["quotaPolicies", index, "policyId"], message: "policy ids must be unique" }); policies.add(policy.policyId); }
  const observations = new Set<string>();
  for (const [index, observation] of value.quotaObservations.entries()) {
    const key = `${observation.policyId}\u0001${observation.taskId}\u0001${observation.attemptId}\u0001${observation.operationId ?? ""}\u0001${observation.artifactId}\u0001${observation.captureId}\u0001${observation.contentHash}`;
    if (observations.has(key)) ctx.addIssue({ code: "custom", path: ["quotaObservations", index], message: "conflicting duplicate quota observations are not allowed" });
    observations.add(key);
  }
});
export type AuthoritativeM1ESnapshotShape = z.infer<typeof AuthoritativeM1ESnapshotShapeSchema>;

const ProducerRequestSchema = z.strictObject({ captureId: SafeIdSchema, evidenceRef: EvidenceRefSchema });
/** Artifact metadata is an external claim; policy and evidence references are opaque. */
export const ArtifactMetadataSchema = z.strictObject({
  artifactVersion: z.literal(CAPTURE_PROJECTION_VERSION), artifactId: SafeIdSchema, taskId: SafeIdSchema, attemptId: SafeIdSchema,
  operationId: OptionalId, approvalId: OptionalId, kind: ArtifactKindSchema, mediaType: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/).max(128),
  logicalName: LogicalArtifactNameSchema, displayLabel: ArtifactDisplayLabelSchema, description: safeProjectionText(512).nullable(),
  byteLength: z.number().int().min(0).max(CAPTURE_LIMITS.maxBytes), contentHash: HashSchema, capturedAt: IsoUtcTimestampSchema,
  state: ArtifactStateSchema, redaction: RedactionStateSchema, producerRequest: ProducerRequestSchema,
  quotaPolicyRef: SafeIdSchema, quotaObservationRef: SafeIdSchema, parentArtifactId: OptionalId,
}).superRefine((v, ctx) => {
  if (v.parentArtifactId === v.artifactId) ctx.addIssue({ code: "custom", path: ["parentArtifactId"], message: "artifact cannot parent itself" });
  if (v.producerRequest.captureId === v.artifactId) ctx.addIssue({ code: "custom", path: ["producerRequest", "captureId"], message: "artifact cannot source itself" });
  if (v.state !== "complete" && v.redaction === "not-required") ctx.addIssue({ code: "custom", path: ["redaction"], message: "non-complete artifacts require redaction status" });
});
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

export const BridgeLogFrontMatterSchema = z.strictObject({
  projectionVersion: z.literal(CAPTURE_PROJECTION_VERSION), nonAuthoritative: z.literal(true), taskId: SafeIdSchema, attemptId: SafeIdSchema,
  projectId: SlugIdSchema, state: SafeIdSchema, createdAt: IsoUtcTimestampSchema, provenanceMode: ProvenanceModeSchema,
  approvalIds: z.array(SafeIdSchema).max(CAPTURE_LIMITS.maxArtifacts), artifactIds: z.array(SafeIdSchema).max(CAPTURE_LIMITS.maxArtifacts), reviewId: OptionalId,
  validation: z.enum(["not-run", "claimed", "observed", "validated"]), redaction: RedactionStateSchema, warnings: z.array(SafeNoteSchema).max(CAPTURE_LIMITS.maxNotes), redactionCount: z.number().int().min(0).max(CAPTURE_LIMITS.maxCaptures),
});
export type BridgeLogFrontMatter = z.infer<typeof BridgeLogFrontMatterSchema>;
export type BridgeLogSerializationResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly code: "MALFORMED_FRONT_MATTER" };
export function serializeBridgeLogFrontMatter(raw: unknown): BridgeLogSerializationResult { try { const parsed = BridgeLogFrontMatterSchema.safeParse(raw); if (!parsed.success) return Object.freeze({ ok: false, code: "MALFORMED_FRONT_MATTER" }); const json = canonicalizeForDigest(parsed.data).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029"); return Object.freeze({ ok: true, value: `---\n${json}\n---\n` }); } catch { return Object.freeze({ ok: false, code: "MALFORMED_FRONT_MATTER" }); } }

const ManifestArtifactBase = { artifactId: SafeIdSchema, contentHash: HashSchema, parentArtifactId: OptionalId } as const;
const IncludedArtifactSchema = z.strictObject({ ...ManifestArtifactBase, disposition: z.literal("included"), redaction: z.enum(["not-redacted", "redacted"]), inclusionRequest: z.strictObject({ captureId: SafeIdSchema, evidenceRef: EvidenceRefSchema }) });
const OmittedArtifactSchema = z.strictObject({ ...ManifestArtifactBase, disposition: z.literal("omitted-by-policy") });
const UnresolvedArtifactSchema = z.strictObject({ ...ManifestArtifactBase, disposition: z.enum(["unavailable", "truncated", "incomplete", "quarantined", "failed"]) });
const RedactedArtifactSchema = z.strictObject({ ...ManifestArtifactBase, disposition: z.literal("redacted"), redactedArtifactId: SafeIdSchema });
const ManifestArtifactSchema = z.discriminatedUnion("disposition", [IncludedArtifactSchema, OmittedArtifactSchema, UnresolvedArtifactSchema, RedactedArtifactSchema]);
const ValidationClaimSchema = z.strictObject({ artifactId: SafeIdSchema, validationCaptureId: SafeIdSchema, validatedCaptureId: SafeIdSchema, evidenceRef: EvidenceRefSchema, result: z.enum(["passed", "failed", "inconclusive"]) });
export const ReviewPackageManifestCoreSchema = z.strictObject({
  manifestVersion: z.literal(CAPTURE_PROJECTION_VERSION), reviewId: SafeIdSchema, taskId: SafeIdSchema, attemptId: SafeIdSchema, operationId: OptionalId, approvalId: OptionalId,
  createdAt: IsoUtcTimestampSchema, provenance: WorkerProvenanceSchema, artifacts: z.array(ManifestArtifactSchema).min(1).max(CAPTURE_LIMITS.maxArtifacts),
  validationRequirement: z.enum(["not-required", "required"]), validationClaims: z.array(ValidationClaimSchema).max(CAPTURE_LIMITS.maxCaptures),
  warnings: z.array(SafeNoteSchema).max(CAPTURE_LIMITS.maxNotes), completeness: z.enum(["complete", "partial", "failed"]), redaction: RedactionStateSchema, redactionCount: z.number().int().min(0).max(CAPTURE_LIMITS.maxCaptures), parentManifestId: OptionalId,
}).superRefine((v, ctx) => {
  const byId = new Map<string, z.infer<typeof ManifestArtifactSchema>>();
  for (const [index, artifact] of v.artifacts.entries()) { if (byId.has(artifact.artifactId)) ctx.addIssue({ code: "custom", path: ["artifacts", index, "artifactId"], message: "artifact ids must be unique" }); byId.set(artifact.artifactId, artifact); }
  if (v.parentManifestId === v.reviewId) ctx.addIssue({ code: "custom", path: ["parentManifestId"], message: "manifest cannot parent itself" });
  const included = new Map(v.artifacts.filter((a): a is z.infer<typeof IncludedArtifactSchema> => a.disposition === "included").map((a) => [a.artifactId, a]));
  for (const [index, artifact] of v.artifacts.entries()) {
    if (artifact.parentArtifactId === artifact.artifactId) ctx.addIssue({ code: "custom", path: ["artifacts", index, "parentArtifactId"], message: "artifact cannot parent itself" });
    if (artifact.disposition === "redacted") { const target = included.get(artifact.redactedArtifactId); if (!target || target.redaction !== "redacted" || target.artifactId === artifact.artifactId) ctx.addIssue({ code: "custom", path: ["artifacts", index, "redactedArtifactId"], message: "redacted artifact requires a distinct included redacted artifact" }); }
  }
  for (const artifact of v.artifacts) { const seen = new Set<string>(); let cursor = artifact; while (cursor.parentArtifactId !== null && byId.has(cursor.parentArtifactId)) { if (seen.has(cursor.artifactId)) { ctx.addIssue({ code: "custom", path: ["artifacts"], message: "artifact parent relationships cannot cycle" }); break; } seen.add(cursor.artifactId); cursor = byId.get(cursor.parentArtifactId)!; } }
  const claimsByArtifact = new Map<string, z.infer<typeof ValidationClaimSchema>>();
  for (const [index, claim] of v.validationClaims.entries()) { if (claimsByArtifact.has(claim.artifactId) || !included.has(claim.artifactId)) ctx.addIssue({ code: "custom", path: ["validationClaims", index], message: "validation claims must uniquely target included artifacts" }); claimsByArtifact.set(claim.artifactId, claim); }
  if (v.validationRequirement === "required" && [...included.keys()].some((id) => !claimsByArtifact.has(id))) ctx.addIssue({ code: "custom", path: ["validationClaims"], message: "required validation needs one claim per included artifact" });
  if (v.validationRequirement === "not-required" && v.validationClaims.length !== 0) ctx.addIssue({ code: "custom", path: ["validationClaims"], message: "validation claims require validation requirement" });
  const unresolved = v.artifacts.some((a) => ["unavailable", "truncated", "incomplete", "quarantined", "failed"].includes(a.disposition));
  const failedValidation = v.validationClaims.some((claim) => claim.result !== "passed");
  if (v.completeness === "complete" && (unresolved || failedValidation)) ctx.addIssue({ code: "custom", path: ["completeness"], message: "complete manifests cannot contain unresolved artifacts or validation failures" });
  if (v.completeness === "partial" && !unresolved && !failedValidation) ctx.addIssue({ code: "custom", path: ["completeness"], message: "partial manifests require an unresolved artifact or validation failure" });
  if (v.completeness === "failed" && !v.artifacts.some((a) => a.disposition === "failed") && !failedValidation) ctx.addIssue({ code: "custom", path: ["completeness"], message: "failed manifests require a failed artifact or validation" });
  if (v.provenance.mode === "owner-attested" && v.provenance.importMode === "text-only" && included.size > 0) ctx.addIssue({ code: "custom", path: ["artifacts"], message: "text-only manual relay cannot include artifacts" });
});
export const ReviewPackageManifestSchema = ReviewPackageManifestCoreSchema.extend({ manifestDigest: HashSchema });
export type ReviewPackageManifest = z.infer<typeof ReviewPackageManifestSchema>;

export const CAPTURE_PARSE_CODES = Object.freeze(["MALFORMED_INPUT", "UNSUPPORTED_VERSION", "HASH_MISMATCH", "UNTRUSTED_REFERENCE", "SUBJECT_MISMATCH"] as const);
export type CaptureParseCode = (typeof CAPTURE_PARSE_CODES)[number];
export type CaptureParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: CaptureParseCode };
const versionOf = (raw: unknown, field: string): unknown => { try { return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[field] : undefined; } catch { return undefined; } };
const parse = <T>(schema: z.ZodType<T>, raw: unknown, versionField: string): CaptureParseResult<T> => { if (versionOf(raw, versionField) !== undefined && versionOf(raw, versionField) !== CAPTURE_PROJECTION_VERSION) return Object.freeze({ ok: false, code: "UNSUPPORTED_VERSION" }); try { const parsed = schema.safeParse(raw); return parsed.success ? Object.freeze({ ok: true, value: parsed.data }) : Object.freeze({ ok: false, code: "MALFORMED_INPUT" }); } catch { return Object.freeze({ ok: false, code: "MALFORMED_INPUT" }); } };
export const parseArtifactMetadata = (raw: unknown) => parse(ArtifactMetadataSchema, raw, "artifactVersion");
export const parseCaptureRecord = (raw: unknown) => parse(CaptureRecordSchema, raw, "captureVersion");
export const parseReviewPackageManifest = (raw: unknown) => parse(ReviewPackageManifestSchema, raw, "manifestVersion");
/** Shape validation only; a future runtime store, not this function, establishes authority. */
export const parseAuthoritativeM1ESnapshotShape = (raw: unknown) => parse(AuthoritativeM1ESnapshotShapeSchema, raw, "contextVersion");

const toSnapshotProvenance = (value: WorkerProvenance): SnapshotProvenance => value.mode === "automated" ? { mode: "automated", connectorType: value.connectorType, workerId: value.workerId, adapterId: value.adapterId, adapterRunId: value.adapterRunId } : { mode: "owner-attested", connectorType: "manual-relay", workerId: value.workerId };
const sameProvenance = (left: SnapshotProvenance, right: WorkerProvenance): boolean => { const expected = toSnapshotProvenance(right); return left.mode === expected.mode && left.workerId === expected.workerId && left.connectorType === expected.connectorType && (left.mode !== "automated" || (expected.mode === "automated" && left.adapterId === expected.adapterId && left.adapterRunId === expected.adapterRunId)); };
const sameSubject = (entry: TrustedEvidenceSnapshot, expected: SnapshotSubject): boolean => subjectKey(entry.subject) === subjectKey(expected);
const fail = (code: Extract<CaptureParseCode, "UNTRUSTED_REFERENCE" | "SUBJECT_MISMATCH">): CaptureParseResult<never> => Object.freeze({ ok: false, code });
const resolveEvidence = (context: AuthoritativeM1ESnapshotShape, ref: string) => context.evidence.find((value) => value.evidenceId === ref);
export type CaptureTrust = "worker-claim" | "derived" | "observed" | "validated" | "owner-attested";
const trust = (value: CaptureTrust): CaptureParseResult<{ readonly trust: CaptureTrust }> => Object.freeze({ ok: true, value: { trust: value } });
const snapshotSubjectForCapture = (capture: CaptureRecord): SnapshotSubject => ({ taskId: capture.taskId, attemptId: capture.attemptId, operationId: capture.operationId, artifactId: capture.artifactId, captureId: capture.captureId, reviewId: null, contentHash: capture.contentHash, sourceProvenance: toSnapshotProvenance(capture.provenance) });

/** Resolves a claim only against a snapshot that the caller obtained from an authoritative future runtime boundary. */
export function evaluateCaptureTrust(rawCapture: unknown, rawAuthoritativeSnapshot: unknown): CaptureParseResult<{ readonly trust: CaptureTrust }> {
  const capture = parseCaptureRecord(rawCapture); const snapshot = parseAuthoritativeM1ESnapshotShape(rawAuthoritativeSnapshot);
  if (!capture.ok) return capture; if (!snapshot.ok) return snapshot;
  try {
    const value = capture.value;
    if (value.evidenceClass === "worker-claim") return trust("worker-claim");
    if (value.evidenceClass === "derived") return trust("derived");
    const evidence = resolveEvidence(snapshot.value, value.evidenceRef);
    if (!evidence) return fail("UNTRUSTED_REFERENCE");
    if (!sameSubject(evidence, snapshotSubjectForCapture(value))) return fail("SUBJECT_MISMATCH");
    if (value.evidenceClass === "observation-request") return evidence.kind === "observed" && evidence.observerId === value.requestedObserverId && evidence.observationMethod === value.observationMethod && evidence.observerId !== value.provenance.workerId ? trust("observed") : fail("UNTRUSTED_REFERENCE");
    if (value.evidenceClass === "validation-request") return evidence.kind === "validated" && evidence.validatorId === value.requestedValidatorId && evidence.validatedCaptureId === value.validatedCaptureId && evidence.validationResult === value.validationResult && evidence.validatorId !== value.provenance.workerId ? trust("validated") : fail("UNTRUSTED_REFERENCE");
    return evidence.kind === "manual-import" && evidence.importMode === "reviewed-artifact-import" ? trust("owner-attested") : fail("UNTRUSTED_REFERENCE");
  } catch { return Object.freeze({ ok: false, code: "MALFORMED_INPUT" }); }
}

/** Checks distinct producer, quota policy, and quota observation bindings using authoritative snapshot facts only. */
export function evaluateArtifactTrust(rawArtifact: unknown, rawAuthoritativeSnapshot: unknown): CaptureParseResult<{ readonly quotaOutcome: "within-limit" | "partial-capture" | "quota-exceeded" }> {
  const artifact = parseArtifactMetadata(rawArtifact); const snapshot = parseAuthoritativeM1ESnapshotShape(rawAuthoritativeSnapshot);
  if (!artifact.ok) return artifact; if (!snapshot.ok) return snapshot;
  try {
    const value = artifact.value; const producer = resolveEvidence(snapshot.value, value.producerRequest.evidenceRef);
    if (!producer) return fail("UNTRUSTED_REFERENCE");
    const producerSubject = { taskId: value.taskId, attemptId: value.attemptId, operationId: value.operationId, artifactId: value.artifactId, captureId: value.producerRequest.captureId, reviewId: null, contentHash: value.contentHash, sourceProvenance: producer.subject.sourceProvenance } satisfies SnapshotSubject;
    if (!sameSubject(producer, producerSubject)) return fail("SUBJECT_MISMATCH");
    if (!((producer.kind === "producer" && producer.producerCaptureId === value.producerRequest.captureId) || (producer.kind === "manual-import" && producer.importMode === "reviewed-artifact-import"))) return fail("UNTRUSTED_REFERENCE");
    const policy = snapshot.value.quotaPolicies.find((item) => item.policyId === value.quotaPolicyRef);
    const observation = snapshot.value.quotaObservations.find((item) => item.observationId === value.quotaObservationRef);
    if (!policy || !observation) return fail("UNTRUSTED_REFERENCE");
    const observationEvidence = resolveEvidence(snapshot.value, observation.evidenceId);
    if (!observationEvidence || (observationEvidence.kind !== "observed" && observationEvidence.kind !== "validated")) return fail("UNTRUSTED_REFERENCE");
    if (policy.taskId !== value.taskId || policy.attemptId !== value.attemptId || policy.operationId !== value.operationId || (policy.artifactId !== null && policy.artifactId !== value.artifactId)) return fail("SUBJECT_MISMATCH");
    if (observation.policyId !== policy.policyId || observation.policyVersion !== policy.policyVersion || observation.taskId !== value.taskId || observation.attemptId !== value.attemptId || observation.operationId !== value.operationId || observation.artifactId !== value.artifactId || observation.contentHash !== value.contentHash || observation.artifactBytes !== value.byteLength) return fail("SUBJECT_MISMATCH");
    const observationSubject = { taskId: observation.taskId, attemptId: observation.attemptId, operationId: observation.operationId, artifactId: observation.artifactId, captureId: observation.captureId, reviewId: null, contentHash: observation.contentHash, sourceProvenance: observationEvidence.subject.sourceProvenance } satisfies SnapshotSubject;
    if (!sameSubject(observationEvidence, observationSubject)) return fail("SUBJECT_MISMATCH");
    const exceeded = observation.artifactBytes > policy.perArtifactLimitBytes || observation.taskBytes > policy.taskLimitBytes;
    if (value.state === "complete" && exceeded) return fail("SUBJECT_MISMATCH");
    const quotaOutcome: "within-limit" | "partial-capture" | "quota-exceeded" = exceeded ? "quota-exceeded" : value.state === "complete" ? "within-limit" : "partial-capture";
    return Object.freeze({ ok: true, value: { quotaOutcome } });
  } catch { return Object.freeze({ ok: false, code: "MALFORMED_INPUT" }); }
}

/** Validates review-scoped inclusion and required validation claims; parsed external IDs never prove either fact. */
export function evaluateReviewPackageManifestTrust(rawManifest: unknown, rawAuthoritativeSnapshot: unknown): CaptureParseResult<ReviewPackageManifest> {
  const manifest = verifyReviewPackageManifest(rawManifest); const snapshot = parseAuthoritativeM1ESnapshotShape(rawAuthoritativeSnapshot);
  if (!manifest.ok) return manifest; if (!snapshot.ok) return snapshot;
  try {
    const value = manifest.value;
    for (const artifact of value.artifacts) {
      if (artifact.disposition !== "included") continue;
      const inclusion = resolveEvidence(snapshot.value, artifact.inclusionRequest.evidenceRef);
      if (!inclusion) return fail("UNTRUSTED_REFERENCE");
      const inclusionSubject = { taskId: value.taskId, attemptId: value.attemptId, operationId: value.operationId, artifactId: artifact.artifactId, captureId: artifact.inclusionRequest.captureId, reviewId: value.reviewId, contentHash: artifact.contentHash, sourceProvenance: toSnapshotProvenance(value.provenance) } satisfies SnapshotSubject;
      if (inclusion.kind !== "inclusion" || !sameSubject(inclusion, inclusionSubject)) return fail("SUBJECT_MISMATCH");
      const source = resolveEvidence(snapshot.value, inclusion.sourceEvidenceId);
      if (!source) return fail("UNTRUSTED_REFERENCE");
      const sourceSubject = { ...inclusionSubject, reviewId: null } satisfies SnapshotSubject;
      if (!sameSubject(source, sourceSubject)) return fail("SUBJECT_MISMATCH");
      if (value.provenance.mode === "automated" && !(source.kind === "producer" && source.producerCaptureId === artifact.inclusionRequest.captureId)) return fail("UNTRUSTED_REFERENCE");
      if (value.provenance.mode === "owner-attested" && !(source.kind === "manual-import" && source.importMode === "reviewed-artifact-import")) return fail("UNTRUSTED_REFERENCE");
    }
    for (const claim of value.validationClaims) {
      const artifact = value.artifacts.find((item) => item.artifactId === claim.artifactId);
      const validation = resolveEvidence(snapshot.value, claim.evidenceRef);
      if (!artifact || !validation) return fail("UNTRUSTED_REFERENCE");
      const subject = { taskId: value.taskId, attemptId: value.attemptId, operationId: value.operationId, artifactId: claim.artifactId, captureId: claim.validationCaptureId, reviewId: value.reviewId, contentHash: artifact.contentHash, sourceProvenance: toSnapshotProvenance(value.provenance) } satisfies SnapshotSubject;
      if (validation.kind !== "validated" || !sameSubject(validation, subject)) return fail("SUBJECT_MISMATCH");
      if (validation.validatedCaptureId !== claim.validatedCaptureId || validation.validationResult !== claim.result || validation.validatorId === value.provenance.workerId) return fail("UNTRUSTED_REFERENCE");
    }
    return manifest;
  } catch { return Object.freeze({ ok: false, code: "MALFORMED_INPUT" }); }
}

export function digestReviewPackageManifest(raw: unknown): CaptureParseResult<string> { const parsed = parse(ReviewPackageManifestCoreSchema, raw, "manifestVersion"); if (!parsed.ok) return parsed; try { const canonical = canonicalizeForDigest(parsed.value); if (canonical.length > CAPTURE_LIMITS.maxCanonicalChars) return Object.freeze({ ok: false, code: "MALFORMED_INPUT" }); return Object.freeze({ ok: true, value: `sha256:${createHash("sha256").update(`chubz.m1e.review-manifest/v1\n${canonical}`, "utf8").digest("hex")}` }); } catch { return Object.freeze({ ok: false, code: "MALFORMED_INPUT" }); } }
export function verifyReviewPackageManifest(raw: unknown): CaptureParseResult<ReviewPackageManifest> { const parsed = parseReviewPackageManifest(raw); if (!parsed.ok) return parsed; const { manifestDigest, ...core } = parsed.value; const digest = digestReviewPackageManifest(core); return digest.ok && digest.value === manifestDigest ? parsed : Object.freeze({ ok: false, code: "HASH_MISMATCH" }); }
