import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalizeForDigest } from "./protocol/digest-internal.js";
import { IsoUtcTimestampSchema, SafeIdSchema, SlugIdSchema, displayText } from "./protocol/common.js";
import { detectRedactions } from "./redaction.js";
import { ProvenanceModeSchema } from "./worker-manifest.js";

/**
 * M1E pure capture, artifact, projection, and review-package contracts.
 * These records describe future runtime evidence; they neither capture,
 * persist, project, nor establish operational authority.
 */
export const CAPTURE_PROJECTION_VERSION = "1.0" as const;
export const CAPTURE_LIMITS = Object.freeze({
  maxArtifacts: 64,
  maxCaptures: 64,
  maxNotes: 32,
  maxProvenanceEvidence: 16,
  maxBytes: 1_073_741_824,
  maxCanonicalChars: 131_072,
} as const);

const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be canonical sha256");
const OptionalId = SafeIdSchema.nullable();
const AutomatedConnectorTypeSchema = z.enum(["cli-headless", "http-api", "local-process", "browser-controlled"]);
const EvidenceReferenceSchema = SafeIdSchema;
const safeProjectionText = (maxLength: number) => displayText(maxLength).refine((value) => {
  const result = detectRedactions(value);
  return result.ok && result.value.length === 0;
}, "must not contain secret-like content");
const SafeNoteSchema = safeProjectionText(256);

const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
/** Portable logical filename only; it is never a storage path. */
export const LogicalArtifactNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/, "must use portable filename characters")
  .refine((value) => value === value.trim(), "must not have leading or trailing spaces")
  .refine((value) => !value.endsWith("."), "must not end with a dot")
  .refine((value) => !value.includes(".."), "must not contain traversal-like segments")
  .refine((value) => !WINDOWS_DEVICE_RE.test(value), "must not be a Windows device name");
/** Broad presentation text; consumers must not interpret this as a path. */
export const ArtifactDisplayLabelSchema = safeProjectionText(256).refine(
  (value) => !/[\\/]/.test(value),
  "must be display text, not a path",
);

export const ArtifactStateSchema = z.enum(["complete", "truncated", "incomplete", "failed", "quarantined"]);
export const ArtifactKindSchema = z.enum([
  "response", "command", "file", "diff", "patch", "test", "log", "review", "manifest", "redacted", "derived",
]);
export const RedactionStateSchema = z.enum(["not-required", "redacted", "required", "failed"]);
export const RetentionClassSchema = z.enum(["ephemeral", "task", "review", "hold"]);

/** Policy is owned by the owner/system boundary, never by a worker or artifact. */
export const QuotaPolicySchema = z.strictObject({
  policyId: SafeIdSchema,
  authority: z.enum(["owner", "system"]),
  perArtifactLimitBytes: z.number().int().min(0).max(CAPTURE_LIMITS.maxBytes),
  taskLimitBytes: z.number().int().min(0).max(CAPTURE_LIMITS.maxBytes),
  retentionClass: RetentionClassSchema,
  expiresAt: IsoUtcTimestampSchema.nullable(),
}).superRefine((value, ctx) => {
  if (value.retentionClass === "hold" && value.expiresAt !== null) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "hold policy does not expire" });
  if (value.retentionClass !== "hold" && value.expiresAt === null) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "non-hold policy requires an expiry" });
});
export type QuotaPolicy = z.infer<typeof QuotaPolicySchema>;

/** Observed accounting is evidence, not a policy decision. */
export const QuotaObservationSchema = z.strictObject({
  observationId: SafeIdSchema,
  source: z.enum(["connector", "adapter", "runtime", "owner-accounting"]),
  confidence: z.enum(["observed", "validated"]),
  evidenceId: EvidenceReferenceSchema,
  artifactBytes: z.number().int().min(0).max(CAPTURE_LIMITS.maxBytes),
  taskBytes: z.number().int().min(0).max(CAPTURE_LIMITS.maxBytes),
  taskArtifactCount: z.number().int().min(0).max(CAPTURE_LIMITS.maxArtifacts),
});
export type QuotaObservation = z.infer<typeof QuotaObservationSchema>;

/** A policy/observation-derived decision; it never asserts enforcement occurred. */
export const QuotaOutcomeSchema = z.strictObject({
  policyId: SafeIdSchema,
  observationId: SafeIdSchema,
  outcome: z.enum(["within-limit", "partial-capture", "quota-exceeded"]),
  allowed: z.boolean(),
  decisionEvidenceId: EvidenceReferenceSchema,
});
export type QuotaOutcome = z.infer<typeof QuotaOutcomeSchema>;

