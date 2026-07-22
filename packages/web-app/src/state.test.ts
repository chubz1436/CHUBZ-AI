import { describe, expect, it } from "vitest";
import { classifyIncomingSequence, mergeTasks, taskColumn } from "./state.js";
import type { Task } from "./types.js";

const task = (overrides: Partial<Task> = {}): Task => ({
  taskId: "task-one", projectId: "project-one", state: "DRAFT", version: 0, attemptId: "attempt-one", operationId: "operation-one", createdAt: "2026-07-22T00:00:00.000Z", updatedAt: "2026-07-22T00:00:00.000Z", cancellationRequestedAt: null, blockedContext: null, executionUnknown: false,
  attempts: [], assignments: [], approval: null, grant: null, lease: null, scopes: [], queue: null, results: [], manualResults: [], structuredResult: null, transitions: [], events: [], actions: { canApproveDispatch: false, canCancel: true, canDecideResult: false, canSubmitManualText: false, canRetry: false }, ...overrides,
});

describe("authoritative board projection", () => {
  it("maps pending, approval, queued, dispatched, running, cancellation, unknown, failure, and completion without client-only states", () => {
    expect(taskColumn(task())).toBe("pending");
    expect(taskColumn(task({ state: "AWAITING_DISPATCH", assignments: [{ status: "pending-approval" }] }))).toBe("approval");
    expect(taskColumn(task({ state: "AWAITING_DISPATCH", queue: { status: "queued" } }))).toBe("queued");
    expect(taskColumn(task({ state: "AWAITING_DISPATCH", queue: { status: "claimed" } }))).toBe("dispatched");
    expect(taskColumn(task({ state: "RUNNING" }))).toBe("running");
    expect(taskColumn(task({ state: "CANCELLED" }))).toBe("cancelled");
    expect(taskColumn(task({ state: "FAILED" }))).toBe("attention");
    expect(taskColumn(task({ state: "BLOCKED", executionUnknown: true }))).toBe("attention");
    expect(taskColumn(task({ state: "COMPLETED" }))).toBe("completed");
  });

  it("prevents an older snapshot or stale event refresh from overwriting a newer task version", () => {
    const current = task({ version: 4, state: "RUNNING", updatedAt: "2026-07-22T00:04:00.000Z" });
    const stale = task({ version: 3, state: "AWAITING_DISPATCH", updatedAt: "2026-07-22T00:05:00.000Z" });
    expect(mergeTasks([current], [stale])[0]).toEqual(current);
    const newer = task({ version: 5, state: "FAILED", updatedAt: "2026-07-22T00:03:00.000Z" });
    expect(mergeTasks([current], [newer])[0]).toEqual(newer);
  });

  it("deduplicates replayed events and detects cursor gaps that require resynchronization", () => {
    expect(classifyIncomingSequence(7, 7)).toBe("duplicate");
    expect(classifyIncomingSequence(7, 6)).toBe("duplicate");
    expect(classifyIncomingSequence(7, 8)).toBe("next");
    expect(classifyIncomingSequence(7, 10)).toBe("gap");
    expect(classifyIncomingSequence(7, Number.NaN)).toBe("invalid");
  });
});
