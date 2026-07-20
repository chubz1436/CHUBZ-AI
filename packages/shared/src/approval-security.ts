import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalizeForDigest } from "./protocol/digest-internal.js";
import {
  IsoUtcTimestampSchema,
  PROTOCOL_LIMITS,
  SafeIdSchema,
  SlugIdSchema,
  displayText,
} from "./protocol/common.js";
import { GitCommitIdSchema } from "./protocol/control-plane-bridge.js";

/**
 * M1C approval-security contracts (D-014).
 *
 * This module is deliberately transport- and persistence-neutral.  A
 * runtime must issue grants, keep the HMAC key, atomically consume grants
 * before execution, and reconcile an uncertain operation.  These pure
 * contracts only define the values and the fail-closed classification.
 */

export const APPROVAL_ACTION_VERSION = "1.0" as const;
export const CAPABILITY_GRANT_VERSION = "1.0" as const;
export const APPROVAL_PROOF_VERSION = "1.0" as const;
export const APPROVAL_SECURITY_LIMITS = Object.freeze({
  maxContextArtifactIds: PROTOCOL_LIMITS.maxMetadataEntries,
  maxGrantLifetimeMs: 10 * 60 * 1000,
  maxProofChallengeLifetimeMs: 5 * 60 * 1000,
  maxTimeoutSec: 86_400,
  maxManifestVersionLength: 32,
} as const);

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** A SHA-256 digest represented without platform-specific formatting. */
export const ActionDigestSchema = z
  .string()
  .regex(DIGEST_RE, "must be a sha256 digest with lowercase hexadecimal output");
export type ActionDigest = z.infer<typeof ActionDigestSchema>;

const HMAC_SHA256_SIGNATURE_BYTES = 32;
const HMAC_SHA256_SIGNATURE_LENGTH = 43;

/**
 * Canonical unpadded base64url representation of exactly one HMAC-SHA-256
 * output. The round trip rejects Node's otherwise permissive decoder input,
 * including padding and altered unused trailing bits.
 */
const HmacSha256SignatureSchema = z
  .string()
  .length(HMAC_SHA256_SIGNATURE_LENGTH)
  .regex(BASE64URL_RE, "must be unpadded base64url")
  .superRefine((value, ctx) => {
    try {
      const decoded = Buffer.from(value, "base64url");
      if (
        decoded.length !== HMAC_SHA256_SIGNATURE_BYTES ||
        decoded.toString("base64url") !== value
      ) {
        ctx.addIssue({ code: "custom", message: "must be canonical HMAC-SHA-256 base64url" });
      }
    } catch {
      ctx.addIssue({ code: "custom", message: "must be canonical HMAC-SHA-256 base64url" });
    }
  });

/** Bounded base64url evidence for public-key assertion fields (not a MAC). */
const Base64UrlEvidenceSchema = z.string().min(1).max(1024).regex(BASE64URL_RE, "must be base64url without padding");

const ActionConstraintsSchema = z.strictObject({
  /** Bound execution limit; it is part of the approved action. */
  timeoutSec: z.number().int().min(1).max(APPROVAL_SECURITY_LIMITS.maxTimeoutSec),
  /** A boolean policy control, included in the action digest. */
  requiresCleanWorktree: z.boolean(),
  /** Explicit null means no artifact is expected; omission is rejected. */
  expectedArtifactId: SafeIdSchema.nullable(),
});

const WorkspacePrepareActionSchema = z.strictObject({
  actionVersion: z.literal(APPROVAL_ACTION_VERSION),
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  operationId: SafeIdSchema,
  operation: z.literal("workspace.prepare"),
  policyClass: z.literal("workspace-write"),
  target: z.strictObject({ kind: z.literal("workspace"), resourceId: SafeIdSchema }),
  parameters: z.strictObject({
    projectId: SlugIdSchema,
    workspaceId: SafeIdSchema,
    /** Explicit null represents no requested base; raw filesystem paths are impossible. */
    baseRef: SafeIdSchema.nullable(),
  }),
  constraints: ActionConstraintsSchema,
});

