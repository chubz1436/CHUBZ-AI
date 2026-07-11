import { z } from "zod";
import {
  IdempotencyKeySchema,
  IsoUtcTimestampSchema,
  MessageDirectionSchema,
  ProtocolVersionSchema,
  SafeIdSchema,
  SlugIdSchema,
  type MessageDirection,
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

// ---------------------------------------------------------------------------
// Semantic digest boundary (R2)
// ---------------------------------------------------------------------------

/**
 * THE one semantic digest input (R2). The future SHA-256 payload digest
 * is computed from `canonicalizeForDigest(buildSemanticDigestInput(…))`
 * and from nothing else. Delivery/retry metadata is EXCLUDED by
 * construction — `messageId`, `sentAt`, `correlationId`, `causationId`,
 * and `idempotencyKey` do not exist in this shape, so two retries of
 * the same request always digest identically, and callers cannot pick
 * arbitrary envelope fields to hash.
 */
export const SemanticDigestInputSchema = z
  .strictObject({
    protocolVersion: ProtocolVersionSchema,
    direction: MessageDirectionSchema,
    messageKind: SafeIdSchema,
    projectId: SlugIdSchema.optional(),
    taskId: SafeIdSchema.optional(),
    attemptId: SafeIdSchema.optional(),
    payload: z.unknown(),
  })
  .superRefine((value, ctx) => {
    if (value.payload === undefined) {
      ctx.addIssue({ code: "custom", path: ["payload"], message: "payload is required" });
    }
  });
export type SemanticDigestInput = z.infer<typeof SemanticDigestInputSchema>;

/**
 * The structural shape of an already PARSED mutating envelope (both
 * directions' mutating message variants satisfy it; read-only variants
 * lack `idempotencyKey` and are rejected at compile time and runtime).
 */
export interface ParsedMutatingEnvelope {
  readonly protocolVersion: string;
  readonly messageId: string;
  readonly messageKind: string;
  readonly sentAt: string;
  readonly idempotencyKey: string;
  readonly correlationId?: string | undefined;
  readonly causationId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly payload: unknown;
}

/**
 * Builds the semantic digest input from an already parsed mutating
 * envelope. Includes protocol version, direction, message kind, the
 * semantic routing IDs, and the payload; excludes all delivery
 * metadata. Returns a NEW frozen plain object and never mutates the
 * envelope (the payload is shared by reference and is never written).
 */
export function buildSemanticDigestInput(
  direction: MessageDirection,
  envelope: ParsedMutatingEnvelope,
): SemanticDigestInput {
  if (typeof envelope !== "object" || envelope === null) {
    throw new TypeError("buildSemanticDigestInput requires a parsed mutating envelope object");
  }
  if (typeof envelope.idempotencyKey !== "string" || envelope.idempotencyKey === "") {
    throw new TypeError(
      "buildSemanticDigestInput accepts only mutating envelopes (idempotencyKey is required)",
    );
  }
  if (!Object.hasOwn(envelope, "payload")) {
    throw new TypeError("buildSemanticDigestInput requires an envelope with a payload");
  }
  const input = SemanticDigestInputSchema.parse({
    protocolVersion: envelope.protocolVersion,
    direction,
    messageKind: envelope.messageKind,
    ...(envelope.projectId !== undefined ? { projectId: envelope.projectId } : {}),
    ...(envelope.taskId !== undefined ? { taskId: envelope.taskId } : {}),
    ...(envelope.attemptId !== undefined ? { attemptId: envelope.attemptId } : {}),
    payload: envelope.payload,
  });
  return Object.freeze(input);
}

// ---------------------------------------------------------------------------
// Strict canonicalization (R2)
// ---------------------------------------------------------------------------

const MAX_CANONICAL_DEPTH = 64;

/**
 * Deterministic PLAIN-JSON-ONLY canonicalization for payload
 * fingerprinting: object keys sorted lexicographically at every depth,
 * array order preserved, one canonical JSON string out. The future
 * runtime feeds this string to SHA-256; M1B deliberately computes no
 * hash.
 *
 * STRICT (R2): only null, booleans, strings, finite numbers, dense
 * arrays, and plain objects with enumerable string keys are legal.
 * Nothing is silently omitted or coerced — undefined (anywhere), sparse
 * arrays, Date, Map, Set, RegExp, class instances, functions, symbols,
 * bigint, NaN, ±Infinity, symbol-keyed or non-enumerable or accessor
 * properties, circular references, and nesting beyond
 * MAX_CANONICAL_DEPTH all throw TypeError.
 */
export function canonicalizeForDigest(value: unknown): string {
  return canonicalize(value, 0, new Set<object>());
}

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function canonicalize(value: unknown, depth: number, seen: Set<object>): string {
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
        throw new TypeError(
          "canonicalizeForDigest: NaN and Infinity are not JSON-representable",
        );
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      // undefined, function, symbol, bigint.
      throw new TypeError(
        `canonicalizeForDigest: '${typeof value}' values are not JSON-representable`,
      );
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    throw new TypeError("canonicalizeForDigest: circular references are not JSON-representable");
  }
  seen.add(objectValue);
  try {
    if (Array.isArray(objectValue)) {
      const parts: string[] = [];
      for (let index = 0; index < objectValue.length; index += 1) {
        if (!Object.hasOwn(objectValue, index)) {
          throw new TypeError(
            "canonicalizeForDigest: sparse arrays are not JSON-representable",
          );
        }
        parts.push(canonicalize((objectValue as unknown[])[index], depth + 1, seen));
      }
      return `[${parts.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(objectValue) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        "canonicalizeForDigest: only plain objects are JSON-representable (Date, Map, Set, RegExp, and class instances are rejected)",
      );
    }
    if (Object.getOwnPropertySymbols(objectValue).length > 0) {
      throw new TypeError(
        "canonicalizeForDigest: symbol-keyed properties are not JSON-representable",
      );
    }
    const enumerableKeys = Object.keys(objectValue);
    if (Object.getOwnPropertyNames(objectValue).length !== enumerableKeys.length) {
      throw new TypeError(
        "canonicalizeForDigest: non-enumerable properties are not JSON-representable",
      );
    }
    const record = objectValue as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of enumerableKeys.sort(compareKeys)) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
        throw new TypeError(
          "canonicalizeForDigest: accessor properties are not JSON-representable",
        );
      }
      parts.push(`${JSON.stringify(key)}:${canonicalize(record[key], depth + 1, seen)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(objectValue);
  }
}
