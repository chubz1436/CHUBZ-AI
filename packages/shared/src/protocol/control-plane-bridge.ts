import { z } from "zod";
import {
  IsoUtcTimestampSchema,
  PROTOCOL_LIMITS,
  SafeIdSchema,
  SlugIdSchema,
  boundedText,
  displayText,
  mutatingEnvelope,
  readonlyEnvelope,
  requireConsistentIdentity,
} from "./common.js";
import { parseEnvelopeWith, type EnvelopeParseResult } from "./errors.js";

/**
 * Control Plane ↔ Local Bridge protocol contracts (M1B, D-023; hardened
 * by review round R1).
 *
 * TYPED HIGH-LEVEL OPERATIONS ONLY. There is no shell-command field, no
 * executable string, and no filesystem path anywhere in this direction:
 * every reference is a SafeId/SlugId, whose grammar structurally
 * excludes `/`, `\`, `:` and `..` — so absolute paths, drive-letter
 * paths, UNC paths, and traversal segments cannot even be expressed.
 * Actual executable and workspace paths are internal Bridge
 * configuration resolved from these identifiers.
 *
 * EVIDENCE MODEL (R1): the Bridge NEVER asserts evidence kinds. Its
 * final reports are typed per originating command kind
 * (workspace.prepare / worker.dispatch / worker.cancel /
 * result.collect), and the schemas have no field through which the
 * Bridge could claim `owner-reconciliation`, `grant-verified`, or any
 * Control-Plane/authority-derived evidence. The future Control Plane
 * derives M1A transition evidence from the validated originating
 * command, the validated report kind, and separately trusted
 * owner/grant state — never from a Bridge assertion.
 *
 * `authorizationRef` exists ONLY on Control-Plane commands as an
 * opaque, unverified reference (M1C owns grants); report schemas have
 * no such field, so a report can neither change nor invent one.
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

/** Every mutating command carries an explicit operationId (R1). */
export const WorkspacePreparePayloadSchema = z.strictObject({
  projectId: SlugIdSchema,
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  operationId: SafeIdSchema,
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
export const MutatingBridgeCommandKindSchema = z.enum(MUTATING_BRIDGE_COMMAND_KINDS);
export type MutatingBridgeCommandKind = z.infer<typeof MutatingBridgeCommandKindSchema>;

export const ControlPlaneToBridgeMessageSchema = requireConsistentIdentity(
  z.discriminatedUnion("messageKind", [
    BridgePingMessageSchema,
    WorkspacePrepareMessageSchema,
    WorkerDispatchMessageSchema,
    WorkerCancelMessageSchema,
    ResultCollectMessageSchema,
  ]),
);
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
 * execution proof and has neither an outcome nor a report field, so it
 * can never satisfy a final-report schema.
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

/** Immutable git commit identity: lowercase hex, abbreviated or full. */
export const GitCommitIdSchema = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/, "must be a lowercase hex commit id (7-64 chars)");
export type GitCommitId = z.infer<typeof GitCommitIdSchema>;

/**
 * Base-ref provenance for workspace preparation (R1 final patch): the
 * report must prove WHICH requested ref it processed and WHICH
 * immutable commit it resolved to — or state explicitly that no base
 * was requested. An ambiguous optional ref is not representable.
 */
export const WorkspaceBaseResolutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("not-requested") }),
  z.strictObject({
    kind: z.literal("resolved"),
    /** Must equal the originating command's baseRef (validated). */
    requestedRef: SafeIdSchema,
    /** The immutable commit the workspace was actually created from. */
    resolvedCommitId: GitCommitIdSchema,
  }),
]);
export type WorkspaceBaseResolution = z.infer<typeof WorkspaceBaseResolutionSchema>;

/**
 * Typed per-command success reports (R1). Each report kind is bound to
 * exactly one originating command kind via the `commandKind`
 * discriminator; there is no evidence field of any sort.
 */
export const WorkspacePrepareReportSchema = z.strictObject({
  commandKind: z.literal("workspace.prepare"),
  workspaceId: SafeIdSchema,
  baseResolution: WorkspaceBaseResolutionSchema,
});
export const WorkerDispatchReportSchema = z.strictObject({
  commandKind: z.literal("worker.dispatch"),
  workspaceId: SafeIdSchema,
  summary: displayText(PROTOCOL_LIMITS.maxWorkerSummaryLength).optional(),
  artifactIds: z.array(SafeIdSchema).max(PROTOCOL_LIMITS.maxMetadataEntries),
});
export const WorkerCancelReportSchema = z.strictObject({
  commandKind: z.literal("worker.cancel"),
  /** Must equal the originating command's operationId (validated). */
  terminatedOperationId: SafeIdSchema,
});
export const ResultCollectReportSchema = z.strictObject({
  commandKind: z.literal("result.collect"),
  workspaceId: SafeIdSchema,
  artifactIds: z.array(SafeIdSchema).max(PROTOCOL_LIMITS.maxMetadataEntries),
  changedFileCount: z.number().int().min(0).optional(),
  summary: displayText(PROTOCOL_LIMITS.maxWorkerSummaryLength).optional(),
});