const WorkerDispatchActionSchema = z.strictObject({
  actionVersion: z.literal(APPROVAL_ACTION_VERSION),
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  operationId: SafeIdSchema,
  operation: z.literal("worker.dispatch"),
  policyClass: z.literal("worker-execution"),
  target: z.strictObject({ kind: z.literal("worker"), resourceId: SlugIdSchema }),
  parameters: z.strictObject({
    projectId: SlugIdSchema,
    workspaceId: SafeIdSchema,
    worker: z.strictObject({
      manifestId: SlugIdSchema,
      manifestVersion: z
        .string()
        .max(APPROVAL_SECURITY_LIMITS.maxManifestVersionLength)
        .regex(/^[0-9]+\.[0-9]+\.[0-9]+$/, "must be bounded semver core"),
    }),
    /** Redacted instruction/content digest; raw prompt text is never an approval authority. */
    instructionDigest: ActionDigestSchema,
    contextArtifactIds: z.array(SafeIdSchema).max(APPROVAL_SECURITY_LIMITS.maxContextArtifactIds),
  }),
  constraints: ActionConstraintsSchema,
});

const WorkerCancelActionSchema = z.strictObject({
  actionVersion: z.literal(APPROVAL_ACTION_VERSION),
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  operationId: SafeIdSchema,
  operation: z.literal("worker.cancel"),
  policyClass: z.literal("worker-control"),
  target: z.strictObject({ kind: z.literal("dispatch"), resourceId: SafeIdSchema }),
  parameters: z.strictObject({ dispatchCommandId: SafeIdSchema }),
  constraints: ActionConstraintsSchema,
});

const ResultCollectActionSchema = z.strictObject({
  actionVersion: z.literal(APPROVAL_ACTION_VERSION),
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  operationId: SafeIdSchema,
  operation: z.literal("result.collect"),
  policyClass: z.literal("result-capture"),
  target: z.strictObject({ kind: z.literal("workspace"), resourceId: SafeIdSchema }),
  parameters: z.strictObject({ workspaceId: SafeIdSchema }),
  constraints: ActionConstraintsSchema,
});

const TaskIntegrationActionSchema = z.strictObject({
  actionVersion: z.literal(APPROVAL_ACTION_VERSION),
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  operationId: SafeIdSchema,
  operation: z.literal("task.integration"),
  policyClass: z.literal("integration"),
  target: z.strictObject({ kind: z.literal("commit"), resourceId: GitCommitIdSchema }),
  parameters: z.strictObject({
    workspaceId: SafeIdSchema,
    expectedCommitId: GitCommitIdSchema,
    patchArtifactId: SafeIdSchema,
  }),
  constraints: ActionConstraintsSchema,
});

/**
 * Exact bounded action an owner may approve.  It intentionally has no
 * shell command, path, environment value, secret, or free-form execution
 * description.  Unknown fields are rejected at every level.
 */
export const ApprovalActionSchema = z
  .discriminatedUnion("operation", [
    WorkspacePrepareActionSchema,
    WorkerDispatchActionSchema,
    WorkerCancelActionSchema,
    ResultCollectActionSchema,
    TaskIntegrationActionSchema,
  ])
  .superRefine((action, ctx) => {
    const targetId = action.target.resourceId;
    const expectedTargetId =
      action.operation === "workspace.prepare" || action.operation === "result.collect"
        ? action.parameters.workspaceId
        : action.operation === "worker.dispatch"
          ? action.parameters.worker.manifestId
          : action.operation === "worker.cancel"
            ? action.parameters.dispatchCommandId
            : action.parameters.expectedCommitId;
    if (targetId !== expectedTargetId) {
      ctx.addIssue({
        code: "custom",
        path: ["target", "resourceId"],
        message: "target must bind the operation's exact resource",
      });
    }
  });
export type ApprovalAction = z.infer<typeof ApprovalActionSchema>;

export const APPROVAL_CONTRACT_ERROR_CODES = Object.freeze([
  "MALFORMED_ACTION",
  "MALFORMED_GRANT",
  "MALFORMED_PROOF",
  "MALFORMED_CHALLENGE",
  "UNSUPPORTED_ACTION_VERSION",
  "UNSUPPORTED_GRANT_VERSION",
  "UNSUPPORTED_PROOF_VERSION",
  "UNSUPPORTED_CHALLENGE_VERSION",
  "INVALID_EXPECTATION",
  "CANONICALIZATION_FAILED",
] as const);
export type ApprovalContractErrorCode = (typeof APPROVAL_CONTRACT_ERROR_CODES)[number];

