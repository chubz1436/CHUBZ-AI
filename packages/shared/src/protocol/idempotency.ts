import { z } from "zod";
import {
  IdempotencyKeySchema,
  IsoUtcTimestampSchema,
  MessageDirectionSchema,
  SafeIdSchema,
} from "./common.js";

/**
 * Idempotency and replay-classification contracts (M1B, D-023).
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

/**
 * Deterministic canonicalization for payload fingerprinting: JSON with
 * lexicographically sorted object keys at every depth. The future
 * runtime feeds this string to SHA-256; M1B deliberately computes no
 * hash. Only JSON-representable values are legal; anything else throws.
 */
export function canonicalizeForDigest(value: unknown): string {
  return canonicalize(value, 0);
}

const MAX_CANONICAL_DEPTH = 64;

function canonicalize(value: unknown, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new TypeError("canonicalizeForDigest: value nests deeper than the canonical limit");
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("canonicalizeForDigest: non-finite numbers are not JSON-representable");
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalize(item, depth + 1)).join(",")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v, depth + 1)}`);
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(
        `canonicalizeForDigest: '${typeof value}' values are not JSON-representable`,
      );
  }
}
