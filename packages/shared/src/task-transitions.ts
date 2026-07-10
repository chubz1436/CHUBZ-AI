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
 * (docs/FINAL_ARCHITECTURE_DESIGN.md §10; D-017, clarified by D-020 and
 * D-021).
 *
 * AUTHORITY MODEL: the Control Plane records state and is the actor for
 * system transitions; Bridge-origin facts are mandatory typed EVIDENCE,
 * never an alternative actor.
 *
 * TRUSTED BLOCKED CONTEXT (D-021): BLOCKED preserves what was blocked —
 * the source state, the operation in flight, the reason, and the attempt
 * and operation identities. Entering BLOCKED requires a proposed context
 * that matches the actual source state; leaving BLOCKED requires the
 * stored trusted context. Recovery targets are DERIVED from the blocked
 * operation, never freely chosen, and execution-unknown can only be
 * resolved through stage-aware owner reconciliation. This contract is
 * pure: it validates the context supplied by the future trusted state
 * store; it does not persist anything itself.
 */

export const TRANSITION_EVIDENCE = Object.freeze([
  "bridge-dispatch-ack",
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
 * Trusted blocked context (D-021). Written by the state store when a task
 * enters BLOCKED; supplied back verbatim when it leaves. A caller cannot
 * substitute pieces: the whole structure is cross-checked against the
 * source/operation/reason matrix, so e.g. a worker-execution context
 * relabeled "queue-lock" is rejected outright.
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

interface BlockedOperationProfile {
  /** The only source state this operation can block from. */
  readonly from: TaskState;
  /** Ordinary (non-execution-unknown) reasons this operation may carry. */
  readonly ordinaryReasons: readonly BlockedReason[];
  /** Whether execution-unknown is meaningful for this operation. */
  readonly executionUnknownAllowed: boolean;
  /**
   * Derived ordinary-recovery target. Absent = no ordinary recovery
   * exists for this operation (uncertainty must reconcile instead).
   */
  readonly ordinaryRecoveryTarget?: TaskState;
}

/**
 * Source / operation / reason compatibility matrix (D-021 correction 2).
 * Recovery returns only to a target valid for the original blocked stage.
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
  /** The only legal target for this operation + outcome. */
  readonly target: TaskState;
  readonly requiredEvidence: readonly TransitionEvidence[];
  /** A NEW operation identity (differing from the blocked one) is required. */
  readonly requiresNewOperationId?: boolean;
  /** A NEW attempt identity (differing from the blocked one) is required. */
  readonly requiresNewAttemptId?: boolean;
}

/**
 * Stage-aware reconciliation matrix (D-021 correction 3). A
 * reconciliation outcome is the outcome of the ORIGINAL OPERATION, not
 * automatically of the whole task: a dispatch that "confirmed-completed"
 * means the worker is RUNNING — nothing more. context-preparation has no
 * entry because execution-unknown is impossible there.
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
      requiredEvidence: Object.freeze(["owner-reconciliation"] as const),
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
      requiredEvidence: Object.freeze(["owner-reconciliation"] as const),
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
      requiredEvidence: Object.freeze(["owner-reconciliation"] as const),
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
 * OUT of BLOCKED are not free-form rules: they are derived from the
 * trusted blocked context via the two matrices above.
 */
export const TRANSITION_RULES: readonly TransitionRule[] = Object.freeze([
  // Draft
  rule("DRAFT", "CONTEXT_PREPARING", ["owner"]),
  rule("DRAFT", "CANCELLED", ["owner"]),
  // Context preparation
  rule("CONTEXT_PREPARING", "AWAITING_DISPATCH", ["control-plane"]),
  rule("CONTEXT_PREPARING", "BLOCKED", ["control-plane"]),
  rule("CONTEXT_PREPARING", "CANCELLED", ["owner"], { source: "d-020-clarification" }),
  // Dispatch queue
  rule("AWAITING_DISPATCH", "RUNNING", ["control-plane"], {
    requiredEvidence: ["bridge-dispatch-ack"],
  }),
  rule("AWAITING_DISPATCH", "BLOCKED", ["control-plane", "system-recovery"]),
  rule("AWAITING_DISPATCH", "CANCELLING", ["owner"], { source: "d-020-clarification" }),
  // Running
  rule("RUNNING", "RESULT_CAPTURED", ["control-plane"], {
    requiredEvidence: ["bridge-execution-report"],
  }),
  rule("RUNNING", "FAILED", ["control-plane"], {
    requiredEvidence: ["bridge-execution-report"],
  }),
  rule("RUNNING", "CANCELLING", ["owner"]),
  rule("RUNNING", "BLOCKED", ["system-recovery"], { source: "d-020-clarification" }),
  // Captured result
  rule("RESULT_CAPTURED", "AWAITING_APPROVAL", ["control-plane"]),
  rule("RESULT_CAPTURED", "CANCELLED", ["owner"], { source: "d-020-clarification" }),
  // Owner gate
  rule("AWAITING_APPROVAL", "APPROVED", ["owner"], { requiresOwnerApproval: true }),
  rule("AWAITING_APPROVAL", "REJECTED", ["owner"]),
  rule("AWAITING_APPROVAL", "REVISION_REQUESTED", ["owner"]),
  rule("AWAITING_APPROVAL", "CANCELLED", ["owner"], { source: "d-020-clarification" }),
  // Revision
  rule("REVISION_REQUESTED", "CONTEXT_PREPARING", ["owner"], { requiresNewAttemptId: true }),
  rule("REVISION_REQUESTED", "CANCELLED", ["owner"], { source: "d-020-clarification" }),
  // Approved / integration
  rule("APPROVED", "COMPLETED", ["control-plane"], {
    requiredEvidence: ["bridge-integration-report", "grant-verified"],
  }),
  rule("APPROVED", "FAILED", ["control-plane"], {
    requiredEvidence: ["bridge-integration-report", "grant-verified"],
  }),
  rule("APPROVED", "BLOCKED", ["system-recovery"], { source: "d-020-clarification" }),
  rule("APPROVED", "CANCELLING", ["owner"], { source: "d-020-clarification" }),
  // Cancellation confirmation
  rule("CANCELLING", "CANCELLED", ["control-plane"], {
    requiredEvidence: ["bridge-kill-confirmation"],
  }),
  // Failure retry
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
  "RECONCILIATION_REQUIRED",
  "RECONCILIATION_NOT_APPLICABLE",
  "INVALID_RECONCILIATION_OUTCOME",
  "UNEXPECTED_RECONCILIATION_OUTCOME",
  "RECONCILIATION_EVIDENCE_REQUIRED",
  "INVALID_RECOVERY_TARGET",
  "MISSING_REQUIRED_EVIDENCE",
  "NEW_ATTEMPT_ID_REQUIRED",
  "ATTEMPT_ID_REUSED",
  "NEW_OPERATION_ID_REQUIRED",
  "OPERATION_ID_REUSED",
] as const);
export type DenyCode = (typeof DENY_CODES)[number];

export const CanTransitionInputSchema = z
  .strictObject({
    from: TaskStateSchema,
    to: TaskStateSchema,
    actor: ActorCategorySchema,
    /** Required iff the TARGET state is BLOCKED: what is being blocked. */
    proposedBlockedContext: BlockedContextSchema.optional(),
    /** Required iff `from` is BLOCKED: the STORED trusted context. */
    currentBlockedContext: BlockedContextSchema.optional(),
    /** Typed facts accompanying the transition (superfluous facts tolerated). */
    evidence: z.array(TransitionEvidenceSchema).readonly().optional(),
    /** Required iff resolving BLOCKED(execution-unknown). */
    reconciliationOutcome: ReconciliationOutcomeSchema.optional(),
    /** Current attempt identity, when known outside a blocked context. */
    currentAttemptId: z.string().min(1).optional(),
    /** Proposed NEW attempt identity where a fresh attempt is required. */
    nextAttemptId: z.string().min(1).optional(),
    /** Proposed NEW operation identity where a fresh operation is required. */
    nextOperationId: z.string().min(1).optional(),
  })
  .readonly();
export type CanTransitionInput = z.infer<typeof CanTransitionInputSchema>;

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
 * Validates a blocked context against the source/operation/reason matrix.
 * Used for both proposed (entry) and stored (exit) contexts, so a caller
 * can never fabricate an inconsistent context in either direction — in
 * particular, relabeling an execution-unknown block with an ordinary
 * reason fails because that reason is invalid for the operation.
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

/** Decides transitions whose source is BLOCKED, from the trusted context. */
function blockedOriginDecision(
  input: CanTransitionInput,
  ctx: BlockedContext,
): CanTransitionResult {
  const inconsistent = validateBlockedContext(ctx);
  if (inconsistent !== undefined) return inconsistent;

  const profile = BLOCKED_OPERATION_MATRIX[ctx.blockedOperation];
  const supplied = input.evidence ?? [];

  if (input.reconciliationOutcome !== undefined) {
    // ---- Stage-aware reconciliation path (execution-unknown only) ----
    if (ctx.blockedReason !== "execution-unknown") {
      return deny(
        "RECONCILIATION_NOT_APPLICABLE",
        `Reconciliation applies only to BLOCKED(execution-unknown), not BLOCKED(${ctx.blockedReason}).`,
      );
    }
    const outcomes = RECONCILIATION_MATRIX[ctx.blockedOperation];
    const profileForOutcome = outcomes?.[input.reconciliationOutcome];
    if (profileForOutcome === undefined) {
      return deny(
        "INVALID_RECONCILIATION_OUTCOME",
        `Outcome '${input.reconciliationOutcome}' is not defined for blocked operation '${ctx.blockedOperation}'.`,
      );
    }
    if (profileForOutcome.target !== input.to) {
      return deny(
        "INVALID_RECOVERY_TARGET",
        `Reconciling '${ctx.blockedOperation}' as '${input.reconciliationOutcome}' targets ${profileForOutcome.target} — the outcome of the original operation, not an arbitrary task outcome (got ${input.to}).`,
      );
    }
    if (input.actor !== "owner") {
      return deny(
        "ACTOR_NOT_PERMITTED",
        "Only the owner may reconcile execution-unknown; automated reconciliation is refused.",
      );
    }
    const evidenceProblem = checkEvidence(
      profileForOutcome.requiredEvidence,
      supplied,
      `Reconciliation of '${ctx.blockedOperation}' (${input.reconciliationOutcome})`,
    );
    if (evidenceProblem !== undefined) return evidenceProblem;

    if (profileForOutcome.requiresNewOperationId === true) {
      if (input.nextOperationId === undefined) {
        return deny(
          "NEW_OPERATION_ID_REQUIRED",
          "confirmed-not-executed requires a proposed NEW operation identity; the blocked operation is never reused.",
        );
      }
      if (input.nextOperationId === ctx.operationId) {
        return deny(
          "OPERATION_ID_REUSED",
          "The new operation identity must differ from the blocked operation's identity.",
        );
      }
    }
    if (profileForOutcome.requiresNewAttemptId === true) {
      if (input.nextAttemptId === undefined) {
        return deny(
          "NEW_ATTEMPT_ID_REQUIRED",
          "This reconciliation requires a proposed NEW attempt identity; the previous attempt remains immutable.",
        );
      }
      if (input.nextAttemptId === ctx.attemptId) {
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

  if (input.to === "CANCELLED") {
    if (input.actor !== "owner") {
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
  if (input.to !== derived) {
    return deny(
      "INVALID_RECOVERY_TARGET",
      `Ordinary recovery from a '${ctx.blockedOperation}' block returns to ${derived}, not ${input.to}.`,
    );
  }
  if (input.actor !== "control-plane" && input.actor !== "owner") {
    return deny(
      "ACTOR_NOT_PERMITTED",
      `Actor '${input.actor}' may not perform ordinary blocked recovery (permitted: control-plane, owner).`,
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
 * Pure legal-transition decision. Deny-by-default. Contextual structures
 * are validated strictly in both directions so callers can never bypass
 * a restriction by omitting, substituting, or smuggling context.
 */
export function canTransition(rawInput: CanTransitionInput): CanTransitionResult {
  const input = CanTransitionInputSchema.parse(rawInput);

  if (input.from === input.to) {
    return deny("SAME_STATE", `A task cannot transition from ${input.from} to itself.`);
  }
  if (isTerminalState(input.from)) {
    return deny(
      "TERMINAL_STATE",
      `${input.from} is terminal; terminal states never restart or transition.`,
    );
  }

  // Blocked-context presence: required exactly where meaningful,
  // rejected everywhere else (D-021 correction 1).
  if (input.to === "BLOCKED" && input.proposedBlockedContext === undefined) {
    return deny(
      "BLOCKED_CONTEXT_REQUIRED",
      "Entering BLOCKED requires a proposed blocked context (source, operation, reason, attempt and operation identity).",
    );
  }
  if (input.to !== "BLOCKED" && input.proposedBlockedContext !== undefined) {
    return deny(
      "UNEXPECTED_BLOCKED_CONTEXT",
      `proposedBlockedContext is only meaningful when the target is BLOCKED (got to=${input.to}).`,
    );
  }
  if (input.from === "BLOCKED" && input.currentBlockedContext === undefined) {
    return deny(
      "BLOCKED_CONTEXT_REQUIRED",
      "Leaving BLOCKED requires the stored trusted blocked context; omitting it cannot bypass execution-unknown gating.",
    );
  }
  if (input.from !== "BLOCKED" && input.currentBlockedContext !== undefined) {
    return deny(
      "UNEXPECTED_BLOCKED_CONTEXT",
      `currentBlockedContext is only meaningful when the current state is BLOCKED (got from=${input.from}).`,
    );
  }

  if (input.from === "BLOCKED") {
    // currentBlockedContext presence checked above.
    return blockedOriginDecision(input, input.currentBlockedContext as BlockedContext);
  }

  if (input.reconciliationOutcome !== undefined) {
    return deny(
      "UNEXPECTED_RECONCILIATION_OUTCOME",
      `Transition ${input.from} -> ${input.to} is not a reconciliation; reconciliationOutcome must not be supplied.`,
    );
  }

  const matched = TRANSITION_RULES.find((r) => r.from === input.from && r.to === input.to);
  if (matched === undefined) {
    return deny(
      "UNKNOWN_TRANSITION",
      `No legal transition from ${input.from} to ${input.to}; unknown transitions are denied by default.`,
    );
  }

  if (input.to === "BLOCKED") {
    const ctx = input.proposedBlockedContext as BlockedContext;
    if (ctx.blockedFrom !== input.from) {
      return deny(
        "BLOCKED_SOURCE_MISMATCH",
        `Proposed blocked context claims source ${ctx.blockedFrom} but the transition is from ${input.from}.`,
      );
    }
    const inconsistent = validateBlockedContext(ctx);
    if (inconsistent !== undefined) return inconsistent;
  }

  if (!matched.actors.includes(input.actor)) {
    return deny(
      "ACTOR_NOT_PERMITTED",
      `Actor '${input.actor}' may not perform ${input.from} -> ${input.to}; permitted: ${matched.actors.join(", ")}.`,
    );
  }

  const evidenceProblem = checkEvidence(
    matched.requiredEvidence,
    input.evidence ?? [],
    `Transition ${input.from} -> ${input.to}`,
  );
  if (evidenceProblem !== undefined) return evidenceProblem;

  if (matched.requiresNewAttemptId) {
    if (input.nextAttemptId === undefined) {
      return deny(
        "NEW_ATTEMPT_ID_REQUIRED",
        `Transition ${input.from} -> ${input.to} requires a proposed NEW attempt identity; a bare boolean claim is insufficient and prior attempts are never rerun.`,
      );
    }
    if (input.currentAttemptId !== undefined && input.nextAttemptId === input.currentAttemptId) {
      return deny(
        "ATTEMPT_ID_REUSED",
        "The new attempt identity must differ from the current attempt's identity.",
      );
    }
  }

  return allowRule(matched);
}

/**
 * All statically-known legal outbound transitions from a state. BLOCKED
 * is context-dependent: its outbound legality derives from
 * BLOCKED_OPERATION_MATRIX and RECONCILIATION_MATRIX, so this returns
 * only table rules (empty for BLOCKED and for terminal states).
 */
export function legalTransitionsFrom(from: TaskState): readonly TransitionRule[] {
  TaskStateSchema.parse(from);
  return TRANSITION_RULES.filter((r) => r.from === from);
}