export const ApprovalContractErrorSchema = z.strictObject({
  code: z.enum(APPROVAL_CONTRACT_ERROR_CODES),
  message: displayText(256),
});
export type ApprovalContractError = z.infer<typeof ApprovalContractErrorSchema>;

export type ApprovalParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApprovalContractError };

const failure = (code: ApprovalContractErrorCode, message: string): ApprovalParseResult<never> =>
  Object.freeze({ ok: false, error: Object.freeze({ code, message }) });

const objectVersion = (raw: unknown, field: string): string | undefined => {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const value = (raw as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
};

/** Total hostile-input parser for approval actions. */
export function parseApprovalAction(raw: unknown): ApprovalParseResult<ApprovalAction> {
  if (objectVersion(raw, "actionVersion") !== undefined && objectVersion(raw, "actionVersion") !== APPROVAL_ACTION_VERSION) {
    return failure("UNSUPPORTED_ACTION_VERSION", "The approval action version is not supported.");
  }
  try {
    const parsed = ApprovalActionSchema.safeParse(raw);
    return parsed.success
      ? Object.freeze({ ok: true, value: parsed.data })
      : failure("MALFORMED_ACTION", "The approval action failed validation.");
  } catch {
    return failure("MALFORMED_ACTION", "The approval action failed validation.");
  }
}

/**
 * Canonical form is UTF-8 JSON with object keys sorted lexicographically,
 * original array order, and JSON's exact null/boolean/finite-number/string
 * encoding. Strings receive no Unicode, locale, path, or timezone
 * normalization: visually similar values remain distinct by design.
 */
export function canonicalizeApprovalAction(raw: unknown): ApprovalParseResult<string> {
  const parsed = parseApprovalAction(raw);
  if (!parsed.ok) return parsed;
  try {
    return Object.freeze({ ok: true, value: canonicalizeForDigest(parsed.value) });
  } catch {
    return failure("CANONICALIZATION_FAILED", "The approval action cannot be canonicalized.");
  }
}

/** SHA-256 over a versioned, domain-separated canonical action. */
export function digestApprovalAction(raw: unknown): ApprovalParseResult<ActionDigest> {
  const canonical = canonicalizeApprovalAction(raw);
  if (!canonical.ok) return canonical;
  try {
    const digest = createHash("sha256")
      .update(`chubz.m1c.approval-action/v1\n${canonical.value}`, "utf8")
      .digest("hex");
    return Object.freeze({ ok: true, value: `sha256:${digest}` });
  } catch {
    return failure("CANONICALIZATION_FAILED", "The approval action digest could not be computed.");
  }
}

const GrantAuthenticationSchema = z.strictObject({
  algorithm: z.literal("hmac-sha256"),
  keyId: SafeIdSchema,
  signature: HmacSha256SignatureSchema,
});

/** Phase-1 HMAC grant.  Its approval reference is provenance, not owner-presence proof. */
export const CapabilityGrantSchema = z
  .strictObject({
    grantVersion: z.literal(CAPABILITY_GRANT_VERSION),
    grantId: SafeIdSchema,
    taskId: SafeIdSchema,
    attemptId: SafeIdSchema,
    operationId: SafeIdSchema,
    actionDigest: ActionDigestSchema,
    issuedAt: IsoUtcTimestampSchema,
    notBefore: IsoUtcTimestampSchema,
    expiresAt: IsoUtcTimestampSchema,
    singleUse: z.literal(true),
    issuer: z.strictObject({ kind: z.literal("control-plane"), issuerId: SafeIdSchema }),
    approval: z.strictObject({ approvalId: SafeIdSchema, mode: z.literal("phase1-local") }),
    intendedVerifier: SafeIdSchema,
    authentication: GrantAuthenticationSchema,
  })
  .superRefine((grant, ctx) => {
    const issued = Date.parse(grant.issuedAt);
    const notBefore = Date.parse(grant.notBefore);
    const expires = Date.parse(grant.expiresAt);
    if (notBefore < issued || expires < notBefore) {
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "grant times are not ordered" });
    }
    if (expires - issued > APPROVAL_SECURITY_LIMITS.maxGrantLifetimeMs) {
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "grant lifetime exceeds the maximum" });
    }
  });
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

