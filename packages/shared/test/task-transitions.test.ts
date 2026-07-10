import { describe, expect, it } from "vitest";
import {
  ACTOR_CATEGORIES,
  TASK_STATES,
  TERMINAL_STATES,
  TRANSITION_RULES,
  canTransition,
  legalTransitionsFrom,
  type ActorCategory,
  type TaskState,
} from "../src/index.js";

const allow = (r: ReturnType<typeof canTransition>) => {
  expect(r.allowed).toBe(true);
  return r;
};
const denyCode = (r: ReturnType<typeof canTransition>) => {
  if (r.allowed) throw new Error("expected denial");
  return r.code;
};

describe("transition rule table", () => {
  it("every rule references only documented states and actors", () => {
    for (const rule of TRANSITION_RULES) {
      expect(TASK_STATES).toContain(rule.from);
      expect(TASK_STATES).toContain(rule.to);
      expect(rule.actors.length).toBeGreaterThan(0);
      for (const actor of rule.actors) {
        expect(ACTOR_CATEGORIES).toContain(actor);
      }
    }
  });

  it("no rule leaves a terminal state", () => {
    for (const rule of TRANSITION_RULES) {
      expect(TERMINAL_STATES).not.toContain(rule.from);
    }
    for (const terminal of TERMINAL_STATES) {
      expect(legalTransitionsFrom(terminal)).toEqual([]);
    }
  });

  it("worker and reviewer actors trigger no transition in the accepted model", () => {
    for (const rule of TRANSITION_RULES) {
      expect(rule.actors).not.toContain("worker");
      expect(rule.actors).not.toContain("reviewer");
    }
  });
});

describe("valid transitions (happy paths)", () => {
  it("owner submits a draft", () => {
    allow(canTransition({ from: "DRAFT", to: "CONTEXT_PREPARING", actor: "owner" }));
  });

  it("full happy path DRAFT -> COMPLETED with correct actors", () => {
    allow(canTransition({ from: "DRAFT", to: "CONTEXT_PREPARING", actor: "owner" }));
    allow(canTransition({ from: "CONTEXT_PREPARING", to: "AWAITING_DISPATCH", actor: "control-plane" }));
    allow(canTransition({ from: "AWAITING_DISPATCH", to: "RUNNING", actor: "control-plane" }));
    allow(canTransition({ from: "RUNNING", to: "RESULT_CAPTURED", actor: "local-bridge" }));
    allow(canTransition({ from: "RESULT_CAPTURED", to: "AWAITING_APPROVAL", actor: "control-plane" }));
    const approved = allow(
      canTransition({ from: "AWAITING_APPROVAL", to: "APPROVED", actor: "owner" }),
    );
    if (approved.allowed) expect(approved.requiresOwnerApproval).toBe(true);
    allow(canTransition({ from: "APPROVED", to: "COMPLETED", actor: "local-bridge" }));
  });

  it("owner rejection and revision request", () => {
    allow(canTransition({ from: "AWAITING_APPROVAL", to: "REJECTED", actor: "owner" }));
    allow(canTransition({ from: "AWAITING_APPROVAL", to: "REVISION_REQUESTED", actor: "owner" }));
  });

  it("blocking transitions carry a reason code", () => {
    allow(
      canTransition({
        from: "CONTEXT_PREPARING",
        to: "BLOCKED",
        actor: "control-plane",
        reasonCode: "missing-context",
      }),
    );
    allow(
      canTransition({
        from: "AWAITING_DISPATCH",
        to: "BLOCKED",
        actor: "control-plane",
        reasonCode: "queue-lock",
      }),
    );
    allow(
      canTransition({
        from: "APPROVED",
        to: "BLOCKED",
        actor: "system-recovery",
        reasonCode: "execution-unknown",
      }),
    );
  });

  it("recovery may mark an in-flight run execution-unknown", () => {
    allow(
      canTransition({
        from: "RUNNING",
        to: "BLOCKED",
        actor: "system-recovery",
        reasonCode: "execution-unknown",
      }),
    );
  });
});

