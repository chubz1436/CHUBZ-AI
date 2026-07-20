import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeForDigest } from "../src/protocol/digest-internal.js";
import {
  APPROVAL_ACTION_VERSION,
  APPROVAL_PROOF_VERSION,
  APPROVAL_SECURITY_LIMITS,
  CapabilityGrantSchema,
  classifyGrantConsumption,
  digestApprovalAction,
  parseApprovalAction,
  parseApprovalProof,
  type ApprovalAction,
  type CapabilityGrant,
  type GrantAuthenticationVerifier,
  verifyApprovalProofBinding,
  verifyCapabilityGrant,
} from "../src/index.js";

type WorkspacePrepareAction = Extract<ApprovalAction, { operation: "workspace.prepare" }>;

const KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
const KEY_ID = "phase1-key-01";

/** Test-only runtime boundary; raw test key material never crosses the shared API. */
const AUTHENTICATOR: GrantAuthenticationVerifier = {
  verify: ({ algorithm, keyId, payload, signature }) => {
    if (algorithm !== "hmac-sha256" || keyId !== KEY_ID) return false;
    const expected = createHmac("sha256", KEY).update(payload, "utf8").digest();
    return expected.length === signature.length && timingSafeEqual(expected, signature);
  },
};

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

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const mutateSignature = (signature: string, offset: number): string => {
  const last = signature.at(-1);
  if (last === undefined) throw new Error("signature unexpectedly empty");
  const index = BASE64URL_ALPHABET.indexOf(last);
  if (index < 0) throw new Error("signature has an invalid alphabet character");
  return `${signature.slice(0, -1)}${BASE64URL_ALPHABET[(index + offset) % 64]}`;
};

const workerDispatchAction = (manifestVersion: string) => ({
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
    worker: { manifestId: "codex", manifestVersion },
    instructionDigest: `sha256:${"c".repeat(64)}`,
    contextArtifactIds: [],
  },
  constraints: { timeoutSec: 120, requiresCleanWorktree: true, expectedArtifactId: null },
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

  it("bounds worker manifest versions while preserving normal semver core values", () => {
    const max = `${"9".repeat(10)}.${"8".repeat(10)}.${"7".repeat(10)}`;
    expect(max).toHaveLength(APPROVAL_SECURITY_LIMITS.maxManifestVersionLength);
    expect(parseApprovalAction(workerDispatchAction(max)).ok).toBe(true);
    expect(parseApprovalAction(workerDispatchAction(`${max}0`)).ok).toBe(false);
    expect(parseApprovalAction(workerDispatchAction(`${"1".repeat(10_000)}.0.0`)).ok).toBe(false);
    expect(parseApprovalAction(workerDispatchAction("1..0")).ok).toBe(false);
    expect(parseApprovalAction(workerDispatchAction("1.0.x")).ok).toBe(false);
    expect(parseApprovalAction(workerDispatchAction("1.0.0")).ok).toBe(true);
  });
});