/** Total hostile-input parser for grants. */
export function parseCapabilityGrant(raw: unknown): ApprovalParseResult<CapabilityGrant> {
  if (objectVersion(raw, "grantVersion") !== undefined && objectVersion(raw, "grantVersion") !== CAPABILITY_GRANT_VERSION) {
    return failure("UNSUPPORTED_GRANT_VERSION", "The capability grant version is not supported.");
  }
  try {
    const parsed = CapabilityGrantSchema.safeParse(raw);
    return parsed.success
      ? Object.freeze({ ok: true, value: parsed.data })
      : failure("MALFORMED_GRANT", "The capability grant failed validation.");
  } catch {
    return failure("MALFORMED_GRANT", "The capability grant failed validation.");
  }
}

const GrantExpectationSchema = z.strictObject({
  actionDigest: ActionDigestSchema,
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  operationId: SafeIdSchema,
  intendedVerifier: SafeIdSchema,
  now: IsoUtcTimestampSchema,
});
export type GrantExpectation = z.infer<typeof GrantExpectationSchema>;

/** Stored by a future runtime after an atomic pre-execution consumption. */
export const GrantConsumptionSchema = z.strictObject({
  grantId: SafeIdSchema,
  actionDigest: ActionDigestSchema,
  operationId: SafeIdSchema,
  consumedAt: IsoUtcTimestampSchema,
  /** Opaque result reference used for duplicate-delivery response replay. */
  outcomeRef: SafeIdSchema.optional(),
});
export type GrantConsumption = z.infer<typeof GrantConsumptionSchema>;

export const GRANT_VERIFICATION_CODES = Object.freeze([
  "VALID",
  "MALFORMED_GRANT",
  "UNSUPPORTED_VERSION",
  "INVALID_EXPECTATION",
  "AUTHENTICATION_FAILED",
  "NOT_YET_VALID",
  "EXPIRED",
  "ACTION_HASH_MISMATCH",
  "TASK_MISMATCH",
  "ATTEMPT_MISMATCH",
  "OPERATION_MISMATCH",
  "WRONG_INTENDED_VERIFIER",
  "ALREADY_CONSUMED",
] as const);
export type GrantVerificationCode = (typeof GRANT_VERIFICATION_CODES)[number];
export type GrantVerificationResult =
  | { readonly ok: true; readonly code: "VALID"; readonly grant: CapabilityGrant }
  | { readonly ok: false; readonly code: Exclude<GrantVerificationCode, "VALID"> };

/**
 * Narrow runtime authentication boundary. The shared public API carries no
 * secret bytes or signing capability: the future key store/runtime receives
 * this canonical authenticated payload and returns only a verification result.
 * Implementations must perform a constant-time MAC-byte comparison after the
 * shared contract has rejected non-canonical signature encodings.
 */
export interface GrantAuthenticationVerifier {
  readonly verify: (input: Readonly<{
    algorithm: "hmac-sha256";
    keyId: string;
    payload: string;
    signature: Uint8Array;
  }>) => boolean;
}

const grantAuthenticationPayload = (grant: CapabilityGrant): string =>
  canonicalizeForDigest({
    domain: "chubz.m1c.capability-grant-auth/v1",
    grantVersion: grant.grantVersion,
    grantId: grant.grantId,
    taskId: grant.taskId,
    attemptId: grant.attemptId,
    operationId: grant.operationId,
    actionDigest: grant.actionDigest,
    issuedAt: grant.issuedAt,
    notBefore: grant.notBefore,
    expiresAt: grant.expiresAt,
    singleUse: grant.singleUse,
    issuer: grant.issuer,
    approval: grant.approval,
    intendedVerifier: grant.intendedVerifier,
    authentication: { algorithm: grant.authentication.algorithm, keyId: grant.authentication.keyId },
  });

const verifyGrantAuthentication = (
  grant: CapabilityGrant,
  rawAuthenticator: unknown,
): boolean => {
  try {
    if (typeof rawAuthenticator !== "object" || rawAuthenticator === null) return false;
    const verify = (rawAuthenticator as { verify?: unknown }).verify;
    if (typeof verify !== "function") return false;
    const signature = Buffer.from(grant.authentication.signature, "base64url");
    if (signature.length !== HMAC_SHA256_SIGNATURE_BYTES) return false;
    return verify.call(
      rawAuthenticator,
      Object.freeze({
        algorithm: grant.authentication.algorithm,
        keyId: grant.authentication.keyId,
        payload: grantAuthenticationPayload(grant),
        signature,
      }),
    ) === true;
  } catch {
    return false;
  }
};

