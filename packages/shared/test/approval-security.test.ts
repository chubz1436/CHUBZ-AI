import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeForDigest } from "../src/protocol/digest-internal.js";
import {
  APPROVAL_ACTION_VERSION,
  APPROVAL_PROOF_VERSION,
  CapabilityGrantSchema,
  classifyGrantConsumption,
  digestApprovalAction,
  parseApprovalAction,
  parseApprovalProof,
  type ApprovalAction,
  type CapabilityGrant,
  verifyApprovalProofBinding,
  verifyCapabilityGrant,
} from "../src/index.js";

type WorkspacePrepareAction = Extract<ApprovalAction, { operation: "workspace.prepare" }>;

const KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
const KEY_ID = "phase1-key-01";

const action = (overrides: Partial<WorkspacePrepareAction> = {}): WorkspacePrepareAction => ({
  actionVersion: APPROVAL_ACTION_VERSION,
  taskId: "task-42",
  attemptId: "attempt-1",
  operationId: "op-prepare-1",
  operation: "workspace.prepare",
  policyClass: "workspace-write",
  target: { kind: "workspace", resourceId: "workspace-42" },
  parameters: { projectId: "pilot-project", workspaceId: "workspace-42", baseRef: null },
  constraints: { timeoutSec: 120, requiresCleanWorktree: true, expectedArtifactId: null },
  ...overrides,
});

const digest = (value: unknown): string => {
  const result = digestApprovalAction(value);
  if (!result.ok) throw new Error(`expected digest, got ${result.error.code}`);
  return result.value;
};

const grantPayload = (grant: CapabilityGrant): string =>
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

const signedGrant = (actionDigest: string, overrides: Partial<CapabilityGrant> = {}): CapabilityGrant => {
  const unsigned = {
    grantVersion: "1.0",
    grantId: "grant-0001",
    taskId: "task-42",
    attemptId: "attempt-1",
    operationId: "op-prepare-1",
    actionDigest,
    issuedAt: "2026-07-20T10:00:00Z",
    notBefore: "2026-07-20T10:00:00Z",
    expiresAt: "2026-07-20T10:10:00Z",
    singleUse: true,
    issuer: { kind: "control-plane", issuerId: "control-plane-01" },
    approval: { approvalId: "approval-01", mode: "phase1-local" },
    intendedVerifier: "bridge-01",
    authentication: { algorithm: "hmac-sha256", keyId: KEY_ID, signature: "A".repeat(43) },
    ...overrides,
  } satisfies CapabilityGrant;
  const signature = createHmac("sha256", KEY).update(grantPayload(unsigned), "utf8").digest("base64url");
  const complete: CapabilityGrant = {
    ...unsigned,
    authentication: { ...unsigned.authentication, signature },
  };
  expect(CapabilityGrantSchema.safeParse(complete).success).toBe(true);
  return complete;
};

const expectation = (actionDigest: string, overrides: Record<string, unknown> = {}) => ({
  actionDigest,
  taskId: "task-42",
  attemptId: "attempt-1",
  operationId: "op-prepare-1",
  intendedVerifier: "bridge-01",
  now: "2026-07-20T10:05:00Z",
  ...overrides,
});

