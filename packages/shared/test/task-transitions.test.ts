import { describe, expect, it } from "vitest";
import {
  ACTOR_CATEGORIES,
  RECONCILIATION_OUTCOMES,
  TASK_STATES,
  TERMINAL_STATES,
  TRANSITION_EVIDENCE,
  TRANSITION_RULES,
  canTransition,
  legalTransitionsFrom,
  type CanTransitionInput,
  type TransitionRule,
} from "../src/index.js";

const allow = (r: ReturnType<typeof canTransition>) => {
  if (!r.allowed) throw new Error(`expected allow, got ${r.code}: ${r.message}`);
  return r;
};
const denyCode = (r: ReturnType<typeof canTransition>) => {
  if (r.allowed) throw new Error("expected denial");
  return r.code;
};

/** Builds the minimal fully-satisfying input for a rule (used by the sweep). */
const satisfyingInput = (rule: TransitionRule, actor: (typeof ACTOR_CATEGORIES)[number]): CanTransitionInput => ({
  from: rule.from,
  to: rule.to,
  actor,
  ...(rule.to === "BLOCKED" ? { reasonCode: "policy" as const } : {}),
  ...(rule.from === "BLOCKED"
    ? {
        currentBlockedReason:
          rule.reconciliationOutcome !== undefined ? ("execution-unknown" as const) : ("queue-lock" as const),
      }
    : {}),
  ...(rule.reconciliationOutcome !== undefined
    ? { reconciliationOutcome: rule.reconciliationOutcome }
    : {}),
  ...(rule.requiredEvidence.length > 0 ? { evidence: rule.requiredEvidence } : {}),
  ...(rule.requiresNewAttempt ? { isNewAttempt: true as const } : {}),
});

describe("state count (D-020)", () => {
  it("the accepted model has exactly 14 visible states", () => {
    expect(TASK_STATES).toHaveLength(14);
  });
});

describe("transition rule table", () => {
  it("every rule references only documented states, actors, and evidence", () => {
    for (const rule of TRANSITION_RULES) {
      expect(TASK_STATES).toContain(rule.from);
      expect(TASK_STATES).toContain(rule.to);
      expect(rule.actors.length).toBeGreaterThan(0);
      for (const actor of rule.actors) expect(ACTOR_CATEGORIES).toContain(actor);
      for (const ev of rule.requiredEvidence) expect(TRANSITION_EVIDENCE).toContain(ev);
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

  it("bridge, worker, and reviewer are never transition actors — the bridge speaks only through evidence", () => {
    for (const rule of TRANSITION_RULES) {
      expect(rule.actors).not.toContain("local-bridge");
      expect(rule.actors).not.toContain("worker");
      expect(rule.actors).not.toContain("reviewer");
    }
  });

  it("reconciliation rules exist for exactly the three D-020 outcomes", () => {
    const recon = TRANSITION_RULES.filter((r) => r.reconciliationOutcome !== undefined);
    expect(recon.map((r) => r.reconciliationOutcome).sort()).toEqual(
      [...RECONCILIATION_OUTCOMES].sort(),
    );
    for (const r of recon) {
      expect(r.from).toBe("BLOCKED");
      expect(r.actors).toEqual(["owner"]);
      expect(r.requiredEvidence).toContain("owner-reconciliation");
    }
  });
});

describe("valid transitions (happy paths)", () => {
  it("full happy path DRAFT -> COMPLETED with correct actors and evidence", () => {
    allow(canTransition({ from: "DRAFT", to: "CONTEXT_PREPARING", actor: "owner" }));
    allow(canTransition({ from: "CONTEXT_PREPARING", to: "AWAITING_DISPATCH", actor: "control-plane" }));
    allow(
      canTransition({
        from: "AWAITING_DISPATCH",
        to: "RUNNING",
        actor: "control-plane",
        evidence: ["bridge-dispatch-ack"],
      }),
    );
    allow(
      canTransition({
        from: "RUNNING",
        to: "RESULT_CAPTURED",
        actor: "control-plane",
        evidence: ["bridge-execution-report"],
      }),
    );
    allow(canTransition({ from: "RESULT_CAPTURED", to: "AWAITING_APPROVAL", actor: "control-plane" }));
    const approved = allow(canTransition({ from: "AWAITING_APPROVAL", to: "APPROVED", actor: "owner" }));
    if (approved.allowed) expect(approved.requiresOwnerApproval).toBe(true);
    allow(
      canTransition({
        from: "APPROVED",
        to: "COMPLETED",
        actor: "control-plane",
        evidence: ["bridge-integration-report", "grant-verified"],
      }),
    );
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
        from: "RUNNING",
        to: "BLOCKED",
        actor: "system-recovery",
        reasonCode: "execution-unknown",
      }),
    );
  });

  it("superfluous valid evidence is tolerated", () => {
    allow(
      canTransition({
        from: "AWAITING_DISPATCH",
        to: "RUNNING",
        actor: "control-plane",
        evidence: ["bridge-dispatch-ack", "grant-verified"],
      }),
    );
  });
});