/**
 * Fail-closed grant verification. Expiry is exclusive: now === expiresAt
 * is expired. No clock skew is accepted by this contract; a runtime must
 * pass its trusted current UTC time explicitly.
 */
export function verifyCapabilityGrant(
  rawGrant: unknown,
  rawExpectation: unknown,
  authenticator: unknown,
  consumed?: unknown,
): GrantVerificationResult {
  const grantResult = parseCapabilityGrant(rawGrant);
  if (!grantResult.ok) {
    return Object.freeze({
      ok: false,
      code: grantResult.error.code === "UNSUPPORTED_GRANT_VERSION" ? "UNSUPPORTED_VERSION" : "MALFORMED_GRANT",
    });
  }
  let expected: ReturnType<typeof GrantExpectationSchema.safeParse> | undefined;
  try {
    expected = GrantExpectationSchema.safeParse(rawExpectation);
  } catch {
    return Object.freeze({ ok: false, code: "INVALID_EXPECTATION" });
  }
  if (!expected.success) return Object.freeze({ ok: false, code: "INVALID_EXPECTATION" });
  const grant = grantResult.value;
  if (grant.taskId !== expected.data.taskId) return Object.freeze({ ok: false, code: "TASK_MISMATCH" });
  if (grant.attemptId !== expected.data.attemptId) return Object.freeze({ ok: false, code: "ATTEMPT_MISMATCH" });
  if (grant.operationId !== expected.data.operationId) return Object.freeze({ ok: false, code: "OPERATION_MISMATCH" });
  if (grant.actionDigest !== expected.data.actionDigest) return Object.freeze({ ok: false, code: "ACTION_HASH_MISMATCH" });
  if (grant.intendedVerifier !== expected.data.intendedVerifier) {
    return Object.freeze({ ok: false, code: "WRONG_INTENDED_VERIFIER" });
  }
  if (!verifyGrantAuthentication(grant, authenticator)) {
    return Object.freeze({ ok: false, code: "AUTHENTICATION_FAILED" });
  }
  const now = Date.parse(expected.data.now);
  if (now < Date.parse(grant.notBefore)) return Object.freeze({ ok: false, code: "NOT_YET_VALID" });
  if (now >= Date.parse(grant.expiresAt)) return Object.freeze({ ok: false, code: "EXPIRED" });
  if (consumed !== undefined) {
    let stored: ReturnType<typeof GrantConsumptionSchema.safeParse> | undefined;
    try {
      stored = GrantConsumptionSchema.safeParse(consumed);
    } catch {
      return Object.freeze({ ok: false, code: "INVALID_EXPECTATION" });
    }
    if (!stored.success) return Object.freeze({ ok: false, code: "INVALID_EXPECTATION" });
    if (stored.data.grantId === grant.grantId) return Object.freeze({ ok: false, code: "ALREADY_CONSUMED" });
  }
  return Object.freeze({ ok: true, code: "VALID", grant });
}

/**
 * Consumption is separate from idempotency: a matching consumption says a
 * redelivered grant may receive its recorded outcome but MUST NOT execute
 * again. Operation-idempotency response replay remains the M1B concern.
 */
export function classifyGrantConsumption(
  grantId: string,
  _actionDigest: string,
  consumed: unknown,
): "eligible" | "duplicate-delivery" {
  if (consumed === undefined) return "eligible";
  let record: ReturnType<typeof GrantConsumptionSchema.safeParse> | undefined;
  try {
    record = GrantConsumptionSchema.safeParse(consumed);
  } catch {
    return "eligible";
  }
  if (!record.success || record.data.grantId !== grantId) {
    return "eligible";
  }
  return "duplicate-delivery";
}

/**
 * Bridge-issued, transport-neutral freshness challenge for a future Phase-2
 * assertion. `challengeDigest` is the SHA-256 digest of the cryptographically
 * random Bridge nonce in its documented domain. The raw nonce stays in the
 * future Bridge challenge store and is never an approval authority here.
 */
