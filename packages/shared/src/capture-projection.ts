import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalizeForDigest } from "./protocol/digest-internal.js";
import { IsoUtcTimestampSchema, SafeIdSchema, SlugIdSchema, displayText } from "./protocol/common.js";
import { ConnectorTypeSchema, ProvenanceModeSchema } from "./worker-manifest.js";

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
const SafeLabelSchema = displayText(256).refine(
  (value) => !/[\\/]/.test(value) && !value.includes(".."),
  "must be a portable display label, not a path",
);
const SafeNoteSchema = displayText(256).refine(
  (value) => !/[{}&*!]|^\s*[-?:]/m.test(value),
  "must not contain YAML control syntax",
);

export const ArtifactStateSchema = z.enum(["complete", "truncated", "incomplete", "failed", "quarantined"]);
export const ArtifactKindSchema = z.enum([
  "response", "command", "file", "diff", "patch", "test", "log", "review", "manifest", "redacted", "derived",
]);
export const RedactionStateSchema = z.enum(["not-required", "redacted", "required", "failed"]);
export const RetentionClassSchema = z.enum(["ephemeral", "task", "review", "hold"]);
export const QuotaAccountingSchema = z.strictObject({
  perArtifactLimitBytes: z.number().int().min(0).max(CAPTURE_LIMITS.maxBytes),
  taskLimitBytes: z.number().int().min(0).max(CAPTURE_LIMITS.maxBytes),
  accountedArtifactBytes: z.number().int().min(0).max(CAPTURE_LIMITS.maxBytes),
  accountedTaskBytes: z.number().int().min(0).max(CAPTURE_LIMITS.maxBytes),
  accountedTaskArtifacts: z.number().int().min(0).max(CAPTURE_LIMITS.maxArtifacts),
  outcome: z.enum(["within-limit", "quota-exceeded", "partial-capture"]),
}).superRefine((value, ctx) => {
  if (value.accountedArtifactBytes > value.perArtifactLimitBytes) ctx.addIssue({ code: "custom", path: ["accountedArtifactBytes"], message: "artifact exceeds its policy limit" });
  if (value.accountedTaskBytes > value.taskLimitBytes) ctx.addIssue({ code: "custom", path: ["accountedTaskBytes"], message: "task exceeds its policy limit" });
});
export type QuotaAccounting = z.infer<typeof QuotaAccountingSchema>;

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
  label: SafeLabelSchema,
  byteLength: z.number().int().min(0).max(CAPTURE_LIMITS.maxBytes),
  contentHash: HashSchema,
  capturedAt: IsoUtcTimestampSchema,
  state: ArtifactStateSchema,
  redaction: RedactionStateSchema,
  retentionClass: RetentionClassSchema,
  expiresAt: IsoUtcTimestampSchema.nullable(),
  quota: QuotaAccountingSchema,
  parentArtifactId: OptionalId,
  description: displayText(512).nullable(),
}).superRefine((value, ctx) => {
  if (value.retentionClass === "hold" && value.expiresAt !== null) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "hold artifacts do not expire" });
  if (value.retentionClass !== "hold" && value.expiresAt === null) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "non-hold retention requires an expiry" });
  if (value.byteLength > value.quota.perArtifactLimitBytes) ctx.addIssue({ code: "custom", path: ["byteLength"], message: "artifact byte length exceeds quota" });
  if (value.state !== "complete" && value.redaction === "not-required") ctx.addIssue({ code: "custom", path: ["redaction"], message: "non-complete artifacts require redaction status" });
});
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

const AutomatedProvenanceSchema = z.strictObject({
  mode: z.literal("automated"),
  connectorType: ConnectorTypeSchema,
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
  captureSource: z.enum(["connector", "adapter", "runtime"]),
  captureConfidence: z.enum(["observed", "validated"]),
  evidenceIds: z.array(SafeIdSchema).max(CAPTURE_LIMITS.maxProvenanceEvidence),
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
  operationId: OptionalId, approvalId: OptionalId, capturedAt: IsoUtcTimestampSchema, provenance: WorkerProvenanceSchema, artifactId: SafeIdSchema,
} as const;
const automatedEvidence = z.enum(["worker-claim", "observed", "validated", "derived"]);
const ownerEvidence = z.literal("owner-attested");
export const CaptureRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...CaptureBase, kind: z.literal("worker-output"), evidenceClass: automatedEvidence }),
  z.strictObject({ ...CaptureBase, kind: z.literal("command"), evidenceClass: automatedEvidence }),
  z.strictObject({ ...CaptureBase, kind: z.literal("artifact"), evidenceClass: automatedEvidence }),
  z.strictObject({ ...CaptureBase, kind: z.literal("diff"), evidenceClass: automatedEvidence }),
  z.strictObject({ ...CaptureBase, kind: z.literal("test"), evidenceClass: automatedEvidence }),
  z.strictObject({ ...CaptureBase, kind: z.literal("failure"), evidenceClass: automatedEvidence }),
  z.strictObject({ ...CaptureBase, kind: z.literal("checkpoint"), evidenceClass: automatedEvidence }),
  z.strictObject({ ...CaptureBase, kind: z.literal("manual-import"), evidenceClass: ownerEvidence }),
]).superRefine((value, ctx) => {
  if (value.kind === "manual-import" && value.provenance.mode !== "owner-attested") ctx.addIssue({ code: "custom", path: ["provenance"], message: "manual imports require owner-attested provenance" });
  if (value.kind !== "manual-import" && value.provenance.mode === "owner-attested") ctx.addIssue({ code: "custom", path: ["provenance"], message: "manual provenance is limited to manual imports" });
});
export type CaptureRecord = z.infer<typeof CaptureRecordSchema>;

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
/** A deterministic JSON subset deliberately used instead of YAML parsing/serialization. */
export function serializeBridgeLogFrontMatter(raw: unknown): BridgeLogSerializationResult {
  try {
    const parsed = BridgeLogFrontMatterSchema.safeParse(raw);
    return parsed.success ? Object.freeze({ ok: true, value: canonicalizeForDigest(parsed.data) }) : Object.freeze({ ok: false, code: "MALFORMED_FRONT_MATTER" });
  } catch { return Object.freeze({ ok: false, code: "MALFORMED_FRONT_MATTER" }); }
}

const ManifestArtifactSchema = z.strictObject({ artifactId: SafeIdSchema, contentHash: HashSchema, disposition: z.enum(["included", "omitted", "unavailable", "redacted", "truncated", "quarantined", "failed"]) });
export const ReviewPackageManifestCoreSchema = z.strictObject({
  manifestVersion: z.literal(CAPTURE_PROJECTION_VERSION), reviewId: SafeIdSchema, taskId: SafeIdSchema, attemptId: SafeIdSchema,
  operationId: OptionalId, approvalId: OptionalId, createdAt: IsoUtcTimestampSchema, provenance: WorkerProvenanceSchema,
  artifacts: z.array(ManifestArtifactSchema).min(1).max(CAPTURE_LIMITS.maxArtifacts).refine((items) => new Set(items.map((item) => item.artifactId)).size === items.length, "artifact ids must be unique"),
  validationCaptureIds: z.array(SafeIdSchema).max(CAPTURE_LIMITS.maxCaptures), warnings: z.array(SafeNoteSchema).max(CAPTURE_LIMITS.maxNotes),
  completeness: z.enum(["complete", "partial", "failed"]), redaction: RedactionStateSchema, redactionCount: z.number().int().min(0).max(CAPTURE_LIMITS.maxCaptures), parentManifestId: OptionalId,
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