describe("M1C approval action hashing", () => {
  it("is deterministic regardless of property insertion order", () => {
    const first = action();
    const second = {
      constraints: { expectedArtifactId: null, requiresCleanWorktree: true, timeoutSec: 120 },
      parameters: { baseRef: null, workspaceId: "workspace-42", projectId: "pilot-project" },
      target: { resourceId: "workspace-42", kind: "workspace" },
      policyClass: "workspace-write",
      operation: "workspace.prepare",
      operationId: "op-prepare-1",
      attemptId: "attempt-1",
      taskId: "task-42",
      actionVersion: "1.0",
    };
    expect(digest(first)).toBe(digest(second));
  });

  it("changes when a bound identity, target, or security-relevant parameter changes", () => {
    const original = digest(action());
    const variants: unknown[] = [
      action({ taskId: "task-43" }),
      action({ attemptId: "attempt-2" }),
      action({ operationId: "op-prepare-2" }),
      { ...action(), target: { kind: "workspace", resourceId: "workspace-99" }, parameters: { projectId: "pilot-project", workspaceId: "workspace-99", baseRef: null } },
      { ...action(), constraints: { timeoutSec: 121, requiresCleanWorktree: true, expectedArtifactId: null } },
      {
        actionVersion: "1.0",
        taskId: "task-42",
        attemptId: "attempt-1",
        operationId: "op-dispatch-1",
        operation: "worker.dispatch",
        policyClass: "worker-execution",
        target: { kind: "worker", resourceId: "codex" },
        parameters: {
          projectId: "pilot-project",
          workspaceId: "workspace-42",
          worker: { manifestId: "codex", manifestVersion: "1.0.0" },
          instructionDigest: `sha256:${"c".repeat(64)}`,
          contextArtifactIds: [],
        },
        constraints: { timeoutSec: 120, requiresCleanWorktree: true, expectedArtifactId: null },
      },
    ];
    for (const variant of variants) expect(digest(variant)).not.toBe(original);
  });

  it("rejects unknown fields, versions, malformed values, and hostile inputs without throwing", () => {
    const C = String.fromCharCode;
    const hostile = [
      { ...action(), extra: "smuggled" },
      { ...action(), actionVersion: "9.9" },
      { ...action(), taskId: "" },
      { ...action(), taskId: `bad${C(0)}id` },
      { ...action(), parameters: { projectId: "pilot-project", workspaceId: `x${C(133)}`, baseRef: null } },
      { taskId: "task-42", actionVersion: "1.0" },
      null,
      [action()],
    ];
    for (const value of hostile) {
      let result: ReturnType<typeof parseApprovalAction> | undefined;
      expect(() => {
        result = parseApprovalAction(value);
      }).not.toThrow();
      expect(result?.ok).toBe(false);
      if (result?.ok === false) expect(/[\u0000-\u001F\u007F-\u009F]/.test(result.error.message)).toBe(false);
    }
  });

  it("holds empty/max-boundary and Unicode confusable identifiers to the strict ASCII identity grammar", () => {
    const max = `a${"b".repeat(127)}`;
    const maxAction = {
      ...action(),
      target: { kind: "workspace", resourceId: max },
      parameters: { projectId: "pilot-project", workspaceId: max, baseRef: null },
    };
    expect(parseApprovalAction(maxAction).ok).toBe(true);
    expect(parseApprovalAction({ ...action(), taskId: "" }).ok).toBe(false);
    // Cyrillic 'a' is visually similar to Latin 'a' but is not a valid trusted identifier.
    expect(parseApprovalAction({ ...action(), taskId: "t\u0430sk-42" }).ok).toBe(false);
  });
});

