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
  type TaskState,
  type TransitionRequest,
  type TransitionRule,
  type TrustedCurrentSnapshot,
} from "../src/index.js";

const allow = (r: ReturnType<typeof canTransition>) => {
  if (!r.allowed) throw new Error(`expected allow, got ${r.code}: ${r.message}`);
  return r;
};
const denyCode = (r: ReturnType<typeof canTransition>) => {
  if (r.allowed) throw new Error("expected denial");
  return r.code;
};

/** Shorthand: trusted snapshot with a default current attempt id. */
const snap = (
  state: TaskState,
  extra: Partial<Omit<TrustedCurrentSnapshot, "state">> = {},
): TrustedCurrentSnapshot => ({ state, attemptId: "attempt-1", ...extra });

const tr = (current: TrustedCurrentSnapshot, request: TransitionRequest) =>
  canTransition({ current, request });

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

const blockedSnap = (ctx: BlockedContext): TrustedCurrentSnapshot =>
  snap("BLOCKED", { blockedContext: ctx });

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

/** Minimal fully-satisfying request for a table rule (non-BLOCKED origin). */
const satisfyingRequest = (
  rule: TransitionRule,
  actor: (typeof ACTOR_CATEGORIES)[number],
): TransitionRequest => ({
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
    allow(tr(snap("DRAFT"), { to: "CONTEXT_PREPARING", actor: "owner" }));
    allow(tr(snap("CONTEXT_PREPARING"), { to: "AWAITING_DISPATCH", actor: "control-plane" }));
    allow(
      tr(snap("AWAITING_DISPATCH"), {
        to: "RUNNING",
        actor: "control-plane",
        evidence: ["bridge-dispatch-ack"],
      }),
    );
    allow(
      tr(snap("RUNNING"), {
        to: "RESULT_CAPTURED",
        actor: "control-plane",
        evidence: ["bridge-execution-report"],
      }),
    );
    allow(tr(snap("RESULT_CAPTURED"), { to: "AWAITING_APPROVAL", actor: "control-plane" }));
    const approved = allow(tr(snap("AWAITING_APPROVAL"), { to: "APPROVED", actor: "owner" }));
    if (approved.allowed) expect(approved.requiresOwnerApproval).toBe(true);
    allow(
      tr(snap("APPROVED"), {
        to: "COMPLETED",
        actor: "control-plane",
        evidence: ["bridge-integration-report", "grant-verified"],
      }),
    );
  });

  it("entering BLOCKED with a matching proposed context", () => {
    allow(
      tr(snap("CONTEXT_PREPARING"), {
        to: "BLOCKED",
        actor: "control-plane",
        proposedBlockedContext: ctxContextPrep,
      }),
    );
    allow(
      tr(snap("RUNNING"), {
        to: "BLOCKED",
        actor: "system-recovery",
        proposedBlockedContext: ctxExecUnknown,
      }),
    );
  });
});

