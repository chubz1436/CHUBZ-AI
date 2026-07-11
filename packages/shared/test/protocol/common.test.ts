import { describe, expect, it } from "vitest";
import {
  BridgePingMessageSchema,
  IdempotencyKeySchema,
  IsoUtcTimestampSchema,
  MESSAGE_DIRECTIONS,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  SafeIdSchema,
  SlugIdSchema,
  TaskGetMessageSchema,
  TaskCancelMessageSchema,
  boundedText,
  displayText,
} from "../../src/index.js";

const validReadonlyEnvelope = () => ({
  protocolVersion: PROTOCOL_VERSION,
  messageId: "msg-001",
  messageKind: "task.get" as const,
  sentAt: "2026-07-11T08:30:00Z",
  payload: { taskId: "task-42" },
});

describe("protocol version", () => {
  it("pins version 1.0 as the only supported version", () => {
    expect(PROTOCOL_VERSION).toBe("1.0");
    expect([...SUPPORTED_PROTOCOL_VERSIONS]).toEqual(["1.0"]);
  });

  it("rejects unsupported versions", () => {
    const bad = { ...validReadonlyEnvelope(), protocolVersion: "2.0" };
    expect(TaskGetMessageSchema.safeParse(bad).success).toBe(false);
  });
});

describe("envelope structure", () => {
  it("accepts a valid envelope with optional correlation fields", () => {
    const full = {
      ...validReadonlyEnvelope(),
      correlationId: "corr-1",
      causationId: "cause-1",
      projectId: "pilot-project",
      taskId: "task-42",
      attemptId: "attempt-1",
    };
    expect(TaskGetMessageSchema.safeParse(full).success).toBe(true);
  });

  it("rejects a missing message ID", () => {
    const { messageId: _omit, ...rest } = validReadonlyEnvelope();
    expect(TaskGetMessageSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects unknown fields at the envelope level", () => {
    const bad = { ...validReadonlyEnvelope(), shellCommand: "rm -rf" };
    expect(TaskGetMessageSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects the wrong payload for a message kind", () => {
    const bad = { ...validReadonlyEnvelope(), payload: { echo: "ping-1" } };
    expect(TaskGetMessageSchema.safeParse(bad).success).toBe(false);
    const alsoBad = {
      ...validReadonlyEnvelope(),
      messageKind: "bridge.ping" as const,
      payload: { taskId: "task-42" },
    };
    expect(BridgePingMessageSchema.safeParse(alsoBad).success).toBe(false);
  });

  it("rejects an unknown message kind", () => {
    const bad = { ...validReadonlyEnvelope(), messageKind: "task.obliterate" };
    expect(TaskGetMessageSchema.safeParse(bad).success).toBe(false);
  });

  it("survives a JSON serialize/parse round trip", () => {
    const message = TaskGetMessageSchema.parse(validReadonlyEnvelope());
    const roundTripped: unknown = JSON.parse(JSON.stringify(message));
    const reparsed = TaskGetMessageSchema.parse(roundTripped);
    expect(reparsed).toEqual(message);
  });
});

describe("timestamps", () => {
  it("accepts ISO-8601 UTC with and without milliseconds", () => {
    for (const sentAt of ["2026-07-11T08:30:00Z", "2026-07-11T08:30:00.123Z"]) {
      expect(TaskGetMessageSchema.safeParse({ ...validReadonlyEnvelope(), sentAt }).success).toBe(
        true,
      );
    }
  });

  it("rejects non-UTC, offset, and malformed timestamps", () => {
    for (const sentAt of [
      "2026-07-11T08:30:00",
      "2026-07-11T08:30:00+08:00",
      "2026-07-11 08:30:00Z",
      "2026-13-45T08:30:00Z",
      "yesterday",
      "",
    ]) {
      expect(IsoUtcTimestampSchema.safeParse(sentAt).success).toBe(false);
    }
  });
});

describe("identifiers", () => {
  it("accepts bounded log-safe IDs", () => {
    for (const id of ["a", "task-42", "OP_1.retry-2", "A".repeat(128)]) {
      expect(SafeIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it("rejects empty, oversized, and unsafe IDs", () => {
    for (const id of [
      "",
      "A".repeat(129),
      "has space",
      "line\nbreak",
      "a/b",
      "a\\b",
      "C:evil",
      "..",
      "a..b",
      "-leading-dash",
      ".leading-dot",
    ]) {
      expect(SafeIdSchema.safeParse(id).success).toBe(false);
    }
  });

  it("slug IDs match the M1A worker/project style", () => {
    expect(SlugIdSchema.safeParse("pilot-project").success).toBe(true);
    expect(SlugIdSchema.safeParse("Codex").success).toBe(false);
    expect(SlugIdSchema.safeParse("a".repeat(64)).success).toBe(false);
  });

  it("idempotency keys have a minimum length floor", () => {
    expect(IdempotencyKeySchema.safeParse("k".repeat(8)).success).toBe(true);
    expect(IdempotencyKeySchema.safeParse("short").success).toBe(false);
    expect(IdempotencyKeySchema.safeParse("k".repeat(129)).success).toBe(false);
  });
});

describe("text bounds", () => {
  it("boundedText enforces its maximum and refuses control characters", () => {
    const schema = boundedText(10);
    expect(schema.safeParse("hello").success).toBe(true);
    expect(schema.safeParse("multi\nline").success).toBe(true);
    expect(schema.safeParse("x".repeat(11)).success).toBe(false);
    expect(schema.safeParse("nul" + String.fromCharCode(0)).success).toBe(false);
    expect(schema.safeParse("bell" + String.fromCharCode(7)).success).toBe(false);
  });

  it("excessive inline text is rejected at the payload level", () => {
    const oversized = {
      protocolVersion: PROTOCOL_VERSION,
      messageId: "msg-002",
      messageKind: "task.cancel" as const,
      sentAt: "2026-07-11T08:30:00Z",
      idempotencyKey: "cancel-key-001",
      payload: {
        taskId: "task-42",
        attemptId: "attempt-1",
        reasonNote: "x".repeat(PROTOCOL_LIMITS.maxStatusTextLength + 1),
      },
    };
    expect(TaskCancelMessageSchema.safeParse(oversized).success).toBe(false);
  });

  it("displayText additionally refuses markup, stack frames, and local paths", () => {
    const schema = displayText(500);
    expect(schema.safeParse("Finalize task 42 as an approved commit").success).toBe(true);
    expect(schema.safeParse("<script>alert(1)</script>").success).toBe(false);
    expect(schema.safeParse("Error\n    at Object.run (thing:1:1)").success).toBe(false);
    expect(schema.safeParse("see B:\\AI_Agent_folder\\secret").success).toBe(false);
    expect(schema.safeParse("see \\\\server\\share").success).toBe(false);
  });
});

describe("directions", () => {
  it("defines exactly the four protocol directions", () => {
    expect([...MESSAGE_DIRECTIONS]).toEqual([
      "client-to-control-plane",
      "control-plane-to-client",
      "control-plane-to-bridge",
      "bridge-to-control-plane",
    ]);
  });
});