export const ApprovalProofChallengeSchema = z
  .strictObject({
    proofVersion: z.literal(APPROVAL_PROOF_VERSION),
    challengeId: SafeIdSchema,
    challengeDigest: ActionDigestSchema,
    actionDigest: ActionDigestSchema,
    taskId: SafeIdSchema,
    attemptId: SafeIdSchema,
    operationId: SafeIdSchema,
    intendedVerifier: SafeIdSchema,
    issuedAt: IsoUtcTimestampSchema,
    expiresAt: IsoUtcTimestampSchema,
  })
  .superRefine((challenge, ctx) => {
    if (Date.parse(challenge.expiresAt) < Date.parse(challenge.issuedAt)) {
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "challenge times are not ordered" });
    }
    if (Date.parse(challenge.expiresAt) - Date.parse(challenge.issuedAt) > APPROVAL_SECURITY_LIMITS.maxProofChallengeLifetimeMs) {
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "challenge lifetime exceeds the maximum" });
    }
  });
export type ApprovalProofChallenge = z.infer<typeof ApprovalProofChallengeSchema>;

/** Total hostile-input parser for Bridge-issued Phase-2 challenge records. */
export function parseApprovalProofChallenge(
  raw: unknown,
): ApprovalParseResult<ApprovalProofChallenge> {
  if (objectVersion(raw, "proofVersion") !== undefined && objectVersion(raw, "proofVersion") !== APPROVAL_PROOF_VERSION) {
    return failure("UNSUPPORTED_CHALLENGE_VERSION", "The approval challenge version is not supported.");
  }
  try {
    const parsed = ApprovalProofChallengeSchema.safeParse(raw);
    return parsed.success
      ? Object.freeze({ ok: true, value: parsed.data })
      : failure("MALFORMED_CHALLENGE", "The approval challenge failed validation.");
  } catch {
    return failure("MALFORMED_CHALLENGE", "The approval challenge failed validation.");
  }
}

/**
 * Future WebAuthn assertion binding. Signature/digests are public-key
 * assertion data, not credentials, cookies, sessions, or private keys.
 * M1C deliberately does not verify a WebAuthn ceremony. A future Bridge
 * verifier MUST derive the challenge digest from the actual stored nonce and
 * from `clientDataJSON.challenge`; the client-supplied evidence fields below
 * are claims only and never substitute for that cryptographic verification.
 */
export const ApprovalProofSchema = z
  .strictObject({
    proofVersion: z.literal(APPROVAL_PROOF_VERSION),
    proofId: SafeIdSchema,
    challengeId: SafeIdSchema,
    challengeDigest: ActionDigestSchema,
    actionDigest: ActionDigestSchema,
    taskId: SafeIdSchema,
    attemptId: SafeIdSchema,
    operationId: SafeIdSchema,
    intendedVerifier: SafeIdSchema,
    issuedAt: IsoUtcTimestampSchema,
    expiresAt: IsoUtcTimestampSchema,
    ownerPresence: z.literal("present"),
    ownerVerification: z.literal("verified"),
    assertion: z.strictObject({
      format: z.literal("webauthn-assertion-v1"),
      credentialId: Base64UrlEvidenceSchema,
      authenticatorDataDigest: ActionDigestSchema,
      clientDataDigest: ActionDigestSchema,
      /** Claimed digest extracted from clientDataJSON.challenge; verify it against the real nonce later. */
      clientDataChallengeDigest: ActionDigestSchema,
      signature: Base64UrlEvidenceSchema,
    }),
  })
  .superRefine((proof, ctx) => {
    if (Date.parse(proof.expiresAt) < Date.parse(proof.issuedAt)) {
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "proof times are not ordered" });
    }
  });
export type ApprovalProof = z.infer<typeof ApprovalProofSchema>;

export const APPROVAL_PROOF_BINDING_CODES = Object.freeze([
  "VALID",
  "MALFORMED_PROOF",
  "MALFORMED_CHALLENGE",
  "UNSUPPORTED_VERSION",
  "ACTION_HASH_MISMATCH",
  "CHALLENGE_MISMATCH",
  "CHALLENGE_DIGEST_MISMATCH",
  "CLIENT_DATA_CHALLENGE_MISMATCH",
  "TASK_MISMATCH",
  "ATTEMPT_MISMATCH",
  "OPERATION_MISMATCH",
  "WRONG_INTENDED_VERIFIER",
  "EXPIRED",
  "NOT_YET_VALID",
] as const);
export type ApprovalProofBindingCode = (typeof APPROVAL_PROOF_BINDING_CODES)[number];
export type ApprovalProofBindingResult =
  | { readonly ok: true; readonly code: "VALID"; readonly proof: ApprovalProof }
  | { readonly ok: false; readonly code: Exclude<ApprovalProofBindingCode, "VALID"> };

