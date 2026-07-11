import { z } from "zod";
import {
  ActorCategorySchema,
  BlockedReasonSchema,
  TaskStateSchema,
  isTerminalState,
  type ActorCategory,
  type BlockedReason,
  type TaskState,
} from "./task-states.js";

/**
 * Legal-transition model for the accepted state machine
 * (docs/FINAL_ARCHITECTURE_DESIGN.md §10; D-017, clarified by D-020,
 * D-021, and D-022).
 *
 * TRUST BOUNDARY (D-022): authorization takes TWO separate inputs —
 * `current`, the trusted snapshot of the task loaded by the future
 * state store (visible state, attempt identity, stored BLOCKED
 * context), and `request`, the proposed transition. The request shape
 * has NO field capable of supplying or replacing the current blocked
 * reason, source state, operation, attempt ID, operation ID, or journal
 * reference — substitution is structurally impossible, not merely
 * validated away. This pure library trusts that the Control Plane
 * loaded `current` from its store; persistence itself is not M1A.
 *
 * AUTHORITY MODEL: the Control Plane records state and is the actor for
 * system transitions; Bridge-origin facts are mandatory typed EVIDENCE,
 * never an alternative actor.
 */

export const TRANSITION_EVIDENCE = Object.freeze([
  "bridge-dispatch-ack",
  "bridge-dispatch-failure-report",
  "bridge-execution-report",
  "bridge-integration-report",
  "grant-verified",
  "bridge-kill-confirmation",
  "owner-reconciliation",
] as const);
export const TransitionEvidenceSchema = z.enum(TRANSITION_EVIDENCE);
export type TransitionEvidence = z.infer<typeof TransitionEvidenceSchema>;

export const RECONCILIATION_OUTCOMES = Object.freeze([
  "confirmed-completed",
  "confirmed-failed",
  "confirmed-not-executed",
] as const);
export const ReconciliationOutcomeSchema = z.enum(RECONCILIATION_OUTCOMES);
export type ReconciliationOutcome = z.infer<typeof ReconciliationOutcomeSchema>;

/** The operation that was in flight when a task entered BLOCKED (D-021). */
export const BLOCKED_OPERATIONS = Object.freeze([
  "context-preparation",
  "worker-dispatch",
  "worker-execution",
  "integration",
] as const);
export const BlockedOperationSchema = z.enum(BLOCKED_OPERATIONS);
export type BlockedOperation = z.infer<typeof BlockedOperationSchema>;

/**
 * Trusted blocked context (D-021/D-022). Written by the state store when
 * a task enters BLOCKED; supplied back only inside the trusted current
 * snapshot when it leaves.
 */
export const BlockedContextSchema = z
  .strictObject({
    /** The state the task was in when it became BLOCKED. */
    blockedFrom: TaskStateSchema,
    /** The operation that was in flight. */
    blockedOperation: BlockedOperationSchema,
    blockedReason: BlockedReasonSchema,
    /** Identity of the attempt that was blocked. */
    attemptId: z.string().min(1),
    /** Identity of the specific journaled operation. */
    operationId: z.string().min(1),
    /**
     * Trusted journal/start reference. MANDATORY for execution-unknown:
     * that reason is only legal when the operation was recorded as
     * started but its result is uncertain.
     */
    journalRef: z.string().min(1).optional(),
  })
  .readonly();
export type BlockedContext = z.infer<typeof BlockedContextSchema>;

/**
 * The trusted current snapshot, loaded from the operational state store
 * — never assembled from a caller's transition request (D-022).
 */
export const TrustedCurrentSnapshotSchema = z
  .strictObject({
    /** Current visible task state. */
    state: TaskStateSchema,
    /** Current attempt identity, as recorded by the store. */
    attemptId: z.string().min(1).optional(),
    /** The stored BLOCKED context; required iff state is BLOCKED. */
    blockedContext: BlockedContextSchema.optional(),
  })
  .readonly();
export type TrustedCurrentSnapshot = z.infer<typeof TrustedCurrentSnapshotSchema>;

/**
 * The transition request. Deliberately has NO current-state fields:
 * nothing here can override the trusted snapshot.
 */
