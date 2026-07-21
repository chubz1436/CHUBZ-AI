import { z } from "zod";

/**
 * The visible task states, exactly as defined by the accepted state
 * diagram in docs/FINAL_ARCHITECTURE_DESIGN.md §10 (D-017).
 *
 * NOTE: the §10 prose says "Twelve states" but the accepted diagram and
 * transition-authority table define the 14 states below. The diagram is
 * the substantive source of truth; the count discrepancy is reported as
 * a documentation defect, not resolved by dropping states here.
 */
export const TASK_STATES = Object.freeze([
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
] as const);

export const TaskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskStateSchema>;

/**
 * Fully terminal states: no transition of any kind may leave them.
 * FAILED is deliberately NOT terminal — the owner may retry it, but only
 * by creating a new immutable attempt (see task-transitions.ts).
 */
export const TERMINAL_STATES = Object.freeze([
  "COMPLETED",
  "REJECTED",
  "CANCELLED",
] as const satisfies readonly TaskState[]);

export type TerminalState = (typeof TERMINAL_STATES)[number];

export function isTerminalState(state: TaskState): state is TerminalState {
  return (TERMINAL_STATES as readonly TaskState[]).includes(state);
}

/**
 * BLOCKED reason codes (§10). These are attributes of the BLOCKED state,
 * never additional visible states. `execution-unknown` marks a privileged
 * operation journaled as started whose completion cannot be proven; it
 * requires owner-reviewed reconciliation and blocks blind retry.
 */
export const BLOCKED_REASONS = Object.freeze([
  "queue-lock",
  "conflict",
  "missing-context",
  "policy",
  "abandoned",
  "execution-unknown",
  /** M1F: trusted readiness/routing snapshots found no eligible worker. */
  "no-eligible-worker",
  /** M1F: authoritative lease snapshot invalidates the pending operation. */
  "stale-lease",
] as const);

export const BlockedReasonSchema = z.enum(BLOCKED_REASONS);
export type BlockedReason = z.infer<typeof BlockedReasonSchema>;

/**
 * Actor categories permitted to trigger transitions (§10 transition
 * authority). `reviewer` exists as a category but triggers no transition
 * in the accepted model: reviewers advise, the owner decides.
 */
export const ACTOR_CATEGORIES = Object.freeze([
  "owner",
  "control-plane",
  "local-bridge",
  "worker",
  "reviewer",
  "system-recovery",
] as const);

export const ActorCategorySchema = z.enum(ACTOR_CATEGORIES);
export type ActorCategory = z.infer<typeof ActorCategorySchema>;
