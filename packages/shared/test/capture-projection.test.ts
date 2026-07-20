import { describe, expect, it } from "vitest";
import { CAPTURE_LIMITS, digestReviewPackageManifest, evaluateArtifactTrust, evaluateCaptureTrust, evaluateReviewPackageManifestTrust, parseArtifactMetadata, parseCaptureRecord, serializeBridgeLogFrontMatter, verifyReviewPackageManifest } from "../src/index.js";

const hash = `sha256:${"a".repeat(64)}`;
const automated = { mode: "automated", connectorType: "cli-headless", workerId: "codex", adapterId: "adapter-1", adapterVersion: "1.0", adapterRunId: "run-1", executableId: "codex-cli", executableVersion: "1.0", executableHash: null, runtime: "node", invocationMode: "headless", authenticationMode: "owner-managed", structuredOutput: true, isolation: "not-attested" } as const;
const manual = { mode: "owner-attested", connectorType: "manual-relay", workerId: "reviewer", importMode: "reviewed-artifact-import", ownerAttestedAt: "2026-07-20T00:00:00Z", guarantees: { cryptographicIdentity: false, commandCapture: false, processSupervision: false, filesystemEnforcement: false } } as const;
const subject = { taskId: "task-1", attemptId: "attempt-1", operationId: null, artifactId: "artifact-1", captureId: "capture-1", contentHash: hash };
const context = {
  contextVersion: "1.0",
  evidence: [
    { evidenceId: "evidence-1", kind: "observed", subject, observerId: "bridge-1", observationMethod: "adapter" },
    { evidenceId: "validation-1", kind: "validated", subject: { ...subject, captureId: "validation-record" }, validatorId: "validator-1", validatedCaptureId: "capture-1", validationResult: "passed" },
  ],
  quotaPolicies: [{ policyId: "policy-1", policyVersion: "v1", authority: "system", taskId: "task-1", artifactId: null, perArtifactLimitBytes: 100, taskLimitBytes: 1000, retentionClass: "task", expiresAt: "2026-07-21T00:00:00Z" }],
  quotaObservations: [{ observationId: "observation-1", evidenceId: "evidence-1", source: "adapter", confidence: "observed", taskId: "task-1", attemptId: "attempt-1", operationId: null, artifactId: "artifact-1", captureId: "capture-1", contentHash: hash, artifactBytes: 0, taskBytes: 0, taskArtifactCount: 1 }],
};
const captureBase = { captureVersion: "1.0", captureId: "capture-1", taskId: "task-1", attemptId: "attempt-1", operationId: null, artifactId: "artifact-1", approvalId: null, capturedAt: "2026-07-20T00:00:00Z" };
const observationRequest = { ...captureBase, kind: "artifact" as const, evidenceClass: "observation-request" as const, provenance: automated, requestedObserverId: "bridge-1", evidenceRef: "evidence-1", observationMethod: "adapter" as const };
const artifact = { artifactVersion: "1.0", artifactId: "artifact-1", taskId: "task-1", attemptId: "attempt-1", operationId: null, approvalId: null, kind: "file" as const, mediaType: "text/plain", logicalName: "result.txt", displayLabel: "Result", description: "safe synthetic result", byteLength: 0, contentHash: hash, capturedAt: "2026-07-20T00:00:00Z", state: "complete" as const, redaction: "not-required" as const, producerRequest: { captureId: "capture-1", evidenceRef: "evidence-1" }, quotaPolicyRef: "policy-1", quotaObservationRef: "observation-1", parentArtifactId: null };
const included = { artifactId: "artifact-1", contentHash: hash, disposition: "included" as const, redaction: "not-redacted" as const, inclusionRequest: { captureId: "capture-1", evidenceRef: "evidence-1" } };
const core = { manifestVersion: "1.0", reviewId: "review-1", taskId: "task-1", attemptId: "attempt-1", operationId: null, approvalId: null, createdAt: "2026-07-20T00:00:00Z", provenance: automated, artifacts: [included], validationCaptureIds: [], warnings: [], completeness: "complete" as const, redaction: "not-required" as const, redactionCount: 0, parentManifestId: null };
const signedManifest = <T extends typeof core>(value: T) => { const digest = digestReviewPackageManifest(value); if (!digest.ok) throw new Error("fixture digest"); return { ...value, manifestDigest: digest.value }; };
const completeManifest = () => signedManifest(core);

