import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestApprovalAction, verifyCapabilityGrant, type ApprovalAction } from "@chubz/shared";
import { createTestConfig } from "../src/config.js";
import { ControlPlaneDatabase } from "../src/database.js";
import { deriveApprovalId, Phase1GrantKey, type Clock } from "../src/grant-engine.js";
import { M4Error, M4Orchestrator } from "../src/orchestrator.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) { try { rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* a failed test may still own a SQLite handle */ } } });
class MutableClock implements Clock {
  public constructor(public milliseconds = Date.parse("2026-07-22T04:00:00.000Z")) {}
  public now(): Date { return new Date(this.milliseconds); }
}
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}` as const;
const actionFor = (taskId: string, attemptId: string, operationId: string, projectId: string, text: string, timeoutSec = 5): ApprovalAction => ({
  actionVersion: "1.0", taskId, attemptId, operationId, operation: "worker.dispatch", policyClass: "worker-execution",
  target: { kind: "worker", resourceId: "synthetic-echo-worker" },
  parameters: { projectId, workspaceId: `workspace-${taskId}`, worker: { manifestId: "synthetic-echo-worker", manifestVersion: "1.0.0" }, instructionDigest: hash(text), contextArtifactIds: [] },
  constraints: { timeoutSec, requiresCleanWorktree: true, expectedArtifactId: null },
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "chubz-m4-control-test-")); roots.push(root);
  const database = new ControlPlaneDatabase(createTestConfig(root));
  const clock = new MutableClock();
  const key = new Phase1GrantKey("phase1-test-key", Buffer.alloc(32, 7));
  const orchestrator = new M4Orchestrator(database, key, clock);
  return { root, database, clock, key, orchestrator };
};
const errorCode = (run: () => unknown): string => { try { run(); } catch (error) { return error instanceof M4Error ? error.code : String(error); } throw new Error("expected operation to fail"); };
const provision = (orchestrator: M4Orchestrator, clock: MutableClock, suffix: string, projectId = `project-${suffix}`) => {
  const taskId = `task-${suffix}`; const attemptId = `attempt-${suffix}`; const operationId = `operation-${suffix}`; const text = `echo-${suffix}`;
  const action = actionFor(taskId, attemptId, operationId, projectId, text);
  orchestrator.createTask(`create-${suffix}`, { taskId, projectId });
  orchestrator.createAttempt(`attempt-command-${suffix}`, { taskId, attemptId, action, taskInput: text });
  orchestrator.activateAttempt(taskId, "owner-one");
  const assigned = orchestrator.assignEcho(`assign-${suffix}`, { taskId, attemptId, assignmentId: `assignment-${suffix}`, scopeId: `scope-${suffix}`, leaseId: `lease-${suffix}`, ownerAssignmentRef: `assignment-approval-${suffix}`, leaseExpiresAt: new Date(clock.milliseconds + 600_000).toISOString() });
  return { taskId, attemptId, operationId, text, action, projectId, scopeHash: assigned.scopeHash };
};
const approve = (orchestrator: M4Orchestrator, ids: ReturnType<typeof provision>, suffix: string) => {
  const digest = digestApprovalAction(ids.action); if (!digest.ok) throw new Error("action digest failed");
  const approvalId = deriveApprovalId({ ownerId: "owner-one", taskId: ids.taskId, attemptId: ids.attemptId, operationId: ids.operationId, actionDigest: digest.value, scopeHash: ids.scopeHash, workerId: "synthetic-echo-worker", adapterId: "synthetic-echo-adapter" });
  return orchestrator.approveAndIssue(`issue-${suffix}`, { taskId: ids.taskId, attemptId: ids.attemptId, ownerId: "owner-one", approvalId, grantId: `grant-${suffix}`, issuerId: "control-plane-one", lifetimeMs: 300_000 });
};

describe("M4 Phase-1 grant engine", () => {
  it("signs the accepted canonical grant and fails closed for mutation, wrong key, and the exact expiry boundary", () => {
    const clock = new MutableClock(); const key = new Phase1GrantKey("key-one", Buffer.alloc(32, 1)); const other = new Phase1GrantKey("key-one", Buffer.alloc(32, 2));
    const grant = key.issue({ grantId: "grant-one", taskId: "task-one", attemptId: "attempt-one", operationId: "operation-one", actionDigest: hash("action"), issuerId: "issuer-one", approvalId: "approval-one", intendedVerifier: "local-bridge", lifetimeMs: 1_000 }, clock);
    const expected = { actionDigest: grant.actionDigest, taskId: grant.taskId, attemptId: grant.attemptId, operationId: grant.operationId, intendedVerifier: "local-bridge", now: clock.now().toISOString() };
    expect(verifyCapabilityGrant(grant, expected, key.verifier())).toMatchObject({ ok: true, code: "VALID" });
    expect(verifyCapabilityGrant(grant, expected, other.verifier())).toEqual({ ok: false, code: "AUTHENTICATION_FAILED" });
    expect(verifyCapabilityGrant({ ...grant, taskId: "task-two" }, { ...expected, taskId: "task-two" }, key.verifier())).toEqual({ ok: false, code: "AUTHENTICATION_FAILED" });
    clock.milliseconds += 1_000;
    expect(verifyCapabilityGrant(grant, { ...expected, now: clock.now().toISOString() }, key.verifier())).toEqual({ ok: false, code: "EXPIRED" });
    key.destroy(); other.destroy();
  });

  it("rejects malformed and unknown-version grants without exposing key material", () => {
    const key = new Phase1GrantKey("key-one", Buffer.alloc(32, 3));
    const expected = { actionDigest: hash("x"), taskId: "task-one", attemptId: "attempt-one", operationId: "operation-one", intendedVerifier: "local-bridge", now: new Date().toISOString() };
    expect(verifyCapabilityGrant({ grantVersion: "9.0" }, expected, key.verifier())).toEqual({ ok: false, code: "UNSUPPORTED_VERSION" });
    expect(verifyCapabilityGrant({ grantVersion: "1.0" }, expected, key.verifier())).toEqual({ ok: false, code: "MALFORMED_GRANT" });
    key.destroy();
  });
});

describe("persistent M4 orchestration", () => {
  it("persists immutable attempts, legal transition events, and rejects stale or illegal transitions", () => {
    const { database, orchestrator } = fixture(); const ids = provision(orchestrator, new MutableClock(), "state");
    expect(orchestrator.getTask(ids.taskId)).toMatchObject({ state: "AWAITING_DISPATCH", version: 2, attemptId: ids.attemptId });
    expect(() => database.connection.prepare("UPDATE task_attempts SET action_digest='changed' WHERE attempt_id=?").run(ids.attemptId)).toThrow("immutable");
    expect(errorCode(() => orchestrator.transition(ids.taskId, 0, { to: "RUNNING", actor: "control-plane", evidence: ["bridge-dispatch-ack"] }))).toBe("STALE_VERSION");
    expect(errorCode(() => orchestrator.transition(ids.taskId, 2, { to: "RUNNING", actor: "control-plane" }))).toBe("ILLEGAL_TRANSITION");
    expect((database.connection.prepare("SELECT COUNT(*) AS count FROM events WHERE stream_id=?").get(`task-${ids.taskId}`) as { count: number }).count).toBeGreaterThanOrEqual(4);
    database.close();
  });

  it("enforces the approval STOP POINT, idempotent replay, and deterministic conflicting reuse", () => {
    const { database, clock, orchestrator } = fixture(); const ids = provision(orchestrator, clock, "stop");
    expect(errorCode(() => orchestrator.claimNextDispatch())).toBe("QUEUE_EMPTY");
    const issued = approve(orchestrator, ids, "stop"); const replay = approve(orchestrator, ids, "stop");
    expect(replay).toEqual(issued);
    const digest = digestApprovalAction(ids.action); if (!digest.ok) throw new Error("action digest failed");
    const conflictingApprovalId = deriveApprovalId({ ownerId: "owner-two", taskId: ids.taskId, attemptId: ids.attemptId, operationId: ids.operationId, actionDigest: digest.value, scopeHash: ids.scopeHash, workerId: "synthetic-echo-worker", adapterId: "synthetic-echo-adapter" });
    expect(errorCode(() => orchestrator.approveAndIssue("issue-stop", { taskId: ids.taskId, attemptId: ids.attemptId, ownerId: "owner-two", approvalId: conflictingApprovalId, grantId: "grant-stop", issuerId: "control-plane-one", lifetimeMs: 300_000 }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(orchestrator.claimNextDispatch()).toMatchObject({ taskId: ids.taskId, ownerId: "owner-one", workerId: "synthetic-echo-worker" });
    database.close();
  });

  it("blocks revoked and expired grants before dispatch and preserves the post-consumption revocation boundary", () => {
    const first = fixture(); const a = provision(first.orchestrator, first.clock, "revoke"); approve(first.orchestrator, a, "revoke");
    expect(first.orchestrator.revokeGrant("grant-revoke")).toBe("revoked");
    expect(errorCode(() => first.orchestrator.claimNextDispatch())).toBe("STOP_POINT"); first.database.close();
    const second = fixture(); const b = provision(second.orchestrator, second.clock, "expire"); approve(second.orchestrator, b, "expire"); second.clock.milliseconds += 300_000;
    expect(errorCode(() => second.orchestrator.claimNextDispatch())).toBe("STOP_POINT"); second.database.close();
  });

  it("uses FIFO among eligible work and enforces one running/reserved task per project and two globally", () => {
    const { database, clock, orchestrator } = fixture();
    const first = provision(orchestrator, clock, "fifo-one", "project-shared"); approve(orchestrator, first, "fifo-one");
    const second = provision(orchestrator, clock, "fifo-two", "project-shared"); approve(orchestrator, second, "fifo-two");
    const third = provision(orchestrator, clock, "fifo-three", "project-other"); approve(orchestrator, third, "fifo-three");
    expect(orchestrator.claimNextDispatch().taskId).toBe(first.taskId);
    expect(orchestrator.claimNextDispatch().taskId).toBe(third.taskId);
    expect(errorCode(() => orchestrator.claimNextDispatch())).toBe("QUEUE_EMPTY");
    expect((database.connection.prepare("SELECT COUNT(*) AS count FROM m4_dispatch_queue WHERE status='claimed'").get() as { count: number }).count).toBe(2);
    database.close();
  });

  it("cancels before approval and after approval-before-consumption without claiming prevention after consumption", () => {
    const { database, clock, orchestrator } = fixture(); const before = provision(orchestrator, clock, "cancel-before");
    expect(orchestrator.cancel(before.taskId).state).toBe("CANCELLING");
    expect(orchestrator.confirmNoExecutionCancellation(before.taskId).state).toBe("CANCELLED");
    const after = provision(orchestrator, clock, "cancel-after"); approve(orchestrator, after, "cancel-after");
    expect(orchestrator.cancel(after.taskId).state).toBe("CANCELLING");
    expect(orchestrator.confirmNoExecutionCancellation(after.taskId).state).toBe("CANCELLED");
    database.close();
  });

  it("survives a Control Plane restart with deterministic state, grant, queue, and cursor records", () => {
    const { root, database, clock, key, orchestrator } = fixture(); const ids = provision(orchestrator, clock, "restart"); approve(orchestrator, ids, "restart"); database.close();
    const reopened = new ControlPlaneDatabase(createTestConfig(root)); const resumed = new M4Orchestrator(reopened, key, clock);
    expect(resumed.getTask(ids.taskId)).toMatchObject({ state: "AWAITING_DISPATCH", attemptId: ids.attemptId });
    expect(resumed.claimNextDispatch()).toMatchObject({ taskId: ids.taskId, operationId: ids.operationId });
    reopened.close();
  });

  it("refuses every non-echo or high-risk accepted action category", () => {
    const { database, orchestrator } = fixture(); orchestrator.createTask("create-policy", { taskId: "task-policy", projectId: "project-policy" });
    const action = { actionVersion: "1.0", taskId: "task-policy", attemptId: "attempt-policy", operationId: "operation-policy", operation: "task.integration", policyClass: "integration", target: { kind: "commit", resourceId: "a".repeat(40) }, parameters: { workspaceId: "workspace-policy", expectedCommitId: "a".repeat(40), patchArtifactId: "patch-policy" }, constraints: { timeoutSec: 5, requiresCleanWorktree: true, expectedArtifactId: null } };
    expect(errorCode(() => orchestrator.createAttempt("attempt-policy-command", { taskId: "task-policy", attemptId: "attempt-policy", action, taskInput: "no" }))).toBe("STOP_POINT");
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM task_attempts").get()).toEqual({ count: 0 }); database.close();
  });
});
