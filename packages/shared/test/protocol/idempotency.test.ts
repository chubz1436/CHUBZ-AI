import { describe, expect, it } from "vitest";
import {
  IncomingDeliverySchema,
  PayloadDigestSchema,
  RecordedIdempotencySchema,
  REPLAY_CLASSIFICATIONS,
  SemanticDigestInputSchema,
  buildSemanticDigestInput,
  canonicalizeForDigest,
  classifyDelivery,
  scopeKey,
  type IdempotencyScope,
  type IncomingDelivery,
  type ParsedMutatingEnvelope,
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
        recorded({
          scope: {
            direction: "control-plane-to-bridge",
            messageKind: "chat.submit",
            contextId: "pilot-project",
          },
        }),
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
    expect(IncomingDeliverySchema.safeParse({ ...incoming(), extra: "field" }).success).toBe(
      false,
    );
    expect(RecordedIdempotencySchema.safeParse({ ...recorded(), apiKey: "sk-x" }).success).toBe(
      false,
    );
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

describe("semantic digest boundary (R2)", () => {
  const envelope = (overrides: Partial<ParsedMutatingEnvelope> = {}): ParsedMutatingEnvelope => ({
    protocolVersion: "1.0",
    messageId: "msg-100",
    messageKind: "task.cancel",
    sentAt: "2026-07-11T09:00:00Z",
    idempotencyKey: "client-key-0001",
    projectId: "pilot-project",
    taskId: "task-42",
    attemptId: "attempt-1",
    payload: { taskId: "task-42", attemptId: "attempt-1" },
    ...overrides,
  });

  const semantic = (direction: Parameters<typeof buildSemanticDigestInput>[0], e: ParsedMutatingEnvelope) =>
    canonicalizeForDigest(buildSemanticDigestInput(direction, e));

  it("delivery metadata never changes the semantic canonical string", () => {
    const baseline = semantic("client-to-control-plane", envelope());
    expect(semantic("client-to-control-plane", envelope({ messageId: "msg-999" }))).toBe(baseline);
    expect(
      semantic("client-to-control-plane", envelope({ sentAt: "2027-01-01T00:00:00Z" })),
    ).toBe(baseline);
    expect(
      semantic("client-to-control-plane", envelope({ correlationId: "corr-77" })),
    ).toBe(baseline);
    expect(semantic("client-to-control-plane", envelope({ causationId: "cause-77" }))).toBe(
      baseline,
    );
    expect(
      semantic("client-to-control-plane", envelope({ idempotencyKey: "retry-key-9999" })),
    ).toBe(baseline);
  });

  it("semantic fields change the canonical string", () => {
    const baseline = semantic("client-to-control-plane", envelope());
    expect(semantic("control-plane-to-bridge", envelope())).not.toBe(baseline);
    expect(
      semantic("client-to-control-plane", envelope({ messageKind: "approval.decide" })),
    ).not.toBe(baseline);
    expect(
      semantic("client-to-control-plane", envelope({ projectId: "other-project" })),
    ).not.toBe(baseline);
    expect(semantic("client-to-control-plane", envelope({ taskId: "task-99" }))).not.toBe(
      baseline,
    );
    expect(semantic("client-to-control-plane", envelope({ attemptId: "attempt-9" }))).not.toBe(
      baseline,
    );
    expect(
      semantic(
        "client-to-control-plane",
        envelope({ payload: { taskId: "task-42", attemptId: "attempt-2" } }),
      ),
    ).not.toBe(baseline);
  });

  it("the digest input contains exactly the semantic fields", () => {
    const input = buildSemanticDigestInput("client-to-control-plane", envelope());
    expect(Object.keys(input).sort()).toEqual([
      "attemptId",
      "direction",
      "messageKind",
      "payload",
      "projectId",
      "protocolVersion",
      "taskId",
    ]);
    expect(Object.isFrozen(input)).toBe(true);
  });

  it("the envelope is never mutated and the result is a new object", () => {
    const original = envelope();
    const snapshot = JSON.parse(JSON.stringify(original)) as unknown;
    const input = buildSemanticDigestInput("client-to-control-plane", original);
    expect(input).not.toBe(original as unknown);
    expect(original).toEqual(snapshot);
    expect(Object.isFrozen(original)).toBe(false);
  });

  it("only mutating envelopes are accepted", () => {
    const { idempotencyKey: _omit, ...readonlyEnvelope } = envelope();
    expect(() =>
      buildSemanticDigestInput(
        "client-to-control-plane",
        readonlyEnvelope as unknown as ParsedMutatingEnvelope,
      ),
    ).toThrow(TypeError);
    expect(() =>
      buildSemanticDigestInput("client-to-control-plane", null as unknown as ParsedMutatingEnvelope),
    ).toThrow(TypeError);
  });

  it("callers cannot smuggle extra fields into the digest input", () => {
    expect(
      SemanticDigestInputSchema.safeParse({
        protocolVersion: "1.0",
        direction: "client-to-control-plane",
        messageKind: "task.cancel",
        payload: {},
        messageId: "msg-100",
      }).success,
    ).toBe(false);
    expect(
      SemanticDigestInputSchema.safeParse({
        protocolVersion: "1.0",
        direction: "client-to-control-plane",
        messageKind: "task.cancel",
      }).success,
    ).toBe(false);
  });
});

describe("strict canonicalization (R2)", () => {
  it("is deterministic regardless of object-key order", () => {
    const one = canonicalizeForDigest({ b: 2, a: 1, nested: { z: true, y: [1, 2] } });
    const two = canonicalizeForDigest({ nested: { y: [1, 2], z: true }, a: 1, b: 2 });
    expect(one).toBe(two);
    expect(one).toBe('{"a":1,"b":2,"nested":{"y":[1,2],"z":true}}');
  });

  it("nested object keys are deterministic at every depth", () => {
    expect(canonicalizeForDigest({ outer: { c: { b: 1, a: 2 }, a: 0 } })).toBe(
      '{"outer":{"a":0,"c":{"a":2,"b":1}}}',
    );
  });

  it("array order remains significant", () => {
    expect(canonicalizeForDigest([2, 1])).toBe("[2,1]");
    expect(canonicalizeForDigest([2, 1])).not.toBe(canonicalizeForDigest([1, 2]));
  });

  it("accepts exactly the plain-JSON value set", () => {
    expect(canonicalizeForDigest(null)).toBe("null");
    expect(canonicalizeForDigest(true)).toBe("true");
    expect(canonicalizeForDigest("text")).toBe('"text"');
    expect(canonicalizeForDigest(1.5)).toBe("1.5");
    expect(canonicalizeForDigest([])).toBe("[]");
    expect(canonicalizeForDigest({})).toBe("{}");
  });

  it("rejects Date, Map, Set, RegExp, and class instances", () => {
    expect(() => canonicalizeForDigest(new Date())).toThrow(TypeError);
    expect(() => canonicalizeForDigest(new Map())).toThrow(TypeError);
    expect(() => canonicalizeForDigest(new Set())).toThrow(TypeError);
    expect(() => canonicalizeForDigest(/x/)).toThrow(TypeError);
    class Thing {
      value = 1;
    }
    expect(() => canonicalizeForDigest(new Thing())).toThrow(TypeError);
  });

  it("rejects undefined anywhere — never silently omitted", () => {
    expect(() => canonicalizeForDigest(undefined)).toThrow(TypeError);
    expect(() => canonicalizeForDigest({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalizeForDigest([1, undefined, 3])).toThrow(TypeError);
  });

  it("rejects sparse arrays", () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalizeForDigest([1, , 3])).toThrow(TypeError);
    const sparse = new Array<number>(3);
    sparse[0] = 1;
    expect(() => canonicalizeForDigest(sparse)).toThrow(TypeError);
  });

  it("rejects circular references but allows repeated (DAG) references", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => canonicalizeForDigest(circular)).toThrow(TypeError);
    const shared = { v: 1 };
    expect(canonicalizeForDigest({ a: shared, b: shared })).toBe('{"a":{"v":1},"b":{"v":1}}');
  });

  it("rejects symbol keys and accessor properties", () => {
    const withSymbol: Record<PropertyKey, unknown> = { a: 1 };
    withSymbol[Symbol("hidden")] = "secret";
    expect(() => canonicalizeForDigest(withSymbol)).toThrow(TypeError);
    const withGetter = {};
    Object.defineProperty(withGetter, "computed", {
      enumerable: true,
      get: () => Math.random(),
    });
    expect(() => canonicalizeForDigest(withGetter)).toThrow(TypeError);
  });

  it("rejects non-enumerable string properties instead of silently dropping them", () => {
    const withHidden = { visible: 1 };
    Object.defineProperty(withHidden, "hidden", { enumerable: false, value: 2 });
    expect(() => canonicalizeForDigest(withHidden)).toThrow(TypeError);
  });

  it("rejects functions, bigint, NaN, and Infinity", () => {
    expect(() => canonicalizeForDigest({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalizeForDigest({ big: BigInt(1) })).toThrow(TypeError);
    expect(() => canonicalizeForDigest({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalizeForDigest(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalizeForDigest({ n: Number.NEGATIVE_INFINITY })).toThrow(TypeError);
  });

  it("enforces the canonical depth limit", () => {
    let value: unknown = "leaf";
    for (let i = 0; i < 70; i += 1) value = { nested: value };
    expect(() => canonicalizeForDigest(value)).toThrow(TypeError);
  });
});
