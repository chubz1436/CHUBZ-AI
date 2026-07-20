import { describe, expect, it } from "vitest";
import {
  CAPTURE_LIMITS,
  TASK_STATES,
  digestReviewPackageManifest,
  evaluateArtifactTrust,
  evaluateCaptureTrust,
  evaluateReviewPackageManifestTrust,
  parseArtifactMetadata,
  parseAuthoritativeM1ESnapshotShape,
  parseCaptureRecord,
  parseReviewPackageManifest,
  serializeBridgeLogFrontMatter,
  verifyReviewPackageManifest,
} from "../src/index.js";

const hash = `sha256:${"a".repeat(64)}`;
const otherHash = `sha256:${"b".repeat(64)}`;
const automated = { mode: "automated", connectorType: "cli-headless", workerId: "codex", adapterId: "adapter-1", adapterVersion: "v1", adapterRunId: "run-1", executableId: "codex-cli", executableVersion: "v1", executableHash: null, runtime: "node", invocationMode: "headless", authenticationMode: "owner-managed", structuredOutput: true, isolation: "not-attested" } as const;
const manual = { mode: "owner-attested", connectorType: "manual-relay", workerId: "reviewer", importMode: "reviewed-artifact-import", ownerAttestedAt: "2026-07-20T00:00:00Z", guarantees: { cryptographicIdentity: false, commandCapture: false, processSupervision: false, filesystemEnforcement: false } } as const;
const sourceProvenance = { mode: "automated", connectorType: "cli-headless", workerId: "codex", adapterId: "adapter-1", adapterRunId: "run-1" } as const;
const observerProvenance = { mode: "automated", connectorType: "browser-controlled", workerId: "bridge-worker", adapterId: "bridge-adapter", adapterRunId: "bridge-run" } as const;
const validatorProvenance = { mode: "automated", connectorType: "http-api", workerId: "validator-worker", adapterId: "validator-adapter", adapterRunId: "validator-run" } as const;
const subject = { taskId: "task-1", attemptId: "attempt-1", operationId: null, artifactId: "artifact-1", captureId: "capture-1", reviewId: null, contentHash: hash, sourceProvenance } as const;
const captureBase = { captureVersion: "1.0", captureId: "capture-1", taskId: "task-1", attemptId: "attempt-1", operationId: null, artifactId: "artifact-1", contentHash: hash, approvalId: null, capturedAt: "2026-07-20T00:00:00Z" } as const;
const observationRequest = { ...captureBase, kind: "artifact" as const, evidenceClass: "observation-request" as const, provenance: automated, requestedObserverId: "bridge-1", evidenceRef: "observation-1", observationMethod: "adapter" as const };
const validationRequest = { ...captureBase, captureId: "validation-record", kind: "test" as const, evidenceClass: "validation-request" as const, provenance: automated, requestedValidatorId: "validator-1", validatedCaptureId: "capture-1", evidenceRef: "capture-validation-1", validationResult: "passed" as const, validationMethod: "independent-validation" as const };
const artifact = { artifactVersion: "1.0", artifactId: "artifact-1", taskId: "task-1", attemptId: "attempt-1", operationId: null, approvalId: null, kind: "file" as const, mediaType: "text/plain", logicalName: "result.txt", displayLabel: "Result", description: "safe synthetic result", byteLength: 0, contentHash: hash, capturedAt: "2026-07-20T00:00:00Z", state: "complete" as const, redaction: "not-required" as const, producerRequest: { captureId: "capture-1", evidenceRef: "producer-1" }, quotaPolicyRef: "policy-1", quotaObservationRef: "quota-observation-1", parentArtifactId: null };
const included = { artifactId: "artifact-1", contentHash: hash, parentArtifactId: null, disposition: "included" as const, redaction: "not-redacted" as const, inclusionRequest: { captureId: "capture-1", evidenceRef: "inclusion-1" } };
const core = { manifestVersion: "1.0", reviewId: "review-1", taskId: "task-1", attemptId: "attempt-1", operationId: null, approvalId: null, createdAt: "2026-07-20T00:00:00Z", provenance: automated, artifacts: [included], validationRequirement: "required" as const, validationClaims: [{ artifactId: "artifact-1", validationCaptureId: "manifest-validation-1", validatedCaptureId: "capture-1", evidenceRef: "manifest-validation-1", result: "passed" as const }], warnings: [], completeness: "complete" as const, redaction: "not-required" as const, redactionCount: 0, parentManifestId: null };
const context = {
  contextVersion: "1.0",
  evidence: [
    { evidenceId: "observation-1", kind: "observed", subject, observerId: "bridge-1", observerProvenance, observationMethod: "adapter" },
    { evidenceId: "capture-validation-1", kind: "validated", subject: { ...subject, captureId: "validation-record" }, validatorId: "validator-1", validatorProvenance, validationSource: "adapter", validatedCaptureId: "capture-1", validationResult: "passed" },
    { evidenceId: "producer-1", kind: "producer", subject, producerCaptureId: "capture-1" },
    { evidenceId: "inclusion-1", kind: "inclusion", subject: { ...subject, reviewId: "review-1" }, sourceEvidenceId: "producer-1" },
    { evidenceId: "manifest-validation-1", kind: "validated", subject: { ...subject, captureId: "manifest-validation-1", reviewId: "review-1" }, validatorId: "validator-1", validatorProvenance, validationSource: "adapter", validatedCaptureId: "capture-1", validationResult: "passed" },
  ],
  quotaPolicies: [{ policyId: "policy-1", policyVersion: "v1", authority: "system", taskId: "task-1", attemptId: "attempt-1", operationId: null, artifactId: null, perArtifactLimitBytes: 100, taskLimitBytes: 1000, retentionClass: "task", expiresAt: "2026-07-21T00:00:00Z" }],
  quotaObservations: [{ observationId: "quota-observation-1", evidenceId: "observation-1", policyId: "policy-1", policyVersion: "v1", source: "adapter", confidence: "observed", taskId: "task-1", attemptId: "attempt-1", operationId: null, artifactId: "artifact-1", captureId: "capture-1", contentHash: hash, artifactBytes: 0, taskBytes: 0, taskArtifactCount: 1 }],
} as const;
const signedManifest = (value: Record<string, unknown>) => { const digest = digestReviewPackageManifest(value); if (!digest.ok) throw new Error("fixture digest"); return { ...value, manifestDigest: digest.value }; };
const completeManifest = () => signedManifest(core);

