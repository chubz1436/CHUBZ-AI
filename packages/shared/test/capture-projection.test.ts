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
  adapterRunId: null, executableId: "codex-cli", executableVersion: "1.0", executableHash: null, runtime: "node",
  invocationMode: "headless", authenticationMode: "owner-managed", structuredOutput: true, isolation: "not-attested",
  captureSource: "adapter", captureConfidence: "observed", evidenceIds: [],
} as const;
const manual = {
  mode: "owner-attested", connectorType: "manual-relay", workerId: "reviewer", importMode: "text-only", ownerAttestedAt: "2026-07-20T00:00:00Z",
  guarantees: { cryptographicIdentity: false, commandCapture: false, processSupervision: false, filesystemEnforcement: false },
} as const;
const core = {
  manifestVersion: "1.0", reviewId: "review-1", taskId: "task-1", attemptId: "attempt-1", operationId: null, approvalId: null,
  createdAt: "2026-07-20T00:00:00Z", provenance: automated, artifacts: [{ artifactId: "artifact-1", contentHash: hash, disposition: "included" as const }],
  validationCaptureIds: [], warnings: [], completeness: "complete" as const, redaction: "not-required" as const, redactionCount: 0, parentManifestId: null,
};
const artifact = {
  artifactVersion: "1.0", artifactId: "artifact-1", taskId: "task-1", attemptId: "attempt-1", operationId: null, approvalId: null,
  kind: "file", mediaType: "text/plain", label: "result.txt", byteLength: 0, contentHash: hash, capturedAt: "2026-07-20T00:00:00Z",
  state: "complete", redaction: "not-required", retentionClass: "task", expiresAt: "2026-07-21T00:00:00Z",
  quota: { perArtifactLimitBytes: 100, taskLimitBytes: 1000, accountedArtifactBytes: 0, accountedTaskBytes: 0, accountedTaskArtifacts: 1, outcome: "within-limit" }, parentArtifactId: null, description: null,
} as const;

describe("M1E capture and projection contracts", () => {
  it("binds every security-relevant manifest core field into a stable digest", () => {
    const one = digestReviewPackageManifest(core);
    const reordered = digestReviewPackageManifest({ ...core, warnings: [] });
    expect(one).toEqual(reordered);
    for (const changed of [
      { ...core, taskId: "task-2" }, { ...core, attemptId: "attempt-2" }, { ...core, warnings: ["redaction applied"] },
      { ...core, completeness: "partial" as const }, { ...core, redaction: "redacted" as const },
      { ...core, artifacts: [{ ...core.artifacts[0], contentHash: `sha256:${"b".repeat(64)}` }] },
    ]) expect(digestReviewPackageManifest(changed)).not.toEqual(one);
    if (one.ok) expect(verifyReviewPackageManifest({ ...core, manifestDigest: one.value })).toMatchObject({ ok: true });
  });

  it("preserves ordered artifact arrays and rejects malformed, duplicate, or mismatched manifests", () => {
    const twoArtifacts = { ...core, artifacts: [...core.artifacts, { artifactId: "artifact-2", contentHash: `sha256:${"b".repeat(64)}`, disposition: "omitted" as const }] };
    expect(digestReviewPackageManifest(twoArtifacts)).not.toEqual(digestReviewPackageManifest({ ...twoArtifacts, artifacts: [...twoArtifacts.artifacts].reverse() }));
    expect(parseReviewPackageManifest({ ...core, manifestDigest: hash, extra: true })).toMatchObject({ ok: false });
    expect(digestReviewPackageManifest({ ...core, artifacts: [core.artifacts[0], core.artifacts[0]] })).toMatchObject({ ok: false });
    expect(verifyReviewPackageManifest({ ...core, manifestDigest: hash })).toEqual({ ok: false, code: "HASH_MISMATCH" });
  });

  it("honestly distinguishes owner-attested imports from automated evidence", () => {
    const base = { captureVersion: "1.0", captureId: "capture-1", taskId: "task-1", attemptId: "attempt-1", operationId: null, approvalId: null, capturedAt: "2026-07-20T00:00:00Z", artifactId: "artifact-1" };
    expect(parseCaptureRecord({ ...base, kind: "manual-import", evidenceClass: "owner-attested", provenance: manual })).toMatchObject({ ok: true });
    expect(parseCaptureRecord({ ...base, kind: "manual-import", evidenceClass: "owner-attested", provenance: automated })).toMatchObject({ ok: false });
    expect(parseCaptureRecord({ ...base, kind: "test", evidenceClass: "validated", provenance: automated })).toMatchObject({ ok: true });
    expect(parseCaptureRecord({ ...base, kind: "command", evidenceClass: "worker-claim", provenance: manual })).toMatchObject({ ok: false });
  });

  it("accepts zero-byte artifacts but enforces portable metadata, retention and quota policy", () => {
    expect(parseArtifactMetadata(artifact)).toMatchObject({ ok: true });
    expect(parseArtifactMetadata({ ...artifact, label: "../secret.txt" })).toMatchObject({ ok: false });
    expect(parseArtifactMetadata({ ...artifact, label: "C:\\owner\\secret.txt" })).toMatchObject({ ok: false });
    expect(parseArtifactMetadata({ ...artifact, contentHash: hash.toUpperCase() })).toMatchObject({ ok: false });
    expect(parseArtifactMetadata({ ...artifact, byteLength: 101 })).toMatchObject({ ok: false });
    expect(parseArtifactMetadata({ ...artifact, retentionClass: "hold", expiresAt: null })).toMatchObject({ ok: true });
    expect(parseArtifactMetadata({ ...artifact, retentionClass: "hold" })).toMatchObject({ ok: false });
  });

  it("serializes only deterministic non-authoritative safe front matter", () => {
    const frontMatter = { projectionVersion: "1.0", nonAuthoritative: true, taskId: "task-1", attemptId: "attempt-1", projectId: "pilot", state: "RESULT_CAPTURED", createdAt: "2026-07-20T00:00:00Z", provenanceMode: "automated", approvalIds: [], artifactIds: [], reviewId: null, validation: "validated", redaction: "redacted", warnings: [], redactionCount: 1 } as const;
    expect(serializeBridgeLogFrontMatter(frontMatter)).toEqual(serializeBridgeLogFrontMatter({ ...frontMatter, warnings: [] }));
    expect(serializeBridgeLogFrontMatter({ ...frontMatter, command: "unsafe" })).toMatchObject({ ok: false });
    expect(serializeBridgeLogFrontMatter({ ...frontMatter, warnings: ["!!python/object"] })).toMatchObject({ ok: false });
  });

  it("is hostile-input total and bounded before canonical hashing", () => {
    const hostile = new Proxy({}, { get() { throw new Error("secret exception"); }, ownKeys() { throw new Error("secret exception"); } });
    expect(() => parseCaptureRecord(hostile)).not.toThrow();
    expect(() => parseArtifactMetadata(hostile)).not.toThrow();
    expect(() => serializeBridgeLogFrontMatter(hostile)).not.toThrow();
    expect(() => digestReviewPackageManifest(hostile)).not.toThrow();
    expect(digestReviewPackageManifest({ ...core, warnings: Array.from({ length: CAPTURE_LIMITS.maxNotes + 1 }, () => "x") })).toMatchObject({ ok: false });
  });
});