const AutomatedProvenanceSchema = z.strictObject({
  mode: z.literal("automated"),
  connectorType: AutomatedConnectorTypeSchema,
  workerId: SlugIdSchema,
  adapterId: SafeIdSchema,
  adapterVersion: z.string().min(1).max(64),
  adapterRunId: OptionalId,
  executableId: SafeIdSchema.nullable(),
  executableVersion: z.string().max(64).nullable(),
  executableHash: HashSchema.nullable(),
  runtime: displayText(128),
  invocationMode: z.enum(["headless", "api", "local-process", "browser-controlled"]),
  authenticationMode: z.enum(["none", "owner-managed", "runtime-managed", "unknown"]),
  structuredOutput: z.boolean(),
  isolation: z.enum(["attested", "not-attested", "unknown"]),
});
const ManualProvenanceSchema = z.strictObject({
  mode: z.literal("owner-attested"),
  connectorType: z.literal("manual-relay"),
  workerId: SlugIdSchema,
  importMode: z.enum(["text-only", "reviewed-artifact-import"]),
  ownerAttestedAt: IsoUtcTimestampSchema,
  guarantees: z.strictObject({
    cryptographicIdentity: z.literal(false), commandCapture: z.literal(false), processSupervision: z.literal(false), filesystemEnforcement: z.literal(false),
  }),
});
export const WorkerProvenanceSchema = z.discriminatedUnion("mode", [AutomatedProvenanceSchema, ManualProvenanceSchema]);
export type WorkerProvenance = z.infer<typeof WorkerProvenanceSchema>;

const CaptureBase = {
  captureVersion: z.literal(CAPTURE_PROJECTION_VERSION), captureId: SafeIdSchema, taskId: SafeIdSchema, attemptId: SafeIdSchema,
  operationId: OptionalId, approvalId: OptionalId, capturedAt: IsoUtcTimestampSchema, artifactId: SafeIdSchema,
} as const;
const AutomatedCaptureKindSchema = z.enum(["worker-output", "command", "artifact", "diff", "test", "failure", "checkpoint"]);
const WorkerClaimCaptureSchema = z.strictObject({
  ...CaptureBase, kind: AutomatedCaptureKindSchema, evidenceClass: z.literal("worker-claim"), provenance: AutomatedProvenanceSchema,
  claimEvidenceIds: z.array(EvidenceReferenceSchema).max(CAPTURE_LIMITS.maxProvenanceEvidence),
});
const ObservedCaptureSchema = z.strictObject({
  ...CaptureBase, kind: AutomatedCaptureKindSchema, evidenceClass: z.literal("observed"), provenance: AutomatedProvenanceSchema,
  observerId: SafeIdSchema, observerEvidenceId: EvidenceReferenceSchema,
  observationMethod: z.enum(["connector", "adapter", "runtime"]),
}).superRefine((value, ctx) => {
  if (value.observerId === value.provenance.workerId) ctx.addIssue({ code: "custom", path: ["observerId"], message: "worker cannot be its sole trusted observer" });
});
const ValidatedCaptureSchema = z.strictObject({
  ...CaptureBase, kind: AutomatedCaptureKindSchema, evidenceClass: z.literal("validated"), provenance: AutomatedProvenanceSchema,
  validatorId: SafeIdSchema, validatedCaptureId: SafeIdSchema, validationEvidenceId: EvidenceReferenceSchema,
  validationResult: z.enum(["passed", "failed", "inconclusive"]), validationMethod: z.enum(["independent-validation", "owner-review"]),
}).superRefine((value, ctx) => {
  if (value.validatorId === value.provenance.workerId) ctx.addIssue({ code: "custom", path: ["validatorId"], message: "worker cannot be its sole trusted validator" });
  if (value.validatedCaptureId === value.captureId) ctx.addIssue({ code: "custom", path: ["validatedCaptureId"], message: "validation must bind a distinct source capture" });
});
const DerivedCaptureSchema = z.strictObject({
  ...CaptureBase, kind: z.literal("checkpoint"), evidenceClass: z.literal("derived"), provenance: AutomatedProvenanceSchema,
  sourceCaptureIds: z.array(SafeIdSchema).min(1).max(CAPTURE_LIMITS.maxCaptures), derivation: z.enum(["projection", "summary"]),
}).superRefine((value, ctx) => {
  if (value.sourceCaptureIds.includes(value.captureId)) ctx.addIssue({ code: "custom", path: ["sourceCaptureIds"], message: "derived capture cannot source itself" });
});
const ManualImportCaptureSchema = z.strictObject({
  ...CaptureBase, kind: z.literal("manual-import"), evidenceClass: z.literal("owner-attested"), provenance: ManualProvenanceSchema,
  importEvidenceId: EvidenceReferenceSchema,
});
/** Capture truth classes are deliberately disjoint; raw worker text is never validated evidence. */
export const CaptureRecordSchema = z.discriminatedUnion("evidenceClass", [
  WorkerClaimCaptureSchema, ObservedCaptureSchema, ValidatedCaptureSchema, DerivedCaptureSchema, ManualImportCaptureSchema,
]);
export type CaptureRecord = z.infer<typeof CaptureRecordSchema>;