export const TransitionRequestSchema = z
  .strictObject({
    to: TaskStateSchema,
    actor: ActorCategorySchema,
    /** Allowed only when `to` is BLOCKED: what is being blocked. */
    proposedBlockedContext: BlockedContextSchema.optional(),
    /** Typed facts accompanying the transition (superfluous facts tolerated). */
    evidence: z.array(TransitionEvidenceSchema).readonly().optional(),
    /** Required iff resolving BLOCKED(execution-unknown). */
    reconciliationOutcome: ReconciliationOutcomeSchema.optional(),
    /** Proposed NEW attempt identity where a fresh attempt is required. */
    nextAttemptId: z.string().min(1).optional(),
    /** Proposed NEW operation identity where a fresh operation is required. */
    nextOperationId: z.string().min(1).optional(),
  })
  .readonly();
export type TransitionRequest = z.infer<typeof TransitionRequestSchema>;

export const CanTransitionInputSchema = z
  .strictObject({
    current: TrustedCurrentSnapshotSchema,
    request: TransitionRequestSchema,
  })
  .readonly();
export type CanTransitionInput = z.infer<typeof CanTransitionInputSchema>;

interface BlockedOperationProfile {
  readonly from: TaskState;
  readonly ordinaryReasons: readonly BlockedReason[];
  readonly executionUnknownAllowed: boolean;
  readonly ordinaryRecoveryTarget?: TaskState;
}

/**
 * Source / operation / reason compatibility matrix (D-021). Recovery
 * returns only to a target valid for the original blocked stage.
 */
export const BLOCKED_OPERATION_MATRIX: Readonly<Record<BlockedOperation, BlockedOperationProfile>> =
  Object.freeze({
    "context-preparation": Object.freeze({
      from: "CONTEXT_PREPARING",
      ordinaryReasons: Object.freeze(["missing-context", "policy", "abandoned"] as const),
      executionUnknownAllowed: false,
      ordinaryRecoveryTarget: "CONTEXT_PREPARING",
    }),
    "worker-dispatch": Object.freeze({
      from: "AWAITING_DISPATCH",
      ordinaryReasons: Object.freeze(["queue-lock", "conflict", "policy", "abandoned"] as const),
      executionUnknownAllowed: true,
      ordinaryRecoveryTarget: "AWAITING_DISPATCH",
    }),
    "worker-execution": Object.freeze({
      from: "RUNNING",
      // No ordinary reasons and no ordinary recovery: silently
      // re-dispatching the same attempt is exactly what D-021 forbids.
      ordinaryReasons: Object.freeze([] as const),
      executionUnknownAllowed: true,
    }),
    integration: Object.freeze({
      from: "APPROVED",
      // File-overlap conflicts block integration (§12.1); ordinary
      // recovery returns to APPROVED — the approved stage is never
      // discarded by ordinary recovery.
      ordinaryReasons: Object.freeze(["conflict"] as const),
      executionUnknownAllowed: true,
      ordinaryRecoveryTarget: "APPROVED",
    }),
  });

interface ReconciliationProfile {
  readonly target: TaskState;
  readonly requiredEvidence: readonly TransitionEvidence[];
  readonly requiresNewOperationId?: boolean;
  readonly requiresNewAttemptId?: boolean;
}

/**
 * Stage-aware reconciliation matrix (D-021/D-022). An outcome resolves
 * the ORIGINAL OPERATION, not automatically the whole task. Every
 * confirmed-failed path requires stage-specific trusted Bridge evidence
 * in addition to owner reconciliation (D-022) — owner reconciliation
 * alone never marks work failed.
 */
export const RECONCILIATION_MATRIX: Readonly<
  Partial<Record<BlockedOperation, Readonly<Record<ReconciliationOutcome, ReconciliationProfile>>>>