export const BridgeCommandReportSchema = z.discriminatedUnion("commandKind", [
  WorkspacePrepareReportSchema,
  WorkerDispatchReportSchema,
  WorkerCancelReportSchema,
  ResultCollectReportSchema,
]);
export type BridgeCommandReport = z.infer<typeof BridgeCommandReportSchema>;

export const CommandResultPayloadSchema = z.strictObject({
  commandMessageId: SafeIdSchema,
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  operationId: SafeIdSchema,
  outcome: z.literal("succeeded"),
  report: BridgeCommandReportSchema,
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

/** Final failure report — typed to its originating command kind (R1). */
export const CommandFailedPayloadSchema = z.strictObject({
  commandMessageId: SafeIdSchema,
  taskId: SafeIdSchema,
  attemptId: SafeIdSchema,
  operationId: SafeIdSchema,
  outcome: z.literal("failed"),
  commandKind: MutatingBridgeCommandKindSchema,
  failureReason: BridgeFailureReasonSchema,
  summary: displayText(PROTOCOL_LIMITS.maxStatusTextLength),
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

export const BridgeToControlPlaneMessageSchema = requireConsistentIdentity(
  z.discriminatedUnion("messageKind", [
    BridgePongMessageSchema,
    CommandAckMessageSchema,
    CommandProgressMessageSchema,
    CommandResultMessageSchema,
    CommandFailedMessageSchema,
    BridgeHealthMessageSchema,
  ]),
);
export type BridgeToControlPlaneMessage = z.infer<typeof BridgeToControlPlaneMessageSchema>;

export function parseBridgeToControlPlaneMessage(
  raw: unknown,
): EnvelopeParseResult<BridgeToControlPlaneMessage> {
  return parseEnvelopeWith(BridgeToControlPlaneMessageSchema, BRIDGE_TO_CONTROL_PLANE_KINDS, raw);
}

// ---------------------------------------------------------------------------
// Command ↔ report binding validator (R1)
// ---------------------------------------------------------------------------

export const BRIDGE_BINDING_ERROR_CODES = Object.freeze([
  "COMMAND_NOT_REPORTABLE",
  "UNSUPPORTED_REPORT_KIND",
  "REPORT_COMMAND_MISMATCH",
  "REPORT_KIND_MISMATCH",
  "TASK_MISMATCH",
  "ATTEMPT_MISMATCH",
  "OPERATION_MISMATCH",
  "WORKSPACE_MISMATCH",
  "PROJECT_MISMATCH",
  "BASE_REF_MISMATCH",
] as const);
export type BridgeBindingErrorCode = (typeof BRIDGE_BINDING_ERROR_CODES)[number];

export const BRIDGE_REPORT_CLASSES = Object.freeze([
  "ack",
  "progress",
  "final-success",
  "final-failure",
] as const);
export type BridgeReportClass = (typeof BRIDGE_REPORT_CLASSES)[number];

export type BridgeReportBinding =
  | { readonly ok: true; readonly reportClass: BridgeReportClass }
  | { readonly ok: false; readonly code: BridgeBindingErrorCode; readonly message: string };

const bindingError = (code: BridgeBindingErrorCode, message: string): BridgeReportBinding =>
  Object.freeze({ ok: false, code, message });

/**
 * Pure, deterministic binding validator: does this Bridge report belong
 * to exactly this originating command? No persistence, no lookup — the
 * future Control Plane loads the command it recorded and calls this.
 *
 * Guarantees (all tested): exact originating command message ID; command
 * kind ↔ report kind pairing; task/attempt/operation identity; workspace
 * and project identity where applicable; final results and failures are
 * classified distinctly from ack/progress, which are never final proof.
 * Authorization references cannot be changed or invented because report
 * schemas carry no such field at all.
 */
export function validateBridgeReportAgainstCommand(
  command: ControlPlaneToBridgeMessage,
  report: BridgeToControlPlaneMessage,
): BridgeReportBinding {
  const cmd = ControlPlaneToBridgeMessageSchema.parse(command);
  const rpt = BridgeToControlPlaneMessageSchema.parse(report);

  if (cmd.messageKind === "bridge.ping") {
    return bindingError(
      "COMMAND_NOT_REPORTABLE",
      "bridge.ping is answered by bridge.pong, not by command reports.",
    );
  }
  if (rpt.messageKind === "bridge.pong" || rpt.messageKind === "bridge.health") {
    return bindingError(
      "UNSUPPORTED_REPORT_KIND",
      `${rpt.messageKind} is not a command report and cannot be bound to a command.`,
    );
  }

  if (rpt.payload.commandMessageId !== cmd.messageId) {
    return bindingError(
      "REPORT_COMMAND_MISMATCH",
      `The report references command ${rpt.payload.commandMessageId}, not ${cmd.messageId}.`,
    );
  }

  if (rpt.messageKind === "command.result" && rpt.payload.report.commandKind !== cmd.messageKind) {
    return bindingError(
      "REPORT_KIND_MISMATCH",
      `A ${rpt.payload.report.commandKind} result cannot answer a ${cmd.messageKind} command.`,
    );
  }
  if (rpt.messageKind === "command.failed" && rpt.payload.commandKind !== cmd.messageKind) {
    return bindingError(
      "REPORT_KIND_MISMATCH",
      `A ${rpt.payload.commandKind} failure cannot answer a ${cmd.messageKind} command.`,
    );
  }

  const commandPayload = cmd.payload as Record<string, unknown>;
  const reportPayload = rpt.payload as Record<string, unknown>;

  const identityChecks: readonly [string, BridgeBindingErrorCode][] = [
    ["taskId", "TASK_MISMATCH"],
    ["attemptId", "ATTEMPT_MISMATCH"],
    ["operationId", "OPERATION_MISMATCH"],
  ];
  for (const [field, code] of identityChecks) {
    const commandValue = commandPayload[field];
    const reportValue = reportPayload[field];
    if (
      typeof commandValue === "string" &&
      typeof reportValue === "string" &&
      commandValue !== reportValue
    ) {
      return bindingError(
        code,
        `The report's ${field} '${reportValue}' does not match the command's '${commandValue}'.`,
      );
    }
  }

  if (rpt.messageKind === "command.result") {
    const nested = rpt.payload.report;
    if (
      "workspaceId" in nested &&
      typeof commandPayload["workspaceId"] === "string" &&
      nested.workspaceId !== commandPayload["workspaceId"]
    ) {
      return bindingError(
        "WORKSPACE_MISMATCH",
        `The report's workspace '${nested.workspaceId}' does not match the command's '${String(commandPayload["workspaceId"])}'.`,
      );
    }
    if (
      nested.commandKind === "worker.cancel" &&
      typeof commandPayload["operationId"] === "string" &&
      nested.terminatedOperationId !== commandPayload["operationId"]
    ) {
      return bindingError(
        "OPERATION_MISMATCH",
        `The cancellation claims it terminated '${nested.terminatedOperationId}', not the commanded operation '${String(commandPayload["operationId"])}'.`,
      );
    }
    // Base-ref provenance (R1 final patch): the workspace report must
    // account for exactly the base the command requested — no more, no
    // less — and name the immutable commit it resolved to.
    if (nested.commandKind === "workspace.prepare") {
      const requestedBase = commandPayload["baseRef"];
      if (typeof requestedBase === "string") {
        if (nested.baseResolution.kind !== "resolved") {
          return bindingError(
            "BASE_REF_MISMATCH",
            `The command requested base ref '${requestedBase}' but the report claims no base was requested.`,
          );
        }
        if (nested.baseResolution.requestedRef !== requestedBase) {
          return bindingError(
            "BASE_REF_MISMATCH",
            `The report resolved ref '${nested.baseResolution.requestedRef}', not the commanded base ref '${requestedBase}'.`,
          );
        }
      } else if (nested.baseResolution.kind !== "not-requested") {
        return bindingError(
          "BASE_REF_MISMATCH",
          "The report claims it resolved a base ref, but the command requested none.",
        );
      }
    }
  }

  // Authoritative project identity (R1 final patch): a command's project
  // may live on its envelope or in its payload (envelope/payload
  // contradiction is already rejected at parse time by
  // requireConsistentIdentity). A report claiming any project must match
  // the authoritative value wherever it came from.
  const payloadProjectId = commandPayload["projectId"];
  const authoritativeProjectId =
    cmd.projectId ?? (typeof payloadProjectId === "string" ? payloadProjectId : undefined);
  if (
    typeof authoritativeProjectId === "string" &&
    typeof rpt.projectId === "string" &&
    authoritativeProjectId !== rpt.projectId
  ) {
    return bindingError(
      "PROJECT_MISMATCH",
      `The report's project '${rpt.projectId}' does not match the command's authoritative project '${authoritativeProjectId}'.`,
    );
  }

  const reportClass: BridgeReportClass =
    rpt.messageKind === "command.ack"
      ? "ack"
      : rpt.messageKind === "command.progress"
        ? "progress"
        : rpt.messageKind === "command.result"
          ? "final-success"
          : "final-failure";
  return Object.freeze({ ok: true, reportClass });
}