describe("M1E claim and authoritative-snapshot boundary", () => {
  it("keeps every capture class distinct and requires exact observation or validation facts", () => {
    expect(parseCaptureRecord(observationRequest)).toMatchObject({ ok: true });
    expect(evaluateCaptureTrust(observationRequest, context)).toEqual({ ok: true, value: { trust: "observed" } });
    expect(evaluateCaptureTrust(validationRequest, context)).toEqual({ ok: true, value: { trust: "validated" } });
    const claim = { ...captureBase, kind: "test" as const, evidenceClass: "worker-claim" as const, provenance: automated, claimEvidenceIds: ["observation-1"] };
    const derived = { ...captureBase, captureId: "derived-1", kind: "checkpoint" as const, evidenceClass: "derived" as const, provenance: automated, sourceCaptureIds: ["capture-1"], derivation: "summary" as const };
    expect(evaluateCaptureTrust(claim, context)).toEqual({ ok: true, value: { trust: "worker-claim" } });
    expect(evaluateCaptureTrust(derived, context)).toEqual({ ok: true, value: { trust: "derived" } });
    expect(parseCaptureRecord({ ...claim, evidenceClass: "observed" })).toMatchObject({ ok: false });
    expect(parseCaptureRecord({ ...observationRequest, authority: "system" })).toMatchObject({ ok: false });
    expect(parseCaptureRecord({ ...observationRequest, requestedObserverId: "bridge-1", evidenceRef: "producer-1" })).toMatchObject({ ok: true });
    expect(evaluateCaptureTrust({ ...observationRequest, evidenceRef: "producer-1" }, context)).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
  });

  it("binds observations and validations to every capture identity and source provenance", () => {
    const mutations = [
      { taskId: "task-2" }, { attemptId: "attempt-2" }, { operationId: "operation-2" }, { artifactId: "artifact-2" }, { captureId: "capture-2" }, { contentHash: otherHash },
      { provenance: { ...automated, workerId: "other-worker" } }, { provenance: { ...automated, adapterId: "adapter-2" } }, { provenance: { ...automated, adapterRunId: "run-2" } },
    ];
    for (const mutation of mutations) expect(evaluateCaptureTrust({ ...observationRequest, ...mutation }, context)).toMatchObject({ ok: false });
    expect(evaluateCaptureTrust({ ...observationRequest, requestedObserverId: "forged" }, context)).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
    expect(evaluateCaptureTrust({ ...validationRequest, requestedValidatorId: "forged" }, context)).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
    expect(evaluateCaptureTrust({ ...validationRequest, validationResult: "failed" }, context)).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
    for (const validationResult of ["failed", "inconclusive"] as const) expect(evaluateCaptureTrust({ ...validationRequest, validationResult }, { ...context, evidence: [context.evidence[0], { ...context.evidence[1], validationResult }, ...context.evidence.slice(2)] })).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
    const withEvidence = (evidence: unknown) => ({ ...context, evidence: [evidence, ...context.evidence.slice(1)] });
    expect(parseAuthoritativeM1ESnapshotShape(withEvidence({ ...context.evidence[0], observerProvenance: { ...observerProvenance, workerId: "codex" } }))).toMatchObject({ ok: false });
    expect(parseAuthoritativeM1ESnapshotShape(withEvidence({ ...context.evidence[0], observerProvenance: { ...observerProvenance, connectorType: "cli-headless" } }))).toMatchObject({ ok: false });
    expect(parseAuthoritativeM1ESnapshotShape(withEvidence({ ...context.evidence[0], observerProvenance: { ...observerProvenance, adapterId: "adapter-1" } }))).toMatchObject({ ok: false });
    expect(parseAuthoritativeM1ESnapshotShape(withEvidence({ ...context.evidence[0], observerProvenance: { ...observerProvenance, adapterRunId: "run-1" } }))).toMatchObject({ ok: false });
    expect(parseAuthoritativeM1ESnapshotShape(withEvidence({ ...context.evidence[0], observerProvenance: undefined }))).toMatchObject({ ok: false });
    expect(parseAuthoritativeM1ESnapshotShape({ ...context, evidence: [{ ...context.evidence[0], evidenceId: "conflicting-actor", observerProvenance: { ...observerProvenance, workerId: "other-observer" } }, ...context.evidence] })).toMatchObject({ ok: false });
    expect(parseAuthoritativeM1ESnapshotShape({ ...context, evidence: [context.evidence[0], { ...context.evidence[1], validatorProvenance: { ...validatorProvenance, workerId: "codex" } }, ...context.evidence.slice(2)] })).toMatchObject({ ok: false });
  });

  it("parses an authoritative snapshot shape without treating parser success as authority and rejects conflicts", () => {
    expect(parseAuthoritativeM1ESnapshotShape(context)).toMatchObject({ ok: true });
    expect(parseAuthoritativeM1ESnapshotShape({ ...context, evidence: [...context.evidence, { ...context.evidence[0], evidenceId: "conflict-1", observerId: "other-observer" }] })).toMatchObject({ ok: false, code: "MALFORMED_INPUT" });
    expect(parseAuthoritativeM1ESnapshotShape({ ...context, quotaObservations: [...context.quotaObservations, { ...context.quotaObservations[0], observationId: "conflict-observation", artifactBytes: 1 }] })).toMatchObject({ ok: false, code: "MALFORMED_INPUT" });
    expect(evaluateCaptureTrust(observationRequest, { ...context, evidence: [] })).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
  });

  it("permits reviewed manual artifact imports only and keeps text-only relay below artifact trust", () => {
    const manualSubject = { ...subject, sourceProvenance: { mode: "owner-attested", connectorType: "manual-relay", workerId: "reviewer" } };
    const manualContext = { ...context, evidence: [{ evidenceId: "manual-import-1", kind: "manual-import", subject: manualSubject, ownerAttestationId: "attestation-1", importMode: "reviewed-artifact-import" }, ...context.evidence] };
    const manualCapture = { ...captureBase, kind: "manual-import" as const, evidenceClass: "manual-import-request" as const, provenance: manual, evidenceRef: "manual-import-1" };
    expect(evaluateCaptureTrust(manualCapture, manualContext)).toEqual({ ok: true, value: { trust: "owner-attested" } });
    expect(parseCaptureRecord({ ...manualCapture, provenance: { ...manual, importMode: "text-only" } })).toMatchObject({ ok: false });
  });
});