> = Object.freeze({
  "worker-dispatch": Object.freeze({
    "confirmed-completed": Object.freeze({
      target: "RUNNING",
      requiredEvidence: Object.freeze(["owner-reconciliation", "bridge-dispatch-ack"] as const),
    }),
    "confirmed-failed": Object.freeze({
      target: "FAILED",
      requiredEvidence: Object.freeze([
        "owner-reconciliation",
        "bridge-dispatch-failure-report",
      ] as const),
    }),
    "confirmed-not-executed": Object.freeze({
      target: "AWAITING_DISPATCH",
      requiredEvidence: Object.freeze(["owner-reconciliation"] as const),
      requiresNewOperationId: true,
    }),
  }),
  "worker-execution": Object.freeze({
    "confirmed-completed": Object.freeze({
      target: "RESULT_CAPTURED",
      requiredEvidence: Object.freeze(["owner-reconciliation", "bridge-execution-report"] as const),
    }),
    "confirmed-failed": Object.freeze({
      target: "FAILED",
      requiredEvidence: Object.freeze(["owner-reconciliation", "bridge-execution-report"] as const),
    }),
    "confirmed-not-executed": Object.freeze({
      target: "CONTEXT_PREPARING",
      requiredEvidence: Object.freeze(["owner-reconciliation"] as const),
      requiresNewAttemptId: true,
      requiresNewOperationId: true,
    }),
  }),
  integration: Object.freeze({
    "confirmed-completed": Object.freeze({
      target: "COMPLETED",
      requiredEvidence: Object.freeze([
        "owner-reconciliation",
        "bridge-integration-report",
        "grant-verified",
      ] as const),
    }),
    "confirmed-failed": Object.freeze({
      target: "FAILED",
      requiredEvidence: Object.freeze([
        "owner-reconciliation",
        "bridge-integration-report",
        "grant-verified",
      ] as const),
    }),
    "confirmed-not-executed": Object.freeze({
      target: "APPROVED",
      requiredEvidence: Object.freeze(["owner-reconciliation"] as const),
      requiresNewOperationId: true,
    }),
  }),
});

export interface TransitionRule {
  readonly from: TaskState;
  readonly to: TaskState;
  readonly actors: readonly ActorCategory[];
  /** True only where the transition IS the owner's approval decision. */
  readonly requiresOwnerApproval: boolean;
  /** A new attempt identity must be proposed (retry/revision paths). */
  readonly requiresNewAttemptId: boolean;
  /** Bridge/owner facts that MUST accompany this transition. */
  readonly requiredEvidence: readonly TransitionEvidence[];
  readonly source: "diagram" | "d-020-clarification" | "d-021-clarification";
}

interface RuleOpts {
  requiresOwnerApproval?: boolean;
  requiresNewAttemptId?: boolean;
  requiredEvidence?: readonly TransitionEvidence[];
  source?: TransitionRule["source"];
}

const rule = (
  from: TaskState,
  to: TaskState,
  actors: readonly ActorCategory[],
  opts: RuleOpts = {},
): TransitionRule =>
  Object.freeze({
    from,
    to,
    actors: Object.freeze([...actors]),
    requiresOwnerApproval: opts.requiresOwnerApproval ?? false,
    requiresNewAttemptId: opts.requiresNewAttemptId ?? false,
    requiredEvidence: Object.freeze([...(opts.requiredEvidence ?? [])]),
    source: opts.source ?? "diagram",
  });

/**
 * Non-BLOCKED-origin transitions plus entries INTO BLOCKED. Transitions
 * OUT of BLOCKED derive from the trusted blocked context via the
 * matrices above.
 */
export const TRANSITION_RULES: readonly TransitionRule[] = Object.freeze([
  rule("DRAFT", "CONTEXT_PREPARING", ["owner"]),
  rule("DRAFT", "CANCELLED", ["owner"]),
  rule("CONTEXT_PREPARING", "AWAITING_DISPATCH", ["control-plane"]),
  rule("CONTEXT_PREPARING", "BLOCKED", ["control-plane"]),
  rule("CONTEXT_PREPARING", "CANCELLED", ["owner"], { source: "d-020-clarification" }),
  rule("AWAITING_DISPATCH", "RUNNING", ["control-plane"], {
    requiredEvidence: ["bridge-dispatch-ack"],
  }),
  rule("AWAITING_DISPATCH", "BLOCKED", ["control-plane", "system-recovery"]),
  rule("AWAITING_DISPATCH", "CANCELLING", ["owner"], { source: "d-020-clarification" }),
  rule("RUNNING", "RESULT_CAPTURED", ["control-plane"], {
    requiredEvidence: ["bridge-execution-report"],
  }),
  rule("RUNNING", "FAILED", ["control-plane"], {
    requiredEvidence: ["bridge-execution-report"],
  }),
  rule("RUNNING", "CANCELLING", ["owner"]),
  rule("RUNNING", "BLOCKED", ["system-recovery"], { source: "d-020-clarification" }),
  rule("RESULT_CAPTURED", "AWAITING_APPROVAL", ["control-plane"]),
  rule("RESULT_CAPTURED", "CANCELLED", ["owner"], { source: "d-020-clarification" }),
  rule("AWAITING_APPROVAL", "APPROVED", ["owner"], { requiresOwnerApproval: true }),
  rule("AWAITING_APPROVAL", "REJECTED", ["owner"]),
  rule("AWAITING_APPROVAL", "REVISION_REQUESTED", ["owner"]),
  rule("AWAITING_APPROVAL", "CANCELLED", ["owner"], { source: "d-020-clarification" }),
  rule("REVISION_REQUESTED", "CONTEXT_PREPARING", ["owner"], { requiresNewAttemptId: true }),
  rule("REVISION_REQUESTED", "CANCELLED", ["owner"], { source: "d-020-clarification" }),
  rule("APPROVED", "COMPLETED", ["control-plane"], {
    requiredEvidence: ["bridge-integration-report", "grant-verified"],
  }),
  rule("APPROVED", "FAILED", ["control-plane"], {
    requiredEvidence: ["bridge-integration-report", "grant-verified"],
  }),
  rule("APPROVED", "BLOCKED", ["system-recovery"], { source: "d-020-clarification" }),
  rule("APPROVED", "CANCELLING", ["owner"], { source: "d-020-clarification" }),
  rule("CANCELLING", "CANCELLED", ["control-plane"], {
    requiredEvidence: ["bridge-kill-confirmation"],
  }),
  rule("FAILED", "CONTEXT_PREPARING", ["owner"], { requiresNewAttemptId: true }),
]);

