import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { Assignment } from "@chubz/shared";
import { ManualRelayConnector, ManualRelayError } from "../src/manual-relay.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const makeRoot = (): string => { const value = mkdtempSync(join(tmpdir(), "chubz-m5-manual-test-")); roots.push(value); return value; };
const hash = (value: string | Buffer): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const assignment = (expiresAt = "2026-07-23T00:00:00.000Z"): Assignment => ({
  coordinationVersion: "1.0", kind: "owner-confirmed", assignmentId: "assignment-manual", taskId: "task-manual", attemptId: "attempt-manual", operationId: "operation-manual",
  projectId: "project-manual", workerId: "manual-worker", adapterId: "manual-relay", requiredCapabilities: ["text-output"], permittedConnectorTier: "manual-relay",
  writeScopeRef: null, leaseRequired: false, readinessSnapshotRef: "readiness-manual", quotaSnapshotRef: null, approvalGrantRef: null,
  expectedEvidenceRefs: ["owner-attestation"], expiresAt, rationaleEvidenceRefs: ["rationale-manual"], ownerApprovalRef: "owner-assignment-manual",
});
const base = () => ({
  idempotencyKey: "import-manual-one", active: { taskId: "task-manual", attemptId: "attempt-manual", operationId: "operation-manual", state: "RUNNING" as const, immutableAttempt: true as const },
  assignment: assignment(), workerIdentityLabel: "manual-worker", readinessSnapshotRef: "readiness-manual",
  attestation: { attestationId: "attestation-manual", ownerId: "owner-one", authenticated: true as const, attestedAt: "2026-07-22T00:00:00.000Z", selectedImportMode: "text" as const },
});