const ArtifactProducerSchema = z.discriminatedUnion("origin", [
  z.strictObject({ origin: z.literal("captured"), captureId: SafeIdSchema, evidenceClass: z.enum(["observed", "validated"]), evidenceId: EvidenceReferenceSchema }),
  z.strictObject({ origin: z.literal("manual-import"), captureId: SafeIdSchema, importMode: z.literal("reviewed-artifact-import"), evidenceId: EvidenceReferenceSchema }),
  z.strictObject({ origin: z.literal("derived"), captureId: SafeIdSchema, sourceArtifactId: SafeIdSchema, evidenceId: EvidenceReferenceSchema }),
  z.strictObject({ origin: z.literal("validated"), captureId: SafeIdSchema, validationEvidenceId: EvidenceReferenceSchema }),
]);
export type ArtifactProducer = z.infer<typeof ArtifactProducerSchema>;

/** Metadata only: this does not assert that the referenced content exists. */
export const ArtifactMetadataSchema = z.strictObject({
  artifactVersion: z.literal(CAPTURE_PROJECTION_VERSION),
  artifactId: SafeIdSchema,
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  operationId: OptionalId,
  approvalId: OptionalId,
  kind: ArtifactKindSchema,
  mediaType: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/).max(128),
  logicalName: LogicalArtifactNameSchema,
  displayLabel: ArtifactDisplayLabelSchema,
  byteLength: z.number().int().min(0).max(CAPTURE_LIMITS.maxBytes),
  contentHash: HashSchema,
  capturedAt: IsoUtcTimestampSchema,
  state: ArtifactStateSchema,
  redaction: RedactionStateSchema,
  producer: ArtifactProducerSchema,
  quotaPolicy: QuotaPolicySchema,
  quotaObservation: QuotaObservationSchema,
  quotaOutcome: QuotaOutcomeSchema,
  parentArtifactId: OptionalId,
  description: displayText(512).nullable(),
}).superRefine((value, ctx) => {
  const { quotaPolicy: policy, quotaObservation: observation, quotaOutcome: outcome } = value;
  if (value.parentArtifactId === value.artifactId) ctx.addIssue({ code: "custom", path: ["parentArtifactId"], message: "artifact cannot parent itself" });
  if (value.producer.captureId === value.artifactId) ctx.addIssue({ code: "custom", path: ["producer", "captureId"], message: "artifact cannot source itself" });
  if (value.producer.origin === "derived" && value.producer.sourceArtifactId === value.artifactId) ctx.addIssue({ code: "custom", path: ["producer", "sourceArtifactId"], message: "derived artifact cannot source itself" });
  if (value.byteLength !== observation.artifactBytes) ctx.addIssue({ code: "custom", path: ["byteLength"], message: "artifact length must match observed accounting" });
  if (outcome.policyId !== policy.policyId || outcome.observationId !== observation.observationId) ctx.addIssue({ code: "custom", path: ["quotaOutcome"], message: "outcome must bind supplied policy and observation" });
  const exceeds = observation.artifactBytes > policy.perArtifactLimitBytes || observation.taskBytes > policy.taskLimitBytes;
  if (outcome.outcome === "within-limit" && (!outcome.allowed || exceeds)) ctx.addIssue({ code: "custom", path: ["quotaOutcome"], message: "within-limit outcome must be allowed and within policy" });
  if (outcome.outcome === "partial-capture" && (outcome.allowed || value.state === "complete")) ctx.addIssue({ code: "custom", path: ["quotaOutcome"], message: "partial capture cannot claim unaffected completeness" });
  if (outcome.outcome === "quota-exceeded" && (outcome.allowed || !exceeds || value.state === "complete")) ctx.addIssue({ code: "custom", path: ["quotaOutcome"], message: "quota-exceeded outcome must be observed and incomplete" });
  if (value.state !== "complete" && value.redaction === "not-required") ctx.addIssue({ code: "custom", path: ["redaction"], message: "non-complete artifacts require redaction status" });
});
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