describe("M1E trusted snapshot boundary", () => {
  it("does not elevate claimed observer or validator IDs without exact trusted snapshot evidence", () => {
    expect(parseCaptureRecord(observationRequest)).toMatchObject({ ok: true });
    expect(evaluateCaptureTrust(observationRequest, context)).toEqual({ ok: true, value: { trust: "observed" } });
    expect(evaluateCaptureTrust({ ...observationRequest, requestedObserverId: "forged-bridge" }, context)).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
    expect(evaluateCaptureTrust({ ...observationRequest, evidenceRef: "missing" }, context)).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
    const validation = { ...captureBase, captureId: "validation-record", kind: "test" as const, evidenceClass: "validation-request" as const, provenance: automated, requestedValidatorId: "validator-1", validatedCaptureId: "capture-1", evidenceRef: "validation-1", validationResult: "passed" as const, validationMethod: "independent-validation" as const };
    expect(evaluateCaptureTrust(validation, context)).toEqual({ ok: true, value: { trust: "validated" } });
    expect(evaluateCaptureTrust({ ...validation, requestedValidatorId: "forged-validator" }, context)).toMatchObject({ ok: false });
    expect(evaluateCaptureTrust({ ...validation, taskId: "task-2" }, context)).toMatchObject({ ok: false, code: "SUBJECT_MISMATCH" });
    const claim = { ...captureBase, kind: "test" as const, evidenceClass: "worker-claim" as const, provenance: automated, claimEvidenceIds: ["evidence-1"] };
    expect(evaluateCaptureTrust(claim, context)).toEqual({ ok: true, value: { trust: "worker-claim" } });
    expect(parseCaptureRecord({ ...claim, evidenceClass: "observation-request" })).toMatchObject({ ok: false });
  });

  it("resolves producer, inclusion, and manual import only through exact trusted subjects", () => {
    expect(evaluateArtifactTrust(artifact, context)).toEqual({ ok: true, value: { quotaOutcome: "within-limit" } });
    expect(evaluateArtifactTrust({ ...artifact, producerRequest: { ...artifact.producerRequest, evidenceRef: "missing" } }, context)).toMatchObject({ ok: false });
    expect(evaluateArtifactTrust({ ...artifact, artifactId: "artifact-2", logicalName: "other.txt" }, context)).toMatchObject({ ok: false, code: "SUBJECT_MISMATCH" });
    expect(evaluateReviewPackageManifestTrust(completeManifest(), context)).toMatchObject({ ok: true });
    expect(evaluateReviewPackageManifestTrust(signedManifest({ ...core, artifacts: [{ ...included, inclusionRequest: { ...included.inclusionRequest, evidenceRef: "missing" } }] }), context)).toMatchObject({ ok: false });
    expect(evaluateReviewPackageManifestTrust(signedManifest({ ...core, artifacts: [{ ...included, artifactId: "artifact-2" }] }), context)).toMatchObject({ ok: false, code: "SUBJECT_MISMATCH" });
    const manualCore = { ...core, provenance: manual, artifacts: [{ ...included, inclusionRequest: { captureId: "capture-1", evidenceRef: "evidence-1" } }] };
    const manualDigest = digestReviewPackageManifest(manualCore); if (!manualDigest.ok) throw new Error("fixture digest");
    expect(evaluateReviewPackageManifestTrust({ ...manualCore, manifestDigest: manualDigest.value }, context)).toMatchObject({ ok: false });
  });
});

describe("M1E quota, metadata, and serialization", () => {
  it("uses snapshot policy and observation rather than externally supplied limits or outcomes", () => {
    expect(parseArtifactMetadata({ ...artifact, quotaPolicy: { authority: "system" } })).toMatchObject({ ok: false });
    expect(evaluateArtifactTrust({ ...artifact, quotaPolicyRef: "missing" }, context)).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
    expect(evaluateArtifactTrust({ ...artifact, quotaObservationRef: "missing" }, context)).toMatchObject({ ok: false, code: "UNTRUSTED_REFERENCE" });
    expect(evaluateArtifactTrust({ ...artifact, byteLength: 1 }, context)).toMatchObject({ ok: false, code: "SUBJECT_MISMATCH" });
    expect(parseArtifactMetadata({ ...artifact, byteLength: Number.MAX_SAFE_INTEGER + 1 })).toMatchObject({ ok: false });
  });

  it("rejects secret-bearing descriptions and unsafe names while preserving deterministic front matter", () => {
    for (const description of ["api_key=abcdefghijklmnopqrstuvwxyz1234567890", "Authorization: Bearer abcdefghijklmnop", "eyJabcdefgh.abcdefgh.abcdefgh", "postgres://user:password@example.test/db", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"]) expect(parseArtifactMetadata({ ...artifact, description })).toMatchObject({ ok: false });
    for (const logicalName of ["CON", "NUL.txt", "COM1.log", "LPT9.txt", "C:relative", "C:\\absolute", "\\\\server\\share", "file:secret", "result.", " result"]) expect(parseArtifactMetadata({ ...artifact, logicalName })).toMatchObject({ ok: false });
    const frontMatter = { projectionVersion: "1.0", nonAuthoritative: true, taskId: "task-1", attemptId: "attempt-1", projectId: "pilot", state: "RESULT_CAPTURED", createdAt: "2026-07-20T00:00:00Z", provenanceMode: "automated" as const, approvalIds: [], artifactIds: [], reviewId: null, validation: "validated" as const, redaction: "redacted" as const, warnings: ["---", "line\r\nbody", "\u2028\u2029"], redactionCount: 1 };
    const serialized = serializeBridgeLogFrontMatter(frontMatter); expect(serialized.ok && serialized.value.startsWith("---\n{")).toBe(true); expect(serialized.ok && serialized.value.endsWith("\n---\n")).toBe(true); expect(serialized.ok && serialized.value.includes("line\\r\\nbody")).toBe(true);
    expect(verifyReviewPackageManifest(completeManifest())).toMatchObject({ ok: true });
  });

  it("keeps context and external hostile input total and bounded", () => {
    const hostile = new Proxy({}, { get() { throw new Error("secret"); }, ownKeys() { throw new Error("secret"); } });
    expect(() => evaluateCaptureTrust(hostile, hostile)).not.toThrow();
    expect(() => evaluateArtifactTrust(hostile, hostile)).not.toThrow();
    expect(() => evaluateReviewPackageManifestTrust(hostile, hostile)).not.toThrow();
    expect(digestReviewPackageManifest({ ...core, warnings: Array.from({ length: CAPTURE_LIMITS.maxNotes + 1 }, () => "x") })).toMatchObject({ ok: false });
  });
});
