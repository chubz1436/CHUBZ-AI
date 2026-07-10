import { z } from "zod";
import {
  ActorCategorySchema,
  BlockedReasonSchema,
  TaskStateSchema,
  isTerminalState,
  type ActorCategory,
  type TaskState,
} from "./task-states.js";

/**
 * Legal-transition model for the accepted state machine
 * (docs/FINAL_ARCHITECTURE_DESIGN.md §10, D-017, clarified by D-020).
 *
 * AUTHORITY MODEL (M1A review correction 4): the Control Plane records
 * state and is the transition actor for system transitions; Bridge-origin
 * facts are mandatory typed EVIDENCE, never an alternative actor. One
 * uncorroborated party can therefore never satisfy a joint-authority
 * transition: the Control Plane cannot move a task without the Bridge's
 * evidence, and the Bridge is not an actor at all — it reports facts.
 *
 * Sources per rule:
 *  - "diagram"             — drawn explicitly in the §10 state diagram.
 *  - "d-020-clarification" — owner-accepted D-020: cancellation paths
 *    (in-flight states cancel via CANCELLING, passive states directly)
 *    and the execution-unknown reconciliation exits.
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

/**
 * Owner-reviewed reconciliation outcomes for BLOCKED(execution-unknown)
 * (D-020). No automated actor may resolve execution-unknown; ordinary
 * unblock, re-dispatch, and cancellation are all refused until the owner
 * records one of these outcomes with evidence.
 */
export const RECONCILIATION_OUTCOMES = Object.freeze([
  "confirmed-completed",
  "confirmed-failed",
  "confirmed-not-executed",
] as const);
export const ReconciliationOutcomeSchema = z.enum(RECONCILIATION_OUTCOMES);
export type ReconciliationOutcome = z.infer<typeof ReconciliationOutcomeSchema>;

export interface TransitionRule {
  readonly from: TaskState;
  readonly to: TaskState;
  readonly actors: readonly ActorCategory[];
  /** True only where the transition IS the owner's approval decision. */
  readonly requiresOwnerApproval: boolean;
  /** Retries/revisions must create a new immutable attempt (§10). */
  readonly requiresNewAttempt: boolean;
  /** Transitions into BLOCKED must carry a reason code (§10). */
  readonly requiresReasonCode: boolean;
  /** Bridge/owner facts that MUST accompany this transition. */
  readonly requiredEvidence: readonly TransitionEvidence[];
  /**
   * Set only on the three D-020 reconciliation exits: the rule is legal
   * solely from BLOCKED(execution-unknown) and solely with this outcome.
   */
  readonly reconciliationOutcome?: ReconciliationOutcome;
  readonly source: "diagram" | "d-020-clarification";
}

interface RuleOpts {
  requiresOwnerApproval?: boolean;
  requiresNewAttempt?: boolean;
  requiresReasonCode?: boolean;
  requiredEvidence?: readonly TransitionEvidence[];
  reconciliationOutcome?: ReconciliationOutcome;
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
    requiresNewAttempt: opts.requiresNewAttempt ?? false,
    requiresReasonCode: opts.requiresReasonCode ?? false,
    requiredEvidence: Object.freeze([...(opts.requiredEvidence ?? [])]),
    ...(opts.reconciliationOutcome !== undefined
      ? { reconciliationOutcome: opts.reconciliationOutcome }
      : {}),
    source: opts.source ?? "diagram",
  });

