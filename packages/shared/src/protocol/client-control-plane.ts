import { z } from "zod";
import { ParsedCommandSchema, ParsedNaturalLanguageSchema } from "../commands.js";
import { BlockedReasonSchema, TaskStateSchema } from "../task-states.js";
import {
  IsoUtcTimestampSchema,
  PROTOCOL_LIMITS,
  SafeIdSchema,
  SlugIdSchema,
  boundedText,
  displayText,
  mutatingEnvelope,
  readonlyEnvelope,
} from "./common.js";
import { ProtocolErrorSchema, parseEnvelopeWith, type EnvelopeParseResult } from "./errors.js";
import { EventSequenceSchema, StreamCursorSchema } from "./event-cursor.js";

/**
 * Client ↔ Control Plane protocol contracts (M1B, D-023).
 *
 * The owner-input grammar is NOT reimplemented here: chat.submit
 * carries the already-parsed M1A command or natural-language result
 * (never the "invalid" variant — clients must not submit parse errors).
 * No credential, token, cookie, or environment field exists anywhere in
 * this direction; strict schemas reject any attempt to add one.
 */

// ---------------------------------------------------------------------------
// Client → Control Plane requests
// ---------------------------------------------------------------------------

/** Valid owner input: a parsed command or a natural-language request. */
export const OwnerInputSchema = z.discriminatedUnion("kind", [
  ParsedCommandSchema,
  ParsedNaturalLanguageSchema,
]);
export type OwnerInput = z.infer<typeof OwnerInputSchema>;

const ownerInputWithinBounds = (input: OwnerInput): boolean => {
  const text = input.kind === "command" ? input.argumentText : input.text;
  return text.length <= PROTOCOL_LIMITS.maxOwnerTextLength;
};

export const ChatSubmitPayloadSchema = z
  .strictObject({
    input: OwnerInputSchema,
    projectId: SlugIdSchema,
    workerId: SlugIdSchema.optional(),
    clientMeta: z
      .strictObject({
        clientName: boundedText(64),
        clientVersion: boundedText(32),
      })
      .optional(),
  })
  .refine((payload) => ownerInputWithinBounds(payload.input), {
    path: ["input"],
    message: `owner text must not exceed ${PROTOCOL_LIMITS.maxOwnerTextLength} characters`,
  });

export const APPROVAL_DECISIONS = Object.freeze(["approve", "reject", "request-revision"] as const);
export const ApprovalDecisionSchema = z.enum(APPROVAL_DECISIONS);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/**
 * Bounded approval decision reference only. It carries NO authority
 * payload; capability grants and their cryptography are M1C.
 */
export const ApprovalDecidePayloadSchema = z.strictObject({
  approvalRequestId: SafeIdSchema,
  decision: ApprovalDecisionSchema,
  note: boundedText(PROTOCOL_LIMITS.maxStatusTextLength).optional(),
});

/** Cancellation request — implies nothing about termination success. */
export const TaskCancelPayloadSchema = z.strictObject({
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema.optional(),
  reasonNote: boundedText(PROTOCOL_LIMITS.maxStatusTextLength).optional(),
});

export const TaskGetPayloadSchema = z.strictObject({
  taskId: SafeIdSchema,
});

