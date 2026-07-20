import { describe, expect, it } from "vitest";
import {
  CAPTURE_LIMITS,
  digestReviewPackageManifest,
  parseArtifactMetadata,
  parseCaptureRecord,
  parseReviewPackageManifest,
  serializeBridgeLogFrontMatter,
  verifyReviewPackageManifest,
} from "../src/index.js";

const hash = `sha256:${"a".repeat(64)}`;
const automated = {
  mode: "automated", connectorType: "cli-headless", workerId: "codex", adapterId: "adapter-1", adapterVersion: "1.0",
  adapterRunId: "run-1", executableId: "codex-cli", executableVersion: "1.0", executableHash: null, runtime: "node",
  invocationMode: "headless", authenticationMode: "owner-managed", structuredOutput: true, isolation: "not-attested",
} as const;
const manual = {
  mode: "owner-attested", connectorType: "manual-relay", workerId: "reviewer", importMode: "text-only", ownerAttestedAt: "2026-07-20T00:00:00Z",
  guarantees: { cryptographicIdentity: false, commandCapture: false, processSupervision: false, filesystemEnforcement: false },
} as const;
const reviewedManual = { ...manual, importMode: "reviewed-artifact-import" as const };
const captureBase = { captureVersion: "1.0", captureId: "capture-1", taskId: "task-1", attemptId: "attempt-1", operationId: null, approvalId: null, capturedAt: "2026-07-20T00:00:00Z", artifactId: "artifact-1" } as const;
const observedCapture = { ...captureBase, kind: "artifact" as const, evidenceClass: "observed" as const, provenance: automated, observerId: "bridge-1", observerEvidenceId: "observation-1", observationMethod: "adapter" as const };
const policy = { policyId: "policy-1", authority: "system" as const, perArtifactLimitBytes: 100, taskLimitBytes: 1000, retentionClass: "task" as const, expiresAt: "2026-07-21T00:00:00Z" };
const observation = { observationId: "observation-1", source: "adapter" as const, confidence: "observed" as const, evidenceId: "observation-evidence-1", artifactBytes: 0, taskBytes: 0, taskArtifactCount: 1 };
const outcome = { policyId: "policy-1", observationId: "observation-1", outcome: "within-limit" as const, allowed: true, decisionEvidenceId: "quota-decision-1" };
const artifact = {
  artifactVersion: "1.0", artifactId: "artifact-1", taskId: "task-1", attemptId: "attempt-1", operationId: null, approvalId: null,
  kind: "file", mediaType: "text/plain", logicalName: "result.txt", displayLabel: "Result", byteLength: 0, contentHash: hash, capturedAt: "2026-07-20T00:00:00Z",
  state: "complete" as const, redaction: "not-required" as const, producer: { origin: "captured" as const, captureId: "capture-1", evidenceClass: "observed" as const, evidenceId: "observation-evidence-1" },
  quotaPolicy: policy, quotaObservation: observation, quotaOutcome: outcome, parentArtifactId: null, description: null,
};
const included = { artifactId: "artifact-1", contentHash: hash, disposition: "included" as const, redaction: "not-redacted" as const, inclusionEvidence: { mode: "automated" as const, captureId: "capture-1", evidenceClass: "observed" as const, evidenceId: "observation-evidence-1" } };
const core = {
  manifestVersion: "1.0", reviewId: "review-1", taskId: "task-1", attemptId: "attempt-1", operationId: null, approvalId: null,
  createdAt: "2026-07-20T00:00:00Z", provenance: automated, artifacts: [included],
  validationCaptureIds: [], warnings: [], completeness: "complete" as const, redaction: "not-required" as const, redactionCount: 0, parentManifestId: null,
};
const frontMatter = { projectionVersion: "1.0", nonAuthoritative: true, taskId: "task-1", attemptId: "attempt-1", projectId: "pilot", state: "RESULT_CAPTURED", createdAt: "2026-07-20T00:00:00Z", provenanceMode: "automated" as const, approvalIds: [], artifactIds: [], reviewId: null, validation: "validated" as const, redaction: "redacted" as const, warnings: [], redactionCount: 1 };

