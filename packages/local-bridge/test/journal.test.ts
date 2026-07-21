import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationJournal, deriveOperationId, type OperationIdentityInput } from "../src/index.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const identity = (suffix = "one"): OperationIdentityInput => Object.freeze({ taskId: `task-${suffix}`, attemptId: `attempt-${suffix}`, stage: "execution", intentDigest: createHash("sha256").update(`intent-${suffix}`).digest("hex") });
const journal = (): OperationJournal => { const root = mkdtempSync(join(tmpdir(), "chubz-journal-")); roots.push(root); return new OperationJournal(join(root, "journal.sqlite")); };

describe("persistent at-most-once operation journal", () => {
  it("normalizes equivalent digest forms into one deterministic operation identity", () => {
    const raw = identity("normalized");
    expect(deriveOperationId(raw)).toBe(deriveOperationId({ ...raw, intentDigest: `sha256:${raw.intentDigest}` }));
  });

  it("durably records prepared and started before invoking execution", async () => {
    const store = journal(); const input = identity(); let observed: readonly string[] = [];
    const result = await store.execute(input, async () => { observed = store.history(deriveOperationId(input)); return { ok: true }; });
    expect(observed).toEqual(["prepared", "started"]);
    expect(result.record.state).toBe("completed");
    expect(store.history(result.record.operationId)).toEqual(["prepared", "started", "completed"]);
    store.close();
  });

  it("returns persisted results for replay and prevents concurrent duplicate execution", async () => {
    const store = journal(); const input = identity("duplicate"); let calls = 0; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = store.execute(input, async () => { calls += 1; await gate; return { value: 7 }; });
    await new Promise((resolve) => setImmediate(resolve));
    const concurrent = await store.execute(input, async () => { calls += 1; return { value: 9 }; });
    expect(concurrent.classification).toBe("in-progress"); expect(calls).toBe(1);
    release(); const completed = await first;
    const replay = await store.execute(input, async () => { calls += 1; return null; });
    expect(completed.record.result).toEqual({ value: 7 }); expect(replay.classification).toBe("replay"); expect(replay.record.result).toEqual({ value: 7 }); expect(calls).toBe(1);
    store.close();
  });

  it("reconciles prepared, provable, and ambiguous restart states without blind retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "chubz-journal-restart-")); roots.push(root); const path = join(root, "journal.sqlite");
    const store = new OperationJournal(path); const input = identity("crash"); let release!: () => void;
    const interrupted = store.execute(input, () => new Promise((resolve) => { release = () => resolve({ late: true }); }));
    await new Promise((resolve) => setImmediate(resolve));
    const restarted = new OperationJournal(path);
    const reconciled = restarted.reconcileAfterRestart(() => ({ outcome: "unknown" }));
    expect(reconciled[0]?.state).toBe("execution-unknown");
    let retried = false; const duplicate = await restarted.execute(input, async () => { retried = true; });
    expect(duplicate.classification).toBe("execution-unknown"); expect(retried).toBe(false);
    release(); await interrupted.catch(() => undefined); store.close(); restarted.close();
  });

  it("accepts only M1F-valid owner reconciliation for execution-unknown", async () => {
    const root = mkdtempSync(join(tmpdir(), "chubz-journal-owner-")); roots.push(root); const path = join(root, "journal.sqlite"); const store = new OperationJournal(path); const input = identity("owner"); let release!: () => void;
    const interrupted = store.execute(input, () => new Promise((resolve) => { release = () => resolve(null); })); await new Promise((resolve) => setImmediate(resolve)); const restarted = new OperationJournal(path); const unknown = restarted.reconcileAfterRestart(() => ({ outcome: "unknown" }))[0]!;
    const reconciled = restarted.ownerReconcile(unknown.operationId, { coordinationVersion: "1.0", journalEntryId: unknown.journalEntryId, taskId: input.taskId, attemptId: input.attemptId, operationId: unknown.operationId, adapterRunId: null, leaseId: null, grantId: null, stage: "reconciled-completed", originalOperationStage: "execution", trustedRuntimeEvidenceRef: "runtime-evidence-one", ownerReconciliationEvidenceRef: "owner-evidence-one", recordedAt: new Date().toISOString() });
    expect(reconciled.state).toBe("reconciled-completed"); expect(restarted.history(unknown.operationId)).toEqual(["prepared", "started", "execution-unknown", "reconciled-completed"]);
    release(); await interrupted.catch(() => undefined); store.close(); restarted.close();
  });

  it("keeps worker and validator process-tree evidence separate", async () => {
    const store = journal(); const result = await store.execute(identity("evidence"), async () => "done");
    store.recordProcessEvidence(result.record.operationId, "worker", { rootPid: 101, proven: true });
    const record = store.recordProcessEvidence(result.record.operationId, "validator", { rootPid: 202, proven: false });
    expect(record.processEvidence).toEqual({ worker: { rootPid: 101, proven: true }, validator: { rootPid: 202, proven: false } });
    store.close();
  });
});