describe("M1C capability grants", () => {
  it("verifies a correctly authenticated, exact, unconsumed grant", () => {
    const actionDigest = digest(action());
    const result = verifyCapabilityGrant(signedGrant(actionDigest), expectation(actionDigest), { keyId: KEY_ID, secret: KEY });
    expect(result.ok && result.code).toBe("VALID");
  });

  it("uses an exclusive expiry boundary without timing sleeps", () => {
    const actionDigest = digest(action());
    const grant = signedGrant(actionDigest);
    for (const [now, code] of [
      ["2026-07-20T09:59:59Z", "NOT_YET_VALID"],
      ["2026-07-20T10:10:00Z", "EXPIRED"],
      ["2026-07-20T10:10:01Z", "EXPIRED"],
    ] as const) {
      const result = verifyCapabilityGrant(grant, expectation(actionDigest, { now }), { keyId: KEY_ID, secret: KEY });
      expect(result.ok ? result.code : result.code).toBe(code);
    }
  });

  it("fails closed for every binding mismatch, tamper, malformed authentication, and replay", () => {
    const actionDigest = digest(action());
    const grant = signedGrant(actionDigest);
    const checks: Array<[Record<string, unknown>, string]> = [
      [{ actionDigest: digest({ ...action(), constraints: { timeoutSec: 121, requiresCleanWorktree: true, expectedArtifactId: null } }) }, "ACTION_HASH_MISMATCH"],
      [{ taskId: "task-43" }, "TASK_MISMATCH"],
      [{ attemptId: "attempt-2" }, "ATTEMPT_MISMATCH"],
      [{ operationId: "op-prepare-2" }, "OPERATION_MISMATCH"],
      [{ intendedVerifier: "bridge-02" }, "WRONG_INTENDED_VERIFIER"],
    ];
    for (const [override, code] of checks) {
      const result = verifyCapabilityGrant(grant, expectation(actionDigest, override), { keyId: KEY_ID, secret: KEY });
      expect(result.ok ? result.code : result.code).toBe(code);
    }
    const tampered = { ...grant, taskId: "task-43" };
    expect(verifyCapabilityGrant(tampered, expectation(actionDigest, { taskId: "task-43" }), { keyId: KEY_ID, secret: KEY })).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    const malformed = { ...grant, authentication: { ...grant.authentication, signature: "*" } };
    expect(verifyCapabilityGrant(malformed, expectation(actionDigest), { keyId: KEY_ID, secret: KEY })).toMatchObject({ code: "MALFORMED_GRANT" });
    const consumed = { grantId: grant.grantId, actionDigest, operationId: grant.operationId, consumedAt: "2026-07-20T10:05:00Z", outcomeRef: "result-01" };
    expect(verifyCapabilityGrant(grant, expectation(actionDigest), { keyId: KEY_ID, secret: KEY }, consumed)).toMatchObject({ code: "ALREADY_CONSUMED" });
    expect(classifyGrantConsumption(grant.grantId, actionDigest, consumed)).toBe("duplicate-delivery");
    expect(classifyGrantConsumption(grant.grantId, actionDigest, undefined)).toBe("eligible");
    expect(verifyCapabilityGrant({ ...grant, grantVersion: "2.0" }, expectation(actionDigest), { keyId: KEY_ID, secret: KEY })).toMatchObject({ code: "UNSUPPORTED_VERSION" });
  });
});

describe("M1C Phase-2 proof binding", () => {
  const challenge = (actionDigest: string) => ({
    proofVersion: APPROVAL_PROOF_VERSION,
    challengeId: "challenge-01",
    actionDigest,
    taskId: "task-42",
    attemptId: "attempt-1",
    operationId: "op-prepare-1",
    intendedVerifier: "bridge-01",
    issuedAt: "2026-07-20T10:00:00Z",
    expiresAt: "2026-07-20T10:05:00Z",
  });
  const proof = (actionDigest: string) => ({
    proofVersion: APPROVAL_PROOF_VERSION,
    proofId: "proof-01",
    challengeId: "challenge-01",
    actionDigest,
    taskId: "task-42",
    attemptId: "attempt-1",
    operationId: "op-prepare-1",
    issuedAt: "2026-07-20T10:00:00Z",
    expiresAt: "2026-07-20T10:05:00Z",
    ownerPresence: "present",
    ownerVerification: "verified",
    assertion: {
      format: "webauthn-assertion-v1",
      credentialId: "a".repeat(43),
      authenticatorDataDigest: `sha256:${"a".repeat(64)}`,
      clientDataDigest: `sha256:${"b".repeat(64)}`,
      signature: "c".repeat(86),
    },
  });

  it("binds proof freshness and action exactly, preventing an action-reuse attempt", () => {
    const actionDigest = digest(action());
    expect(verifyApprovalProofBinding(proof(actionDigest), challenge(actionDigest), "2026-07-20T10:02:00Z")).toMatchObject({ code: "VALID" });
    const otherActionDigest = digest({ ...action(), constraints: { timeoutSec: 121, requiresCleanWorktree: true, expectedArtifactId: null } });
    expect(verifyApprovalProofBinding(proof(actionDigest), challenge(otherActionDigest), "2026-07-20T10:02:00Z")).toMatchObject({ code: "ACTION_HASH_MISMATCH" });
    expect(verifyApprovalProofBinding(proof(actionDigest), challenge(actionDigest), "2026-07-20T10:05:00Z")).toMatchObject({ code: "EXPIRED" });
    expect(parseApprovalProof({ ...proof(actionDigest), clientText: "approve something else" }).ok).toBe(false);
    expect(parseApprovalProof({ ...proof(actionDigest), proofVersion: "9.0" })).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_PROOF_VERSION" } });
    const C = String.fromCharCode;
    expect(() => parseApprovalProof({ ...proof(actionDigest), proofId: `bad${C(1)}` })).not.toThrow();
  });
});
