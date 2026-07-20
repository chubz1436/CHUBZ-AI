import { describe, expect, it } from "vitest";
import * as sharedRoot from "../../src/index.js";
import * as protocolBarrel from "../../src/protocol/index.js";

// Type-level boundary check (compiles under `tsc --noEmit`): the
// internal parsed-envelope type must not be importable from the shared
// package root or the protocol barrel.
// @ts-expect-error — ParsedMutatingEnvelope is internal (digest-internal.ts) and not public API
import type { ParsedMutatingEnvelope as _NotExportedFromRoot } from "../../src/index.js";
// @ts-expect-error — ParsedMutatingEnvelope is internal (digest-internal.ts) and not public API
import type { ParsedMutatingEnvelope as _NotExportedFromBarrel } from "../../src/protocol/index.js";

/**
 * R2 export-boundary patch: the only supported public mutation-digest
 * entry points are the two direction-specific helpers. The low-level
 * canonicalizers live in digest-internal.ts and must not leak through
 * the protocol barrel or the shared package root.
 */

const UNSAFE_LOW_LEVEL_EXPORTS = [
  "canonicalizeMutatingEnvelopeForDigest",
  "canonicalizeForDigest",
  "grantAuthenticationPayload",
  "verifyGrantAuthentication",
] as const;

const rawChatSubmit = (extra: Record<string, unknown> = {}) => ({
  protocolVersion: "1.0",
  messageId: "msg-100",
  messageKind: "chat.submit",
  sentAt: "2026-07-11T09:00:00Z",
  idempotencyKey: "client-key-0001",
  payload: {
    input: { kind: "natural-language", text: "please fix the login timeout" },
    projectId: "pilot-project",
  },
  ...extra,
});

const rawDispatch = (extra: Record<string, unknown> = {}) => ({
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
  ...extra,
});

describe("digest export boundary (R2 patch)", () => {
  it("unsafe low-level runtime helpers are absent from the shared package root", () => {
    for (const name of UNSAFE_LOW_LEVEL_EXPORTS) {
      expect(name in sharedRoot, `${name} must not be exported from src/index`).toBe(false);
    }
  });

  it("unsafe low-level runtime helpers are absent from the protocol barrel", () => {
    for (const name of UNSAFE_LOW_LEVEL_EXPORTS) {
      expect(name in protocolBarrel, `${name} must not be exported from protocol/index`).toBe(
        false,
      );
    }
  });

  it("the two direction-specific public helpers remain available from the package root", () => {
    expect(typeof sharedRoot.canonicalizeClientMutationForDigest).toBe("function");
    expect(typeof sharedRoot.canonicalizeBridgeCommandForDigest).toBe("function");
    expect(typeof protocolBarrel.canonicalizeClientMutationForDigest).toBe("function");
    expect(typeof protocolBarrel.canonicalizeBridgeCommandForDigest).toBe("function");
  });

  it("public idempotency schemas, digest format, scopes, and classifyDelivery stay public", () => {
    expect(typeof sharedRoot.classifyDelivery).toBe("function");
    expect(typeof sharedRoot.scopeKey).toBe("function");
    expect(sharedRoot.PayloadDigestSchema.safeParse(`sha256:${"a".repeat(64)}`).success).toBe(
      true,
    );
    expect(
      sharedRoot.IdempotencyScopeSchema.safeParse({
        direction: "client-to-control-plane",
        messageKind: "chat.submit",
      }).success,
    ).toBe(true);
    expect(sharedRoot.IncomingDeliverySchema).toBeDefined();
    expect(sharedRoot.RecordedIdempotencySchema).toBeDefined();
  });

  it("exports the intentional M1C approval-security surface", () => {
    expect(sharedRoot.ApprovalActionSchema).toBeDefined();
    expect(sharedRoot.CapabilityGrantSchema).toBeDefined();
    expect(sharedRoot.ApprovalProofChallengeSchema).toBeDefined();
    expect(typeof sharedRoot.parseApprovalAction).toBe("function");
    expect(typeof sharedRoot.digestApprovalAction).toBe("function");
    expect(typeof sharedRoot.verifyCapabilityGrant).toBe("function");
    expect(typeof sharedRoot.verifyApprovalProofBinding).toBe("function");
  });

  it("valid client and Bridge mutations still canonicalize through the public helpers", () => {
    const clientDigest = sharedRoot.canonicalizeClientMutationForDigest(rawChatSubmit());
    expect(typeof clientDigest).toBe("string");
    expect(clientDigest).toContain('"direction":"client-to-control-plane"');
    const bridgeDigest = sharedRoot.canonicalizeBridgeCommandForDigest(rawDispatch());
    expect(typeof bridgeDigest).toBe("string");
    expect(bridgeDigest).toContain('"direction":"control-plane-to-bridge"');
  });

  it("fake kinds, malformed payloads, and invalid timestamps remain rejected", () => {
    expect(() =>
      sharedRoot.canonicalizeClientMutationForDigest(rawChatSubmit({ messageKind: "made.up" })),
    ).toThrow(TypeError);
    expect(() =>
      sharedRoot.canonicalizeClientMutationForDigest(rawChatSubmit({ payload: { wrong: true } })),
    ).toThrow(TypeError);
    expect(() =>
      sharedRoot.canonicalizeClientMutationForDigest(
        rawChatSubmit({ sentAt: "2026-02-30T08:30:00Z" }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      sharedRoot.canonicalizeBridgeCommandForDigest(rawDispatch({ messageKind: "made.up" })),
    ).toThrow(TypeError);
    expect(() =>
      sharedRoot.canonicalizeBridgeCommandForDigest(rawDispatch({ payload: { wrong: true } })),
    ).toThrow(TypeError);
  });

  it("read-only messages and missing idempotency keys remain rejected", () => {
    const readOnly = {
      protocolVersion: "1.0",
      messageId: "msg-100",
      messageKind: "task.get",
      sentAt: "2026-07-11T09:00:00Z",
      payload: { taskId: "task-42" },
    };
    expect(() => sharedRoot.canonicalizeClientMutationForDigest(readOnly)).toThrow(TypeError);
    const ping = {
      protocolVersion: "1.0",
      messageId: "cmd-201",
      messageKind: "bridge.ping",
      sentAt: "2026-07-11T10:00:00Z",
      payload: {},
    };
    expect(() => sharedRoot.canonicalizeBridgeCommandForDigest(ping)).toThrow(TypeError);
    const { idempotencyKey: _omit, ...missingKey } = rawChatSubmit();
    expect(() => sharedRoot.canonicalizeClientMutationForDigest(missingKey)).toThrow(TypeError);
    const { idempotencyKey: _omit2, ...missingBridgeKey } = rawDispatch();
    expect(() => sharedRoot.canonicalizeBridgeCommandForDigest(missingBridgeKey)).toThrow(
      TypeError,
    );
  });
});