/** Total parser for Phase-2 proof input; it is unused in Phase 1. */
export function parseApprovalProof(raw: unknown): ApprovalParseResult<ApprovalProof> {
  if (objectVersion(raw, "proofVersion") !== undefined && objectVersion(raw, "proofVersion") !== APPROVAL_PROOF_VERSION) {
    return failure("UNSUPPORTED_PROOF_VERSION", "The approval proof version is not supported.");
  }
  try {
    const parsed = ApprovalProofSchema.safeParse(raw);
    return parsed.success
      ? Object.freeze({ ok: true, value: parsed.data })
      : failure("MALFORMED_PROOF", "The approval proof failed validation.");
  } catch {
    return failure("MALFORMED_PROOF", "The approval proof failed validation.");
  }
}

/** Binding only: actual WebAuthn public-key verification belongs to Phase 2 runtime work. */
export function verifyApprovalProofBinding(
  rawProof: unknown,
  rawChallenge: unknown,
  now: unknown,
): ApprovalProofBindingResult {
  const proofResult = parseApprovalProof(rawProof);
  if (!proofResult.ok) {
    return Object.freeze({
      ok: false,
      code: proofResult.error.code === "UNSUPPORTED_PROOF_VERSION" ? "UNSUPPORTED_VERSION" : "MALFORMED_PROOF",
    });
  }
  const challengeResult = parseApprovalProofChallenge(rawChallenge);
  if (!challengeResult.ok) {
    return Object.freeze({
      ok: false,
      code:
        challengeResult.error.code === "UNSUPPORTED_CHALLENGE_VERSION"
          ? "UNSUPPORTED_VERSION"
          : "MALFORMED_CHALLENGE",
    });
  }
  let parsedNow: ReturnType<typeof IsoUtcTimestampSchema.safeParse> | undefined;
  try {
    parsedNow = IsoUtcTimestampSchema.safeParse(now);
  } catch {
    return Object.freeze({ ok: false, code: "NOT_YET_VALID" });
  }
  if (!parsedNow.success) return Object.freeze({ ok: false, code: "NOT_YET_VALID" });
  const challenge = challengeResult.value;
  const proof = proofResult.value;
  if (proof.challengeId !== challenge.challengeId) return Object.freeze({ ok: false, code: "CHALLENGE_MISMATCH" });
  if (proof.challengeDigest !== challenge.challengeDigest) return Object.freeze({ ok: false, code: "CHALLENGE_DIGEST_MISMATCH" });
  if (proof.assertion.clientDataChallengeDigest !== challenge.challengeDigest) {
    return Object.freeze({ ok: false, code: "CLIENT_DATA_CHALLENGE_MISMATCH" });
  }
  if (proof.intendedVerifier !== challenge.intendedVerifier) {
    return Object.freeze({ ok: false, code: "WRONG_INTENDED_VERIFIER" });
  }
  if (proof.actionDigest !== challenge.actionDigest) return Object.freeze({ ok: false, code: "ACTION_HASH_MISMATCH" });
  if (proof.taskId !== challenge.taskId) return Object.freeze({ ok: false, code: "TASK_MISMATCH" });
  if (proof.attemptId !== challenge.attemptId) return Object.freeze({ ok: false, code: "ATTEMPT_MISMATCH" });
  if (proof.operationId !== challenge.operationId) return Object.freeze({ ok: false, code: "OPERATION_MISMATCH" });
  const current = Date.parse(parsedNow.data);
  if (current < Date.parse(proof.issuedAt) || current < Date.parse(challenge.issuedAt)) {
    return Object.freeze({ ok: false, code: "NOT_YET_VALID" });
  }
  if (current >= Date.parse(proof.expiresAt) || current >= Date.parse(challenge.expiresAt)) {
    return Object.freeze({ ok: false, code: "EXPIRED" });
  }
  return Object.freeze({ ok: true, code: "VALID", proof });
}