describe("M1C capability grants", () => {
  it("verifies a correctly authenticated, exact, unconsumed grant", () => {
    const actionDigest = digest(action());
    const result = verifyCapabilityGrant(signedGrant(actionDigest), expectation(actionDigest), AUTHENTICATOR);
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
      const result = verifyCapabilityGrant(grant, expectation(actionDigest, { now }), AUTHENTICATOR);
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
      const result = verifyCapabilityGrant(grant, expectation(actionDigest, override), AUTHENTICATOR);
      expect(result.ok ? result.code : result.code).toBe(code);
    }
    const tampered = { ...grant, taskId: "task-43" };
    expect(verifyCapabilityGrant(tampered, expectation(actionDigest, { taskId: "task-43" }), AUTHENTICATOR)).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    const malformed = { ...grant, authentication: { ...grant.authentication, signature: "*" } };
    expect(verifyCapabilityGrant(malformed, expectation(actionDigest), AUTHENTICATOR)).toMatchObject({ code: "MALFORMED_GRANT" });
    const consumed = { grantId: grant.grantId, actionDigest, operationId: grant.operationId, consumedAt: "2026-07-20T10:05:00Z", outcomeRef: "result-01" };
    expect(verifyCapabilityGrant(grant, expectation(actionDigest), AUTHENTICATOR, consumed)).toMatchObject({ code: "ALREADY_CONSUMED" });
    expect(classifyGrantConsumption(grant.grantId, actionDigest, consumed)).toBe("duplicate-delivery");
    expect(classifyGrantConsumption(grant.grantId, actionDigest, undefined)).toBe("eligible");
    const throwingConsumption = new Proxy({}, { get: () => { throw new Error("hostile"); } });
    expect(() => classifyGrantConsumption(grant.grantId, actionDigest, throwingConsumption)).not.toThrow();
    expect(classifyGrantConsumption(grant.grantId, actionDigest, throwingConsumption)).toBe("eligible");
    expect(verifyCapabilityGrant({ ...grant, grantVersion: "2.0" }, expectation(actionDigest), AUTHENTICATOR)).toMatchObject({ code: "UNSUPPORTED_VERSION" });
  });

  it("accepts only canonical HMAC-SHA-256 signature encodings", () => {
    const actionDigest = digest(action());
    const grant = signedGrant(actionDigest);
    expect(verifyCapabilityGrant(grant, expectation(actionDigest), AUTHENTICATOR)).toMatchObject({ code: "VALID" });

    const nonCanonicalTrailingBits = mutateSignature(grant.authentication.signature, 1);
    const tamperedCanonical = mutateSignature(grant.authentication.signature, 4);
    const signatures = [
      nonCanonicalTrailingBits,
      `${grant.authentication.signature}=`,
      grant.authentication.signature.slice(1),
      `${grant.authentication.signature}A`,
      "*".repeat(43),
    ];
    for (const signature of signatures) {
      expect(
        verifyCapabilityGrant(
          { ...grant, authentication: { ...grant.authentication, signature } },
          expectation(actionDigest),
          AUTHENTICATOR,
        ),
      ).toMatchObject({ code: "MALFORMED_GRANT" });
    }
    expect(
      verifyCapabilityGrant(
        { ...grant, authentication: { ...grant.authentication, signature: tamperedCanonical } },
        expectation(actionDigest),
        AUTHENTICATOR,
      ),
    ).toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("keeps verifier inputs total for throwing expectation and authenticator objects", () => {
    const actionDigest = digest(action());
    const grant = signedGrant(actionDigest);
    const throwingExpectation = new Proxy({}, { get: () => { throw new Error("hostile"); } });
    const throwingAuthenticator = new Proxy({}, { get: () => { throw new Error("hostile"); } });
    expect(() => verifyCapabilityGrant(grant, throwingExpectation, AUTHENTICATOR)).not.toThrow();
    expect(verifyCapabilityGrant(grant, throwingExpectation, AUTHENTICATOR)).toMatchObject({ code: "INVALID_EXPECTATION" });
    expect(() => verifyCapabilityGrant(grant, expectation(actionDigest), throwingAuthenticator)).not.toThrow();
    expect(verifyCapabilityGrant(grant, expectation(actionDigest), throwingAuthenticator)).toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("keeps raw key material out of serialized grant contracts", () => {
    const actionDigest = digest(action());
    const grant = signedGrant(actionDigest);
    expect(CapabilityGrantSchema.safeParse({ ...grant, secret: "not-a-contract-field" }).success).toBe(false);
    expect(
      CapabilityGrantSchema.safeParse({
        ...grant,
        authentication: { ...grant.authentication, secret: "not-a-contract-field" },
      }).success,
    ).toBe(false);
  });
});

describe("M1C Phase-2 proof binding", () => {
  const challenge = (actionDigest: string, overrides: Record<string, unknown> = {}) => ({
    proofVersion: APPROVAL_PROOF_VERSION,
    challengeId: "challenge-01",
    challengeDigest: `sha256:${"d".repeat(64)}`,
    actionDigest,
    taskId: "task-42",
    attemptId: "attempt-1",
    operationId: "op-prepare-1",
    intendedVerifier: "bridge-01",
    issuedAt: "2026-07-20T10:00:00Z",
    expiresAt: "2026-07-20T10:05:00Z",
    ...overrides,
  });
  const proof = (actionDigest: string, overrides: Record<string, unknown> = {}) => ({
    proofVersion: APPROVAL_PROOF_VERSION,
    proofId: "proof-01",
    challengeId: "challenge-01",
    challengeDigest: `sha256:${"d".repeat(64)}`,
    actionDigest,
    taskId: "task-42",
    attemptId: "attempt-1",
    operationId: "op-prepare-1",
    intendedVerifier: "bridge-01",
    issuedAt: "2026-07-20T10:00:00Z",
    expiresAt: "2026-07-20T10:05:00Z",
    ownerPresence: "present",
    ownerVerification: "verified",
    assertion: {
      format: "webauthn-assertion-v1",
      credentialId: "a".repeat(43),
      authenticatorDataDigest: `sha256:${"a".repeat(64)}`,
      clientDataDigest: `sha256:${"b".repeat(64)}`,
      clientDataChallengeDigest: `sha256:${"d".repeat(64)}`,
      signature: "c".repeat(86),
    },
    ...overrides,
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

  it("binds verifier, nonce digest, challenge identity, and client-data evidence", () => {
    const actionDigest = digest(action());
    const alternateDigest = `sha256:${"e".repeat(64)}`;
    expect(
      verifyApprovalProofBinding(
        proof(actionDigest, { intendedVerifier: "bridge-02" }),
        challenge(actionDigest),
        "2026-07-20T10:02:00Z",
      ),
    ).toMatchObject({ code: "WRONG_INTENDED_VERIFIER" });
    expect(
      verifyApprovalProofBinding(
        proof(actionDigest, { challengeDigest: alternateDigest }),
        challenge(actionDigest),
        "2026-07-20T10:02:00Z",
      ),
    ).toMatchObject({ code: "CHALLENGE_DIGEST_MISMATCH" });
    expect(
      verifyApprovalProofBinding(
        proof(actionDigest, {
          assertion: {
            ...proof(actionDigest).assertion,
            clientDataChallengeDigest: alternateDigest,
          },
        }),
        challenge(actionDigest),
        "2026-07-20T10:02:00Z",
      ),
    ).toMatchObject({ code: "CLIENT_DATA_CHALLENGE_MISMATCH" });
    expect(
      verifyApprovalProofBinding(
        proof(actionDigest, { challengeId: "challenge-02" }),
        challenge(actionDigest),
        "2026-07-20T10:02:00Z",
      ),
    ).toMatchObject({ code: "CHALLENGE_MISMATCH" });
    const otherActionDigest = digest({ ...action(), constraints: { timeoutSec: 121, requiresCleanWorktree: true, expectedArtifactId: null } });
    expect(
      verifyApprovalProofBinding(proof(actionDigest), challenge(otherActionDigest), "2026-07-20T10:02:00Z"),
    ).toMatchObject({ code: "ACTION_HASH_MISMATCH" });
  });

  it("keeps proof and challenge verification total for hostile inputs", () => {
    const actionDigest = digest(action());
    const throwing = new Proxy({}, { get: () => { throw new Error("hostile"); } });
    expect(() => verifyApprovalProofBinding(throwing, challenge(actionDigest), "2026-07-20T10:02:00Z")).not.toThrow();
    expect(verifyApprovalProofBinding(throwing, challenge(actionDigest), "2026-07-20T10:02:00Z")).toMatchObject({ code: "MALFORMED_PROOF" });
    expect(() => verifyApprovalProofBinding(proof(actionDigest), throwing, "2026-07-20T10:02:00Z")).not.toThrow();
    expect(verifyApprovalProofBinding(proof(actionDigest), throwing, "2026-07-20T10:02:00Z")).toMatchObject({ code: "MALFORMED_CHALLENGE" });
  });
});
