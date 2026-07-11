import { z } from "zod";
import {
  IdempotencyKeySchema,
  IsoUtcTimestampSchema,
  MessageDirectionSchema,
  ProtocolVersionSchema,
  SafeIdSchema,
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
 * THE semantic digest boundary (R2, atomicity hardened in the final R2
 * patch). The future SHA-256 payload digest is computed from exactly:
 * protocolVersion, direction, messageKind, projectId/taskId/attemptId
 * when present, and the payload. Delivery/retry metadata is EXCLUDED by
 * construction — `messageId`, `sentAt`, `correlationId`, `causationId`,
 * and `idempotencyKey` never enter the canonical string, so retries of
 * the same request always digest identically.
 *
 * There is deliberately NO public digest-input object: the semantic
 * shape is built and canonicalized in one synchronous step and only the
 * canonical STRING escapes, so no aliased intermediate (whose payload a
 * caller could mutate between build and hash) ever exists. Use the
 * direction-specific helpers — `canonicalizeClientMutationForDigest`
 * and `canonicalizeBridgeCommandForDigest` — which validate through the
 * REAL direction schemas first; this low-level function only guards
 * structure and must be fed an already schema-parsed mutating envelope.
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

export function canonicalizeMutatingEnvelopeForDigest(
  direction: MessageDirection,
  envelope: ParsedMutatingEnvelope,
): string {
  if (typeof envelope !== "object" || envelope === null) {
    throw new TypeError("digest canonicalization requires a parsed mutating envelope object");
  }
  MessageDirectionSchema.parse(direction);
  ProtocolVersionSchema.parse(envelope.protocolVersion);
  SafeIdSchema.parse(envelope.messageKind);
  if (typeof envelope.idempotencyKey !== "string" || envelope.idempotencyKey === "") {
    throw new TypeError(
      "digest canonicalization accepts only mutating envelopes (idempotencyKey is required)",
    );
  }
  if (!Object.hasOwn(envelope, "payload")) {
    throw new TypeError("digest canonicalization requires an envelope with a payload");
  }
  const semantic: Record<string, unknown> = {
    protocolVersion: envelope.protocolVersion,
    direction,
    messageKind: envelope.messageKind,
    ...(envelope.projectId !== undefined ? { projectId: envelope.projectId } : {}),
    ...(envelope.taskId !== undefined ? { taskId: envelope.taskId } : {}),
    ...(envelope.attemptId !== undefined ? { attemptId: envelope.attemptId } : {}),
    payload: envelope.payload,
  };
  return canonicalizeForDigest(semantic);
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
      // Strict arrays (final R2 patch): exactly Array.prototype, and the
      // ONLY own keys are `length` plus dense data-property indexes
      // 0..length-1. Descriptors are inspected without ever executing a
      // getter; anything exotic is rejected, never silently skipped.
      if (Object.getPrototypeOf(objectValue) !== Array.prototype) {
        throw new TypeError(
          "canonicalizeForDigest: array subclasses and custom prototypes are not JSON-representable",
        );
      }
      const arrayValue = objectValue as unknown[];
      let indexCount = 0;
      for (const key of Reflect.ownKeys(arrayValue)) {
        if (typeof key === "symbol") {
          throw new TypeError(
            "canonicalizeForDigest: symbol-keyed array properties are not JSON-representable",
          );
        }
        if (key === "length") continue;
        const index = Number(key);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= arrayValue.length ||
          String(index) !== key
        ) {
          throw new TypeError(
            "canonicalizeForDigest: arrays with extra properties are not JSON-representable",
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(arrayValue, key);
        if (descriptor === undefined) {
          throw new TypeError("canonicalizeForDigest: array index descriptor is missing");
        }
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          throw new TypeError(
            "canonicalizeForDigest: accessor array elements are not JSON-representable",
          );
        }
        if (descriptor.enumerable !== true) {
          throw new TypeError(
            "canonicalizeForDigest: non-enumerable array indexes are not JSON-representable",
          );
        }
        indexCount += 1;
      }
      if (indexCount !== arrayValue.length) {
        throw new TypeError("canonicalizeForDigest: sparse arrays are not JSON-representable");
      }
      const parts: string[] = [];
      for (let index = 0; index < arrayValue.length; index += 1) {
        // Safe: every index was verified above to be a plain enumerable
        // data property, so this read cannot execute a getter.
        parts.push(canonicalize(arrayValue[index], depth + 1, seen));
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
