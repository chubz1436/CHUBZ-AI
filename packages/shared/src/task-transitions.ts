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
 * (docs/FINAL_ARCHITECTURE_DESIGN.md §10, D-017).
 *
 * Sources per rule:
 *  - "diagram"              — drawn explicitly in the §10 state diagram.
 *  - "authority-extension"  — implied by the §10 transition-authority row
 *    "any active → CANCELLING | Owner only" and the owner's undisputed
 *    power to abandon un-run work. States where asynchronous bridge work
 *    may be in flight (AWAITING_DISPATCH, RUNNING, APPROVED) cancel via
 *    CANCELLING (the bridge must confirm); passive states cancel directly
 *    to CANCELLED. Recovery entries to BLOCKED implement §16
 *    (execution-unknown reconciliation).
 */
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
  readonly source: "diagram" | "authority-extension";
}

const rule = (
  from: TaskState,
  to: TaskState,
  actors: readonly ActorCategory[],
  opts: Partial<Pick<TransitionRule, "requiresOwnerApproval" | "requiresNewAttempt" | "requiresReasonCode" | "source">> = {},
): TransitionRule =>
  Object.freeze({
    from,
    to,
    actors: Object.freeze([...actors]),
    requiresOwnerApproval: opts.requiresOwnerApproval ?? false,
    requiresNewAttempt: opts.requiresNewAttempt ?? false,
    requiresReasonCode: opts.requiresReasonCode ?? false,
    source: opts.source ?? "diagram",
  });

export const TRANSITION_RULES: readonly TransitionRule[] = Object.freeze([
  // Draft
  rule("DRAFT", "CONTEXT_PREPARING", ["owner"]),
  rule("DRAFT", "CANCELLED", ["owner"]),
  // Context preparation
  rule("CONTEXT_PREPARING", "AWAITING_DISPATCH", ["control-plane"]),
  rule("CONTEXT_PREPARING", "BLOCKED", ["control-plane"], { requiresReasonCode: true }),
  rule("CONTEXT_PREPARING", "CANCELLED", ["owner"], { source: "authority-extension" }),
  // Dispatch queue
  rule("AWAITING_DISPATCH", "RUNNING", ["control-plane"]),
  rule("AWAITING_DISPATCH", "BLOCKED", ["control-plane", "system-recovery"], { requiresReasonCode: true }),
  rule("AWAITING_DISPATCH", "CANCELLING", ["owner"], { source: "authority-extension" }),
  // Running
  rule("RUNNING", "RESULT_CAPTURED", ["local-bridge", "control-plane"]),
  rule("RUNNING", "FAILED", ["local-bridge", "control-plane"]),
  rule("RUNNING", "CANCELLING", ["owner"]),
  rule("RUNNING", "BLOCKED", ["system-recovery"], { requiresReasonCode: true, source: "authority-extension" }),
  // Captured result
  rule("RESULT_CAPTURED", "AWAITING_APPROVAL", ["control-plane"]),
  rule("RESULT_CAPTURED", "CANCELLED", ["owner"], { source: "authority-extension" }),
  // Owner gate
  rule("AWAITING_APPROVAL", "APPROVED", ["owner"], { requiresOwnerApproval: true }),
  rule("AWAITING_APPROVAL", "REJECTED", ["owner"]),
  rule("AWAITING_APPROVAL", "REVISION_REQUESTED", ["owner"]),
  rule("AWAITING_APPROVAL", "CANCELLED", ["owner"], { source: "authority-extension" }),
  // Revision
  rule("REVISION_REQUESTED", "CONTEXT_PREPARING", ["owner"], { requiresNewAttempt: true }),
  rule("REVISION_REQUESTED", "CANCELLED", ["owner"], { source: "authority-extension" }),
  // Approved / integration
  rule("APPROVED", "COMPLETED", ["control-plane", "local-bridge"]),
  rule("APPROVED", "FAILED", ["control-plane", "local-bridge"]),
  rule("APPROVED", "BLOCKED", ["system-recovery"], { requiresReasonCode: true, source: "authority-extension" }),
  rule("APPROVED", "CANCELLING", ["owner"], { source: "authority-extension" }),
  // Blocked
  rule("BLOCKED", "AWAITING_DISPATCH", ["control-plane", "owner"]),
  rule("BLOCKED", "CANCELLED", ["owner"]),
  // Cancellation confirmation
  rule("CANCELLING", "CANCELLED", ["local-bridge"]),
  // Failure retry
  rule("FAILED", "CONTEXT_PREPARING", ["owner"], { requiresNewAttempt: true }),
]);

export const DENY_CODES = Object.freeze([
  "TERMINAL_STATE",
  "UNKNOWN_TRANSITION",
  "ACTOR_NOT_PERMITTED",
  "REASON_CODE_REQUIRED",
  "EXECUTION_UNKNOWN_REQUIRES_OWNER",
  "NEW_ATTEMPT_REQUIRED",
  "SAME_STATE",
] as const);

export type DenyCode = (typeof DENY_CODES)[number];

export const CanTransitionInputSchema = z
  .strictObject({
    from: TaskStateSchema,
    to: TaskStateSchema,
    actor: ActorCategorySchema,
    /** Required when the target state is BLOCKED. */
    reasonCode: BlockedReasonSchema.optional(),
    /** The stored reason of the CURRENT state when `from` is BLOCKED. */
    currentBlockedReason: BlockedReasonSchema.optional(),
    /** Must be true for retry/revision transitions (new immutable attempt). */
    isNewAttempt: z.boolean().optional(),
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
 * explicitly present in TRANSITION_RULES is refused.
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

  const matched = TRANSITION_RULES.find((r) => r.from === input.from && r.to === input.to);
  if (matched === undefined) {
    return deny(
      "UNKNOWN_TRANSITION",
      `No legal transition from ${input.from} to ${input.to}; unknown transitions are denied by default.`,
    );
  }

  // §16 / §10: BLOCKED(execution-unknown) requires owner-reviewed
  // reconciliation. Nothing may leave that condition without the owner —
  // automated (blind) retry is structurally refused.
  if (
    input.from === "BLOCKED" &&
    input.currentBlockedReason === "execution-unknown" &&
    input.actor !== "owner"
  ) {
    return deny(
      "EXECUTION_UNKNOWN_REQUIRES_OWNER",
      "BLOCKED(execution-unknown) requires owner-reviewed reconciliation; automated retry is refused.",
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