describe("M1E capture truth classes", () => {
  it("keeps worker claims, observed evidence, validation, derived summaries, and manual imports disjoint", () => {
    const claim = { ...captureBase, kind: "test" as const, evidenceClass: "worker-claim" as const, provenance: automated, claimEvidenceIds: ["claim-1"] };
    expect(parseCaptureRecord(claim)).toMatchObject({ ok: true });
    expect(parseCaptureRecord({ ...claim, observerId: "bridge-1" })).toMatchObject({ ok: false });
    expect(parseCaptureRecord({ ...claim, evidenceClass: "observed" })).toMatchObject({ ok: false });
    expect(parseCaptureRecord({ ...observedCapture, observerId: "codex" })).toMatchObject({ ok: false });
    expect(parseCaptureRecord({ ...observedCapture, observerId: undefined })).toMatchObject({ ok: false });
    expect(parseCaptureRecord(observedCapture)).toMatchObject({ ok: true });
    const validation = { ...captureBase, captureId: "capture-2", kind: "test" as const, evidenceClass: "validated" as const, provenance: automated, validatorId: "validator-1", validatedCaptureId: "capture-1", validationEvidenceId: "validation-1", validationResult: "passed" as const, validationMethod: "independent-validation" as const };
    expect(parseCaptureRecord({ ...validation, validatorId: "codex" })).toMatchObject({ ok: false });
    expect(parseCaptureRecord({ ...validation, validatedCaptureId: "capture-2" })).toMatchObject({ ok: false });
    expect(parseCaptureRecord({ ...validation, validationEvidenceId: undefined })).toMatchObject({ ok: false });
    expect(parseCaptureRecord(validation)).toMatchObject({ ok: true });
    expect(parseCaptureRecord({ ...captureBase, kind: "checkpoint", evidenceClass: "derived", provenance: automated, sourceCaptureIds: ["capture-0"], derivation: "projection" })).toMatchObject({ ok: true });
    expect(parseCaptureRecord({ ...captureBase, kind: "manual-import", evidenceClass: "owner-attested", provenance: manual, importEvidenceId: "manual-proof-1" })).toMatchObject({ ok: true });
  });
});

describe("M1E artifact truth, quota, and portable names", () => {
  it("requires trusted producer/capture binding and blocks self relationships while allowing equal content", () => {
    expect(parseArtifactMetadata(artifact)).toMatchObject({ ok: true });
    expect(parseArtifactMetadata({ ...artifact, producer: { origin: "worker-claim", captureId: "capture-1" } })).toMatchObject({ ok: false });
    expect(parseArtifactMetadata({ ...artifact, parentArtifactId: "artifact-1" })).toMatchObject({ ok: false });
    expect(parseArtifactMetadata({ ...artifact, producer: { origin: "derived", captureId: "capture-2", sourceArtifactId: "artifact-1", evidenceId: "derived-1" } })).toMatchObject({ ok: false });
    expect(parseArtifactMetadata({ ...artifact, artifactId: "artifact-2", logicalName: "derived.txt", producer: { origin: "derived", captureId: "capture-2", sourceArtifactId: "artifact-1", evidenceId: "derived-1" }, parentArtifactId: "artifact-1" })).toMatchObject({ ok: true });
    expect(parseArtifactMetadata({ ...artifact, artifactId: "artifact-2", logicalName: "duplicate.txt" })).toMatchObject({ ok: true });
  });

  it("separates owner/system policy from observed accounting and a consistent outcome", () => {
    expect(parseArtifactMetadata({ ...artifact, quotaPolicy: { ...policy, authority: "worker" } })).toMatchObject({ ok: false });
    expect(parseArtifactMetadata({ ...artifact, quotaOutcome: { ...outcome, policyId: "policy-2" } })).toMatchObject({ ok: false });
    expect(parseArtifactMetadata({ ...artifact, quotaObservation: { ...observation, artifactBytes: 101 }, byteLength: 101 })).toMatchObject({ ok: false });
    expect(parseArtifactMetadata({ ...artifact, quotaOutcome: { ...outcome, outcome: "partial-capture", allowed: false } })).toMatchObject({ ok: false });
    expect(parseArtifactMetadata({ ...artifact, byteLength: Number.MAX_SAFE_INTEGER + 1 })).toMatchObject({ ok: false });
  });

  it("accepts zero bytes but rejects portable-name path, URI, device, and unsafe-ending forms", () => {
    expect(parseArtifactMetadata(artifact)).toMatchObject({ ok: true });
    for (const logicalName of ["../secret.env", "C:relative", "C:\\absolute", "\\\\server\\share", "file:secret", "http:artifact", "CON", "NUL.txt", "result.", "result "]) {
      expect(parseArtifactMetadata({ ...artifact, logicalName })).toMatchObject({ ok: false });
    }
    expect(parseArtifactMetadata({ ...artifact, displayLabel: "api_key=abcdefghijklmnopqrstuvwxyz1234567890" })).toMatchObject({ ok: false });
  });
});