describe("contextual field validation (correction 1)", () => {
  it("every outbound BLOCKED transition requires currentBlockedReason", () => {
    expect(
      denyCode(canTransition({ from: "BLOCKED", to: "AWAITING_DISPATCH", actor: "control-plane" })),
    ).toBe("BLOCKED_REASON_REQUIRED");
    expect(denyCode(canTransition({ from: "BLOCKED", to: "CANCELLED", actor: "owner" }))).toBe(
      "BLOCKED_REASON_REQUIRED",
    );
    expect(
      denyCode(
        canTransition({
          from: "BLOCKED",
          to: "COMPLETED",
          actor: "owner",
          reconciliationOutcome: "confirmed-completed",
          evidence: ["owner-reconciliation"],
        }),
      ),
    ).toBe("BLOCKED_REASON_REQUIRED");
  });

  it("the Control Plane cannot bypass execution-unknown by omitting the reason", () => {
    const result = canTransition({ from: "BLOCKED", to: "AWAITING_DISPATCH", actor: "control-plane" });
    expect(denyCode(result)).toBe("BLOCKED_REASON_REQUIRED");
  });

  it("currentBlockedReason is rejected when from is not BLOCKED", () => {
    expect(
      denyCode(
        canTransition({
          from: "RUNNING",
          to: "CANCELLING",
          actor: "owner",
          currentBlockedReason: "queue-lock",
        }),
      ),
    ).toBe("UNEXPECTED_BLOCKED_REASON");
  });

  it("reasonCode is rejected unless the target is BLOCKED", () => {
    expect(
      denyCode(
        canTransition({
          from: "DRAFT",
          to: "CONTEXT_PREPARING",
          actor: "owner",
          reasonCode: "policy",
        }),
      ),
    ).toBe("UNEXPECTED_REASON_CODE");
  });
});

