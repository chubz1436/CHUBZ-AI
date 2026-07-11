import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRYABILITY,
  PROTOCOL_ERROR_CODES,
  ProtocolErrorSchema,
  makeProtocolError,
} from "../../src/index.js";

describe("protocol error codes", () => {
  it("defines the full documented code set", () => {
    expect([...PROTOCOL_ERROR_CODES]).toEqual([
      "INVALID_ENVELOPE",
      "UNSUPPORTED_PROTOCOL_VERSION",
      "UNKNOWN_MESSAGE_KIND",
      "VALIDATION_ERROR",
      "IDEMPOTENCY_CONFLICT",
      "CURSOR_AHEAD",
      "CURSOR_TOO_OLD",
      "UNKNOWN_STREAM",
      "SEQUENCE_GAP",
      "NOT_FOUND",
      "BUSY",
      "WORKER_OFFLINE",
      "UNAUTHORIZED",
      "INTERNAL_ERROR",
    ]);
  });

  it("every code builds a valid error with sane default retryability", () => {
    for (const code of PROTOCOL_ERROR_CODES) {
      const error = makeProtocolError(code, "Something bounded happened.");
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(DEFAULT_RETRYABILITY[code]);
      expect(ProtocolErrorSchema.safeParse(error).success).toBe(true);
    }
  });

  it("transient conditions are retryable; conflicts and contract violations are not", () => {
    expect(DEFAULT_RETRYABILITY.BUSY).toBe(true);
    expect(DEFAULT_RETRYABILITY.WORKER_OFFLINE).toBe(true);
    expect(DEFAULT_RETRYABILITY.INTERNAL_ERROR).toBe(true);
    expect(DEFAULT_RETRYABILITY.IDEMPOTENCY_CONFLICT).toBe(false);
    expect(DEFAULT_RETRYABILITY.VALIDATION_ERROR).toBe(false);
    expect(DEFAULT_RETRYABILITY.UNAUTHORIZED).toBe(false);
  });

  it("retryability can be overridden explicitly", () => {
    const error = makeProtocolError("BUSY", "Queue is saturated.", { retryable: false });
    expect(error.retryable).toBe(false);
  });
});

describe("error safety", () => {
  it("supports bounded structured field errors", () => {
    const error = makeProtocolError("VALIDATION_ERROR", "The message failed schema validation.", {
      fieldErrors: [{ path: "payload.taskId", message: "must be a bounded log-safe identifier" }],
      relatesToMessageId: "msg-100",
      correlationId: "corr-1",
    });
    expect(error.fieldErrors).toHaveLength(1);
    expect(error.relatesToMessageId).toBe("msg-100");
  });

  it("rejects oversized field-error lists", () => {
    const tooMany = Array.from({ length: 65 }, (_, i) => ({
      path: `payload.field${i}`,
      message: "bad",
    }));
    expect(
      ProtocolErrorSchema.safeParse({
        code: "VALIDATION_ERROR",
        summary: "Too many problems.",
        retryable: false,
        fieldErrors: tooMany,
      }).success,
    ).toBe(false);
  });

  it("summaries with stack traces are refused", () => {
    expect(() =>
      makeProtocolError("INTERNAL_ERROR", "Error: boom\n    at Object.run (server.js:10:5)"),
    ).toThrow();
  });

  it("summaries with local filesystem paths are refused", () => {
    expect(() =>
      makeProtocolError("INTERNAL_ERROR", "failed reading B:\\AI_Agent_folder\\secrets.txt"),
    ).toThrow();
    expect(() => makeProtocolError("INTERNAL_ERROR", "UNC \\\\server\\share failed")).toThrow();
  });

  it("summaries with markup are refused", () => {
    expect(() => makeProtocolError("NOT_FOUND", "<b>not found</b>")).toThrow();
  });

  it("stack and credential-like fields are rejected as unknown keys", () => {
    for (const extra of [
      { stack: "Error at line 1" },
      { apiKey: "sk-secret" },
      { authorization: "Bearer token" },
      { exception: { message: "raw" } },
    ]) {
      expect(
        ProtocolErrorSchema.safeParse({
          code: "INTERNAL_ERROR",
          summary: "Something happened.",
          retryable: true,
          ...extra,
        }).success,
      ).toBe(false);
    }
  });

  it("oversized summaries are refused", () => {
    expect(() => makeProtocolError("BUSY", "x".repeat(2_001))).toThrow();
  });
});