export const TaskListPayloadSchema = z.strictObject({
  projectId: SlugIdSchema.optional(),
  states: z.array(TaskStateSchema).min(1).max(14).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const StreamResumePayloadSchema = z.strictObject({
  cursor: StreamCursorSchema,
});

export const ChatSubmitMessageSchema = mutatingEnvelope("chat.submit", ChatSubmitPayloadSchema);
export const ApprovalDecideMessageSchema = mutatingEnvelope(
  "approval.decide",
  ApprovalDecidePayloadSchema,
);
export const TaskCancelMessageSchema = mutatingEnvelope("task.cancel", TaskCancelPayloadSchema);
export const TaskGetMessageSchema = readonlyEnvelope("task.get", TaskGetPayloadSchema);
export const TaskListMessageSchema = readonlyEnvelope("task.list", TaskListPayloadSchema);
export const StreamResumeMessageSchema = readonlyEnvelope(
  "stream.resume",
  StreamResumePayloadSchema,
);

export const CLIENT_TO_CONTROL_PLANE_KINDS = Object.freeze([
  "chat.submit",
  "approval.decide",
  "task.cancel",
  "task.get",
  "task.list",
  "stream.resume",
] as const);

export const MUTATING_CLIENT_KINDS = Object.freeze([
  "chat.submit",
  "approval.decide",
  "task.cancel",
] as const);

export const READONLY_CLIENT_KINDS = Object.freeze([
  "task.get",
  "task.list",
  "stream.resume",
] as const);

export const ClientToControlPlaneMessageSchema = z.discriminatedUnion("messageKind", [
  ChatSubmitMessageSchema,
  ApprovalDecideMessageSchema,
  TaskCancelMessageSchema,
  TaskGetMessageSchema,
  TaskListMessageSchema,
  StreamResumeMessageSchema,
]);
export type ClientToControlPlaneMessage = z.infer<typeof ClientToControlPlaneMessageSchema>;

export function parseClientToControlPlaneMessage(
  raw: unknown,
): EnvelopeParseResult<ClientToControlPlaneMessage> {
  return parseEnvelopeWith(ClientToControlPlaneMessageSchema, CLIENT_TO_CONTROL_PLANE_KINDS, raw);
}

// ---------------------------------------------------------------------------
// Control Plane → Client messages
// ---------------------------------------------------------------------------

export const RequestAcceptedPayloadSchema = z.strictObject({
  acceptedMessageId: SafeIdSchema,
  /** Duplicate deliveries replay the recorded result (see idempotency). */
  replayClassification: z.enum(["new", "duplicate-same-request"]).optional(),
  resultRef: SafeIdSchema.optional(),
});

export const RequestRejectedPayloadSchema = z.strictObject({
  rejectedMessageId: SafeIdSchema,
  error: ProtocolErrorSchema,
});

/** Task snapshots use the M1A task-state type — never a parallel enum. */
export const TaskSnapshotPayloadSchema = z.strictObject({
  taskId: SafeIdSchema,
  projectId: SlugIdSchema,
  workerId: SlugIdSchema.optional(),
  state: TaskStateSchema,
  blockedReason: BlockedReasonSchema.optional(),
  attemptId: SafeIdSchema.optional(),
  updatedAt: IsoUtcTimestampSchema,
  summary: displayText(PROTOCOL_LIMITS.maxStatusTextLength).optional(),
});

export const TaskEventPayloadSchema = z.strictObject({
  streamId: SafeIdSchema,
  sequence: EventSequenceSchema,
  eventId: SafeIdSchema,
  taskId: SafeIdSchema,
  occurredAt: IsoUtcTimestampSchema,
  eventKind: SafeIdSchema,
  /** Worker output appears only as plain bounded text… */
  summary: displayText(PROTOCOL_LIMITS.maxWorkerSummaryLength).optional(),
  /** …or as artifact references; never unbounded inline content. */
  artifactIds: z.array(SafeIdSchema).max(PROTOCOL_LIMITS.maxMetadataEntries).optional(),
});

/**
 * Approval card: CONTROL-PLANE-DERIVED facts only (diff stats, test
 * verdict, gate, expiry). There is deliberately no field for
 * worker-authored action text, so worker output cannot phrase the thing
 * being approved. All display fields are markup-free by schema.
 */
export const ApprovalRequestedPayloadSchema = z.strictObject({
  approvalRequestId: SafeIdSchema,
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  gate: SlugIdSchema,
  actionSummary: displayText(PROTOCOL_LIMITS.maxStatusTextLength),
  diffStats: z
    .strictObject({
      filesChanged: z.number().int().min(0),
      insertions: z.number().int().min(0),
      deletions: z.number().int().min(0),
    })
    .optional(),
  testVerdict: z.enum(["passed", "failed", "none"]).optional(),
  riskFlags: z.array(displayText(200)).max(PROTOCOL_LIMITS.maxRiskFlags).optional(),
  expiresAt: IsoUtcTimestampSchema,
});

/** Connector tier is always shown honestly (D-012). */
export const WorkerStatusPayloadSchema = z.strictObject({
  workerId: SlugIdSchema,
  connectorTier: z.enum(["automated", "manual"]),
  state: z.enum(["ready", "busy", "queued", "blocked", "offline", "manual"]),
  activeTaskId: SafeIdSchema.optional(),
  queuedCount: z.number().int().min(0).optional(),
  lastError: displayText(PROTOCOL_LIMITS.maxStatusTextLength).optional(),
});

export const ProtocolErrorPayloadSchema = z.strictObject({
  error: ProtocolErrorSchema,
});

export const RequestAcceptedMessageSchema = readonlyEnvelope(
  "request.accepted",
  RequestAcceptedPayloadSchema,
);
export const RequestRejectedMessageSchema = readonlyEnvelope(
  "request.rejected",
  RequestRejectedPayloadSchema,
);
export const TaskSnapshotMessageSchema = readonlyEnvelope(
  "task.snapshot",
  TaskSnapshotPayloadSchema,
);
export const TaskEventMessageSchema = readonlyEnvelope("task.event", TaskEventPayloadSchema);
export const ApprovalRequestedMessageSchema = readonlyEnvelope(
  "approval.requested",
  ApprovalRequestedPayloadSchema,
);
export const WorkerStatusMessageSchema = readonlyEnvelope(
  "worker.status",
  WorkerStatusPayloadSchema,
);
export const ProtocolErrorMessageSchema = readonlyEnvelope(
  "protocol.error",
  ProtocolErrorPayloadSchema,
);

export const CONTROL_PLANE_TO_CLIENT_KINDS = Object.freeze([
  "request.accepted",
  "request.rejected",
  "task.snapshot",
  "task.event",
  "approval.requested",
  "worker.status",
  "protocol.error",
] as const);

export const ControlPlaneToClientMessageSchema = z.discriminatedUnion("messageKind", [
  RequestAcceptedMessageSchema,
  RequestRejectedMessageSchema,
  TaskSnapshotMessageSchema,
  TaskEventMessageSchema,
  ApprovalRequestedMessageSchema,
  WorkerStatusMessageSchema,
  ProtocolErrorMessageSchema,
]);
export type ControlPlaneToClientMessage = z.infer<typeof ControlPlaneToClientMessageSchema>;

export function parseControlPlaneToClientMessage(
  raw: unknown,
): EnvelopeParseResult<ControlPlaneToClientMessage> {
  return parseEnvelopeWith(ControlPlaneToClientMessageSchema, CONTROL_PLANE_TO_CLIENT_KINDS, raw);
}
