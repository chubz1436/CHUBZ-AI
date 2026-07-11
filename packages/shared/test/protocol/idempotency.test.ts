import { describe, expect, it } from "vitest";
import {
  IncomingDeliverySchema,
  PayloadDigestSchema,
  RecordedIdempotencySchema,
  REPLAY_CLASSIFICATIONS,
  canonicalizeForDigest,
  classifyDelivery,
  scopeKey,
  type IdempotencyScope,
  type IncomingDelivery,
  type RecordedIdempotency,
} from "../../src/index.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

const scope = (contextId?: string): IdempotencyScope => ({
  direction: "client-to-control-plane",
  messageKind: "chat.submit",
  ...(contextId !== undefined ? { contextId } : {}),
});

const incoming = (overrides: Partial<IncomingDelivery> = {}): IncomingDelivery => ({
  idempotencyKey: "client-key-0001",
  scope: scope("pilot-project"),
  payloadDigest: digestA,
  ...overrides,
});

const recorded = (overrides: Partial<RecordedIdempotency> = {}): RecordedIdempotency => ({
  idempotencyKey: "client-key-0001",
  scope: scope("pilot-project"),
  payloadDigest: digestA,
  firstMessageId: "msg-100",
  recordedAt: "2026-07-11T09:00:00Z",
  ...overrides,
});

describe("replay classification", () => {
  it("defines exactly the four documented classifications", () => {
    expect([...REPLAY_CLASSIFICATIONS]).toEqual([
      "new",
      "duplicate-same-request",
      "conflict",
      "different-scope",
    ]);
  });

  it("first delivery is new", () => {
    expect(classifyDelivery(incoming(), undefined)).toBe("new");
  });

  it("same key + same scope + same digest is a duplicate — replay the recorded result", () => {
    expect(classifyDelivery(incoming(), recorded())).toBe("duplicate-same-request");
  });

  it("same key + same scope + different digest is a conflict — never execute", () => {
    expect(classifyDelivery(incoming({ payloadDigest: digestB }), recorded())).toBe("conflict");
  });

  it("a record from a different scope is classified separately", () => {
    expect(classifyDelivery(incoming(), recorded({ scope: scope("other-project") }))).toBe(
      "different-scope",
    );
    expect(
      classifyDelivery(
        incoming(),
        recorded({ scope: { direction: "control-plane-to-bridge", messageKind: "chat.submit", contextId: "pilot-project" } }),
      ),
    ).toBe("different-scope");
  });

  it("a record stored under a different key is contract misuse and throws", () => {
    expect(() =>
      classifyDelivery(incoming(), recorded({ idempotencyKey: "other-key-0001" })),
    ).toThrow(TypeError);
  });
});

describe("key and digest validation", () => {
  it("rejects empty and oversized keys", () => {
    expect(() => classifyDelivery(incoming({ idempotencyKey: "" }), undefined)).toThrow();
    expect(() =>
      classifyDelivery(incoming({ idempotencyKey: "k".repeat(129) }), undefined),
    ).toThrow();
    expect(() => classifyDelivery(incoming({ idempotencyKey: "short" }), undefined)).toThrow();
  });

  it("rejects malformed digests", () => {
    for (const bad of [
      "a".repeat(64),
      "sha256:" + "A".repeat(64),
      "sha256:" + "a".repeat(63),
      "sha1:" + "a".repeat(64),
      "sha256:",
      "",
    ]) {
      expect(PayloadDigestSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(PayloadDigestSchema.safeParse(digestA).success).toBe(true);
  });

  it("incoming deliveries and records are strict", () => {
    expect(
      IncomingDeliverySchema.safeParse({ ...incoming(), extra: "field" }).success,
    ).toBe(false);
    expect(
      RecordedIdempotencySchema.safeParse({ ...recorded(), apiKey: "sk-x" }).success,
    ).toBe(false);
  });
});

describe("scope keys", () => {
  it("scopeKey is deterministic and context-sensitive", () => {
    expect(scopeKey(scope("pilot-project"))).toBe(
      "client-to-control-plane|chat.submit|pilot-project",
    );
    expect(scopeKey(scope())).toBe("client-to-control-plane|chat.submit|-");
    expect(scopeKey(scope("a"))).not.toBe(scopeKey(scope("b")));
  });
});

describe("canonicalization for digests", () => {
  it("is deterministic regardless of key order", () => {
    const one = canonicalizeForDigest({ b: 2, a: 1, nested: { z: true, y: [1, 2] } });
    const two = canonicalizeForDigest({ nested: { y: [1, 2], z: true }, a: 1, b: 2 });
    expect(one).toBe(two);
    expect(one).toBe('{"a":1,"b":2,"nested":{"y":[1,2],"z":true}}');
  });

  it("preserves array order (arrays are semantically ordered)", () => {
    expect(canonicalizeForDigest([2, 1])).toBe("[2,1]");
    expect(canonicalizeForDigest([2, 1])).not.toBe(canonicalizeForDigest([1, 2]));
  });

  it("drops undefined object members and handles null", () => {
    expect(canonicalizeForDigest({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("rejects non-JSON values", () => {
    expect(() => canonicalizeForDigest({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalizeForDigest(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalizeForDigest({ big: BigInt(1) })).toThrow(TypeError);
  });

  it("rejects pathologically deep nesting", () => {
    let value: unknown = "leaf";
    for (let i = 0; i < 70; i += 1) value = { nested: value };
    expect(() => canonicalizeForDigest(value)).toThrow(TypeError);
  });
});