describe("trusted snapshot boundary (D-022 correction 1)", () => {
  it("current.blockedContext is required when the current state is BLOCKED", () => {
    expect(denyCode(tr(snap("BLOCKED"), { to: "AWAITING_DISPATCH", actor: "control-plane" }))).toBe(
      "BLOCKED_CONTEXT_REQUIRED",
    );
    expect(denyCode(tr(snap("BLOCKED"), { to: "CANCELLED", actor: "owner" }))).toBe(
      "BLOCKED_CONTEXT_REQUIRED",
    );
  });

  it("current.blockedContext is rejected outside BLOCKED", () => {
    expect(
      denyCode(
        tr(snap("RUNNING", { blockedContext: ctxExecUnknown }), {
          to: "CANCELLING",
          actor: "owner",
        }),
      ),
    ).toBe("UNEXPECTED_BLOCKED_CONTEXT");
  });

  it("a request cannot provide a replacement current blocked context — the field does not exist", () => {
    expect(() =>
      canTransition({
        current: snap("BLOCKED", { blockedContext: ctxExecUnknown }),
        request: {
          to: "RESULT_CAPTURED",
          actor: "owner",
          currentBlockedContext: { ...ctxExecUnknown, blockedReason: "queue-lock" },
        } as never,
      }),
    ).toThrow();
    expect(() =>
      canTransition({
        current: snap("BLOCKED", { blockedContext: ctxExecUnknown }),
        request: { to: "RESULT_CAPTURED", actor: "owner", from: "AWAITING_APPROVAL" } as never,
      }),
    ).toThrow();
  });

  it("proposed blocked context is accepted only when entering BLOCKED", () => {
    expect(
      denyCode(
        tr(snap("DRAFT"), {
          to: "CONTEXT_PREPARING",
          actor: "owner",
          proposedBlockedContext: ctxContextPrep,
        }),
      ),
    ).toBe("UNEXPECTED_BLOCKED_CONTEXT");
    expect(denyCode(tr(snap("CONTEXT_PREPARING"), { to: "BLOCKED", actor: "control-plane" }))).toBe(
      "BLOCKED_CONTEXT_REQUIRED",
    );
  });

  it("proposed source must match the trusted current state", () => {
    expect(
      denyCode(
        tr(snap("AWAITING_DISPATCH"), {
          to: "BLOCKED",
          actor: "control-plane",
          proposedBlockedContext: ctxContextPrep, // claims CONTEXT_PREPARING
        }),
      ),
    ).toBe("BLOCKED_SOURCE_MISMATCH");
  });

  it("proposed attempt must match the trusted current attempt", () => {
    expect(
      denyCode(
        tr(snap("AWAITING_DISPATCH", { attemptId: "attempt-9" }), {
          to: "BLOCKED",
          actor: "control-plane",
          proposedBlockedContext: ctxDispatchOrdinary, // attempt-1
        }),
      ),
    ).toBe("ATTEMPT_ID_MISMATCH");
    expect(
      denyCode(
        tr(snap("AWAITING_DISPATCH", { attemptId: undefined }), {
          to: "BLOCKED",
          actor: "control-plane",
          proposedBlockedContext: ctxDispatchOrdinary,
        }),
      ),
    ).toBe("CURRENT_ATTEMPT_ID_REQUIRED");
  });

  it("proposed operation/source and reason/operation must be consistent, journalRef required", () => {
    expect(
      denyCode(
        tr(snap("RUNNING"), {
          to: "BLOCKED",
          actor: "system-recovery",
          proposedBlockedContext: { ...ctxExecUnknown, blockedOperation: "worker-dispatch" },
        }),
      ),
    ).toBe("OPERATION_SOURCE_MISMATCH");
    expect(
      denyCode(
        tr(snap("CONTEXT_PREPARING"), {
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
    const { journalRef: _omitted, ...noJournal } = ctxExecUnknown;
    expect(
      denyCode(
        tr(snap("RUNNING"), {
          to: "BLOCKED",
          actor: "system-recovery",
          proposedBlockedContext: noJournal,
        }),
      ),
    ).toBe("JOURNAL_REF_REQUIRED");
  });

  it("dispatch execution-unknown cannot be relabeled queue-lock for ordinary recovery — recovery reads only the stored context", () => {
    // The stored context says execution-unknown; there is no request
    // field to claim otherwise, so ordinary recovery is refused.
    expect(
      denyCode(
        tr(blockedSnap(ctxDispatchUnknown), { to: "AWAITING_DISPATCH", actor: "control-plane" }),
      ),
    ).toBe("RECONCILIATION_REQUIRED");
    // And a store snapshot that itself tries to relabel an execution
    // operation with an ordinary reason is internally inconsistent.
    expect(
      denyCode(
        tr(blockedSnap({ ...ctxExecUnknown, blockedReason: "queue-lock" }), {
          to: "AWAITING_DISPATCH",
          actor: "control-plane",
        }),
      ),
    ).toBe("REASON_OPERATION_MISMATCH");
  });

  it("execution and integration blocked contexts cannot be relabeled", () => {
    expect(
      denyCode(
        tr(blockedSnap({ ...ctxExecUnknown, blockedReason: "missing-context" }), {
          to: "CONTEXT_PREPARING",
          actor: "control-plane",
        }),
      ),
    ).toBe("REASON_OPERATION_MISMATCH");
    expect(
      denyCode(
        tr(blockedSnap({ ...ctxIntegrationUnknown, blockedReason: "queue-lock" }), {
          to: "APPROVED",
          actor: "control-plane",
        }),
      ),
    ).toBe("REASON_OPERATION_MISMATCH");
  });

  it("a snapshot whose attempt disagrees with its blocked context is inconsistent", () => {
    expect(
      denyCode(
        tr(snap("BLOCKED", { attemptId: "attempt-9", blockedContext: ctxDispatchOrdinary }), {
          to: "AWAITING_DISPATCH",
          actor: "control-plane",
        }),
      ),
    ).toBe("ATTEMPT_ID_MISMATCH");
  });
});

describe("ordinary blocked recovery is derived (D-021)", () => {
  it("context-preparation blocker recovers to CONTEXT_PREPARING", () => {
    allow(tr(blockedSnap(ctxContextPrep), { to: "CONTEXT_PREPARING", actor: "control-plane" }));
  });

  it("worker-dispatch blocker recovers to AWAITING_DISPATCH", () => {
    allow(tr(blockedSnap(ctxDispatchOrdinary), { to: "AWAITING_DISPATCH", actor: "control-plane" }));
    allow(tr(blockedSnap(ctxDispatchOrdinary), { to: "AWAITING_DISPATCH", actor: "owner" }));
  });

  it("integration conflict recovers to APPROVED only", () => {
    allow(tr(blockedSnap(ctxIntegrationConflict), { to: "APPROVED", actor: "control-plane" }));
    expect(
      denyCode(
        tr(blockedSnap(ctxIntegrationConflict), { to: "AWAITING_DISPATCH", actor: "control-plane" }),
      ),
    ).toBe("INVALID_RECOVERY_TARGET");
  });

  it("universal BLOCKED -> AWAITING_DISPATCH no longer exists", () => {
    expect(
      denyCode(tr(blockedSnap(ctxContextPrep), { to: "AWAITING_DISPATCH", actor: "control-plane" })),
    ).toBe("INVALID_RECOVERY_TARGET");
  });

  it("uncertain worker execution has no ordinary recovery", () => {
    expect(denyCode(tr(blockedSnap(ctxExecUnknown), { to: "RUNNING", actor: "control-plane" }))).toBe(
      "RECONCILIATION_REQUIRED",
    );
  });

  it("ordinary blocked cancellation stays owner-only", () => {
    allow(tr(blockedSnap(ctxDispatchOrdinary), { to: "CANCELLED", actor: "owner" }));
    expect(
      denyCode(tr(blockedSnap(ctxDispatchOrdinary), { to: "CANCELLED", actor: "control-plane" })),
    ).toBe("ACTOR_NOT_PERMITTED");
  });

  it("no other actor may perform ordinary recovery", () => {
    for (const actor of ["local-bridge", "worker", "reviewer", "system-recovery"] as const) {
      expect(
        denyCode(tr(blockedSnap(ctxDispatchOrdinary), { to: "AWAITING_DISPATCH", actor })),
      ).toBe("ACTOR_NOT_PERMITTED");
    }
  });
});

describe("stage-aware reconciliation with failure evidence (D-021/D-022)", () => {
  const ownerRecon = ["owner-reconciliation"] as const;

  describe("worker dispatch", () => {
    it("confirmed-completed targets RUNNING only, with dispatch acknowledgement", () => {
      allow(
        tr(blockedSnap(ctxDispatchUnknown), {
          to: "RUNNING",
          actor: "owner",
          reconciliationOutcome: "confirmed-completed",
          evidence: ["owner-reconciliation", "bridge-dispatch-ack"],
        }),
      );
      expect(
        denyCode(
          tr(blockedSnap(ctxDispatchUnknown), {
            to: "COMPLETED",
            actor: "owner",
            reconciliationOutcome: "confirmed-completed",
            evidence: ["owner-reconciliation", "bridge-dispatch-ack"],
          }),
        ),
      ).toBe("INVALID_RECOVERY_TARGET");
    });

    it("confirmed-failed requires the dispatch failure report; owner word alone is rejected", () => {
      expect(
        denyCode(
          tr(blockedSnap(ctxDispatchUnknown), {
            to: "FAILED",
            actor: "owner",
            reconciliationOutcome: "confirmed-failed",
            evidence: ownerRecon,
          }),
        ),
      ).toBe("MISSING_REQUIRED_EVIDENCE");
      // Evidence from the wrong stage does not satisfy it either.
      expect(
        denyCode(
          tr(blockedSnap(ctxDispatchUnknown), {
            to: "FAILED",
            actor: "owner",
            reconciliationOutcome: "confirmed-failed",
            evidence: ["owner-reconciliation", "bridge-execution-report"],
          }),
        ),
      ).toBe("MISSING_REQUIRED_EVIDENCE");
      allow(
        tr(blockedSnap(ctxDispatchUnknown), {
          to: "FAILED",
          actor: "owner",
          reconciliationOutcome: "confirmed-failed",
          evidence: ["owner-reconciliation", "bridge-dispatch-failure-report"],
        }),
      );
    });

    it("confirmed-not-executed targets AWAITING_DISPATCH with a NEW operation id", () => {
      allow(
        tr(blockedSnap(ctxDispatchUnknown), {
          to: "AWAITING_DISPATCH",
          actor: "owner",
          reconciliationOutcome: "confirmed-not-executed",
          evidence: ownerRecon,
          nextOperationId: "op-disp-2",
        }),
      );
      expect(
        denyCode(
          tr(blockedSnap(ctxDispatchUnknown), {
            to: "AWAITING_DISPATCH",
            actor: "owner",
            reconciliationOutcome: "confirmed-not-executed",
            evidence: ownerRecon,
            nextOperationId: "op-disp-1", // reused
          }),
        ),
      ).toBe("OPERATION_ID_REUSED");
    });
  });

  describe("worker execution", () => {
    it("confirmed-completed targets RESULT_CAPTURED only", () => {
      allow(
        tr(blockedSnap(ctxExecUnknown), {
          to: "RESULT_CAPTURED",
          actor: "owner",
          reconciliationOutcome: "confirmed-completed",
          evidence: ["owner-reconciliation", "bridge-execution-report"],
        }),
      );
      expect(
        denyCode(
          tr(blockedSnap(ctxExecUnknown), {
            to: "COMPLETED",
            actor: "owner",
            reconciliationOutcome: "confirmed-completed",
            evidence: ["owner-reconciliation", "bridge-execution-report"],
          }),
        ),
      ).toBe("INVALID_RECOVERY_TARGET");
    });

    it("confirmed-failed requires the execution report; owner word alone is rejected", () => {
      expect(
        denyCode(
          tr(blockedSnap(ctxExecUnknown), {
            to: "FAILED",
            actor: "owner",
            reconciliationOutcome: "confirmed-failed",
            evidence: ownerRecon,
          }),
        ),
      ).toBe("MISSING_REQUIRED_EVIDENCE");
      expect(
        denyCode(
          tr(blockedSnap(ctxExecUnknown), {
            to: "FAILED",
            actor: "owner",
            reconciliationOutcome: "confirmed-failed",
            evidence: ["owner-reconciliation", "bridge-dispatch-failure-report"], // wrong stage
          }),
        ),
      ).toBe("MISSING_REQUIRED_EVIDENCE");
      allow(
        tr(blockedSnap(ctxExecUnknown), {
          to: "FAILED",
          actor: "owner",
          reconciliationOutcome: "confirmed-failed",
          evidence: ["owner-reconciliation", "bridge-execution-report"],
        }),
      );
    });

    it("confirmed-not-executed targets CONTEXT_PREPARING with NEW attempt and operation ids", () => {
      allow(
        tr(blockedSnap(ctxExecUnknown), {
          to: "CONTEXT_PREPARING",
          actor: "owner",
          reconciliationOutcome: "confirmed-not-executed",
          evidence: ownerRecon,
          nextAttemptId: "attempt-2",
          nextOperationId: "op-exec-2",
        }),
      );
      expect(
        denyCode(
          tr(blockedSnap(ctxExecUnknown), {
            to: "CONTEXT_PREPARING",
            actor: "owner",
            reconciliationOutcome: "confirmed-not-executed",
            evidence: ownerRecon,
            nextOperationId: "op-exec-2",
          }),
        ),
      ).toBe("NEXT_ATTEMPT_ID_REQUIRED");
      expect(
        denyCode(
          tr(blockedSnap(ctxExecUnknown), {
            to: "CONTEXT_PREPARING",
            actor: "owner",
            reconciliationOutcome: "confirmed-not-executed",
            evidence: ownerRecon,
            nextAttemptId: "attempt-1", // reused — previous attempt is immutable
            nextOperationId: "op-exec-2",
          }),
        ),
      ).toBe("ATTEMPT_ID_REUSED");
      expect(
        denyCode(
          tr(snap("BLOCKED", { attemptId: undefined, blockedContext: ctxExecUnknown }), {
            to: "CONTEXT_PREPARING",
            actor: "owner",
            reconciliationOutcome: "confirmed-not-executed",
            evidence: ownerRecon,
            nextAttemptId: "attempt-2",
            nextOperationId: "op-exec-2",
          }),
        ),
      ).toBe("CURRENT_ATTEMPT_ID_REQUIRED");
    });
  });

  describe("integration", () => {
    it("confirmed-completed targets COMPLETED with report + grant evidence", () => {
      allow(
        tr(blockedSnap(ctxIntegrationUnknown), {
          to: "COMPLETED",
          actor: "owner",
          reconciliationOutcome: "confirmed-completed",
          evidence: ["owner-reconciliation", "bridge-integration-report", "grant-verified"],
        }),
      );
    });

    it("confirmed-failed requires report + grant evidence; owner word alone is rejected", () => {
      expect(
        denyCode(
          tr(blockedSnap(ctxIntegrationUnknown), {
            to: "FAILED",
            actor: "owner",
            reconciliationOutcome: "confirmed-failed",
            evidence: ownerRecon,
          }),
        ),
      ).toBe("MISSING_REQUIRED_EVIDENCE");
      expect(
        denyCode(
          tr(blockedSnap(ctxIntegrationUnknown), {
            to: "FAILED",
            actor: "owner",
            reconciliationOutcome: "confirmed-failed",
            evidence: ["owner-reconciliation", "bridge-integration-report"], // grant missing
          }),
        ),
      ).toBe("MISSING_REQUIRED_EVIDENCE");
      expect(
        denyCode(
          tr(blockedSnap(ctxIntegrationUnknown), {
            to: "FAILED",
            actor: "owner",
            reconciliationOutcome: "confirmed-failed",
            evidence: ["owner-reconciliation", "bridge-execution-report", "grant-verified"], // wrong stage
          }),
        ),
      ).toBe("MISSING_REQUIRED_EVIDENCE");
      allow(
        tr(blockedSnap(ctxIntegrationUnknown), {
          to: "FAILED",
          actor: "owner",
          reconciliationOutcome: "confirmed-failed",
          evidence: ["owner-reconciliation", "bridge-integration-report", "grant-verified"],
        }),
      );
    });

    it("confirmed-not-executed returns to APPROVED with a NEW integration operation id", () => {
      allow(
        tr(blockedSnap(ctxIntegrationUnknown), {
          to: "APPROVED",
          actor: "owner",
          reconciliationOutcome: "confirmed-not-executed",
          evidence: ownerRecon,
          nextOperationId: "op-int-2",
        }),
      );
      expect(
        denyCode(
          tr(blockedSnap(ctxIntegrationUnknown), {
            to: "APPROVED",
            actor: "owner",
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
          tr(blockedSnap(ctxDispatchOrdinary), {
            to: "AWAITING_DISPATCH",
            actor: "owner",
            reconciliationOutcome: "confirmed-not-executed",
            evidence: ownerRecon,
            nextOperationId: "op-disp-2",
          }),
        ),
      ).toBe("RECONCILIATION_NOT_APPLICABLE");
    });

    it("ordinary cancellation cannot hide an unresolved execution outcome", () => {
      for (const ctx of [ctxDispatchUnknown, ctxExecUnknown, ctxIntegrationUnknown]) {
        expect(denyCode(tr(blockedSnap(ctx), { to: "CANCELLED", actor: "owner" }))).toBe(
          "RECONCILIATION_REQUIRED",
        );
      }
    });

    it("missing reconciliation evidence is refused", () => {
      expect(
        denyCode(
          tr(blockedSnap(ctxExecUnknown), {
            to: "RESULT_CAPTURED",
            actor: "owner",
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
            tr(blockedSnap(ctxExecUnknown), {
              to: "FAILED",
              actor,
              reconciliationOutcome: "confirmed-failed",
              evidence: ["owner-reconciliation", "bridge-execution-report"],
            }),
          ),
        ).toBe("ACTOR_NOT_PERMITTED");
      }
    });

    it("reconciliationOutcome may not be smuggled onto ordinary transitions", () => {
      expect(
        denyCode(
          tr(snap("DRAFT"), {
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
    expect(denyCode(tr(snap("AWAITING_DISPATCH"), { to: "RUNNING", actor: "control-plane" }))).toBe(
      "MISSING_REQUIRED_EVIDENCE",
    );
  });

  it("RUNNING outcomes require a bridge execution report", () => {
    expect(denyCode(tr(snap("RUNNING"), { to: "RESULT_CAPTURED", actor: "control-plane" }))).toBe(
      "MISSING_REQUIRED_EVIDENCE",
    );
    expect(denyCode(tr(snap("RUNNING"), { to: "FAILED", actor: "control-plane" }))).toBe(
      "MISSING_REQUIRED_EVIDENCE",
    );
  });

  it("integration outcomes require BOTH the integration report and grant verification", () => {
    for (const to of ["COMPLETED", "FAILED"] as const) {
      expect(
        denyCode(
          tr(snap("APPROVED"), { to, actor: "control-plane", evidence: ["bridge-integration-report"] }),
        ),
      ).toBe("MISSING_REQUIRED_EVIDENCE");
    }
  });

  it("cancellation completes only on the bridge kill confirmation", () => {
    expect(denyCode(tr(snap("CANCELLING"), { to: "CANCELLED", actor: "control-plane" }))).toBe(
      "MISSING_REQUIRED_EVIDENCE",
    );
    allow(
      tr(snap("CANCELLING"), {
        to: "CANCELLED",
        actor: "control-plane",
        evidence: ["bridge-kill-confirmation"],
      }),
    );
  });

  it("the bridge cannot act directly even with full evidence", () => {
    expect(
      denyCode(
        tr(snap("RUNNING"), {
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
    allow(tr(snap("AWAITING_DISPATCH"), { to: "CANCELLING", actor: "owner" }));
    allow(tr(snap("RUNNING"), { to: "CANCELLING", actor: "owner" }));
    allow(tr(snap("APPROVED"), { to: "CANCELLING", actor: "owner" }));
    allow(tr(snap("DRAFT"), { to: "CANCELLED", actor: "owner" }));
    allow(tr(snap("CONTEXT_PREPARING"), { to: "CANCELLED", actor: "owner" }));
    allow(tr(snap("RESULT_CAPTURED"), { to: "CANCELLED", actor: "owner" }));
    allow(tr(snap("AWAITING_APPROVAL"), { to: "CANCELLED", actor: "owner" }));
    allow(tr(snap("REVISION_REQUESTED"), { to: "CANCELLED", actor: "owner" }));
    expect(denyCode(tr(snap("RUNNING"), { to: "CANCELLED", actor: "owner" }))).toBe(
      "UNKNOWN_TRANSITION",
    );
    expect(denyCode(tr(snap("DRAFT"), { to: "CANCELLING", actor: "owner" }))).toBe(
      "UNKNOWN_TRANSITION",
    );
  });
});

describe("attempt identity (D-022 correction 2)", () => {
  it("FAILED retry requires trusted current + distinct next attempt ids", () => {
    expect(
      denyCode(
        tr(snap("FAILED", { attemptId: undefined }), {
          to: "CONTEXT_PREPARING",
          actor: "owner",
          nextAttemptId: "attempt-2",
        }),
      ),
    ).toBe("CURRENT_ATTEMPT_ID_REQUIRED");
    expect(denyCode(tr(snap("FAILED"), { to: "CONTEXT_PREPARING", actor: "owner" }))).toBe(
      "NEXT_ATTEMPT_ID_REQUIRED",
    );
    expect(
      denyCode(
        tr(snap("FAILED"), { to: "CONTEXT_PREPARING", actor: "owner", nextAttemptId: "attempt-1" }),
      ),
    ).toBe("ATTEMPT_ID_REUSED");
    allow(
      tr(snap("FAILED"), { to: "CONTEXT_PREPARING", actor: "owner", nextAttemptId: "attempt-2" }),
    );
  });

  it("REVISION_REQUESTED retry has the same identity requirements", () => {
    expect(
      denyCode(
        tr(snap("REVISION_REQUESTED", { attemptId: undefined }), {
          to: "CONTEXT_PREPARING",
          actor: "owner",
          nextAttemptId: "attempt-2",
        }),
      ),
    ).toBe("CURRENT_ATTEMPT_ID_REQUIRED");
    expect(denyCode(tr(snap("REVISION_REQUESTED"), { to: "CONTEXT_PREPARING", actor: "owner" }))).toBe(
      "NEXT_ATTEMPT_ID_REQUIRED",
    );
    expect(
      denyCode(
        tr(snap("REVISION_REQUESTED"), {
          to: "CONTEXT_PREPARING",
          actor: "owner",
          nextAttemptId: "attempt-1",
        }),
      ),
    ).toBe("ATTEMPT_ID_REUSED");
    allow(
      tr(snap("REVISION_REQUESTED"), {
        to: "CONTEXT_PREPARING",
        actor: "owner",
        nextAttemptId: "attempt-2",
      }),
    );
  });

  it("empty identity strings are rejected at the schema boundary", () => {
    expect(() =>
      tr(snap("FAILED"), { to: "CONTEXT_PREPARING", actor: "owner", nextAttemptId: "" }),
    ).toThrow();
    expect(() =>
      canTransition({
        current: { state: "FAILED", attemptId: "" },
        request: { to: "CONTEXT_PREPARING", actor: "owner", nextAttemptId: "attempt-2" },
      }),
    ).toThrow();
  });
});

describe("deny-by-default", () => {
  it("terminal states never restart", () => {
    for (const terminal of TERMINAL_STATES) {
      for (const to of TASK_STATES) {
        if (to === terminal) continue;
        expect(denyCode(tr(snap(terminal), { to, actor: "owner" }))).toBe("TERMINAL_STATE");
      }
    }
  });

  it("exhaustive sweep: every (state,to,actor) combination outside the contract is denied", () => {
    let checked = 0;
    for (const state of TASK_STATES) {
      for (const to of TASK_STATES) {
        for (const actor of ACTOR_CATEGORIES) {
          if (state === "BLOCKED") {
            // Without the stored trusted context, nothing leaves BLOCKED.
            const result = tr(snap("BLOCKED", { blockedContext: undefined }), { to, actor });
            expect(result.allowed, `${state}>${to}>${actor}`).toBe(false);
          } else {
            const matched = TRANSITION_RULES.find((r) => r.from === state && r.to === to);
            if (matched !== undefined && matched.actors.includes(actor)) {
              const result = tr(snap(state), satisfyingRequest(matched, actor));
              expect(result.allowed, `${state}>${to}>${actor}`).toBe(true);
            } else {
              const request: TransitionRequest = {
                to,
                actor,
                ...(to === "BLOCKED" && matched !== undefined
                  ? { proposedBlockedContext: proposedFor(state) }
                  : {}),
                evidence: TRANSITION_EVIDENCE,
              };
              const result = tr(snap(state), request);
              expect(result.allowed, `${state}>${to}>${actor}`).toBe(false);
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
    expect(() => tr(snap("LIMBO" as never), { to: "RUNNING", actor: "owner" })).toThrow();
    expect(() => tr(snap("DRAFT"), { to: "CONTEXT_PREPARING", actor: "root" as never })).toThrow();
    expect(() =>
      tr(snap("AWAITING_DISPATCH"), {
        to: "RUNNING",
        actor: "control-plane",
        evidence: ["pinky-promise" as never],
      }),
    ).toThrow();
    expect(() =>
      tr(snap("RUNNING"), {
        to: "BLOCKED",
        actor: "system-recovery",
        proposedBlockedContext: { ...ctxExecUnknown, blockedOperation: "vibes" as never },
      }),
    ).toThrow();
  });
});