describe("M1E artifact, inclusion, and quota truth", () => {
  it("requires distinct producer evidence and authoritative policy and observation scope", () => {
    expect(evaluateArtifactTrust(artifact, context)).toEqual({ ok: true, value: { quotaOutcome: "within-limit" } });
    expect(evaluateArtifactTrust({ ...artifact, producerRequest: { ...artifact.producerRequest, evidenceRef: "observation-1" } }, context)).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
    expect(evaluateArtifactTrust({ ...artifact, artifactId: "artifact-2", logicalName: "other.txt" }, context)).toMatchObject({ ok: false, code: "SUBJECT_MISMATCH" });
    expect(evaluateArtifactTrust({ ...artifact, contentHash: otherHash }, context)).toMatchObject({ ok: false, code: "SUBJECT_MISMATCH" });
    expect(evaluateArtifactTrust({ ...artifact, quotaPolicyRef: "missing" }, context)).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
    expect(evaluateArtifactTrust({ ...artifact, quotaObservationRef: "missing" }, context)).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
    expect(parseArtifactMetadata({ ...artifact, quotaPolicy: { authority: "system" } })).toMatchObject({ ok: false });
    expect(evaluateArtifactTrust({ ...artifact, byteLength: 101 }, { ...context, quotaObservations: [{ ...context.quotaObservations[0], artifactBytes: 101 }] })).toMatchObject({ ok: false, code: "SUBJECT_MISMATCH" });
    expect(evaluateArtifactTrust({ ...artifact, byteLength: 101, state: "truncated", redaction: "required" }, { ...context, quotaObservations: [{ ...context.quotaObservations[0], artifactBytes: 101 }] })).toEqual({ ok: true, value: { quotaOutcome: "quota-exceeded" } });
    const validatedObservation = { ...context.quotaObservations[0], evidenceId: "capture-validation-1", confidence: "validated" as const, captureId: "validation-record" };
    expect(evaluateArtifactTrust(artifact, { ...context, quotaObservations: [validatedObservation] })).toEqual({ ok: true, value: { quotaOutcome: "within-limit" } });
    for (const validationResult of ["failed", "inconclusive"] as const) {
      expect(evaluateArtifactTrust(artifact, { ...context, evidence: [context.evidence[0], { ...context.evidence[1], validationResult }, ...context.evidence.slice(2)], quotaObservations: [validatedObservation] })).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
    }
    expect(evaluateArtifactTrust(artifact, { ...context, evidence: context.evidence.filter((item) => item.evidenceId !== "capture-validation-1"), quotaObservations: [validatedObservation] })).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
    expect(evaluateArtifactTrust(artifact, { ...context, quotaObservations: [{ ...validatedObservation, captureId: "capture-1" }] })).toMatchObject({ ok: false, code: "SUBJECT_MISMATCH" });
    expect(evaluateArtifactTrust(artifact, { ...context, quotaObservations: [{ ...validatedObservation, confidence: "observed" }] })).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
    expect(evaluateArtifactTrust(artifact, { ...context, quotaObservations: [{ ...context.quotaObservations[0], source: "runtime" }] })).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
    expect(evaluateArtifactTrust(artifact, { ...context, quotaObservations: [{ ...validatedObservation, source: "runtime" }] })).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
  });

  it("requires review-scoped inclusion that is distinct from producer evidence", () => {
    expect(evaluateReviewPackageManifestTrust(completeManifest(), context)).toMatchObject({ ok: true });
    expect(evaluateReviewPackageManifestTrust(signedManifest({ ...core, artifacts: [{ ...included, inclusionRequest: { ...included.inclusionRequest, evidenceRef: "producer-1" } }] }), context)).toMatchObject({ ok: false });
    const otherReview = signedManifest({ ...core, reviewId: "review-2" });
    expect(evaluateReviewPackageManifestTrust(otherReview, context)).toMatchObject({ ok: false, code: "SUBJECT_MISMATCH" });
    expect(evaluateReviewPackageManifestTrust(signedManifest({ ...core, provenance: { ...automated, workerId: "other-worker" } }), context)).toMatchObject({ ok: false, code: "SUBJECT_MISMATCH" });
    expect(evaluateReviewPackageManifestTrust(signedManifest({ ...core, artifacts: [{ ...included, contentHash: otherHash }] }), context)).toMatchObject({ ok: false, code: "SUBJECT_MISMATCH" });
  });

  it("keeps required validation claims honest and rejects contradictory completeness or disposition states", () => {
    expect(parseReviewPackageManifest({ ...completeManifest(), completeness: "partial" })).toMatchObject({ ok: false });
    expect(digestReviewPackageManifest({ ...core, artifacts: [{ artifactId: "artifact-2", contentHash: hash, parentArtifactId: null, disposition: "unavailable" }], validationRequirement: "not-required", validationClaims: [], completeness: "complete" })).toMatchObject({ ok: false });
    expect(digestReviewPackageManifest({ ...core, validationClaims: [{ ...core.validationClaims[0], result: "failed" }], completeness: "complete" })).toMatchObject({ ok: false });
    expect(digestReviewPackageManifest({ ...core, validationRequirement: "not-required", validationClaims: [], completeness: "failed" })).toMatchObject({ ok: false });
    expect(digestReviewPackageManifest({ ...core, artifacts: [{ artifactId: "original", contentHash: hash, parentArtifactId: null, disposition: "redacted", redactedArtifactId: "missing" }], validationRequirement: "not-required", validationClaims: [], completeness: "complete" })).toMatchObject({ ok: false });
    expect(digestReviewPackageManifest({ ...core, artifacts: [{ ...included, parentArtifactId: "artifact-1" }], validationRequirement: "not-required", validationClaims: [] })).toMatchObject({ ok: false });
    expect(digestReviewPackageManifest({ ...core, artifacts: [included, included] })).toMatchObject({ ok: false });
    expect(digestReviewPackageManifest({ ...core, provenance: { ...manual, importMode: "text-only" } })).toMatchObject({ ok: false });
    expect(evaluateReviewPackageManifestTrust(signedManifest({ ...core, validationClaims: [{ ...core.validationClaims[0], result: "failed" }], completeness: "partial" }), context)).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
  });
});