export const DENY_CODES = Object.freeze([
  "SAME_STATE",
  "TERMINAL_STATE",
  "UNKNOWN_TRANSITION",
  "ACTOR_NOT_PERMITTED",
  "BLOCKED_CONTEXT_REQUIRED",
  "UNEXPECTED_BLOCKED_CONTEXT",
  "BLOCKED_SOURCE_MISMATCH",
  "OPERATION_SOURCE_MISMATCH",
  "REASON_OPERATION_MISMATCH",
  "JOURNAL_REF_REQUIRED",
  "ATTEMPT_ID_MISMATCH",
  "RECONCILIATION_REQUIRED",
  "RECONCILIATION_NOT_APPLICABLE",
  "INVALID_RECONCILIATION_OUTCOME",
  "UNEXPECTED_RECONCILIATION_OUTCOME",
  "RECONCILIATION_EVIDENCE_REQUIRED",
  "INVALID_RECOVERY_TARGET",
  "MISSING_REQUIRED_EVIDENCE",
  "CURRENT_ATTEMPT_ID_REQUIRED",
  "NEXT_ATTEMPT_ID_REQUIRED",
  "ATTEMPT_ID_REUSED",
  "NEW_OPERATION_ID_REQUIRED",
  "OPERATION_ID_REUSED",
] as const);
export type DenyCode = (typeof DENY_CODES)[number];

export type CanTransitionResult =
  | {
      readonly allowed: true;
      readonly rule: TransitionRule;
      readonly requiresOwnerApproval: boolean;
    }
  | {
      readonly allowed: false;
      readonly code: DenyCode;
      readonly message: string;
    };

const deny = (code: DenyCode, message: string): CanTransitionResult =>
  Object.freeze({ allowed: false, code, message });

const allowRule = (matched: TransitionRule): CanTransitionResult =>
  Object.freeze({
    allowed: true,
    rule: matched,
    requiresOwnerApproval: matched.requiresOwnerApproval,
  });

/**
 * Validates a blocked context against the source/operation/reason
 * matrix. Applied to the STORED context on exit and the PROPOSED context
 * on entry, so an internally inconsistent context — e.g. a
 * worker-execution block relabeled "queue-lock" — is rejected wherever
 * it appears.
 */
function validateBlockedContext(ctx: BlockedContext): CanTransitionResult | undefined {
  const profile = BLOCKED_OPERATION_MATRIX[ctx.blockedOperation];
  if (profile.from !== ctx.blockedFrom) {
    return deny(
      "OPERATION_SOURCE_MISMATCH",
      `Operation '${ctx.blockedOperation}' blocks only from ${profile.from}, not ${ctx.blockedFrom}.`,
    );
  }
  if (ctx.blockedReason === "execution-unknown") {
    if (!profile.executionUnknownAllowed) {
      return deny(
        "REASON_OPERATION_MISMATCH",
        `execution-unknown is not a valid reason for '${ctx.blockedOperation}' (nothing execution-shaped was started).`,
      );
    }
    if (ctx.journalRef === undefined) {
      return deny(
        "JOURNAL_REF_REQUIRED",
        "execution-unknown requires a trusted journal/start reference: it means the operation was recorded as started with an uncertain result.",
      );
    }
  } else if (!profile.ordinaryReasons.includes(ctx.blockedReason)) {
    return deny(
      "REASON_OPERATION_MISMATCH",
      `Reason '${ctx.blockedReason}' is not valid for operation '${ctx.blockedOperation}' (valid: ${profile.ordinaryReasons.join(", ") || "none"}).`,
    );
  }
  return undefined;
}

