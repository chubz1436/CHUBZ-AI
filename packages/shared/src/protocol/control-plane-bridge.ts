import { z } from "zod";
import { TransitionEvidenceSchema } from "../task-transitions.js";
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
import { parseEnvelopeWith, type EnvelopeParseResult } from "./errors.js";

/**
 * Control Plane ↔ Local Bridge protocol contracts (M1B, D-023).
 *
 * TYPED HIGH-LEVEL OPERATIONS ONLY. There is no shell-command field, no
 * executable string, and no filesystem path anywhere in this direction:
 * every reference is a SafeId/SlugId, whose grammar structurally
 * excludes `/`, `\`, `:` and `..` — so absolute paths, drive-letter
 * paths, UNC paths, and traversal segments cannot even be expressed.
 * Actual executable and workspace paths are internal Bridge
 * configuration resolved from these identifiers.
 *
 * `authorizationRef` is an OPAQUE, UNVERIFIED reference. Capability
 * grants, their schema, and their cryptography are M1C; nothing here
 * claims verification.
 */

/** Reference to a validated worker-manifest identity + version. */
export const WorkerManifestRefSchema = z.strictObject({
  manifestId: SlugIdSchema,
  manifestVersion: z
    .string()
    .regex(/^[0-9]+\.[0-9]+\.[0-9]+$/, "must be a semver core version like 1.0.0"),
});
export type WorkerManifestRef = z.infer<typeof WorkerManifestRefSchema>;

// ---------------------------------------------------------------------------
// Control Plane → Bridge commands
// ---------------------------------------------------------------------------

export const BridgePingPayloadSchema = z.strictObject({
  echo: SafeIdSchema.optional(),
});

export const WorkspacePreparePayloadSchema = z.strictObject({
  projectId: SlugIdSchema,
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  workspaceId: SafeIdSchema,
  /** Git ref identifier (e.g. a commit hash) — an ID, never a path. */
  baseRef: SafeIdSchema.optional(),
  /** Opaque and unverified in M1B; M1C owns grants. */
  authorizationRef: SafeIdSchema.optional(),
});

export const WorkerDispatchPayloadSchema = z.strictObject({
  projectId: SlugIdSchema,
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  operationId: SafeIdSchema,
  workspaceId: SafeIdSchema,
  worker: WorkerManifestRefSchema,
  prompt: z.strictObject({
    text: boundedText(PROTOCOL_LIMITS.maxOwnerTextLength),
    contextArtifactIds: z.array(SafeIdSchema).max(PROTOCOL_LIMITS.maxMetadataEntries),
  }),
  /** Opaque and unverified in M1B; M1C owns grants. */
  authorizationRef: SafeIdSchema.optional(),
});

/** Identifies the EXACT operation and originating dispatch to cancel. */
export const WorkerCancelPayloadSchema = z.strictObject({
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  operationId: SafeIdSchema,
  dispatchCommandId: SafeIdSchema,
});

export const ResultCollectPayloadSchema = z.strictObject({
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  operationId: SafeIdSchema,
  workspaceId: SafeIdSchema,
});

export const BridgePingMessageSchema = readonlyEnvelope("bridge.ping", BridgePingPayloadSchema);
export const WorkspacePrepareMessageSchema = mutatingEnvelope(
  "workspace.prepare",
  WorkspacePreparePayloadSchema,
);
export const WorkerDispatchMessageSchema = mutatingEnvelope(
  "worker.dispatch",
  WorkerDispatchPayloadSchema,
);
export const WorkerCancelMessageSchema = mutatingEnvelope(
  "worker.cancel",
  WorkerCancelPayloadSchema,
);
export const ResultCollectMessageSchema = mutatingEnvelope(
  "result.collect",
  ResultCollectPayloadSchema,
);

export const CONTROL_PLANE_TO_BRIDGE_KINDS = Object.freeze([
  "bridge.ping",
  "workspace.prepare",
  "worker.dispatch",
  "worker.cancel",
  "result.collect",
] as const);

export const MUTATING_BRIDGE_COMMAND_KINDS = Object.freeze([
  "workspace.prepare",
  "worker.dispatch",
  "worker.cancel",
  "result.collect",
] as const);

export const ControlPlaneToBridgeMessageSchema = z.discriminatedUnion("messageKind", [
  BridgePingMessageSchema,
  WorkspacePrepareMessageSchema,
  WorkerDispatchMessageSchema,
  WorkerCancelMessageSchema,
  ResultCollectMessageSchema,
]);
export type ControlPlaneToBridgeMessage = z.infer<typeof ControlPlaneToBridgeMessageSchema>;

export function parseControlPlaneToBridgeMessage(
  raw: unknown,
): EnvelopeParseResult<ControlPlaneToBridgeMessage> {
  return parseEnvelopeWith(ControlPlaneToBridgeMessageSchema, CONTROL_PLANE_TO_BRIDGE_KINDS, raw);
}