export const BridgeLogFrontMatterSchema = z.strictObject({
  projectionVersion: z.literal(CAPTURE_PROJECTION_VERSION),
  nonAuthoritative: z.literal(true),
  taskId: SafeIdSchema, attemptId: SafeIdSchema, projectId: SlugIdSchema, state: SafeIdSchema, createdAt: IsoUtcTimestampSchema,
  provenanceMode: ProvenanceModeSchema, approvalIds: z.array(SafeIdSchema).max(CAPTURE_LIMITS.maxArtifacts),
  artifactIds: z.array(SafeIdSchema).max(CAPTURE_LIMITS.maxArtifacts), reviewId: OptionalId,
  validation: z.enum(["not-run", "claimed", "observed", "validated"]), redaction: RedactionStateSchema,
  warnings: z.array(SafeNoteSchema).max(CAPTURE_LIMITS.maxNotes), redactionCount: z.number().int().min(0).max(CAPTURE_LIMITS.maxCaptures),
});
export type BridgeLogFrontMatter = z.infer<typeof BridgeLogFrontMatterSchema>;
export type BridgeLogSerializationResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly code: "MALFORMED_FRONT_MATTER" };
/** Deterministic, delimited JSON-in-YAML front matter. It is a projection, never operational authority. */
export function serializeBridgeLogFrontMatter(raw: unknown): BridgeLogSerializationResult {
  try {
    const parsed = BridgeLogFrontMatterSchema.safeParse(raw);
    if (!parsed.success) return Object.freeze({ ok: false, code: "MALFORMED_FRONT_MATTER" });
    const canonical = canonicalizeForDigest(parsed.data).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    return Object.freeze({ ok: true, value: `---\n${canonical}\n---\n` });
  } catch { return Object.freeze({ ok: false, code: "MALFORMED_FRONT_MATTER" }); }
}

const TrustedAutomatedInclusionSchema = z.strictObject({
  mode: z.literal("automated"), captureId: SafeIdSchema, evidenceClass: z.enum(["observed", "validated"]), evidenceId: EvidenceReferenceSchema,
});
const TrustedManualInclusionSchema = z.strictObject({
  mode: z.literal("owner-attested"), captureId: SafeIdSchema, importMode: z.literal("reviewed-artifact-import"), evidenceId: EvidenceReferenceSchema,
});
const IncludedManifestArtifactSchema = z.strictObject({
  artifactId: SafeIdSchema, contentHash: HashSchema, disposition: z.literal("included"), redaction: z.enum(["not-redacted", "redacted"]),
  inclusionEvidence: z.discriminatedUnion("mode", [TrustedAutomatedInclusionSchema, TrustedManualInclusionSchema]),
});
const NonIncludedManifestArtifactSchema = z.strictObject({
  artifactId: SafeIdSchema, contentHash: HashSchema, disposition: z.enum(["omitted", "unavailable", "redacted", "truncated", "quarantined", "failed"]),
});
const ManifestArtifactSchema = z.discriminatedUnion("disposition", [IncludedManifestArtifactSchema, NonIncludedManifestArtifactSchema]);
export const ReviewPackageManifestCoreSchema = z.strictObject({
  manifestVersion: z.literal(CAPTURE_PROJECTION_VERSION), reviewId: SafeIdSchema, taskId: SafeIdSchema, attemptId: SafeIdSchema,
  operationId: OptionalId, approvalId: OptionalId, createdAt: IsoUtcTimestampSchema, provenance: WorkerProvenanceSchema,
  artifacts: z.array(ManifestArtifactSchema).min(1).max(CAPTURE_LIMITS.maxArtifacts).refine((items) => new Set(items.map((item) => item.artifactId)).size === items.length, "artifact ids must be unique"),
  validationCaptureIds: z.array(SafeIdSchema).max(CAPTURE_LIMITS.maxCaptures), warnings: z.array(SafeNoteSchema).max(CAPTURE_LIMITS.maxNotes),
  completeness: z.enum(["complete", "partial", "failed"]), redaction: RedactionStateSchema, redactionCount: z.number().int().min(0).max(CAPTURE_LIMITS.maxCaptures), parentManifestId: OptionalId,
}).superRefine((value, ctx) => {
  const badForComplete = new Set(["unavailable", "truncated", "quarantined", "failed", "redacted"]);
  if (value.completeness === "complete" && value.artifacts.some((artifact) => badForComplete.has(artifact.disposition))) ctx.addIssue({ code: "custom", path: ["completeness"], message: "complete manifests contain only included or policy-omitted artifacts" });
  if (value.completeness === "failed" && !value.artifacts.some((artifact) => artifact.disposition === "failed")) ctx.addIssue({ code: "custom", path: ["completeness"], message: "failed manifests require a failed artifact" });
  for (const [index, artifact] of value.artifacts.entries()) {
    if (artifact.disposition !== "included") continue;
    if (value.provenance.mode === "owner-attested") {
      if (value.provenance.importMode !== "reviewed-artifact-import" || artifact.inclusionEvidence.mode !== "owner-attested") ctx.addIssue({ code: "custom", path: ["artifacts", index, "inclusionEvidence"], message: "manual inclusion requires reviewed artifact import evidence" });
    } else if (artifact.inclusionEvidence.mode !== "automated") {
      ctx.addIssue({ code: "custom", path: ["artifacts", index, "inclusionEvidence"], message: "automated inclusion requires observed or validated capture evidence" });
    }
  }
});
export const ReviewPackageManifestSchema = ReviewPackageManifestCoreSchema.extend({ manifestDigest: HashSchema });
export type ReviewPackageManifest = z.infer<typeof ReviewPackageManifestSchema>;