const checkEvidence = (
  required: readonly TransitionEvidence[],
  supplied: readonly TransitionEvidence[],
  label: string,
): CanTransitionResult | undefined => {
  const missing = required.filter((e) => !supplied.includes(e));
  if (missing.length === 0) return undefined;
  if (missing.includes("owner-reconciliation")) {
    return deny(
      "RECONCILIATION_EVIDENCE_REQUIRED",
      `${label} requires recorded owner-reconciliation evidence.`,
    );
  }
  return deny(
    "MISSING_REQUIRED_EVIDENCE",
    `${label} requires evidence: ${required.join(", ")} (missing: ${missing.join(", ")}). One uncorroborated actor never suffices.`,
  );
};

/**
 * New-attempt identity checks (D-022): the trusted current attempt ID
 * and a distinct proposed next attempt ID are BOTH mandatory. There is
 * no "compare only when known" path.
 */
const checkNewAttemptIdentity = (
  currentAttemptId: string | undefined,
  nextAttemptId: string | undefined,
  label: string,
): CanTransitionResult | undefined => {
  if (currentAttemptId === undefined) {
    return deny(
      "CURRENT_ATTEMPT_ID_REQUIRED",
      `${label} requires the trusted current attempt identity in the snapshot; it may not be omitted.`,
    );
  }
  if (nextAttemptId === undefined) {
    return deny(
      "NEXT_ATTEMPT_ID_REQUIRED",
      `${label} requires a proposed NEW attempt identity; a bare claim is insufficient and prior attempts are never rerun.`,
    );
  }
  if (nextAttemptId === currentAttemptId) {
    return deny(
      "ATTEMPT_ID_REUSED",
      "The new attempt identity must differ from the current attempt's identity.",
    );
  }
  return undefined;
};