describe("forbidden transitions and deny-by-default", () => {
  it("denies unknown transitions by default", () => {
    expect(denyCode(canTransition({ from: "DRAFT", to: "RUNNING", actor: "owner" }))).toBe(
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

  it("exhaustive sweep: every (from,to,actor) combination outside the rule table is denied", () => {
    const ruleFor = (from: string, to: string): TransitionRule | undefined =>
      TRANSITION_RULES.find((r) => r.from === from && r.to === to);
    let checked = 0;
    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        for (const actor of ACTOR_CATEGORIES) {
          const matched = ruleFor(from, to);
          if (matched !== undefined && matched.actors.includes(actor)) {
            const result = canTransition(satisfyingInput(matched, actor));
            expect(result.allowed, `${from}>${to}>${actor}`).toBe(true);
          } else {
            // Build a plausibly-complete input anyway; it must still deny.
            const input: CanTransitionInput = {
              from,
              to,
              actor,
              ...(to === "BLOCKED" ? { reasonCode: "policy" as const } : {}),
              ...(from === "BLOCKED" ? { currentBlockedReason: "queue-lock" as const } : {}),
              evidence: TRANSITION_EVIDENCE,
            };
            const result = canTransition(input);
            expect(result.allowed, `${from}>${to}>${actor}`).toBe(false);
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
    for (const actor of ACTOR_CATEGORIES.filter((a) => a !== "owner")) {
      expect(denyCode(canTransition({ from: "AWAITING_APPROVAL", to: "APPROVED", actor }))).toBe(
        "ACTOR_NOT_PERMITTED",
      );
    }
  });

  it("the bridge cannot act directly — even with full evidence it is not an actor", () => {
    expect(
      denyCode(
        canTransition({
          from: "RUNNING",
          to: "RESULT_CAPTURED",
          actor: "local-bridge",
          evidence: ["bridge-execution-report"],
        }),
      ),
    ).toBe("ACTOR_NOT_PERMITTED");
    expect(
      denyCode(
        canTransition({
          from: "CANCELLING",
          to: "CANCELLED",
          actor: "local-bridge",
          evidence: ["bridge-kill-confirmation"],
        }),
      ),
    ).toBe("ACTOR_NOT_PERMITTED");
  });

  it("a worker can never move any task", () => {
    for (const rule of TRANSITION_RULES) {
      const result = canTransition({ ...satisfyingInput(rule, "worker") });
      expect(result.allowed).toBe(false);
    }
  });
});

describe("evidence corroboration (correction 3)", () => {
  it("dispatch cannot become RUNNING without the bridge acknowledgement", () => {
    expect(
      denyCode(canTransition({ from: "AWAITING_DISPATCH", to: "RUNNING", actor: "control-plane" })),
    ).toBe("MISSING_REQUIRED_EVIDENCE");
    expect(
      denyCode(
        canTransition({
          from: "AWAITING_DISPATCH",
          to: "RUNNING",
          actor: "control-plane",
          evidence: ["grant-verified"],
        }),
      ),
    ).toBe("MISSING_REQUIRED_EVIDENCE");
  });

  it("RUNNING outcomes require a bridge execution report", () => {
    expect(
      denyCode(canTransition({ from: "RUNNING", to: "RESULT_CAPTURED", actor: "control-plane" })),
    ).toBe("MISSING_REQUIRED_EVIDENCE");
    expect(denyCode(canTransition({ from: "RUNNING", to: "FAILED", actor: "control-plane" }))).toBe(
      "MISSING_REQUIRED_EVIDENCE",
    );
  });

  it("integration outcomes require BOTH the integration report and grant verification", () => {
    for (const to of ["COMPLETED", "FAILED"] as const) {
      expect(denyCode(canTransition({ from: "APPROVED", to, actor: "control-plane" }))).toBe(
        "MISSING_REQUIRED_EVIDENCE",
      );
      expect(
        denyCode(
          canTransition({
            from: "APPROVED",
            to,
            actor: "control-plane",
            evidence: ["bridge-integration-report"],
          }),
        ),
      ).toBe("MISSING_REQUIRED_EVIDENCE");
      expect(
        denyCode(
          canTransition({ from: "APPROVED", to, actor: "control-plane", evidence: ["grant-verified"] }),
        ),
      ).toBe("MISSING_REQUIRED_EVIDENCE");
      allow(
        canTransition({
          from: "APPROVED",
          to,
          actor: "control-plane",
          evidence: ["bridge-integration-report", "grant-verified"],
        }),
      );
    }
  });

  it("cancellation completes only on the bridge kill confirmation", () => {
    expect(denyCode(canTransition({ from: "CANCELLING", to: "CANCELLED", actor: "control-plane" }))).toBe(
      "MISSING_REQUIRED_EVIDENCE",
    );
    allow(
      canTransition({
        from: "CANCELLING",
        to: "CANCELLED",
        actor: "control-plane",
        evidence: ["bridge-kill-confirmation"],
      }),
    );
  });
});

describe("cancellation semantics (D-020)", () => {
  it("in-flight states cancel via CANCELLING", () => {
    allow(canTransition({ from: "AWAITING_DISPATCH", to: "CANCELLING", actor: "owner" }));
    allow(canTransition({ from: "RUNNING", to: "CANCELLING", actor: "owner" }));
    allow(canTransition({ from: "APPROVED", to: "CANCELLING", actor: "owner" }));
    expect(denyCode(canTransition({ from: "RUNNING", to: "CANCELLED", actor: "owner" }))).toBe(
      "UNKNOWN_TRANSITION",
    );
    expect(denyCode(canTransition({ from: "APPROVED", to: "CANCELLED", actor: "owner" }))).toBe(
      "UNKNOWN_TRANSITION",
    );
  });

  it("passive states cancel directly to CANCELLED", () => {
    allow(canTransition({ from: "DRAFT", to: "CANCELLED", actor: "owner" }));
    allow(canTransition({ from: "CONTEXT_PREPARING", to: "CANCELLED", actor: "owner" }));
    allow(canTransition({ from: "RESULT_CAPTURED", to: "CANCELLED", actor: "owner" }));
    allow(canTransition({ from: "AWAITING_APPROVAL", to: "CANCELLED", actor: "owner" }));
    allow(canTransition({ from: "REVISION_REQUESTED", to: "CANCELLED", actor: "owner" }));
    allow(
      canTransition({
        from: "BLOCKED",
        to: "CANCELLED",
        actor: "owner",
        currentBlockedReason: "queue-lock",
      }),
    );
  });

  it("passive states may not detour through CANCELLING", () => {
    expect(denyCode(canTransition({ from: "DRAFT", to: "CANCELLING", actor: "owner" }))).toBe(
      "UNKNOWN_TRANSITION",
    );
    expect(
      denyCode(canTransition({ from: "AWAITING_APPROVAL", to: "CANCELLING", actor: "owner" })),
    ).toBe("UNKNOWN_TRANSITION");
  });

  it("no other actor may cancel", () => {
    for (const actor of ACTOR_CATEGORIES.filter((a) => a !== "owner")) {
      expect(denyCode(canTransition({ from: "RUNNING", to: "CANCELLING", actor }))).toBe(
        "ACTOR_NOT_PERMITTED",
      );
    }
  });
});

describe("execution-unknown reconciliation (correction 2)", () => {
  const eu = { from: "BLOCKED" as const, currentBlockedReason: "execution-unknown" as const };

  it("ordinary re-dispatch of execution-unknown is refused even for the owner", () => {
    expect(denyCode(canTransition({ ...eu, to: "AWAITING_DISPATCH", actor: "owner" }))).toBe(
      "RECONCILIATION_REQUIRED",
    );
    expect(denyCode(canTransition({ ...eu, to: "AWAITING_DISPATCH", actor: "control-plane" }))).toBe(
      "RECONCILIATION_REQUIRED",
    );
    expect(denyCode(canTransition({ ...eu, to: "AWAITING_DISPATCH", actor: "system-recovery" }))).toBe(
      "RECONCILIATION_REQUIRED",
    );
  });

  it("ordinary cancellation cannot hide an unresolved execution outcome", () => {
    expect(denyCode(canTransition({ ...eu, to: "CANCELLED", actor: "owner" }))).toBe(
      "RECONCILIATION_REQUIRED",
    );
  });

  it("confirmed-completed: owner + outcome + evidence -> COMPLETED", () => {
    allow(
      canTransition({
        ...eu,
        to: "COMPLETED",
        actor: "owner",
        reconciliationOutcome: "confirmed-completed",
        evidence: ["owner-reconciliation"],
      }),
    );
  });

  it("confirmed-failed: owner + outcome + evidence -> FAILED", () => {
    allow(
      canTransition({
        ...eu,
        to: "FAILED",
        actor: "owner",
        reconciliationOutcome: "confirmed-failed",
        evidence: ["owner-reconciliation"],
      }),
    );
  });

  it("confirmed-not-executed: owner + outcome + evidence + new attempt -> CONTEXT_PREPARING", () => {
    allow(
      canTransition({
        ...eu,
        to: "CONTEXT_PREPARING",
        actor: "owner",
        reconciliationOutcome: "confirmed-not-executed",
        evidence: ["owner-reconciliation"],
        isNewAttempt: true,
      }),
    );
    expect(
      denyCode(
        canTransition({
          ...eu,
          to: "CONTEXT_PREPARING",
          actor: "owner",
          reconciliationOutcome: "confirmed-not-executed",
          evidence: ["owner-reconciliation"],
        }),
      ),
    ).toBe("NEW_ATTEMPT_REQUIRED");
  });

  it("a missing or wrong outcome is refused", () => {
    expect(
      denyCode(
        canTransition({ ...eu, to: "COMPLETED", actor: "owner", evidence: ["owner-reconciliation"] }),
      ),
    ).toBe("INVALID_RECONCILIATION_OUTCOME");
    expect(
      denyCode(
        canTransition({
          ...eu,
          to: "COMPLETED",
          actor: "owner",
          reconciliationOutcome: "confirmed-failed",
          evidence: ["owner-reconciliation"],
        }),
      ),
    ).toBe("INVALID_RECONCILIATION_OUTCOME");
  });

  it("missing reconciliation evidence is refused", () => {
    expect(
      denyCode(
        canTransition({
          ...eu,
          to: "COMPLETED",
          actor: "owner",
          reconciliationOutcome: "confirmed-completed",
        }),
      ),
    ).toBe("RECONCILIATION_EVIDENCE_REQUIRED");
  });

  it("no automated actor may reconcile", () => {
    for (const actor of ACTOR_CATEGORIES.filter((a) => a !== "owner")) {
      expect(
        denyCode(
          canTransition({
            ...eu,
            to: "COMPLETED",
            actor,
            reconciliationOutcome: "confirmed-completed",
            evidence: ["owner-reconciliation"],
          }),
        ),
      ).toBe("ACTOR_NOT_PERMITTED");
    }
  });

  it("reconciliation exits are not available for ordinary blocked reasons", () => {
    expect(
      denyCode(
        canTransition({
          from: "BLOCKED",
          to: "COMPLETED",
          actor: "owner",
          currentBlockedReason: "queue-lock",
          reconciliationOutcome: "confirmed-completed",
          evidence: ["owner-reconciliation"],
        }),
      ),
    ).toBe("RECONCILIATION_NOT_APPLICABLE");
  });

  it("reconciliationOutcome may not be smuggled onto ordinary transitions", () => {
    expect(
      denyCode(
        canTransition({
          from: "DRAFT",
          to: "CONTEXT_PREPARING",
          actor: "owner",
          reconciliationOutcome: "confirmed-completed",
        }),
      ),
    ).toBe("UNEXPECTED_RECONCILIATION_OUTCOME");
  });

  it("ordinary blocked reasons still unblock normally", () => {
    allow(
      canTransition({
        from: "BLOCKED",
        to: "AWAITING_DISPATCH",
        actor: "control-plane",
        currentBlockedReason: "queue-lock",
      }),
    );
  });
});

describe("retry / new-attempt rule", () => {
  it("retry of a failed task requires a new immutable attempt by the owner", () => {
    expect(denyCode(canTransition({ from: "FAILED", to: "CONTEXT_PREPARING", actor: "owner" }))).toBe(
      "NEW_ATTEMPT_REQUIRED",
    );
    const ok = allow(
      canTransition({ from: "FAILED", to: "CONTEXT_PREPARING", actor: "owner", isNewAttempt: true }),
    );
    if (ok.allowed) expect(ok.requiresNewAttempt).toBe(true);
    for (const actor of ACTOR_CATEGORIES.filter((a) => a !== "owner")) {
      expect(
        denyCode(canTransition({ from: "FAILED", to: "CONTEXT_PREPARING", actor, isNewAttempt: true })),
      ).toBe("ACTOR_NOT_PERMITTED");
    }
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
});

describe("input validation", () => {
  it("rejects unknown states, actors, evidence, and outcomes at the schema boundary", () => {
    expect(() => canTransition({ from: "LIMBO" as never, to: "RUNNING", actor: "owner" })).toThrow();
    expect(() =>
      canTransition({ from: "DRAFT", to: "CONTEXT_PREPARING", actor: "root" as never }),
    ).toThrow();
    expect(() =>
      canTransition({
        from: "AWAITING_DISPATCH",
        to: "RUNNING",
        actor: "control-plane",
        evidence: ["pinky-promise" as never],
      }),
    ).toThrow();
    expect(() =>
      canTransition({
        from: "BLOCKED",
        to: "COMPLETED",
        actor: "owner",
        currentBlockedReason: "execution-unknown",
        reconciliationOutcome: "probably-fine" as never,
      }),
    ).toThrow();
  });
});
