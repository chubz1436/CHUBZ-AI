import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectRedactions, digestApprovalAction, redactText, type ApprovalAction } from "@chubz/shared";
import { ControlPlaneDatabase, deriveApprovalId, M4Orchestrator, Phase1GrantKey, createTestConfig, type Clock } from "@chubz/control-plane";
import { EchoBridge, TestOnlyEchoAdapter, type BridgeClock, type EchoDispatchCommand, type SyntheticEchoAdapter } from "../src/echo-bridge.js";
import { OperationJournal } from "../src/journal.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) { try { rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* a failed test may still own a SQLite handle */ } } });
class MutableClock implements Clock, BridgeClock {
  public constructor(public milliseconds = Date.parse("2026-07-22T06:00:00.000Z")) {}
  public now(): Date { return new Date(this.milliseconds); }
}
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}` as const;
const sanitized = (text: string): string => { const found = detectRedactions(text); if (!found.ok) throw new Error("redaction failed"); const value = redactText(text, found.value); if (!value.ok) throw new Error("redaction failed"); return value.value.text; };

type Fixture = ReturnType<typeof fixture>;
const fixture = (suffix: string, adapter: SyntheticEchoAdapter = new TestOnlyEchoAdapter(), rawInput = `echo-${suffix}`, timeoutSec = 5) => {
  const root = mkdtempSync(join(tmpdir(), "chubz-m4-e2e-test-")); roots.push(root);
  const controlDatabase = new ControlPlaneDatabase(createTestConfig(root)); const clock = new MutableClock(); const key = new Phase1GrantKey(`key-${suffix}`, Buffer.alloc(32, suffix.length + 1));
  const orchestrator = new M4Orchestrator(controlDatabase, key, clock);
  const taskId = `task-${suffix}`; const attemptId = `attempt-${suffix}`; const operationId = `operation-${suffix}`; const projectId = `project-${suffix}`; const taskInput = sanitized(rawInput);
  const action: ApprovalAction = { actionVersion: "1.0", taskId, attemptId, operationId, operation: "worker.dispatch", policyClass: "worker-execution", target: { kind: "worker", resourceId: "synthetic-echo-worker" }, parameters: { projectId, workspaceId: `workspace-${suffix}`, worker: { manifestId: "synthetic-echo-worker", manifestVersion: "1.0.0" }, instructionDigest: hash(taskInput), contextArtifactIds: [] }, constraints: { timeoutSec, requiresCleanWorktree: true, expectedArtifactId: null } };
  orchestrator.createTask(`create-${suffix}`, { taskId, projectId }); orchestrator.createAttempt(`attempt-command-${suffix}`, { taskId, attemptId, action, taskInput: rawInput }); orchestrator.activateAttempt(taskId, "owner-one");
  const assigned = orchestrator.assignEcho(`assign-${suffix}`, { taskId, attemptId, assignmentId: `assignment-${suffix}`, scopeId: `scope-${suffix}`, leaseId: `lease-${suffix}`, ownerAssignmentRef: `assignment-approval-${suffix}`, leaseExpiresAt: new Date(clock.milliseconds + 600_000).toISOString() });
  const actionDigest = digestApprovalAction(action); if (!actionDigest.ok) throw new Error("action digest failed");
  const approvalId = deriveApprovalId({ ownerId: "owner-one", taskId, attemptId, operationId, actionDigest: actionDigest.value, scopeHash: assigned.scopeHash, workerId: "synthetic-echo-worker", adapterId: "synthetic-echo-adapter" });
  orchestrator.approveAndIssue(`issue-${suffix}`, { taskId, attemptId, ownerId: "owner-one", approvalId, grantId: `grant-${suffix}`, issuerId: "control-plane-one", lifetimeMs: 300_000 });
  const command = orchestrator.claimNextDispatch(); const bridgePath = join(root, "bridge.sqlite"); const journal = new OperationJournal(bridgePath); const bridge = new EchoBridge(journal, key.verifier(), adapter, clock); bridge.registerAuthorization(command);
  return { root, controlDatabase, clock, key, orchestrator, taskId, attemptId, operationId, projectId, command, bridgePath, journal, bridge, adapter };
};
const close = (value: Fixture): void => { value.journal.close(); value.controlDatabase.close(); value.key.destroy(); };
const acknowledge = (value: Fixture): (() => void) => () => { value.orchestrator.acknowledgeDispatch(value.taskId, value.operationId); };

describe("M4 synthetic echo end to end", () => {
  it("executes exactly once for concurrent duplicate dispatch, persists a bounded redacted result, and follows legal states", async () => {
    const secret = "api_key=ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"; const value = fixture("happy", new TestOnlyEchoAdapter("success", 20), secret);
    const started = () => { if (value.orchestrator.getTask(value.taskId).state === "AWAITING_DISPATCH") value.orchestrator.acknowledgeDispatch(value.taskId, value.operationId); };
    const [first, duplicate] = await Promise.all([value.bridge.execute(value.command, { onStarted: started }), value.bridge.execute(value.command, { onStarted: started })]);
    expect(first).toEqual(duplicate); expect((value.adapter as TestOnlyEchoAdapter).executions).toBe(1); expect(first.state).toBe("completed"); expect(first.output).toContain("[REDACTED:"); expect(first.output).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890");
    const recorded = value.orchestrator.recordBridgeResult("completion-happy", value.taskId, first);
    expect(recorded).toMatchObject({ state: "RESULT_CAPTURED", resultRef: first.resultRef });
    expect(value.orchestrator.recordBridgeResult("completion-happy", value.taskId, first)).toEqual(recorded);
    expect(() => value.orchestrator.recordBridgeResult("completion-happy", value.taskId, { ...first, output: "conflicting" })).toThrow("conflicts");
    expect(value.orchestrator.advanceCapturedResult(value.taskId)).toMatchObject({ state: "AWAITING_APPROVAL" });
    const persisted = value.controlDatabase.connection.prepare("SELECT result_json FROM m4_results WHERE result_ref=?").get(first.resultRef) as { result_json: string };
    expect(persisted.result_json).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890");
    expect(value.journal.history(value.operationId)).toEqual(["prepared", "started", "completed"]); close(value);
  });

  it("returns the original durable result after Bridge restart without re-executing", async () => {
    const value = fixture("replay"); const first = await value.bridge.execute(value.command, { onStarted: acknowledge(value) }); expect((value.adapter as TestOnlyEchoAdapter).executions).toBe(1); value.journal.close();
    const reopened = new OperationJournal(value.bridgePath); const replacement = new TestOnlyEchoAdapter(); const bridge = new EchoBridge(reopened, value.key.verifier(), replacement, value.clock); expect(bridge.registerAuthorization(value.command)).toBe("duplicate");
    expect(await bridge.execute(value.command)).toEqual(first); expect(replacement.executions).toBe(0); reopened.close(); value.controlDatabase.close(); value.key.destroy();
  });

  it("rejects owner, task, attempt, worker, scope, action, signature, expiry, and malformed grant substitutions", async () => {
    const cases: Array<(command: EchoDispatchCommand) => EchoDispatchCommand> = [
      (c) => ({ ...c, ownerId: "owner-two" }),
      (c) => ({ ...c, taskId: "task-other" }),
      (c) => ({ ...c, attemptId: "attempt-other" }),
      (c) => ({ ...c, workerId: "other-worker" as EchoDispatchCommand["workerId"] }),
      (c) => ({ ...c, writeScope: { ...c.writeScope, scopeHash: hash("wrong") } }),
      (c) => { if (c.action.operation !== "worker.dispatch") throw new Error("unexpected action"); return { ...c, action: { ...c.action, parameters: { ...c.action.parameters, instructionDigest: hash("changed") } } }; },
      (c) => ({ ...c, grant: { ...c.grant, authentication: { ...c.grant.authentication, signature: `${c.grant.authentication.signature.slice(0, 42)}A` } } }),
      (c) => ({ ...c, grant: { ...c.grant, grantVersion: "9.0" as "1.0" } }),
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const value = fixture(`mismatch-${index}`); await expect(value.bridge.execute(cases[index]!(value.command))).rejects.toThrow(); expect((value.adapter as TestOnlyEchoAdapter).executions).toBe(0); close(value);
    }
    const expired = fixture("expired"); expired.clock.milliseconds += 300_000; await expect(expired.bridge.execute(expired.command)).rejects.toThrow("GRANT_EXPIRED"); close(expired);
  });

  it("makes revocation before consumption decisive and reports post-consumption revocation honestly", async () => {
    const before = fixture("revoke-before"); expect(before.bridge.revoke(before.command.grant.grantId)).toBe("revoked"); await expect(before.bridge.execute(before.command)).rejects.toThrow("unavailable"); expect((before.adapter as TestOnlyEchoAdapter).executions).toBe(0); close(before);
    const after = fixture("revoke-after"); await after.bridge.execute(after.command, { onStarted: acknowledge(after) }); expect(after.bridge.revoke(after.command.grant.grantId)).toBe("already-consumed"); close(after);
  });

  it("handles worker failure, malformed output, timeout, and owner cancellation without success", async () => {
    const failure = fixture("failure", new TestOnlyEchoAdapter("failure")); expect((await failure.bridge.execute(failure.command, { onStarted: acknowledge(failure) })).failureCode).toBe("WORKER_FAILURE"); close(failure);
    const malformed = fixture("malformed", new TestOnlyEchoAdapter("malformed")); expect((await malformed.bridge.execute(malformed.command, { onStarted: acknowledge(malformed) })).failureCode).toBe("MALFORMED_RESULT"); close(malformed);
    const timeout = fixture("timeout", new TestOnlyEchoAdapter("hang"), "timeout", 1); const timed = await timeout.bridge.execute(timeout.command, { onStarted: acknowledge(timeout) }); expect(timed).toMatchObject({ state: "failed", failureCode: "TIMEOUT" }); close(timeout);
    const cancelled = fixture("cancel", new TestOnlyEchoAdapter("success", 200)); const abort = new AbortController(); const promise = cancelled.bridge.execute(cancelled.command, { signal: abort.signal, onStarted: () => { cancelled.orchestrator.acknowledgeDispatch(cancelled.taskId, cancelled.operationId); cancelled.orchestrator.cancel(cancelled.taskId); setTimeout(() => abort.abort(), 10); } }); const result = await promise; expect(result).toMatchObject({ state: "cancelled", failureCode: "CANCELLED" }); expect(cancelled.orchestrator.recordBridgeResult("cancel-result", cancelled.taskId, result).state).toBe("CANCELLED"); close(cancelled);
  });

  it("bounds oversized adapter output before both Bridge and Control Plane persistence", async () => {
    const adapter: SyntheticEchoAdapter = { workerId: "synthetic-echo-worker", adapterId: "synthetic-echo-adapter", execute: async () => ({ version: "1.0", kind: "echo.result", text: "x".repeat(80_000) }) };
    const value = fixture("bounded", adapter); const result = await value.bridge.execute(value.command, { onStarted: acknowledge(value) });
    expect(result.outputTruncated).toBe(true); expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(65_536); value.orchestrator.recordBridgeResult("bounded-result", value.taskId, result);
    expect(Buffer.byteLength((value.controlDatabase.connection.prepare("SELECT result_json FROM m4_results").get() as { result_json: string }).result_json)).toBeLessThanOrEqual(65_536); close(value);
  });
});

describe("M4 crash and reconciliation boundaries", () => {
  it("rolls back before consumption and the injected consumption-before-journal window atomically", async () => {
    for (const failpoint of ["before-consumption", "after-consumption-before-journal"] as const) {
      const value = fixture(`rollback-${failpoint}`); await expect(value.bridge.execute(value.command, { failpoint })).rejects.toThrow(); expect(value.journal.grantConsumption(value.command.grant.grantId)).toBeNull(); expect(value.journal.get(value.operationId)).toBeNull(); close(value);
    }
  });

  it("reconciles prepared-before-start as proven not executed and started windows as execution-unknown with no auto-retry", async () => {
    const prepared = fixture("prepared-crash"); await expect(prepared.bridge.execute(prepared.command, { failpoint: "after-journal-before-start" })).rejects.toThrow(); prepared.journal.close();
    const preparedJournal = new OperationJournal(prepared.bridgePath); const preparedBridge = new EchoBridge(preparedJournal, prepared.key.verifier(), new TestOnlyEchoAdapter(), prepared.clock); expect(preparedBridge.reconcileAfterRestart()[0]).toMatchObject({ state: "failed", failureCode: "RESTART_BEFORE_EXECUTION" }); preparedJournal.close(); prepared.controlDatabase.close(); prepared.key.destroy();
    for (const failpoint of ["after-start-before-evidence", "after-worker-completion-before-result"] as const) {
      const value = fixture(`unknown-${failpoint}`); await expect(value.bridge.execute(value.command, { failpoint, onStarted: acknowledge(value) })).rejects.toThrow(); value.journal.close();
      const reopened = new OperationJournal(value.bridgePath); const replacement = new TestOnlyEchoAdapter(); const bridge = new EchoBridge(reopened, value.key.verifier(), replacement, value.clock); expect(bridge.registerAuthorization(value.command)).toBe("duplicate"); const reconciled = bridge.reconcileAfterRestart()[0]!; expect(reconciled).toMatchObject({ state: "execution-unknown", failureCode: "EXECUTION_UNKNOWN" });
      expect(value.orchestrator.recordBridgeResult(`unknown-result-${failpoint}`, value.taskId, reconciled)).toMatchObject({ state: "BLOCKED" }); expect(value.orchestrator.getTask(value.taskId).blockedContext).toMatchObject({ blockedReason: "execution-unknown", journalRef: reconciled.journalRef });
      expect((await bridge.execute(value.command)).state).toBe("execution-unknown"); expect(replacement.executions).toBe(0); reopened.close(); value.controlDatabase.close(); value.key.destroy();
    }
  });

  it("requires accepted owner/runtime reconciliation evidence and rejects blind or incomplete reconciliation", async () => {
    const value = fixture("owner-reconcile"); await expect(value.bridge.execute(value.command, { failpoint: "after-start-before-evidence", onStarted: acknowledge(value) })).rejects.toThrow(); value.journal.reconcileAfterRestart(() => ({ outcome: "unknown" })); const record = value.journal.get(value.operationId)!;
    const base = { coordinationVersion: "1.0" as const, journalEntryId: record.journalEntryId, taskId: value.taskId, attemptId: value.attemptId, operationId: value.operationId, adapterRunId: null, leaseId: null, grantId: null, originalOperationStage: "execution" as const, recordedAt: value.clock.now().toISOString() };
    expect(() => value.journal.ownerReconcile(value.operationId, { ...base, stage: "reconciled-completed", trustedRuntimeEvidenceRef: null, ownerReconciliationEvidenceRef: "owner-evidence" })).toThrow("invalid owner reconciliation");
    expect(value.journal.ownerReconcile(value.operationId, { ...base, stage: "reconciled-completed", trustedRuntimeEvidenceRef: "runtime-evidence", ownerReconciliationEvidenceRef: "owner-evidence" }).state).toBe("reconciled-completed"); close(value);
  });

  it("contains no inbound listener, real worker invocation, shell construction, or task-in-argv path in the M4 Bridge module", () => {
    const source = readFileSync(new URL("../src/echo-bridge.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/createServer|\.listen\(|execFile|spawn\(|shell\s*:/u); expect(source).not.toMatch(/codex|claude|antigravity|santos/iu);
  });
});
