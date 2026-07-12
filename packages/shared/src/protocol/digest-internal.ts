import {
  MessageDirectionSchema,
  ProtocolVersionSchema,
  SafeIdSchema,
  type MessageDirection,
} from "./common.js";

/**
 * INTERNAL digest machinery (R2 export-boundary patch). This module is
 * deliberately NOT exported from the protocol barrel or the shared
 * package root. The only supported public mutation-digest entry points
 * are the direction-specific helpers:
 *
 *  - canonicalizeClientMutationForDigest (client-control-plane.ts)
 *  - canonicalizeBridgeCommandForDigest  (control-plane-bridge.ts)
 *
 * Those helpers validate through the REAL direction schemas before
 * delegating here. Direction modules import this file directly; nothing
 * else may. Exposing the low-level helpers publicly would let a caller
 * digest an envelope that never passed direction-schema validation.
 */

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
 * caller could mutate between build and hash) ever exists. This
 * low-level function only guards structure and must be fed an already
 * schema-parsed mutating envelope by a direction-specific helper.
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