export const TRANSITION_RULES: readonly TransitionRule[] = Object.freeze([
  // Draft
  rule("DRAFT", "CONTEXT_PREPARING", ["owner"]),
  rule("DRAFT", "CANCELLED", ["owner"]),
  // Context preparation
  rule("CONTEXT_PREPARING", "AWAITING_DISPATCH", ["control-plane"]),
  rule("CONTEXT_PREPARING", "BLOCKED", ["control-plane"], { requiresReasonCode: true }),
  rule("CONTEXT_PREPARING", "CANCELLED", ["owner"], { source: "d-020-clarification" }),
  // Dispatch queue — RUNNING only with the Bridge's dispatch acknowledgement
  rule("AWAITING_DISPATCH", "RUNNING", ["control-plane"], {
    requiredEvidence: ["bridge-dispatch-ack"],
  }),
  rule("AWAITING_DISPATCH", "BLOCKED", ["control-plane", "system-recovery"], {
    requiresReasonCode: true,
  }),
  rule("AWAITING_DISPATCH", "CANCELLING", ["owner"], { source: "d-020-clarification" }),
  // Running — outcomes exist only as Bridge-reported facts
  rule("RUNNING", "RESULT_CAPTURED", ["control-plane"], {
    requiredEvidence: ["bridge-execution-report"],
  }),
  rule("RUNNING", "FAILED", ["control-plane"], {
    requiredEvidence: ["bridge-execution-report"],
  }),
  rule("RUNNING", "CANCELLING", ["owner"]),
  rule("RUNNING", "BLOCKED", ["system-recovery"], {
    requiresReasonCode: true,
    source: "d-020-clarification",
  }),
  // Captured result
  rule("RESULT_CAPTURED", "AWAITING_APPROVAL", ["control-plane"]),
  rule("RESULT_CAPTURED", "CANCELLED", ["owner"], { source: "d-020-clarification" }),
  // Owner gate
  rule("AWAITING_APPROVAL", "APPROVED", ["owner"], { requiresOwnerApproval: true }),
  rule("AWAITING_APPROVAL", "REJECTED", ["owner"]),
  rule("AWAITING_APPROVAL", "REVISION_REQUESTED", ["owner"]),
  rule("AWAITING_APPROVAL", "CANCELLED", ["owner"], { source: "d-020-clarification" }),
  // Revision
  rule("REVISION_REQUESTED", "CONTEXT_PREPARING", ["owner"], { requiresNewAttempt: true }),
  rule("REVISION_REQUESTED", "CANCELLED", ["owner"], { source: "d-020-clarification" }),
  // Approved / integration — completion needs the Bridge's integration
  // report AND verified-grant execution; neither party suffices alone.
  rule("APPROVED", "COMPLETED", ["control-plane"], {
    requiredEvidence: ["bridge-integration-report", "grant-verified"],
  }),
  rule("APPROVED", "FAILED", ["control-plane"], {
    requiredEvidence: ["bridge-integration-report", "grant-verified"],
  }),
  rule("APPROVED", "BLOCKED", ["system-recovery"], {
    requiresReasonCode: true,
    source: "d-020-clarification",
  }),
  rule("APPROVED", "CANCELLING", ["owner"], { source: "d-020-clarification" }),
  // Blocked — ordinary reasons only; execution-unknown is gated below
  rule("BLOCKED", "AWAITING_DISPATCH", ["control-plane", "owner"]),
  rule("BLOCKED", "CANCELLED", ["owner"]),
  // D-020 owner-reviewed reconciliation exits from BLOCKED(execution-unknown)
  rule("BLOCKED", "COMPLETED", ["owner"], {
    reconciliationOutcome: "confirmed-completed",
    requiredEvidence: ["owner-reconciliation"],
    source: "d-020-clarification",
  }),
  rule("BLOCKED", "FAILED", ["owner"], {
    reconciliationOutcome: "confirmed-failed",
    requiredEvidence: ["owner-reconciliation"],
    source: "d-020-clarification",
  }),
  rule("BLOCKED", "CONTEXT_PREPARING", ["owner"], {
    reconciliationOutcome: "confirmed-not-executed",
    requiredEvidence: ["owner-reconciliation"],
    requiresNewAttempt: true,
    source: "d-020-clarification",
  }),
  // Cancellation confirmation — recorded by the Control Plane only on the
  // Bridge's kill confirmation
  rule("CANCELLING", "CANCELLED", ["control-plane"], {
    requiredEvidence: ["bridge-kill-confirmation"],
  }),
  // Failure retry
  rule("FAILED", "CONTEXT_PREPARING", ["owner"], { requiresNewAttempt: true }),
]);

