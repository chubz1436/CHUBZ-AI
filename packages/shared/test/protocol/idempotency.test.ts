import { describe, expect, it } from "vitest";
import {
  IncomingDeliverySchema,
  PayloadDigestSchema,
  RecordedIdempotencySchema,
  REPLAY_CLASSIFICATIONS,
  canonicalizeBridgeCommandForDigest,
  canonicalizeClientMutationForDigest,
  classifyDelivery,
  scopeKey,
  type IdempotencyScope,
  type IncomingDelivery,
  type RecordedIdempotency,
} from "../../src/index.js";
// The low-level canonicalizer is INTERNAL (R2 export-boundary patch): it
// is not part of the public package API, so its behavioral tests reach
// into the internal module directly. Public-surface tests live in
// export-boundary.test.ts.
import { canonicalizeForDigest } from "../../src/protocol/digest-internal.js";

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

describe("atomic semantic digest helpers (final R2 patch)", () => {
  interface ChatPayload {
    input: { kind: string; text: string };
    projectId: string;
  }
  const rawChatSubmit = (
    extra: Record<string, unknown> = {},
    text = "please fix the login timeout",
  ) => ({
    protocolVersion: "1.0",
    messageId: "msg-100",
    messageKind: "chat.submit",
    sentAt: "2026-07-11T09:00:00Z",
    idempotencyKey: "client-key-0001",
    taskId: "task-42",
    payload: {
      input: { kind: "natural-language", text },
      projectId: "pilot-project",
    },
    ...extra,
  });

  const rawDispatch = () => ({
    protocolVersion: "1.0",
    messageId: "cmd-200",
    messageKind: "worker.dispatch",
    sentAt: "2026-07-11T10:00:00Z",
    idempotencyKey: "bridge-cmd-key-01",
    payload: {
      projectId: "pilot-project",
      taskId: "task-42",
      attemptId: "attempt-1",
      operationId: "op-disp-1",
      workspaceId: "ws-task-42-a1",
      worker: { manifestId: "codex", manifestVersion: "1.0.0" },
      prompt: { text: "Fix the login timeout.", contextArtifactIds: [] },
    },
  });

  it("returns a canonical string, never a shared digest-input object", () => {
    const digest = canonicalizeClientMutationForDigest(rawChatSubmit());
    expect(typeof digest).toBe("string");
    expect(digest).toContain('"direction":"client-to-control-plane"');
    const bridgeDigest = canonicalizeBridgeCommandForDigest(rawDispatch());
    expect(typeof bridgeDigest).toBe("string");
    expect(bridgeDigest).toContain('"direction":"control-plane-to-bridge"');
  });

  it("delivery-only differences produce identical canonical strings", () => {
    const baseline = canonicalizeClientMutationForDigest(rawChatSubmit());
    expect(canonicalizeClientMutationForDigest(rawChatSubmit({ messageId: "msg-999" }))).toBe(
      baseline,
    );
    expect(
      canonicalizeClientMutationForDigest(rawChatSubmit({ sentAt: "2027-01-01T00:00:00Z" })),
    ).toBe(baseline);
    expect(
      canonicalizeClientMutationForDigest(rawChatSubmit({ correlationId: "corr-77" })),
    ).toBe(baseline);
    expect(
      canonicalizeClientMutationForDigest(rawChatSubmit({ causationId: "cause-77" })),
    ).toBe(baseline);
    expect(
      canonicalizeClientMutationForDigest(rawChatSubmit({ idempotencyKey: "retry-key-9999" })),
    ).toBe(baseline);
  });

  it("semantic differences produce different canonical strings", () => {
    const baseline = canonicalizeClientMutationForDigest(rawChatSubmit());
    expect(canonicalizeClientMutationForDigest(rawChatSubmit({ taskId: "task-99" }))).not.toBe(
      baseline,
    );
    expect(
      canonicalizeClientMutationForDigest(rawChatSubmit({ attemptId: "attempt-9" })),
    ).not.toBe(baseline);
    expect(
      canonicalizeClientMutationForDigest(rawChatSubmit({}, "a different request")),
    ).not.toBe(baseline);
    const cancel = canonicalizeClientMutationForDigest({
      protocolVersion: "1.0",
      messageId: "msg-100",
      messageKind: "task.cancel",
      sentAt: "2026-07-11T09:00:00Z",
      idempotencyKey: "client-key-0001",
      payload: { taskId: "task-42", attemptId: "attempt-1" },
    });
    expect(cancel).not.toBe(baseline);
  });

  it("a previously produced digest cannot change when the input is mutated afterwards (no aliasing)", () => {
    const raw = rawChatSubmit();
    const digestBefore = canonicalizeClientMutationForDigest(raw);
    const saved = `${digestBefore}`;
    (raw.payload as ChatPayload).input.text = "maliciously changed after digest";
    expect(digestBefore).toBe(saved);
    expect(canonicalizeClientMutationForDigest(raw)).not.toBe(digestBefore);
  });

  it("validates through the REAL client schema — structural lookalikes are rejected", () => {
    expect(() =>
      canonicalizeClientMutationForDigest(rawChatSubmit({ messageKind: "made.up" })),
    ).toThrow(TypeError);
    expect(() =>
      canonicalizeClientMutationForDigest(rawChatSubmit({ sentAt: "yesterday" })),
    ).toThrow(TypeError);
    expect(() =>
      canonicalizeClientMutationForDigest(rawChatSubmit({ payload: { wrong: true } })),
    ).toThrow(TypeError);
    expect(() =>
      canonicalizeClientMutationForDigest(rawChatSubmit({ smuggled: "field" })),
    ).toThrow(TypeError);
    const { idempotencyKey: _omit, ...missingKey } = rawChatSubmit();
    expect(() => canonicalizeClientMutationForDigest(missingKey)).toThrow(TypeError);
    const readOnly = {
      protocolVersion: "1.0",
      messageId: "msg-100",
      messageKind: "task.get",
      sentAt: "2026-07-11T09:00:00Z",
      payload: { taskId: "task-42" },
    };
    expect(() => canonicalizeClientMutationForDigest(readOnly)).toThrow(TypeError);
  });

  it("the bridge helper validates through the REAL bridge command schema", () => {
    expect(typeof canonicalizeBridgeCommandForDigest(rawDispatch())).toBe("string");
    const ping = {
      protocolVersion: "1.0",
      messageId: "cmd-201",
      messageKind: "bridge.ping",
      sentAt: "2026-07-11T10:00:00Z",
      payload: {},
    };
    expect(() => canonicalizeBridgeCommandForDigest(ping)).toThrow(TypeError);
    expect(() => canonicalizeBridgeCommandForDigest(rawChatSubmit())).toThrow(TypeError);
    const withShell = rawDispatch();
    (withShell.payload as Record<string, unknown>)["shellCommand"] = "rm -rf /";
    expect(() => canonicalizeBridgeCommandForDigest(withShell)).toThrow(TypeError);
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

  it("rejects arrays with extra enumerable properties", () => {
    const arr: number[] & { extra?: number } = [1, 2];
    arr.extra = 3;
    expect(() => canonicalizeForDigest(arr)).toThrow(TypeError);
  });

  it("rejects arrays with symbol properties", () => {
    const arr: unknown[] = [1, 2];
    (arr as unknown as Record<PropertyKey, unknown>)[Symbol("hidden")] = "x";
    expect(() => canonicalizeForDigest(arr)).toThrow(TypeError);
  });

  it("rejects arrays with non-enumerable custom properties", () => {
    const arr = [1, 2];
    Object.defineProperty(arr, "hidden", { enumerable: false, value: 9 });
    expect(() => canonicalizeForDigest(arr)).toThrow(TypeError);
  });

  it("rejects index getters WITHOUT executing them", () => {
    let executed = false;
    const arr = [1, 2];
    Object.defineProperty(arr, 1, {
      enumerable: true,
      configurable: true,
      get: () => {
        executed = true;
        return 2;
      },
    });
    expect(() => canonicalizeForDigest(arr)).toThrow(TypeError);
    expect(executed).toBe(false);
  });

  it("rejects extra-property getters WITHOUT executing them", () => {
    let executed = false;
    const arr = [1, 2];
    Object.defineProperty(arr, "extra", {
      enumerable: true,
      configurable: true,
      get: () => {
        executed = true;
        return "evil";
      },
    });
    expect(() => canonicalizeForDigest(arr)).toThrow(TypeError);
    expect(executed).toBe(false);
  });

  it("rejects arrays with custom prototypes and Array subclasses", () => {
    const detached = [1, 2];
    Object.setPrototypeOf(detached, null);
    expect(() => canonicalizeForDigest(detached)).toThrow(TypeError);
    class FancyArray extends Array<number> {}
    const fancy = FancyArray.from([1, 2]);
    expect(() => canonicalizeForDigest(fancy)).toThrow(TypeError);
  });

  it("normal dense arrays still canonicalize deterministically", () => {
    expect(canonicalizeForDigest([1, "two", { b: 2, a: 1 }, [true, null]])).toBe(
      '[1,"two",{"a":1,"b":2},[true,null]]',
    );
  });

  it("enforces the canonical depth limit", () => {
    let value: unknown = "leaf";
    for (let i = 0; i < 70; i += 1) value = { nested: value };
    expect(() => canonicalizeForDigest(value)).toThrow(TypeError);
  });
});
