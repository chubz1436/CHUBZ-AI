import { z } from "zod";
import {
  IdempotencyKeySchema,
  IsoUtcTimestampSchema,
  MessageDirectionSchema,
  SafeIdSchema,
} from "./common.js";

/**
 * Idempotency and replay-classification contracts (M1B, D-023; digest
 * semantics fixed in review round R2).
 *
 * Pure contracts only: NO storage, NO runtime replay handling, NO
 * cryptographic hashing. The future runtime stores one
 * RecordedIdempotency per (key, scope) and consults classifyDelivery:
 *
 *  - "new"                    → execute and record
 *  - "duplicate-same-request" → return the recorded result; NEVER
 *                               execute again
 *  - "conflict"               → refuse with IDEMPOTENCY_CONFLICT; NEVER
 *                               execute (same key reused for a
 *                               different request)
 *  - "different-scope"        → the record belongs to another scope;
 *                               treat the delivery as new within its
 *                               own scope
 *
 * DIGEST EXPORT BOUNDARY (R2 patch): the low-level digest machinery
 * (`canonicalizeMutatingEnvelopeForDigest`, `canonicalizeForDigest`,
 * and the parsed-envelope shape) lives in ./digest-internal.ts, which
 * is intentionally NOT exported from the protocol barrel or the shared
 * package root. The only supported public mutation-digest entry points
 * are the direction-specific helpers, which validate through the REAL
 * direction schemas before canonicalizing:
 *
 *  - canonicalizeClientMutationForDigest (client-control-plane.ts)
 *  - canonicalizeBridgeCommandForDigest  (control-plane-bridge.ts)
 */

export { IdempotencyKeySchema } from "./common.js";

/**
 * Payload digest in a strict format ready for a future SHA-256
 * implementation: "sha256:" + 64 lowercase hex chars. M1B validates the
 * format only; computing the actual hash is runtime work (M2+).
 */
export const PayloadDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "must be 'sha256:' followed by 64 lowercase hex characters");
export type PayloadDigest = z.infer<typeof PayloadDigestSchema>;

/** The scope an idempotency key is unique within. */
export const IdempotencyScopeSchema = z.strictObject({
  direction: MessageDirectionSchema,
  /** The message kind the key applies to, e.g. "chat.submit". */
  messageKind: SafeIdSchema,
  /** Optional narrowing context (e.g. a project or task id). */
  contextId: SafeIdSchema.optional(),
});
export type IdempotencyScope = z.infer<typeof IdempotencyScopeSchema>;

/** Deterministic canonical string for scope comparison. */
export function scopeKey(scope: IdempotencyScope): string {
  const parsed = IdempotencyScopeSchema.parse(scope);
  return `${parsed.direction}|${parsed.messageKind}|${parsed.contextId ?? "-"}`;
}

/** What the future runtime records after first execution. */
export const RecordedIdempotencySchema = z.strictObject({
  idempotencyKey: IdempotencyKeySchema,
  scope: IdempotencyScopeSchema,
  payloadDigest: PayloadDigestSchema,
  /** The messageId of the first delivery. */
  firstMessageId: SafeIdSchema,
  recordedAt: IsoUtcTimestampSchema,
  /** Reference to the recorded response/result to replay to duplicates. */
  responseRef: SafeIdSchema.optional(),
});
export type RecordedIdempotency = z.infer<typeof RecordedIdempotencySchema>;

export const REPLAY_CLASSIFICATIONS = Object.freeze([
  "new",
  "duplicate-same-request",
  "conflict",
  "different-scope",
] as const);
export const ReplayClassificationSchema = z.enum(REPLAY_CLASSIFICATIONS);
export type ReplayClassification = z.infer<typeof ReplayClassificationSchema>;

export const IncomingDeliverySchema = z.strictObject({
  idempotencyKey: IdempotencyKeySchema,
  scope: IdempotencyScopeSchema,
  payloadDigest: PayloadDigestSchema,
});
export type IncomingDelivery = z.infer<typeof IncomingDeliverySchema>;

/**
 * Pure replay classification. `recorded` is whatever the runtime found
 * stored under the incoming idempotency key (or undefined). Passing a
 * record with a DIFFERENT key is contract misuse and throws.
 */
export function classifyDelivery(
  incoming: IncomingDelivery,
  recorded: RecordedIdempotency | undefined,
): ReplayClassification {
  const parsedIncoming = IncomingDeliverySchema.parse(incoming);
  if (recorded === undefined) {
    return "new";
  }
  const parsedRecorded = RecordedIdempotencySchema.parse(recorded);
  if (parsedRecorded.idempotencyKey !== parsedIncoming.idempotencyKey) {
    throw new TypeError(
      "classifyDelivery received a record stored under a different idempotency key; the runtime lookup is broken",
    );
  }
  if (scopeKey(parsedRecorded.scope) !== scopeKey(parsedIncoming.scope)) {
    return "different-scope";
  }
  if (parsedRecorded.payloadDigest === parsedIncoming.payloadDigest) {
    return "duplicate-same-request";
  }
  return "conflict";
}