export const CAPTURE_PARSE_CODES = Object.freeze(["MALFORMED_INPUT", "UNSUPPORTED_VERSION", "HASH_MISMATCH"] as const);
export type CaptureParseCode = (typeof CAPTURE_PARSE_CODES)[number];
export type CaptureParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: CaptureParseCode };
const versionOf = (raw: unknown, field: string): unknown => { try { return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[field] : undefined; } catch { return undefined; } };
const parse = <T>(schema: z.ZodType<T>, raw: unknown, versionField: string): CaptureParseResult<T> => {
  if (versionOf(raw, versionField) !== undefined && versionOf(raw, versionField) !== CAPTURE_PROJECTION_VERSION) return Object.freeze({ ok: false, code: "UNSUPPORTED_VERSION" });
  try { const parsed = schema.safeParse(raw); return parsed.success ? Object.freeze({ ok: true, value: parsed.data }) : Object.freeze({ ok: false, code: "MALFORMED_INPUT" }); }
  catch { return Object.freeze({ ok: false, code: "MALFORMED_INPUT" }); }
};
export const parseArtifactMetadata = (raw: unknown) => parse(ArtifactMetadataSchema, raw, "artifactVersion");
export const parseCaptureRecord = (raw: unknown) => parse(CaptureRecordSchema, raw, "captureVersion");
export const parseReviewPackageManifest = (raw: unknown) => parse(ReviewPackageManifestSchema, raw, "manifestVersion");

/** Hashes only the schema-validated core, with a fixed M1E domain separator. */
export function digestReviewPackageManifest(raw: unknown): CaptureParseResult<string> {
  const parsed = parse(ReviewPackageManifestCoreSchema, raw, "manifestVersion");
  if (!parsed.ok) return parsed;
  try {
    const canonical = canonicalizeForDigest(parsed.value);
    if (canonical.length > CAPTURE_LIMITS.maxCanonicalChars) return Object.freeze({ ok: false, code: "MALFORMED_INPUT" });
    return Object.freeze({ ok: true, value: `sha256:${createHash("sha256").update(`chubz.m1e.review-manifest/v1\n${canonical}`, "utf8").digest("hex")}` });
  } catch { return Object.freeze({ ok: false, code: "MALFORMED_INPUT" }); }
}
export function verifyReviewPackageManifest(raw: unknown): CaptureParseResult<ReviewPackageManifest> {
  const parsed = parseReviewPackageManifest(raw);
  if (!parsed.ok) return parsed;
  const { manifestDigest, ...core } = parsed.value;
  const digest = digestReviewPackageManifest(core);
  return digest.ok && digest.value === manifestDigest ? parsed : Object.freeze({ ok: false, code: "HASH_MISMATCH" });
}