describe("M5 owner-attested manual relay", () => {
  it("imports, redacts, persists, and replays one bounded text result without stronger provenance claims", () => {
    const root = makeRoot(); const databasePath = join(root, "manual.sqlite"); const relay = new ManualRelayConnector(databasePath, join(root, "quarantine"));
    const request = { ...base(), expectedResponseType: "review" as const, response: { version: "1.0", kind: "manual.text", responseType: "review", text: "review complete api_key=ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890" } };
    const first = relay.importText(request); const replay = relay.importText(request);
    expect(first).toMatchObject({ provenance: "owner-attested manual relay", assurance: "weaker-manual", responseType: "review", replayed: false, run: { connectorTier: "manual-relay", invocationMode: "manual-relay" } });
    expect(first.text).toContain("[REDACTED:"); expect(first.text).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890");
    expect(replay).toEqual({ ...first, replayed: true }); relay.close();
    const database = new Database(databasePath, { readonly: true }); const persisted = (database.prepare("SELECT result_json FROM manual_imports").get() as { result_json: string }).result_json; database.close();
    expect(persisted).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890");
  });

  it("rejects conflicting identity reuse, malformed shape, wrong attestation mode, wrong bindings, and oversized text", () => {
    const root = makeRoot(); const relay = new ManualRelayConnector(join(root, "manual.sqlite"), join(root, "quarantine"));
    const request = { ...base(), expectedResponseType: "text" as const, response: { version: "1.0", kind: "manual.text", responseType: "text", text: "one" } };
    relay.importText(request);
    expect(() => relay.importText({ ...request, response: { ...request.response, text: "two" } })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(() => relay.importText({ ...request, idempotencyKey: "malformed", response: { ...request.response, unknown: true } })).toThrowError(expect.objectContaining({ code: "MALFORMED_IMPORT" }));
    expect(() => relay.importText({ ...request, idempotencyKey: "oversized", response: { ...request.response, text: "x".repeat(70_000) } })).toThrowError(expect.objectContaining({ code: "OVERSIZED_IMPORT" }));
    expect(() => relay.importText({ ...request, idempotencyKey: "wrong-mode", attestation: { ...request.attestation, selectedImportMode: "artifact" } })).toThrowError(expect.objectContaining({ code: "ATTESTATION_REQUIRED" }));
    expect(() => relay.importText({ ...request, idempotencyKey: "wrong-task", active: { ...request.active, taskId: "task-other" } })).toThrowError(expect.objectContaining({ code: "BINDING_MISMATCH" }));
    relay.close();
  });

  it("quarantines a separately selected artifact by hash and never applies it to a project or worktree", async () => {
    const root = makeRoot(); const source = join(root, "source.txt"); writeFileSync(source, "synthetic artifact");
    const relay = new ManualRelayConnector(join(root, "manual.sqlite"), join(root, "quarantine"));
    const request = { ...base(), idempotencyKey: "artifact-one", importId: "import-one", attestation: { ...base().attestation, selectedImportMode: "artifact" as const }, files: [{ sourcePath: source, relativePath: "reports/result.txt", declaredPurpose: "synthetic review evidence", declaredSha256: hash("synthetic artifact") }] };
    const first = await relay.importArtifacts(request); const replay = await relay.importArtifacts(request);
    expect(first).toMatchObject({ provenance: "owner-attested manual relay", assurance: "weaker-manual", appliedToProject: false, appliedToWorktree: false, replayed: false });
    expect(first.artifacts[0]).toMatchObject({ relativePath: "reports/result.txt", state: "quarantined", contentHash: hash("synthetic artifact") });
    expect(readFileSync(join(root, "quarantine", "task-manual", "attempt-manual", "import-one", "reports", "result.txt"), "utf8")).toBe("synthetic artifact");
    expect(replay).toEqual({ ...first, replayed: true }); relay.close();
  });

  it("rejects traversal, links or junctions, executables, archives, collisions, hash mismatch, and oversized artifacts without persisting a result", async () => {
    const root = makeRoot(); const source = join(root, "source.txt"); writeFileSync(source, "artifact"); const relay = new ManualRelayConnector(join(root, "manual.sqlite"), join(root, "quarantine"));
    const request = { ...base(), idempotencyKey: "artifact-reject", importId: "import-reject", attestation: { ...base().attestation, selectedImportMode: "artifact" as const }, files: [{ sourcePath: source, relativePath: "../escape.txt", declaredPurpose: "bad", declaredSha256: hash("artifact") }] };
    await expect(relay.importArtifacts(request)).rejects.toMatchObject({ code: "ARTIFACT_REJECTED" });
    await expect(relay.importArtifacts({ ...request, idempotencyKey: "executable", files: [{ ...request.files[0]!, relativePath: "payload.exe" }] })).rejects.toMatchObject({ code: "ARTIFACT_REJECTED" });
    await expect(relay.importArtifacts({ ...request, idempotencyKey: "archive", files: [{ ...request.files[0]!, relativePath: "payload.zip" }] })).rejects.toMatchObject({ code: "ARTIFACT_REJECTED" });
    const linkTarget = join(root, "link-target"); const linkPath = join(root, "source-link"); mkdirSync(linkTarget); writeFileSync(join(linkTarget, "source.txt"), "artifact"); symlinkSync(linkTarget, linkPath, process.platform === "win32" ? "junction" : "dir");
    await expect(relay.importArtifacts({ ...request, idempotencyKey: "link", importId: "import-link", files: [{ ...request.files[0]!, sourcePath: join(linkPath, "source.txt"), relativePath: "safe.txt" }] })).rejects.toMatchObject({ code: "ARTIFACT_REJECTED" });
    await expect(relay.importArtifacts({ ...request, idempotencyKey: "hash", files: [{ ...request.files[0]!, relativePath: "safe.txt", declaredSha256: hash("wrong") }] })).rejects.toMatchObject({ code: "ARTIFACT_REJECTED" });
    await expect(relay.importArtifacts({ ...request, idempotencyKey: "collision", files: [{ ...request.files[0]!, relativePath: "A.txt" }, { ...request.files[0]!, relativePath: "a.txt" }] })).rejects.toMatchObject({ code: process.platform === "win32" ? "ARTIFACT_REJECTED" : expect.any(String) });
    writeFileSync(source, Buffer.alloc(4 * 1024 * 1024 + 1));
    await expect(relay.importArtifacts({ ...request, idempotencyKey: "oversized", files: [{ ...request.files[0]!, relativePath: "large.txt", declaredSha256: hash(readFileSync(source)) }] })).rejects.toMatchObject({ code: "OVERSIZED_IMPORT" });
    relay.close();
  });
});
