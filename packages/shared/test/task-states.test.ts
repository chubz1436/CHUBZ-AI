import { describe, expect, it } from "vitest";
import {
  ACTOR_CATEGORIES,
  BLOCKED_REASONS,
  BlockedReasonSchema,
  TASK_STATES,
  TaskStateSchema,
  TERMINAL_STATES,
  isTerminalState,
} from "../src/index.js";

describe("task states", () => {
  it("defines exactly the 14 states of the accepted §10 state diagram", () => {
    expect([...TASK_STATES]).toEqual([
      "DRAFT",
      "CONTEXT_PREPARING",
      "AWAITING_DISPATCH",
      "RUNNING",
      "RESULT_CAPTURED",
      "AWAITING_APPROVAL",
      "APPROVED",
      "REVISION_REQUESTED",
      "REJECTED",
      "BLOCKED",
      "CANCELLING",
      "CANCELLED",
      "FAILED",
      "COMPLETED",
    ]);
  });

  it("accepts every documented state and rejects unknown ones", () => {
    for (const state of TASK_STATES) {
      expect(TaskStateSchema.parse(state)).toBe(state);
    }
    expect(TaskStateSchema.safeParse("DEPLOYING").success).toBe(false);
    expect(TaskStateSchema.safeParse("draft").success).toBe(false);
    expect(TaskStateSchema.safeParse("").success).toBe(false);
  });

  it("exposes an immutable state list", () => {
    expect(Object.isFrozen(TASK_STATES)).toBe(true);
    expect(Object.isFrozen(TERMINAL_STATES)).toBe(true);
    expect(Object.isFrozen(BLOCKED_REASONS)).toBe(true);
    expect(Object.isFrozen(ACTOR_CATEGORIES)).toBe(true);
  });

  it("treats exactly COMPLETED, REJECTED, CANCELLED as terminal", () => {
    expect([...TERMINAL_STATES]).toEqual(["COMPLETED", "REJECTED", "CANCELLED"]);
    for (const state of TASK_STATES) {
      expect(isTerminalState(state)).toBe(
        state === "COMPLETED" || state === "REJECTED" || state === "CANCELLED",
      );
    }
  });

  it("FAILED is not terminal (retry via new attempt is legal)", () => {
    expect(isTerminalState("FAILED")).toBe(false);
  });

  it("defines the documented BLOCKED reason codes including execution-unknown", () => {
    expect([...BLOCKED_REASONS]).toEqual([
      "queue-lock",
      "conflict",
      "missing-context",
      "policy",
      "abandoned",
      "execution-unknown",
      "no-eligible-worker",
      "stale-lease",
    ]);
    expect(BlockedReasonSchema.safeParse("execution-unknown").success).toBe(true);
    expect(BlockedReasonSchema.safeParse("EXECUTION-UNKNOWN").success).toBe(false);
    expect(BlockedReasonSchema.safeParse("network-down").success).toBe(false);
  });

  it("does not model blocked reasons as visible states", () => {
    for (const reason of BLOCKED_REASONS) {
      expect(TaskStateSchema.safeParse(reason).success).toBe(false);
    }
  });
});