/** Decides transitions whose source is BLOCKED, from the trusted snapshot only. */
function blockedOriginDecision(
  current: TrustedCurrentSnapshot,
  request: TransitionRequest,
  ctx: BlockedContext,
): CanTransitionResult {
  const inconsistent = validateBlockedContext(ctx);
  if (inconsistent !== undefined) return inconsistent;

  if (current.attemptId !== undefined && current.attemptId !== ctx.attemptId) {
    return deny(
      "ATTEMPT_ID_MISMATCH",
      `The snapshot attempt (${current.attemptId}) does not match the blocked context's attempt (${ctx.attemptId}); the trusted snapshot is inconsistent.`,
    );
  }

  const profile = BLOCKED_OPERATION_MATRIX[ctx.blockedOperation];
  const supplied = request.evidence ?? [];

  if (request.reconciliationOutcome !== undefined) {
    // ---- Stage-aware reconciliation path (execution-unknown only) ----
    if (ctx.blockedReason !== "execution-unknown") {
      return deny(
        "RECONCILIATION_NOT_APPLICABLE",
        `Reconciliation applies only to BLOCKED(execution-unknown), not BLOCKED(${ctx.blockedReason}).`,
      );
    }
    const outcomes = RECONCILIATION_MATRIX[ctx.blockedOperation];
    const profileForOutcome = outcomes?.[request.reconciliationOutcome];
    if (profileForOutcome === undefined) {
      return deny(
        "INVALID_RECONCILIATION_OUTCOME",
        `Outcome '${request.reconciliationOutcome}' is not defined for blocked operation '${ctx.blockedOperation}'.`,
      );
    }
    if (profileForOutcome.target !== request.to) {
      return deny(
        "INVALID_RECOVERY_TARGET",
        `Reconciling '${ctx.blockedOperation}' as '${request.reconciliationOutcome}' targets ${profileForOutcome.target} — the outcome of the original operation, not an arbitrary task outcome (got ${request.to}).`,
      );
    }
    if (request.actor !== "owner") {
      return deny(
        "ACTOR_NOT_PERMITTED",
        "Only the owner may reconcile execution-unknown; automated reconciliation is refused.",
      );
    }
    const evidenceProblem = checkEvidence(
      profileForOutcome.requiredEvidence,
      supplied,
      `Reconciliation of '${ctx.blockedOperation}' (${request.reconciliationOutcome})`,
    );
    if (evidenceProblem !== undefined) return evidenceProblem;

    if (profileForOutcome.requiresNewOperationId === true) {
      if (request.nextOperationId === undefined) {
        return deny(
          "NEW_OPERATION_ID_REQUIRED",
          "confirmed-not-executed requires a proposed NEW operation identity; the blocked operation is never reused.",
        );
      }
      if (request.nextOperationId === ctx.operationId) {
        return deny(
          "OPERATION_ID_REUSED",
          "The new operation identity must differ from the blocked operation's identity.",
        );
      }
    }
    if (profileForOutcome.requiresNewAttemptId === true) {
      const identityProblem = checkNewAttemptIdentity(
        current.attemptId,
        request.nextAttemptId,
        "This reconciliation",
      );
      if (identityProblem !== undefined) return identityProblem;
      if (request.nextAttemptId === ctx.attemptId) {
        return deny(
          "ATTEMPT_ID_REUSED",
          "The new attempt identity must differ from the blocked attempt's identity.",
        );
      }
    }
    return allowRule(
      Object.freeze({
        from: "BLOCKED",
        to: profileForOutcome.target,
        actors: Object.freeze(["owner"] as const),
        requiresOwnerApproval: false,
        requiresNewAttemptId: profileForOutcome.requiresNewAttemptId === true,
        requiredEvidence: profileForOutcome.requiredEvidence,
        source: "d-021-clarification",
      }),
    );
  }

  // ---- Ordinary path: no reconciliation outcome supplied ----
  if (ctx.blockedReason === "execution-unknown") {
    return deny(
      "RECONCILIATION_REQUIRED",
      "BLOCKED(execution-unknown) may only be resolved through an owner-reviewed reconciliation outcome; ordinary unblock, re-dispatch, and cancellation are refused.",
    );
  }

  if (request.to === "CANCELLED") {
    if (request.actor !== "owner") {
      return deny("ACTOR_NOT_PERMITTED", "Only the owner may cancel a blocked task.");
    }
    return allowRule(
      Object.freeze({
        from: "BLOCKED",
        to: "CANCELLED",
        actors: Object.freeze(["owner"] as const),
        requiresOwnerApproval: false,
        requiresNewAttemptId: false,
        requiredEvidence: Object.freeze([] as const),
        source: "d-020-clarification",
      }),
    );
  }

  // Ordinary recovery target is DERIVED from the blocked operation —
  // there is no universal BLOCKED -> AWAITING_DISPATCH (D-021).
  const derived = profile.ordinaryRecoveryTarget;
  if (derived === undefined) {
    return deny(
      "INVALID_RECOVERY_TARGET",
      `Operation '${ctx.blockedOperation}' has no ordinary recovery; uncertainty must be reconciled explicitly.`,
    );
  }
  if (request.to !== derived) {
    return deny(
      "INVALID_RECOVERY_TARGET",
      `Ordinary recovery from a '${ctx.blockedOperation}' block returns to ${derived}, not ${request.to}.`,
    );
  }
  if (request.actor !== "control-plane" && request.actor !== "owner") {
    return deny(
      "ACTOR_NOT_PERMITTED",
      `Actor '${request.actor}' may not perform ordinary blocked recovery (permitted: control-plane, owner).`,
    );
  }
  return allowRule(
    Object.freeze({
      from: "BLOCKED",
      to: derived,
      actors: Object.freeze(["control-plane", "owner"] as const),
      requiresOwnerApproval: false,
      requiresNewAttemptId: false,
      requiredEvidence: Object.freeze([] as const),
      source: "d-021-clarification",
    }),
  );
}

/**
 * Pure legal-transition decision over a trusted snapshot and a
 * transition request. Deny-by-default; the request cannot supply or
 * replace any element of the current state.
 */
