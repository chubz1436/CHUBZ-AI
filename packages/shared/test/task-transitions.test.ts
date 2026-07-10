import { describe, expect, it } from "vitest";
import {
  ACTOR_CATEGORIES,
  BLOCKED_OPERATIONS,
  BLOCKED_OPERATION_MATRIX,
  RECONCILIATION_MATRIX,
  RECONCILIATION_OUTCOMES,
  TASK_STATES,
  TERMINAL_STATES,
  TRANSITION_EVIDENCE,
  TRANSITION_RULES,
  canTransition,
  legalTransitionsFrom,
  type BlockedContext,
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

// ---- Trusted blocked-context fixtures ----
const ctxContextPrep: BlockedContext = {
  blockedFrom: "CONTEXT_PREPARING",
  blockedOperation: "context-preparation",
  blockedReason: "missing-context",
  attemptId: "attempt-1",
  operationId: "op-ctx-1",
};
const ctxDispatchOrdinary: BlockedContext = {
  blockedFrom: "AWAITING_DISPATCH",
  blockedOperation: "worker-dispatch",
  blockedReason: "queue-lock",
  attemptId: "attempt-1",
  operationId: "op-disp-1",
};
const ctxDispatchUnknown: BlockedContext = {
  blockedFrom: "AWAITING_DISPATCH",
  blockedOperation: "worker-dispatch",
  blockedReason: "execution-unknown",
  attemptId: "attempt-1",
  operationId: "op-disp-1",
  journalRef: "journal-disp-1",
};
const ctxExecUnknown: BlockedContext = {
  blockedFrom: "RUNNING",
  blockedOperation: "worker-execution",
  blockedReason: "execution-unknown",
  attemptId: "attempt-1",
  operationId: "op-exec-1",
  journalRef: "journal-exec-1",
};
const ctxIntegrationConflict: BlockedContext = {
  blockedFrom: "APPROVED",
  blockedOperation: "integration",
  blockedReason: "conflict",
  attemptId: "attempt-1",
  operationId: "op-int-1",
};
const ctxIntegrationUnknown: BlockedContext = {
  blockedFrom: "APPROVED",
  blockedOperation: "integration",
  blockedReason: "execution-unknown",
  attemptId: "attempt-1",
  operationId: "op-int-1",
  journalRef: "journal-int-1",
};

/** Proposed entry context appropriate for each BLOCK-capable source state. */
const proposedFor = (from: string): BlockedContext => {
  switch (from) {
    case "CONTEXT_PREPARING":
      return ctxContextPrep;
    case "AWAITING_DISPATCH":
      return ctxDispatchOrdinary;
    case "RUNNING":
      return ctxExecUnknown;
    case "APPROVED":
      return ctxIntegrationUnknown;
    default:
      throw new Error(`no blocked entry from ${from}`);
  }
};

/** Minimal fully-satisfying input for a table rule (non-BLOCKED origin). */
const satisfyingInput = (
  rule: TransitionRule,
  actor: (typeof ACTOR_CATEGORIES)[number],
): CanTransitionInput => ({
  from: rule.from,
  to: rule.to,
  actor,
  ...(rule.to === "BLOCKED" ? { proposedBlockedContext: proposedFor(rule.from) } : {}),
  ...(rule.requiredEvidence.length > 0 ? { evidence: rule.requiredEvidence } : {}),
  ...(rule.requiresNewAttemptId ? { nextAttemptId: "attempt-2" as const } : {}),
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

  it("no rule leaves a terminal state, and BLOCKED has no free-form outbound rules", () => {
    for (const rule of TRANSITION_RULES) {
      expect(TERMINAL_STATES).not.toContain(rule.from);
      expect(rule.from).not.toBe("BLOCKED");
    }
    for (const terminal of TERMINAL_STATES) {
      expect(legalTransitionsFrom(terminal)).toEqual([]);
    }
    expect(legalTransitionsFrom("BLOCKED")).toEqual([]);
  });

  it("bridge, worker, and reviewer are never transition actors", () => {
    for (const rule of TRANSITION_RULES) {
      expect(rule.actors).not.toContain("local-bridge");
      expect(rule.actors).not.toContain("worker");
      expect(rule.actors).not.toContain("reviewer");
    }
  });

  it("the matrices cover exactly the documented operations and outcomes", () => {
    expect(Object.keys(BLOCKED_OPERATION_MATRIX).sort()).toEqual([...BLOCKED_OPERATIONS].sort());
    expect(BLOCKED_OPERATION_MATRIX["context-preparation"].executionUnknownAllowed).toBe(false);
    for (const op of ["worker-dispatch", "worker-execution", "integration"] as const) {
      const outcomes = RECONCILIATION_MATRIX[op];
      expect(outcomes).toBeDefined();
      expect(Object.keys(outcomes ?? {}).sort()).toEqual([...RECONCILIATION_OUTCOMES].sort());
    }
    expect(RECONCILIATION_MATRIX["context-preparation"]).toBeUndefined();
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

  it("entering BLOCKED with a matching proposed context", () => {
    allow(
      canTransition({
        from: "CONTEXT_PREPARING",
        to: "BLOCKED",
        actor: "control-plane",
        proposedBlockedContext: ctxContextPrep,
      }),
    );
    allow(
      canTransition({
        from: "RUNNING",
        to: "BLOCKED",
        actor: "system-recovery",
        proposedBlockedContext: ctxExecUnknown,
      }),
    );
    allow(
      canTransition({
        from: "APPROVED",
        to: "BLOCKED",
        actor: "system-recovery",
        proposedBlockedContext: ctxIntegrationConflict,
      }),
    );
  });
});

describe("trusted blocked context (correction 1)", () => {
  it("entering BLOCKED requires a proposed context", () => {
    expect(
      denyCode(canTransition({ from: "CONTEXT_PREPARING", to: "BLOCKED", actor: "control-plane" })),
    ).toBe("BLOCKED_CONTEXT_REQUIRED");
  });

  it("blocked source mismatch is rejected", () => {
    expect(
      denyCode(
        canTransition({
          from: "AWAITING_DISPATCH",
          to: "BLOCKED",
          actor: "control-plane",
          proposedBlockedContext: ctxContextPrep, // claims CONTEXT_PREPARING
        }),
      ),
    ).toBe("BLOCKED_SOURCE_MISMATCH");
  });

  it("operation/source mismatch is rejected", () => {
    expect(
      denyCode(
        canTransition({
          from: "RUNNING",
          to: "BLOCKED",
          actor: "system-recovery",
          proposedBlockedContext: { ...ctxExecUnknown, blockedFrom: "RUNNING", blockedOperation: "worker-dispatch" },
        }),
      ),
    ).toBe("OPERATION_SOURCE_MISMATCH");
  });

  it("reason/operation mismatch is rejected — a caller cannot relabel execution-unknown as queue-lock", () => {
    expect(
      denyCode(
        canTransition({
          from: "BLOCKED",
          to: "RESULT_CAPTURED",
          actor: "control-plane",
          currentBlockedContext: { ...ctxExecUnknown, blockedReason: "queue-lock" },
        }),
      ),
    ).toBe("REASON_OPERATION_MISMATCH");
  });

  it("execution-unknown is rejected from context preparation", () => {
    expect(
      denyCode(
        canTransition({
          from: "CONTEXT_PREPARING",
          to: "BLOCKED",
          actor: "control-plane",
          proposedBlockedContext: {
            ...ctxContextPrep,
            blockedReason: "execution-unknown",
            journalRef: "journal-x",
          },
        }),
      ),
    ).toBe("REASON_OPERATION_MISMATCH");
  });

  it("execution-unknown without a trusted journal reference is rejected", () => {
    const { journalRef: _omitted, ...noJournal } = ctxExecUnknown;
    expect(
      denyCode(
        canTransition({
          from: "RUNNING",
          to: "BLOCKED",
          actor: "system-recovery",
          proposedBlockedContext: noJournal,
        }),
      ),
    ).toBe("JOURNAL_REF_REQUIRED");
  });

  it("leaving BLOCKED requires the stored trusted context", () => {
    expect(
      denyCode(canTransition({ from: "BLOCKED", to: "AWAITING_DISPATCH", actor: "control-plane" })),
    ).toBe("BLOCKED_CONTEXT_REQUIRED");
    expect(denyCode(canTransition({ from: "BLOCKED", to: "CANCELLED", actor: "owner" }))).toBe(
      "BLOCKED_CONTEXT_REQUIRED",
    );
  });

  it("blocked context is rejected when neither side is BLOCKED", () => {
    expect(
      denyCode(
        canTransition({
          from: "RUNNING",
          to: "CANCELLING",
          actor: "owner",
          currentBlockedContext: ctxExecUnknown,
        }),
      ),
    ).toBe("UNEXPECTED_BLOCKED_CONTEXT");
    expect(
      denyCode(
        canTransition({
          from: "DRAFT",
          to: "CONTEXT_PREPARING",
          actor: "owner",
          proposedBlockedContext: ctxContextPrep,
        }),
      ),
    ).toBe("UNEXPECTED_BLOCKED_CONTEXT");
  });

  it("a partial context cannot be supplied — the schema demands the full structure", () => {
    expect(() =>
      canTransition({
        from: "BLOCKED",
        to: "AWAITING_DISPATCH",
        actor: "control-plane",
        currentBlockedContext: { blockedReason: "queue-lock" } as never,
      }),
    ).toThrow();
  });
});

describe("ordinary blocked recovery is derived (correction 5)", () => {
  it("context-preparation blocker recovers to CONTEXT_PREPARING", () => {
    allow(
      canTransition({
        from: "BLOCKED",
        to: "CONTEXT_PREPARING",
        actor: "control-plane",
        currentBlockedContext: ctxContextPrep,
      }),
    );
  });

  it("worker-dispatch blocker recovers to AWAITING_DISPATCH", () => {
    allow(
      canTransition({
        from: "BLOCKED",
        to: "AWAITING_DISPATCH",
        actor: "control-plane",
        currentBlockedContext: ctxDispatchOrdinary,
      }),
    );
    allow(
      canTransition({
        from: "BLOCKED",
        to: "AWAITING_DISPATCH",
        actor: "owner",
        currentBlockedContext: ctxDispatchOrdinary,
      }),
    );
  });

  it("integration conflict recovers to APPROVED — the approved stage is never discarded", () => {
    allow(
      canTransition({
        from: "BLOCKED",
        to: "APPROVED",
        actor: "control-plane",
        currentBlockedContext: ctxIntegrationConflict,
      }),
    );
    expect(
      denyCode(
        canTransition({
          from: "BLOCKED",
          to: "AWAITING_DISPATCH",
          actor: "control-plane",
          currentBlockedContext: ctxIntegrationConflict,
        }),
      ),
    ).toBe("INVALID_RECOVERY_TARGET");
  });

  it("universal BLOCKED -> AWAITING_DISPATCH no longer exists", () => {
    expect(
      denyCode(
        canTransition({
          from: "BLOCKED",
          to: "AWAITING_DISPATCH",
          actor: "control-plane",
          currentBlockedContext: ctxContextPrep,
        }),
      ),
    ).toBe("INVALID_RECOVERY_TARGET");
  });

  it("uncertain worker execution has no ordinary recovery", () => {
    expect(
      denyCode(
        canTransition({
          from: "BLOCKED",
          to: "RUNNING",
          actor: "control-plane",
          currentBlockedContext: ctxExecUnknown,
        }),
      ),
    ).toBe("RECONCILIATION_REQUIRED");
  });

  it("ordinary blocked cancellation stays owner-only", () => {
    allow(
      canTransition({
        from: "BLOCKED",
        to: "CANCELLED",
        actor: "owner",
        currentBlockedContext: ctxDispatchOrdinary,
      }),
    );
    expect(
      denyCode(
        canTransition({
          from: "BLOCKED",
          to: "CANCELLED",
          actor: "control-plane",
          currentBlockedContext: ctxDispatchOrdinary,
        }),
      ),
    ).toBe("ACTOR_NOT_PERMITTED");
  });

  it("no other actor may perform ordinary recovery", () => {
    for (const actor of ["local-bridge", "worker", "reviewer", "system-recovery"] as const) {
      expect(
        denyCode(
          canTransition({
            from: "BLOCKED",
            to: "AWAITING_DISPATCH",
            actor,
            currentBlockedContext: ctxDispatchOrdinary,
          }),
        ),
      ).toBe("ACTOR_NOT_PERMITTED");
    }
  });
});

describe("stage-aware reconciliation (correction 3)", () => {
  const ownerRecon = ["owner-reconciliation"] as const;

  describe("worker dispatch", () => {
    it("confirmed-completed targets RUNNING only, with dispatch acknowledgement", () => {
      allow(
        canTransition({
          from: "BLOCKED",
          to: "RUNNING",
          actor: "owner",
          currentBlockedContext: ctxDispatchUnknown,
          reconciliationOutcome: "confirmed-completed",
          evidence: ["owner-reconciliation", "bridge-dispatch-ack"],
        }),
      );
      expect(
        denyCode(
          canTransition({
            from: "BLOCKED",
            to: "COMPLETED",
            actor: "owner",
            currentBlockedContext: ctxDispatchUnknown,
            reconciliationOutcome: "confirmed-completed",
            evidence: ["owner-reconciliation", "bridge-dispatch-ack"],
          }),
        ),
      ).toBe("INVALID_RECOVERY_TARGET");
      expect(
        denyCode(
          canTransition({
            from: "BLOCKED",
            to: "RUNNING",
            actor: "owner",
            currentBlockedContext: ctxDispatchUnknown,
            reconciliationOutcome: "confirmed-completed",
            evidence: ownerRecon, // missing the dispatch ack
          }),
        ),
      ).toBe("MISSING_REQUIRED_EVIDENCE");
    });

    it("confirmed-failed targets FAILED", () => {
      allow(
        canTransition({
          from: "BLOCKED",
          to: "FAILED",
          actor: "owner",
          currentBlockedContext: ctxDispatchUnknown,
          reconciliationOutcome: "confirmed-failed",
          evidence: ownerRecon,
        }),
      );
    });

    it("confirmed-not-executed targets AWAITING_DISPATCH with a NEW operation id", () => {
      allow(
        canTransition({
          from: "BLOCKED",
          to: "AWAITING_DISPATCH",
          actor: "owner",
          currentBlockedContext: ctxDispatchUnknown,
          reconciliationOutcome: "confirmed-not-executed",
          evidence: ownerRecon,
          nextOperationId: "op-disp-2",
        }),
      );
      expect(
        denyCode(
          canTransition({
            from: "BLOCKED",
            to: "AWAITING_DISPATCH",
            actor: "owner",
            currentBlockedContext: ctxDispatchUnknown,
            reconciliationOutcome: "confirmed-not-executed",
            evidence: ownerRecon,
          }),
        ),
      ).toBe("NEW_OPERATION_ID_REQUIRED");
      expect(
        denyCode(
          canTransition({
            from: "BLOCKED",
            to: "AWAITING_DISPATCH",
            actor: "owner",
            currentBlockedContext: ctxDispatchUnknown,
            reconciliationOutcome: "confirmed-not-executed",
            evidence: ownerRecon,
            nextOperationId: "op-disp-1", // reused
          }),
        ),
      ).toBe("OPERATION_ID_REUSED");
    });
  });

  describe("worker execution", () => {
    it("confirmed-completed targets RESULT_CAPTURED only — never straight to COMPLETED", () => {
      allow(
        canTransition({
          from: "BLOCKED",
          to: "RESULT_CAPTURED",
          actor: "owner",
          currentBlockedContext: ctxExecUnknown,
          reconciliationOutcome: "confirmed-completed",
          evidence: ["owner-reconciliation", "bridge-execution-report"],
        }),
      );
      expect(
        denyCode(
          canTransition({
            from: "BLOCKED",
            to: "COMPLETED",
            actor: "owner",
            currentBlockedContext: ctxExecUnknown,
            reconciliationOutcome: "confirmed-completed",
            evidence: ["owner-reconciliation", "bridge-execution-report"],
          }),
        ),
      ).toBe("INVALID_RECOVERY_TARGET");
    });

    it("confirmed-failed targets FAILED", () => {
      allow(
        canTransition({
          from: "BLOCKED",
          to: "FAILED",
          actor: "owner",
          currentBlockedContext: ctxExecUnknown,
          reconciliationOutcome: "confirmed-failed",
          evidence: ownerRecon,
        }),
      );
    });

    it("confirmed-not-executed targets CONTEXT_PREPARING with NEW attempt and operation ids", () => {
      allow(
        canTransition({
          from: "BLOCKED",
          to: "CONTEXT_PREPARING",
          actor: "owner",
          currentBlockedContext: ctxExecUnknown,
          reconciliationOutcome: "confirmed-not-executed",
          evidence: ownerRecon,
          nextAttemptId: "attempt-2",
          nextOperationId: "op-exec-2",
        }),
      );
      expect(
        denyCode(
          canTransition({
            from: "BLOCKED",
            to: "CONTEXT_PREPARING",
            actor: "owner",
            currentBlockedContext: ctxExecUnknown,
            reconciliationOutcome: "confirmed-not-executed",
            evidence: ownerRecon,
            nextOperationId: "op-exec-2",
          }),
        ),
      ).toBe("NEW_ATTEMPT_ID_REQUIRED");
      expect(
        denyCode(
          canTransition({
            from: "BLOCKED",
            to: "CONTEXT_PREPARING",
            actor: "owner",
            currentBlockedContext: ctxExecUnknown,
            reconciliationOutcome: "confirmed-not-executed",
            evidence: ownerRecon,
            nextAttemptId: "attempt-1", // reused — previous attempt is immutable
            nextOperationId: "op-exec-2",
          }),
        ),
      ).toBe("ATTEMPT_ID_REUSED");
    });
  });

  describe("integration", () => {
    it("confirmed-completed targets COMPLETED with report + grant evidence", () => {
      allow(
        canTransition({
          from: "BLOCKED",
          to: "COMPLETED",
          actor: "owner",
          currentBlockedContext: ctxIntegrationUnknown,
          reconciliationOutcome: "confirmed-completed",
          evidence: ["owner-reconciliation", "bridge-integration-report", "grant-verified"],
        }),
      );
      expect(
        denyCode(
          canTransition({
            from: "BLOCKED",
            to: "COMPLETED",
            actor: "owner",
            currentBlockedContext: ctxIntegrationUnknown,
            reconciliationOutcome: "confirmed-completed",
            evidence: ["owner-reconciliation", "bridge-integration-report"],
          }),
        ),
      ).toBe("MISSING_REQUIRED_EVIDENCE");
    });

    it("confirmed-failed targets FAILED", () => {
      allow(
        canTransition({
          from: "BLOCKED",
          to: "FAILED",
          actor: "owner",
          currentBlockedContext: ctxIntegrationUnknown,
          reconciliationOutcome: "confirmed-failed",
          evidence: ownerRecon,
        }),
      );
    });

    it("confirmed-not-executed returns to APPROVED with a NEW integration operation id", () => {
      allow(
        canTransition({
          from: "BLOCKED",
          to: "APPROVED",
          actor: "owner",
          currentBlockedContext: ctxIntegrationUnknown,
          reconciliationOutcome: "confirmed-not-executed",
          evidence: ownerRecon,
          nextOperationId: "op-int-2",
        }),
      );
      expect(
        denyCode(
          canTransition({
            from: "BLOCKED",
            to: "APPROVED",
            actor: "owner",
            currentBlockedContext: ctxIntegrationUnknown,
            reconciliationOutcome: "confirmed-not-executed",
            evidence: ownerRecon,
            nextOperationId: "op-int-1", // reused
          }),
        ),
      ).toBe("OPERATION_ID_REUSED");
    });
  });

  describe("invalid reconciliation", () => {
    it("reconciliation of ordinary blocked reasons is not applicable", () => {
      expect(
        denyCode(
          canTransition({
            from: "BLOCKED",
            to: "AWAITING_DISPATCH",
            actor: "owner",
            currentBlockedContext: ctxDispatchOrdinary,
            reconciliationOutcome: "confirmed-not-executed",
            evidence: ownerRecon,
            nextOperationId: "op-disp-2",
          }),
        ),
      ).toBe("RECONCILIATION_NOT_APPLICABLE");
    });

    it("execution-unknown cannot be resolved without an outcome", () => {
      expect(
        denyCode(
          canTransition({
            from: "BLOCKED",
            to: "AWAITING_DISPATCH",
            actor: "owner",
            currentBlockedContext: ctxDispatchUnknown,
          }),
        ),
      ).toBe("RECONCILIATION_REQUIRED");
    });

    it("ordinary cancellation cannot hide an unresolved execution outcome", () => {
      for (const ctx of [ctxDispatchUnknown, ctxExecUnknown, ctxIntegrationUnknown]) {
        expect(
          denyCode(
            canTransition({
              from: "BLOCKED",
              to: "CANCELLED",
              actor: "owner",
              currentBlockedContext: ctx,
            }),
          ),
        ).toBe("RECONCILIATION_REQUIRED");
      }
    });

    it("missing reconciliation evidence is refused", () => {
      expect(
        denyCode(
          canTransition({
            from: "BLOCKED",
            to: "RESULT_CAPTURED",
            actor: "owner",
            currentBlockedContext: ctxExecUnknown,
            reconciliationOutcome: "confirmed-completed",
            evidence: ["bridge-execution-report"],
          }),
        ),
      ).toBe("RECONCILIATION_EVIDENCE_REQUIRED");
    });

    it("no automated actor may reconcile", () => {
      for (const actor of ACTOR_CATEGORIES.filter((a) => a !== "owner")) {
        expect(
          denyCode(
            canTransition({
              from: "BLOCKED",
              to: "FAILED",
              actor,
              currentBlockedContext: ctxExecUnknown,
              reconciliationOutcome: "confirmed-failed",
              evidence: ownerRecon,
            }),
          ),
        ).toBe("ACTOR_NOT_PERMITTED");
      }
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
  });
});

describe("evidence corroboration", () => {
  it("dispatch cannot become RUNNING without the bridge acknowledgement", () => {
    expect(
      denyCode(canTransition({ from: "AWAITING_DISPATCH", to: "RUNNING", actor: "control-plane" })),
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
    }
  });

  it("cancellation completes only on the bridge kill confirmation", () => {
    expect(
      denyCode(canTransition({ from: "CANCELLING", to: "CANCELLED", actor: "control-plane" })),
    ).toBe("MISSING_REQUIRED_EVIDENCE");
    allow(
      canTransition({
        from: "CANCELLING",
        to: "CANCELLED",
        actor: "control-plane",
        evidence: ["bridge-kill-confirmation"],
      }),
    );
  });

  it("the bridge cannot act directly even with full evidence", () => {
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
  });
});

describe("cancellation semantics (D-020)", () => {
  it("in-flight states cancel via CANCELLING; passive states cancel directly", () => {
    allow(canTransition({ from: "AWAITING_DISPATCH", to: "CANCELLING", actor: "owner" }));
    allow(canTransition({ from: "RUNNING", to: "CANCELLING", actor: "owner" }));
    allow(canTransition({ from: "APPROVED", to: "CANCELLING", actor: "owner" }));
    allow(canTransition({ from: "DRAFT", to: "CANCELLED", actor: "owner" }));
    allow(canTransition({ from: "CONTEXT_PREPARING", to: "CANCELLED", actor: "owner" }));
    allow(canTransition({ from: "RESULT_CAPTURED", to: "CANCELLED", actor: "owner" }));
    allow(canTransition({ from: "AWAITING_APPROVAL", to: "CANCELLED", actor: "owner" }));
    allow(canTransition({ from: "REVISION_REQUESTED", to: "CANCELLED", actor: "owner" }));
    expect(denyCode(canTransition({ from: "RUNNING", to: "CANCELLED", actor: "owner" }))).toBe(
      "UNKNOWN_TRANSITION",
    );
    expect(denyCode(canTransition({ from: "DRAFT", to: "CANCELLING", actor: "owner" }))).toBe(
      "UNKNOWN_TRANSITION",
    );
  });
});

describe("retry / new-attempt identity (correction 4)", () => {
  it("a boolean-style claim is impossible — an explicit new attempt id is required", () => {
    expect(denyCode(canTransition({ from: "FAILED", to: "CONTEXT_PREPARING", actor: "owner" }))).toBe(
      "NEW_ATTEMPT_ID_REQUIRED",
    );
    allow(
      canTransition({
        from: "FAILED",
        to: "CONTEXT_PREPARING",
        actor: "owner",
        nextAttemptId: "attempt-2",
      }),
    );
  });

  it("a reused attempt id is rejected when the current id is known", () => {
    expect(
      denyCode(
        canTransition({
          from: "FAILED",
          to: "CONTEXT_PREPARING",
          actor: "owner",
          currentAttemptId: "attempt-1",
          nextAttemptId: "attempt-1",
        }),
      ),
    ).toBe("ATTEMPT_ID_REUSED");
  });

  it("revision rework likewise requires a new attempt identity", () => {
    expect(
      denyCode(canTransition({ from: "REVISION_REQUESTED", to: "CONTEXT_PREPARING", actor: "owner" })),
    ).toBe("NEW_ATTEMPT_ID_REQUIRED");
    allow(
      canTransition({
        from: "REVISION_REQUESTED",
        to: "CONTEXT_PREPARING",
        actor: "owner",
        nextAttemptId: "attempt-2",
      }),
    );
  });

  it("empty identity strings are rejected at the schema boundary", () => {
    expect(() =>
      canTransition({ from: "FAILED", to: "CONTEXT_PREPARING", actor: "owner", nextAttemptId: "" }),
    ).toThrow();
  });
});

describe("deny-by-default", () => {
  it("terminal states never restart", () => {
    for (const terminal of TERMINAL_STATES) {
      for (const to of TASK_STATES) {
        if (to === terminal) continue;
        expect(denyCode(canTransition({ from: terminal, to, actor: "owner" }))).toBe(
          "TERMINAL_STATE",
        );
      }
    }
  });

  it("exhaustive sweep: every (from,to,actor) combination outside the contract is denied", () => {
    let checked = 0;
    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        for (const actor of ACTOR_CATEGORIES) {
          if (from === "BLOCKED") {
            // Without the stored trusted context, nothing leaves BLOCKED.
            const result = canTransition({ from, to, actor });
            expect(result.allowed, `${from}>${to}>${actor}`).toBe(false);
          } else {
            const matched = TRANSITION_RULES.find((r) => r.from === from && r.to === to);
            if (matched !== undefined && matched.actors.includes(actor)) {
              const result = canTransition(satisfyingInput(matched, actor));
              expect(result.allowed, `${from}>${to}>${actor}`).toBe(true);
            } else {
              const input: CanTransitionInput = {
                from,
                to,
                actor,
                ...(to === "BLOCKED" && matched !== undefined
                  ? { proposedBlockedContext: proposedFor(from) }
                  : {}),
                evidence: TRANSITION_EVIDENCE,
              };
              const result = canTransition(input);
              expect(result.allowed, `${from}>${to}>${actor}`).toBe(false);
            }
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBe(TASK_STATES.length * TASK_STATES.length * ACTOR_CATEGORIES.length);
  });
});

describe("input validation", () => {
  it("rejects unknown states, actors, evidence, outcomes, and operations at the schema boundary", () => {
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
        from: "RUNNING",
        to: "BLOCKED",
        actor: "system-recovery",
        proposedBlockedContext: { ...ctxExecUnknown, blockedOperation: "vibes" as never },
      }),
    ).toThrow();
  });
});