// ---------------------------------------------------------------------------
// Bridge → Control Plane reports
// ---------------------------------------------------------------------------

export const BridgePongPayloadSchema = z.strictObject({
  echo: SafeIdSchema.optional(),
  bridgeVersion: boundedText(32).optional(),
});

/**
 * Acknowledgement: "the command was received and journaled". It is NOT
 * execution proof and has neither an outcome nor evidence field, so it
 * can never satisfy a final-result schema.
 */
export const CommandAckPayloadSchema = z.strictObject({
  commandMessageId: SafeIdSchema,
  taskId: SafeIdSchema.optional(),
  attemptId: SafeIdSchema.optional(),
  operationId: SafeIdSchema.optional(),
});

/** Progress is informational only — never final execution proof. */
export const CommandProgressPayloadSchema = z.strictObject({
  commandMessageId: SafeIdSchema,
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  operationId: SafeIdSchema,
  progressSequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  note: displayText(PROTOCOL_LIMITS.maxStatusTextLength).optional(),
});

/**
 * Final success report. Evidence kinds align with the M1A transition
 * evidence vocabulary (bridge-dispatch-ack, bridge-execution-report,
 * bridge-integration-report, …) without implementing transition
 * persistence. Large output goes to artifacts; the inline summary is
 * bounded plain text.
 */
export const CommandResultPayloadSchema = z.strictObject({
  commandMessageId: SafeIdSchema,
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  operationId: SafeIdSchema,
  outcome: z.literal("succeeded"),
  evidenceKinds: z.array(TransitionEvidenceSchema).min(1).max(8),
  summary: displayText(PROTOCOL_LIMITS.maxWorkerSummaryLength).optional(),
  artifactIds: z.array(SafeIdSchema).max(PROTOCOL_LIMITS.maxMetadataEntries),
});

export const BRIDGE_FAILURE_REASONS = Object.freeze([
  "timeout",
  "crash",
  "nonzero-exit",
  "cancelled",
  "workspace-error",
  "manifest-unknown",
  "internal",
] as const);
export const BridgeFailureReasonSchema = z.enum(BRIDGE_FAILURE_REASONS);
export type BridgeFailureReason = z.infer<typeof BridgeFailureReasonSchema>;

/** Final failure report — distinct from ack and progress by construction. */
export const CommandFailedPayloadSchema = z.strictObject({
  commandMessageId: SafeIdSchema,
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  operationId: SafeIdSchema,
  outcome: z.literal("failed"),
  failureReason: BridgeFailureReasonSchema,
  summary: displayText(PROTOCOL_LIMITS.maxStatusTextLength),
  evidenceKinds: z.array(TransitionEvidenceSchema).max(8).optional(),
  artifactIds: z.array(SafeIdSchema).max(PROTOCOL_LIMITS.maxMetadataEntries).optional(),
});

export const BridgeHealthPayloadSchema = z.strictObject({
  status: z.enum(["ok", "degraded"]),
  activeOperationIds: z.array(SafeIdSchema).max(32),
  queuedCount: z.number().int().min(0),
  reportedAt: IsoUtcTimestampSchema,
});

export const BridgePongMessageSchema = readonlyEnvelope("bridge.pong", BridgePongPayloadSchema);
export const CommandAckMessageSchema = readonlyEnvelope("command.ack", CommandAckPayloadSchema);
export const CommandProgressMessageSchema = readonlyEnvelope(
  "command.progress",
  CommandProgressPayloadSchema,
);
export const CommandResultMessageSchema = readonlyEnvelope(
  "command.result",
  CommandResultPayloadSchema,
);
export const CommandFailedMessageSchema = readonlyEnvelope(
  "command.failed",
  CommandFailedPayloadSchema,
);
export const BridgeHealthMessageSchema = readonlyEnvelope(
  "bridge.health",
  BridgeHealthPayloadSchema,
);

export const BRIDGE_TO_CONTROL_PLANE_KINDS = Object.freeze([
  "bridge.pong",
  "command.ack",
  "command.progress",
  "command.result",
  "command.failed",
  "bridge.health",
] as const);

export const BridgeToControlPlaneMessageSchema = z.discriminatedUnion("messageKind", [
  BridgePongMessageSchema,
  CommandAckMessageSchema,
  CommandProgressMessageSchema,
  CommandResultMessageSchema,
  CommandFailedMessageSchema,
  BridgeHealthMessageSchema,
]);
export type BridgeToControlPlaneMessage = z.infer<typeof BridgeToControlPlaneMessageSchema>;

export function parseBridgeToControlPlaneMessage(
  raw: unknown,
): EnvelopeParseResult<BridgeToControlPlaneMessage> {
  return parseEnvelopeWith(BridgeToControlPlaneMessageSchema, BRIDGE_TO_CONTROL_PLANE_KINDS, raw);
}