export const DENY_CODES = Object.freeze([
  "SAME_STATE",
  "TERMINAL_STATE",
  "UNKNOWN_TRANSITION",
  "ACTOR_NOT_PERMITTED",
  "REASON_CODE_REQUIRED",
  "UNEXPECTED_REASON_CODE",
  "BLOCKED_REASON_REQUIRED",
  "UNEXPECTED_BLOCKED_REASON",
  "RECONCILIATION_REQUIRED",
  "RECONCILIATION_NOT_APPLICABLE",
  "INVALID_RECONCILIATION_OUTCOME",
  "UNEXPECTED_RECONCILIATION_OUTCOME",
  "RECONCILIATION_EVIDENCE_REQUIRED",
  "MISSING_REQUIRED_EVIDENCE",
  "NEW_ATTEMPT_REQUIRED",
] as const);

export type DenyCode = (typeof DENY_CODES)[number];

export const CanTransitionInputSchema = z
  .strictObject({
    from: TaskStateSchema,
    to: TaskStateSchema,
    actor: ActorCategorySchema,
    /** Required iff the TARGET state is BLOCKED. */
    reasonCode: BlockedReasonSchema.optional(),
    /** Required iff the CURRENT state (`from`) is BLOCKED; forbidden otherwise. */
    currentBlockedReason: BlockedReasonSchema.optional(),
    /** Must be true for retry/revision/reconciled-rework transitions. */
    isNewAttempt: z.boolean().optional(),
    /**
     * Typed facts accompanying the transition. Required evidence per rule
     * must all be present; superfluous valid evidence is tolerated (extra
     * true facts never invalidate a transition).
     */
    evidence: z.array(TransitionEvidenceSchema).readonly().optional(),
    /** Required iff the matched rule is a D-020 reconciliation exit. */
    reconciliationOutcome: ReconciliationOutcomeSchema.optional(),
  })
  .readonly();

export type CanTransitionInput = z.infer<typeof CanTransitionInputSchema>;

export type CanTransitionResult =
  | {
      readonly allowed: true;
      readonly rule: TransitionRule;
      readonly requiresOwnerApproval: boolean;
      readonly requiresNewAttempt: boolean;
    }
  | {
      readonly allowed: false;
      readonly code: DenyCode;
      readonly message: string;
    };

const deny = (code: DenyCode, message: string): CanTransitionResult =>
  Object.freeze({ allowed: false, code, message });