export function canTransition(rawInput: CanTransitionInput): CanTransitionResult {
  const { current, request } = CanTransitionInputSchema.parse(rawInput);

  if (current.state === request.to) {
    return deny("SAME_STATE", `A task cannot transition from ${current.state} to itself.`);
  }
  if (isTerminalState(current.state)) {
    return deny(
      "TERMINAL_STATE",
      `${current.state} is terminal; terminal states never restart or transition.`,
    );
  }

  // Snapshot-side blocked context: required exactly when BLOCKED.
  if (current.state === "BLOCKED" && current.blockedContext === undefined) {
    return deny(
      "BLOCKED_CONTEXT_REQUIRED",
      "A BLOCKED snapshot must carry its stored blocked context; omitting it cannot bypass execution-unknown gating.",
    );
  }
  if (current.state !== "BLOCKED" && current.blockedContext !== undefined) {
    return deny(
      "UNEXPECTED_BLOCKED_CONTEXT",
      `The snapshot carries a blocked context but the current state is ${current.state}.`,
    );
  }

  // Request-side proposed context: allowed only when entering BLOCKED.
  if (request.to === "BLOCKED" && request.proposedBlockedContext === undefined) {
    return deny(
      "BLOCKED_CONTEXT_REQUIRED",
      "Entering BLOCKED requires a proposed blocked context (source, operation, reason, attempt and operation identity).",
    );
  }
  if (request.to !== "BLOCKED" && request.proposedBlockedContext !== undefined) {
    return deny(
      "UNEXPECTED_BLOCKED_CONTEXT",
      `proposedBlockedContext is only meaningful when the target is BLOCKED (got to=${request.to}).`,
    );
  }

  if (current.state === "BLOCKED") {
    return blockedOriginDecision(current, request, current.blockedContext as BlockedContext);
  }

  if (request.reconciliationOutcome !== undefined) {
    return deny(
      "UNEXPECTED_RECONCILIATION_OUTCOME",
      `Transition ${current.state} -> ${request.to} is not a reconciliation; reconciliationOutcome must not be supplied.`,
    );
  }

  const matched = TRANSITION_RULES.find((r) => r.from === current.state && r.to === request.to);
  if (matched === undefined) {
    return deny(
      "UNKNOWN_TRANSITION",
      `No legal transition from ${current.state} to ${request.to}; unknown transitions are denied by default.`,
    );
  }

  if (request.to === "BLOCKED") {
    const ctx = request.proposedBlockedContext as BlockedContext;
    if (ctx.blockedFrom !== current.state) {
      return deny(
        "BLOCKED_SOURCE_MISMATCH",
        `Proposed blocked context claims source ${ctx.blockedFrom} but the transition is from ${current.state}.`,
      );
    }
    if (current.attemptId === undefined) {
      return deny(
        "CURRENT_ATTEMPT_ID_REQUIRED",
        "Entering BLOCKED requires the trusted current attempt identity in the snapshot.",
      );
    }
    if (ctx.attemptId !== current.attemptId) {
      return deny(
        "ATTEMPT_ID_MISMATCH",
        `Proposed blocked context references attempt ${ctx.attemptId} but the trusted current attempt is ${current.attemptId}.`,
      );
    }
    const inconsistent = validateBlockedContext(ctx);
    if (inconsistent !== undefined) return inconsistent;
  }

  if (!matched.actors.includes(request.actor)) {
    return deny(
      "ACTOR_NOT_PERMITTED",
      `Actor '${request.actor}' may not perform ${current.state} -> ${request.to}; permitted: ${matched.actors.join(", ")}.`,
    );
  }

  const evidenceProblem = checkEvidence(
    matched.requiredEvidence,
    request.evidence ?? [],
    `Transition ${current.state} -> ${request.to}`,
  );
  if (evidenceProblem !== undefined) return evidenceProblem;

  if (matched.requiresNewAttemptId) {
    const identityProblem = checkNewAttemptIdentity(
      current.attemptId,
      request.nextAttemptId,
      `Transition ${current.state} -> ${request.to}`,
    );
    if (identityProblem !== undefined) return identityProblem;
  }

  return allowRule(matched);
}

/**
 * All statically-known legal outbound transitions from a state. BLOCKED
 * is context-dependent (BLOCKED_OPERATION_MATRIX / RECONCILIATION_MATRIX),
 * so this returns only table rules (empty for BLOCKED and terminals).
 */
export function legalTransitionsFrom(from: TaskState): readonly TransitionRule[] {
  TaskStateSchema.parse(from);
  return TRANSITION_RULES.filter((r) => r.from === from);
}