describe("M1E safe projection, canonical output, and totality", () => {
  it("screens every public free-text projection field without echoing secret input", () => {
    const secrets = ["api_key=abcdefghijklmnopqrstuvwxyz1234567890", "Authorization: Bearer abcdefghijklmnop", "eyJabcdefgh.abcdefgh.abcdefgh", "postgres://user:password@example.test/db", "token=abcdefghijklmnopqrstuvwxyz1234567890", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", "Cookie: session=abcdefghijklmnopqrstuvwxyz1234567890"];
    for (const value of secrets) {
      expect(parseArtifactMetadata({ ...artifact, description: value })).toMatchObject({ ok: false, code: "MALFORMED_INPUT" });
      expect(parseArtifactMetadata({ ...artifact, displayLabel: value })).toMatchObject({ ok: false, code: "MALFORMED_INPUT" });
      expect(parseCaptureRecord({ ...observationRequest, provenance: { ...automated, runtime: value } })).toMatchObject({ ok: false, code: "MALFORMED_INPUT" });
      expect(digestReviewPackageManifest({ ...core, warnings: [value] })).toMatchObject({ ok: false, code: "MALFORMED_INPUT" });
    }
    for (const logicalName of ["CON", "NUL.txt", "COM1.log", "LPT9.txt", "C:relative", "C:\\absolute", "\\\\server\\share", "file:secret", "result.", " result", "a..b"]) expect(parseArtifactMetadata({ ...artifact, logicalName })).toMatchObject({ ok: false });
  });

  it("emits exact LF-only canonical Bridge Log front matter and blocks breakout text", () => {
    const frontMatter = { projectionVersion: "1.0", nonAuthoritative: true, taskId: "task-1", attemptId: "attempt-1", projectId: "pilot", state: "RESULT_CAPTURED", createdAt: "2026-07-20T00:00:00Z", provenanceMode: "automated" as const, approvalIds: [], artifactIds: [], reviewId: null, validation: "validated" as const, redaction: "redacted" as const, warnings: ["line\\nbody"], redactionCount: 1 };
    const serialized = serializeBridgeLogFrontMatter(frontMatter);
    expect(serialized).toEqual({ ok: true, value: "---\n{\"approvalIds\":[],\"artifactIds\":[],\"attemptId\":\"attempt-1\",\"createdAt\":\"2026-07-20T00:00:00Z\",\"nonAuthoritative\":true,\"projectId\":\"pilot\",\"projectionVersion\":\"1.0\",\"provenanceMode\":\"automated\",\"redaction\":\"redacted\",\"redactionCount\":1,\"reviewId\":null,\"state\":\"RESULT_CAPTURED\",\"taskId\":\"task-1\",\"validation\":\"validated\",\"warnings\":[\"line\\\\nbody\"]}\n---\n" });
    expect(serializeBridgeLogFrontMatter({ ...frontMatter, warnings: ["---\nAuthorization: Bearer abcdefghijklmnop"] })).toEqual({ ok: false, code: "MALFORMED_FRONT_MATTER" });
    for (const state of TASK_STATES) expect(serializeBridgeLogFrontMatter({ ...frontMatter, state })).toMatchObject({ ok: true });
    for (const state of ["result_captured", "RESULT-CAPTURED", "ghp_abcdefghijklmnopqrstuvwxyz1234567890"]) {
      const rejected = serializeBridgeLogFrontMatter({ ...frontMatter, state });
      expect(rejected).toEqual({ ok: false, code: "MALFORMED_FRONT_MATTER" });
      expect(JSON.stringify(rejected)).not.toContain(state);
    }
  });

  it("hashes every trust-relevant manifest field canonically while preserving array order", () => {
    const base = digestReviewPackageManifest(core); if (!base.ok) throw new Error("fixture digest");
    const mutations = [
      { reviewId: "review-2" }, { taskId: "task-2" }, { attemptId: "attempt-2" }, { operationId: "op-1" }, { approvalId: "approval-1" }, { createdAt: "2026-07-20T00:00:01Z" },
      { provenance: { ...automated, adapterId: "adapter-2" } }, { artifacts: [{ ...included, contentHash: otherHash }] }, { validationRequirement: "not-required", validationClaims: [] },
      { warnings: ["warning"] }, { completeness: "partial", artifacts: [{ artifactId: "missing", contentHash: hash, parentArtifactId: null, disposition: "unavailable" }], validationRequirement: "not-required", validationClaims: [] }, { redaction: "redacted" }, { redactionCount: 1 }, { parentManifestId: "parent-1" },
    ];
    for (const mutation of mutations) { const value = digestReviewPackageManifest({ ...core, ...mutation }); expect(value.ok && value.value).not.toBe(base.value); }
    const first = { ...included, artifactId: "artifact-a" }; const second = { ...included, artifactId: "artifact-b" };
    const ordered = { ...core, artifacts: [first, second], validationRequirement: "not-required" as const, validationClaims: [] };
    const reversed = { ...ordered, artifacts: [second, first] };
    expect(digestReviewPackageManifest(ordered)).not.toEqual(digestReviewPackageManifest(reversed));
    expect(verifyReviewPackageManifest({ ...completeManifest(), manifestDigest: hash })).toMatchObject({ ok: false, code: "HASH_MISMATCH" });
  });

  it("returns bounded failures for hostile values, collection overflow, and unsafe integers", () => {
    const hostile = new Proxy({}, { get() { throw new Error("secret"); }, ownKeys() { throw new Error("secret"); } });
    expect(() => evaluateCaptureTrust(hostile, hostile)).not.toThrow();
    expect(() => evaluateArtifactTrust(hostile, hostile)).not.toThrow();
    expect(() => evaluateReviewPackageManifestTrust(hostile, hostile)).not.toThrow();
    expect(() => digestReviewPackageManifest(hostile)).not.toThrow();
    expect(parseAuthoritativeM1ESnapshotShape({ ...context, evidence: Array.from({ length: CAPTURE_LIMITS.maxProvenanceEvidence + 1 }, () => context.evidence[0]) })).toMatchObject({ ok: false });
    expect(digestReviewPackageManifest({ ...core, warnings: Array.from({ length: CAPTURE_LIMITS.maxNotes + 1 }, () => "x") })).toMatchObject({ ok: false });
    expect(parseArtifactMetadata({ ...artifact, byteLength: Number.MAX_SAFE_INTEGER + 1 })).toMatchObject({ ok: false });
  });
});