/**
 * Pure legal-transition decision. Deny-by-default: anything not
 * explicitly present in TRANSITION_RULES is refused, and contextual
 * fields are validated strictly in both directions so callers can never
 * bypass a restriction by omitting or smuggling context.
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

  // Contextual field validation (M1A review correction 1): the blocked
  // reason is trusted context — required when leaving BLOCKED (omitting
  // it must never bypass execution-unknown gating) and forbidden
  // elsewhere; reasonCode exists only when entering BLOCKED.
  if (input.from === "BLOCKED" && input.currentBlockedReason === undefined) {
    return deny(
      "BLOCKED_REASON_REQUIRED",
      "Transitions out of BLOCKED require currentBlockedReason; omitting it cannot bypass execution-unknown gating.",
    );
  }
  if (input.from !== "BLOCKED" && input.currentBlockedReason !== undefined) {
    return deny(
      "UNEXPECTED_BLOCKED_REASON",
      `currentBlockedReason is only meaningful when the current state is BLOCKED (got from=${input.from}).`,
    );
  }
  if (input.to !== "BLOCKED" && input.reasonCode !== undefined) {
    return deny(
      "UNEXPECTED_REASON_CODE",
      `reasonCode is only meaningful when the target state is BLOCKED (got to=${input.to}).`,
    );
  }

  const matched = TRANSITION_RULES.find((r) => r.from === input.from && r.to === input.to);
  if (matched === undefined) {
    return deny(
      "UNKNOWN_TRANSITION",
      `No legal transition from ${input.from} to ${input.to}; unknown transitions are denied by default.`,
    );
  }

  // D-020: BLOCKED(execution-unknown) is not an ordinary blocked state.
  // Ordinary unblock, re-dispatch, and cancellation are refused for every
  // actor (including the owner) until a reconciliation outcome is
  // recorded through one of the dedicated reconciliation rules.
  const fromExecutionUnknown =
    input.from === "BLOCKED" && input.currentBlockedReason === "execution-unknown";

  if (fromExecutionUnknown && matched.reconciliationOutcome === undefined) {
    return deny(
      "RECONCILIATION_REQUIRED",
      "BLOCKED(execution-unknown) may only be resolved through an owner-reviewed reconciliation outcome; ordinary unblock, re-dispatch, and cancellation are refused.",
    );
  }
  if (!fromExecutionUnknown && matched.reconciliationOutcome !== undefined) {
    return deny(
      "RECONCILIATION_NOT_APPLICABLE",
      `Reconciliation exits apply only to BLOCKED(execution-unknown), not BLOCKED(${input.currentBlockedReason ?? "unknown"}).`,
    );
  }

  if (!matched.actors.includes(input.actor)) {
    return deny(
      "ACTOR_NOT_PERMITTED",
      `Actor '${input.actor}' may not perform ${input.from} -> ${input.to}; permitted: ${matched.actors.join(", ")}.`,
    );
  }

  if (matched.requiresReasonCode && input.reasonCode === undefined) {
    return deny(
      "REASON_CODE_REQUIRED",
      `Transition ${input.from} -> ${input.to} requires a BLOCKED reason code.`,
    );
  }

  // Reconciliation outcome must match the dedicated rule exactly; it may
  // not be supplied on any other transition.
  if (matched.reconciliationOutcome !== undefined) {
    if (input.reconciliationOutcome !== matched.reconciliationOutcome) {
      return deny(
        "INVALID_RECONCILIATION_OUTCOME",
        `Transition ${input.from} -> ${input.to} requires the explicit reconciliation outcome '${matched.reconciliationOutcome}'.`,
      );
    }
  } else if (input.reconciliationOutcome !== undefined) {
    return deny(
      "UNEXPECTED_RECONCILIATION_OUTCOME",
      `Transition ${input.from} -> ${input.to} is not a reconciliation exit; reconciliationOutcome must not be supplied.`,
    );
  }

  const supplied = input.evidence ?? [];
  const missing = matched.requiredEvidence.filter((e) => !supplied.includes(e));
  if (missing.length > 0) {
    if (missing.includes("owner-reconciliation")) {
      return deny(
        "RECONCILIATION_EVIDENCE_REQUIRED",
        `Reconciliation of ${input.from} -> ${input.to} requires recorded owner-reconciliation evidence.`,
      );
    }
    return deny(
      "MISSING_REQUIRED_EVIDENCE",
      `Transition ${input.from} -> ${input.to} requires evidence: ${matched.requiredEvidence.join(", ")} (missing: ${missing.join(", ")}). One uncorroborated actor never suffices.`,
    );
  }

  if (matched.requiresNewAttempt && input.isNewAttempt !== true) {
    return deny(
      "NEW_ATTEMPT_REQUIRED",
      `Transition ${input.from} -> ${input.to} must create a new immutable attempt; prior attempts are never rerun.`,
    );
  }

  return Object.freeze({
    allowed: true,
    rule: matched,
    requiresOwnerApproval: matched.requiresOwnerApproval,
    requiresNewAttempt: matched.requiresNewAttempt,
  });
}

/** All legal outbound transitions from a state (empty for terminal states). */
export function legalTransitionsFrom(from: TaskState): readonly TransitionRule[] {
  TaskStateSchema.parse(from);
  return TRANSITION_RULES.filter((r) => r.from === from);
}