describe("forbidden transitions and deny-by-default", () => {
  it("denies unknown transitions by default", () => {
    expect(denyCode(canTransition({ from: "DRAFT", to: "RUNNING", actor: "owner" }))).toBe(
      "UNKNOWN_TRANSITION",
    );
    expect(denyCode(canTransition({ from: "RUNNING", to: "APPROVED", actor: "owner" }))).toBe(
      "UNKNOWN_TRANSITION",
    );
    expect(
      denyCode(canTransition({ from: "AWAITING_APPROVAL", to: "COMPLETED", actor: "owner" })),
    ).toBe("UNKNOWN_TRANSITION");
  });

  it("denies self-transitions", () => {
    expect(denyCode(canTransition({ from: "RUNNING", to: "RUNNING", actor: "owner" }))).toBe(
      "SAME_STATE",
    );
  });

  it("terminal states never restart — no target or actor may leave them", () => {
    for (const terminal of TERMINAL_STATES) {
      for (const to of TASK_STATES) {
        if (to === terminal) continue;
        for (const actor of ACTOR_CATEGORIES) {
          expect(denyCode(canTransition({ from: terminal, to, actor }))).toBe("TERMINAL_STATE");
        }
      }
    }
  });

  it("exhaustive sweep: every (from,to,actor) combination not in the rule table is denied", () => {
    const ruleKey = new Set(
      TRANSITION_RULES.flatMap((r) => r.actors.map((a) => `${r.from}>${r.to}>${a}`)),
    );
    let checked = 0;
    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        for (const actor of ACTOR_CATEGORIES) {
          const result = canTransition({
            from,
            to,
            actor,
            reasonCode: to === "BLOCKED" ? "policy" : undefined,
            isNewAttempt: true,
          });
          const key = `${from}>${to}>${actor}`;
          if (ruleKey.has(key)) {
            expect(result.allowed, key).toBe(true);
          } else {
            expect(result.allowed, key).toBe(false);
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBe(TASK_STATES.length * TASK_STATES.length * ACTOR_CATEGORIES.length);
  });
});

describe("actor authority", () => {
  it("only the owner decides at the approval gate", () => {
    for (const actor of ACTOR_CATEGORIES.filter((a): a is ActorCategory => a !== "owner")) {
      expect(
        denyCode(canTransition({ from: "AWAITING_APPROVAL", to: "APPROVED", actor })),
      ).toBe("ACTOR_NOT_PERMITTED");
      expect(
        denyCode(canTransition({ from: "AWAITING_APPROVAL", to: "REJECTED", actor })),
      ).toBe("ACTOR_NOT_PERMITTED");
    }
  });

  it("only the bridge confirms a kill", () => {
    allow(canTransition({ from: "CANCELLING", to: "CANCELLED", actor: "local-bridge" }));
    for (const actor of ["owner", "control-plane", "worker", "reviewer", "system-recovery"] as const) {
      expect(denyCode(canTransition({ from: "CANCELLING", to: "CANCELLED", actor }))).toBe(
        "ACTOR_NOT_PERMITTED",
      );
    }
  });

  it("a worker can never move its own task", () => {
    for (const from of TASK_STATES.filter((s: TaskState) => !TERMINAL_STATES.includes(s as never))) {
      for (const to of TASK_STATES) {
        if (from === to) continue;
        const result = canTransition({
          from,
          to,
          actor: "worker",
          reasonCode: to === "BLOCKED" ? "policy" : undefined,
          isNewAttempt: true,
        });
        expect(result.allowed).toBe(false);
      }
    }
  });
});

describe("cancellation authority", () => {
  it("owner cancels a running task via CANCELLING, not directly", () => {
    allow(canTransition({ from: "RUNNING", to: "CANCELLING", actor: "owner" }));
    expect(denyCode(canTransition({ from: "RUNNING", to: "CANCELLED", actor: "owner" }))).toBe(
      "UNKNOWN_TRANSITION",
    );
  });

  it("owner cancels passive states directly", () => {
    allow(canTransition({ from: "DRAFT", to: "CANCELLED", actor: "owner" }));
    allow(canTransition({ from: "CONTEXT_PREPARING", to: "CANCELLED", actor: "owner" }));
    allow(canTransition({ from: "RESULT_CAPTURED", to: "CANCELLED", actor: "owner" }));
    allow(canTransition({ from: "AWAITING_APPROVAL", to: "CANCELLED", actor: "owner" }));
    allow(canTransition({ from: "REVISION_REQUESTED", to: "CANCELLED", actor: "owner" }));
    allow(canTransition({ from: "BLOCKED", to: "CANCELLED", actor: "owner" }));
  });

  it("in-flight dispatch and integration cancel via CANCELLING", () => {
    allow(canTransition({ from: "AWAITING_DISPATCH", to: "CANCELLING", actor: "owner" }));
    allow(canTransition({ from: "APPROVED", to: "CANCELLING", actor: "owner" }));
  });

  it("no other actor may cancel", () => {
    for (const actor of ["control-plane", "local-bridge", "worker", "reviewer", "system-recovery"] as const) {
      expect(denyCode(canTransition({ from: "RUNNING", to: "CANCELLING", actor }))).toBe(
        "ACTOR_NOT_PERMITTED",
      );
      expect(denyCode(canTransition({ from: "DRAFT", to: "CANCELLED", actor }))).toBe(
        "ACTOR_NOT_PERMITTED",
      );
    }
  });
});

describe("blocked handling and execution-unknown", () => {
  it("transitions into BLOCKED require a reason code", () => {
    expect(
      denyCode(canTransition({ from: "CONTEXT_PREPARING", to: "BLOCKED", actor: "control-plane" })),
    ).toBe("REASON_CODE_REQUIRED");
  });

  it("system may auto-unblock ordinary reasons", () => {
    allow(
      canTransition({
        from: "BLOCKED",
        to: "AWAITING_DISPATCH",
        actor: "control-plane",
        currentBlockedReason: "queue-lock",
      }),
    );
  });

  it("execution-unknown blocks blind retry: only the owner may resolve it", () => {
    expect(
      denyCode(
        canTransition({
          from: "BLOCKED",
          to: "AWAITING_DISPATCH",
          actor: "control-plane",
          currentBlockedReason: "execution-unknown",
        }),
      ),
    ).toBe("EXECUTION_UNKNOWN_REQUIRES_OWNER");
    expect(
      denyCode(
        canTransition({
          from: "BLOCKED",
          to: "AWAITING_DISPATCH",
          actor: "system-recovery",
          currentBlockedReason: "execution-unknown",
        }),
      ),
    ).toBe("EXECUTION_UNKNOWN_REQUIRES_OWNER");
    allow(
      canTransition({
        from: "BLOCKED",
        to: "AWAITING_DISPATCH",
        actor: "owner",
        currentBlockedReason: "execution-unknown",
      }),
    );
  });

  it("owner may always cancel an execution-unknown task", () => {
    allow(
      canTransition({
        from: "BLOCKED",
        to: "CANCELLED",
        actor: "owner",
        currentBlockedReason: "execution-unknown",
      }),
    );
  });
});

describe("retry / new-attempt rule", () => {
  it("retry of a failed task requires a new immutable attempt", () => {
    expect(
      denyCode(canTransition({ from: "FAILED", to: "CONTEXT_PREPARING", actor: "owner" })),
    ).toBe("NEW_ATTEMPT_REQUIRED");
    expect(
      denyCode(
        canTransition({ from: "FAILED", to: "CONTEXT_PREPARING", actor: "owner", isNewAttempt: false }),
      ),
    ).toBe("NEW_ATTEMPT_REQUIRED");
    const ok = allow(
      canTransition({ from: "FAILED", to: "CONTEXT_PREPARING", actor: "owner", isNewAttempt: true }),
    );
    if (ok.allowed) expect(ok.requiresNewAttempt).toBe(true);
  });

  it("revision rework likewise requires a new attempt", () => {
    expect(
      denyCode(canTransition({ from: "REVISION_REQUESTED", to: "CONTEXT_PREPARING", actor: "owner" })),
    ).toBe("NEW_ATTEMPT_REQUIRED");
    allow(
      canTransition({
        from: "REVISION_REQUESTED",
        to: "CONTEXT_PREPARING",
        actor: "owner",
        isNewAttempt: true,
      }),
    );
  });

  it("only the owner may retry", () => {
    for (const actor of ["control-plane", "local-bridge", "worker", "reviewer", "system-recovery"] as const) {
      expect(
        denyCode(
          canTransition({ from: "FAILED", to: "CONTEXT_PREPARING", actor, isNewAttempt: true }),
        ),
      ).toBe("ACTOR_NOT_PERMITTED");
    }
  });
});

describe("input validation", () => {
  it("rejects unknown states, actors, and reason codes at the schema boundary", () => {
    expect(() =>
      canTransition({ from: "LIMBO" as never, to: "RUNNING", actor: "owner" }),
    ).toThrow();
    expect(() =>
      canTransition({ from: "DRAFT", to: "CONTEXT_PREPARING", actor: "root" as never }),
    ).toThrow();
    expect(() =>
      canTransition({
        from: "CONTEXT_PREPARING",
        to: "BLOCKED",
        actor: "control-plane",
        reasonCode: "gremlins" as never,
      }),
    ).toThrow();
  });
});