describe("M1E review-package manifest integrity", () => {
  it("requires trusted inclusion evidence and enforces the completeness/disposition matrix", () => {
    expect(digestReviewPackageManifest(core)).toMatchObject({ ok: true });
    for (const disposition of ["unavailable", "failed", "truncated", "quarantined", "redacted"] as const) {
      expect(digestReviewPackageManifest({ ...core, artifacts: [{ artifactId: "artifact-1", contentHash: hash, disposition }] })).toMatchObject({ ok: false });
    }
    expect(digestReviewPackageManifest({ ...core, artifacts: [{ artifactId: "artifact-1", contentHash: hash, disposition: "included" }] })).toMatchObject({ ok: false });
    expect(digestReviewPackageManifest({ ...core, provenance: manual })).toMatchObject({ ok: false });
    expect(digestReviewPackageManifest({ ...core, provenance: reviewedManual, artifacts: [{ ...included, inclusionEvidence: { mode: "owner-attested", captureId: "capture-3", importMode: "reviewed-artifact-import", evidenceId: "manual-proof-1" } }] })).toMatchObject({ ok: true });
    expect(digestReviewPackageManifest({ ...core, artifacts: [included, included] })).toMatchObject({ ok: false });
    expect(digestReviewPackageManifest({ ...core, completeness: "failed", artifacts: [included] })).toMatchObject({ ok: false });
  });

  it("binds every manifest trust field into a stable domain-separated digest", () => {
    const one = digestReviewPackageManifest(core);
    const reordered = digestReviewPackageManifest({ ...core, warnings: [] });
    expect(one).toEqual(reordered);
    for (const changed of [
      { ...core, taskId: "task-2" }, { ...core, attemptId: "attempt-2" }, { ...core, warnings: ["redaction applied"] },
      { ...core, completeness: "partial" as const }, { ...core, redaction: "redacted" as const },
      { ...core, artifacts: [{ ...included, contentHash: `sha256:${"b".repeat(64)}` }] },
      { ...core, artifacts: [{ ...included, inclusionEvidence: { ...included.inclusionEvidence, evidenceClass: "validated" as const } }] },
    ]) expect(digestReviewPackageManifest(changed)).not.toEqual(one);
    if (one.ok) expect(verifyReviewPackageManifest({ ...core, manifestDigest: one.value })).toMatchObject({ ok: true });
    expect(parseReviewPackageManifest({ ...core, manifestDigest: hash, extra: true })).toMatchObject({ ok: false });
  });
});

describe("M1E Bridge Log projection", () => {
  it("emits exact deterministic LF-delimited JSON front matter", () => {
    const expected = "---\n{\"approvalIds\":[],\"artifactIds\":[],\"attemptId\":\"attempt-1\",\"createdAt\":\"2026-07-20T00:00:00Z\",\"nonAuthoritative\":true,\"projectId\":\"pilot\",\"projectionVersion\":\"1.0\",\"provenanceMode\":\"automated\",\"redaction\":\"redacted\",\"redactionCount\":1,\"reviewId\":null,\"state\":\"RESULT_CAPTURED\",\"taskId\":\"task-1\",\"validation\":\"validated\",\"warnings\":[]}\n---\n";
    expect(serializeBridgeLogFrontMatter(frontMatter)).toEqual({ ok: true, value: expected });
    expect(serializeBridgeLogFrontMatter({ ...frontMatter, warnings: [] })).toEqual(serializeBridgeLogFrontMatter(frontMatter));
  });

  it("JSON-escapes YAML, Markdown, newline, and Unicode-breakout strings", () => {
    const warnings = ["---", "...", "!!js/function", "&anchor", "*alias", "<<:", "# heading", ": value", "- item", "? key", "{map", "[list", "line\r\nbody", "\u2028\u2029"];
    const result = serializeBridgeLogFrontMatter({ ...frontMatter, warnings });
    expect(result.ok && result.value.startsWith("---\n{")).toBe(true);
    expect(result.ok && result.value.endsWith("\n---\n")).toBe(true);
    expect(result.ok && result.value.includes("line\\r\\nbody")).toBe(true);
    expect(result.ok && result.value.includes("\\u2028\\u2029")).toBe(true);
    expect(result.ok && result.value.split("\n---\n")).toHaveLength(2);
    expect(serializeBridgeLogFrontMatter({ ...frontMatter, warnings: ["api_key=abcdefghijklmnopqrstuvwxyz1234567890"] })).toMatchObject({ ok: false });
  });
});

describe("M1E hostile-input totality and bounds", () => {
  it("never throws or leaks hostile values through public helpers", () => {
    const hostile = new Proxy({}, { get() { throw new Error("secret exception"); }, ownKeys() { throw new Error("secret exception"); } });
    expect(() => parseCaptureRecord(hostile)).not.toThrow();
    expect(() => parseArtifactMetadata(hostile)).not.toThrow();
    expect(() => serializeBridgeLogFrontMatter(hostile)).not.toThrow();
    expect(() => digestReviewPackageManifest(hostile)).not.toThrow();
    expect(digestReviewPackageManifest({ ...core, warnings: Array.from({ length: CAPTURE_LIMITS.maxNotes + 1 }, () => "x") })).toMatchObject({ ok: false });
  });
});
