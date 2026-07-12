import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRYABILITY,
  FIXED_NON_RETRYABLE_CODES,
  FieldErrorSchema,
  PROTOCOL_ERROR_CODES,
  ProtocolErrorSchema,
  makeProtocolError,
  parseBridgeToControlPlaneMessage,
  parseClientToControlPlaneMessage,
  parseControlPlaneToBridgeMessage,
  parseControlPlaneToClientMessage,
  type EnvelopeParseResult,
  type ProtocolError,
} from "../../src/index.js";

describe("protocol error codes", () => {
  it("defines the full documented code set", () => {
    expect([...PROTOCOL_ERROR_CODES]).toEqual([
      "INVALID_ENVELOPE",
      "UNSUPPORTED_PROTOCOL_VERSION",
      "UNKNOWN_MESSAGE_KIND",
      "VALIDATION_ERROR",
      "IDEMPOTENCY_CONFLICT",
      "EXECUTION_UNKNOWN",
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

  it("only genuinely transient pre-execution conditions are retryable by default (R3)", () => {
    expect(DEFAULT_RETRYABILITY.BUSY).toBe(true);
    expect(DEFAULT_RETRYABILITY.WORKER_OFFLINE).toBe(true);
    expect(DEFAULT_RETRYABILITY.INTERNAL_ERROR).toBe(false);
    expect(DEFAULT_RETRYABILITY.EXECUTION_UNKNOWN).toBe(false);
    expect(DEFAULT_RETRYABILITY.IDEMPOTENCY_CONFLICT).toBe(false);
    expect(DEFAULT_RETRYABILITY.VALIDATION_ERROR).toBe(false);
    expect(DEFAULT_RETRYABILITY.UNAUTHORIZED).toBe(false);
  });

  it("retryability of non-fixed codes can be overridden explicitly", () => {
    const busy = makeProtocolError("BUSY", "Queue is saturated.", { retryable: false });
    expect(busy.retryable).toBe(false);
    // A runtime that PROVED an internal failure happened before execution
    // may mark that specific case retryable; the default stays false.
    const internal = makeProtocolError("INTERNAL_ERROR", "Failed before execution began.", {
      retryable: true,
    });
    expect(internal.retryable).toBe(true);
  });
});

describe("fixed non-retryable codes (R3)", () => {
  it("names exactly the contract-violation, conflict, and execution-unknown codes", () => {
    expect([...FIXED_NON_RETRYABLE_CODES]).toEqual([
      "INVALID_ENVELOPE",
      "UNSUPPORTED_PROTOCOL_VERSION",
      "UNKNOWN_MESSAGE_KIND",
      "VALIDATION_ERROR",
      "IDEMPOTENCY_CONFLICT",
      "EXECUTION_UNKNOWN",
    ]);
  });

  it("makeProtocolError refuses to override a fixed non-retryable code to retryable", () => {
    for (const code of FIXED_NON_RETRYABLE_CODES) {
      expect(() =>
        makeProtocolError(code, "Attempted forbidden retryable override.", { retryable: true }),
      ).toThrow();
    }
  });

  it("hand-built errors claiming a fixed code is retryable fail schema validation", () => {
    for (const code of FIXED_NON_RETRYABLE_CODES) {
      expect(
        ProtocolErrorSchema.safeParse({
          code,
          summary: "Claims to be retryable.",
          retryable: true,
        }).success,
      ).toBe(false);
      expect(
        ProtocolErrorSchema.safeParse({
          code,
          summary: "Correctly non-retryable.",
          retryable: false,
        }).success,
      ).toBe(true);
    }
  });

  it("EXECUTION_UNKNOWN exists as the machine-readable reconciliation-required code", () => {
    const error = makeProtocolError(
      "EXECUTION_UNKNOWN",
      "The operation outcome cannot be proven; owner reconciliation is required.",
    );
    expect(error.code).toBe("EXECUTION_UNKNOWN");
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

describe("field-error paths (R3): bounded dot/index notation only", () => {
  const fieldError = (path: string) => ({ path, message: "invalid value" });

  it("accepts the documented dot/index path forms", () => {
    for (const path of [
      "payload",
      "payload.taskId",
      "payload.items[0].name",
      "$",
      "$.payload.items[0]",
      "$[3]",
      "payload.items[12345]",
      "_private.field_1",
    ]) {
      expect(
        ProtocolErrorSchema.safeParse({
          code: "VALIDATION_ERROR",
          summary: "The message failed schema validation.",
          retryable: false,
          fieldErrors: [fieldError(path)],
        }).success,
        path,
      ).toBe(true);
    }
  });

  it("rejects control characters, separators, traversal, and trace-like paths", () => {
    for (const path of [
      "payload\u0000.taskId", // NUL control character
      "payload\n.taskId", // newline
      "payload\t.taskId", // tab
      "payload/items", // forward slash
      "payload\\items", // backslash
      "C:\\Users\\owner\\secret", // drive-letter path
      "C:/Users/owner/secret", // drive-letter path, forward slashes
      "\\\\server\\share\\file", // UNC path
      "..", // traversal
      "payload..taskId", // empty segment / traversal
      "payload.", // trailing empty segment
      ".payload", // leading empty segment
      "payload.items[0",
      "payload.items0]",
      "payload.items[-1]",
      "Error\n    at Object.run (server.js:10:5)", // stack trace
      "payload with spaces",
      "x".repeat(257), // excessively long
      "", // empty
      "$$", // malformed root
      "$payload", // root not followed by . or [
    ]) {
      expect(
        ProtocolErrorSchema.safeParse({
          code: "VALIDATION_ERROR",
          summary: "The message failed schema validation.",
          retryable: false,
          fieldErrors: [fieldError(path)],
        }).success,
        JSON.stringify(path),
      ).toBe(false);
    }
  });

  it("makeProtocolError refuses unsafe field paths instead of leaking them", () => {
    expect(() =>
      makeProtocolError("VALIDATION_ERROR", "The message failed schema validation.", {
        fieldErrors: [fieldError("B:\\AI_Agent_folder\\secrets.txt")],
      }),
    ).toThrow();
  });

  it("real parse failures emit $-rooted paths that satisfy the field-path schema", () => {
    // Nested payload failure → a deep path; array index failure → bracket form.
    const invalid = {
      protocolVersion: "1.0",
      messageId: "msg-100",
      messageKind: "chat.submit",
      sentAt: "2026-07-11T09:00:00Z",
      idempotencyKey: "client-key-0001",
      payload: {
        input: { kind: "natural-language", text: "ok" },
        projectId: "NOT A SLUG",
      },
    };
    const result = parseClientToControlPlaneMessage(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.fieldErrors).toBeDefined();
      for (const fe of result.error.fieldErrors ?? []) {
        expect(fe.path.startsWith("$")).toBe(true);
        expect(
          ProtocolErrorSchema.safeParse({
            code: "VALIDATION_ERROR",
            summary: "re-validating emitted field paths",
            retryable: false,
            fieldErrors: [fe],
          }).success,
          fe.path,
        ).toBe(true);
      }
    }
  });

  it("root-level issues are reported at $", () => {
    const missingEverything = {
      protocolVersion: "1.0",
      messageKind: "chat.submit",
    };
    const result = parseClientToControlPlaneMessage(missingEverything);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const fe of result.error.fieldErrors ?? []) {
        expect(fe.path.startsWith("$")).toBe(true);
      }
    }
  });
});

describe("hostile unknown-field input keeps the public parsers total (hostile-input patch)", () => {
  // Control characters are built at runtime so no raw control byte and
  // no escape sequence has to appear in this source file.
  const C = String.fromCharCode;
  const PROHIBITED_CONTROLS = new RegExp("[" + C(0) + "-" + C(31) + C(127) + "-" + C(159) + "]");

  const clientBase = () => ({
    protocolVersion: "1.0",
    messageId: "msg-001",
    messageKind: "task.get",
    sentAt: "2026-07-11T08:30:00Z",
    payload: { taskId: "task-42" },
  });

  const bridgeBase = () => ({
    protocolVersion: "1.0",
    messageId: "cmd-001",
    messageKind: "bridge.ping",
    sentAt: "2026-07-11T08:30:00Z",
    payload: {},
  });

  const controlPlaneToClientBase = () => ({
    protocolVersion: "1.0",
    messageId: "msg-500",
    messageKind: "request.accepted",
    sentAt: "2026-07-11T08:30:00Z",
    payload: { acceptedMessageId: "msg-001" },
  });

  const bridgeToControlPlaneBase = () => ({
    protocolVersion: "1.0",
    messageId: "rpt-001",
    messageKind: "bridge.pong",
    sentAt: "2026-07-11T08:30:00Z",
    payload: {},
  });

  const HOSTILE_KEYS: ReadonlyArray<[label: string, key: string]> = [
    ["C0 control character", "ctrl" + C(1) + "name"],
    ["NUL control character", "nul" + C(0) + "key"],
    ["C1 control character", "c1" + C(133) + "key"],
    ["newline", "line" + C(10) + "break"],
    ["carriage return", "cr" + C(13) + "key"],
    ["tab", "tab" + C(9) + "key"],
    ["whitespace-only key", "   "],
    ["punctuation", "punct!@#key"],
    ["forward slash", "slash/key"],
    ["backslash", "back\\slash\\key"],
    ["drive-letter-looking key", "C:\\evil\\path"],
    ["UNC-looking key", "\\\\server\\share\\file"],
    ["numeric key", "42"],
    ["very long key", "k".repeat(500)],
  ];

  type FailedParse = { ok: false; error: ProtocolError };

  const expectTotalRejection = <T>(
    parse: (raw: unknown) => EnvelopeParseResult<T>,
    raw: unknown,
  ): FailedParse["error"] => {
    let result: EnvelopeParseResult<T> | undefined;
    expect(() => {
      result = parse(raw);
    }).not.toThrow();
    if (result === undefined || result.ok) {
      throw new Error("expected the parser to return a failed EnvelopeParseResult");
    }
    const error = result.error;
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(ProtocolErrorSchema.safeParse(error).success).toBe(true);
    expect(PROHIBITED_CONTROLS.test(error.summary)).toBe(false);
    for (const fe of error.fieldErrors ?? []) {
      expect(FieldErrorSchema.safeParse(fe).success, fe.path).toBe(true);
      expect(PROHIBITED_CONTROLS.test(fe.path)).toBe(false);
      expect(PROHIBITED_CONTROLS.test(fe.message)).toBe(false);
    }
    return error;
  };

  it("Client → Control Plane parser stays total for every hostile envelope key", () => {
    for (const [label, key] of HOSTILE_KEYS) {
      expectTotalRejection(parseClientToControlPlaneMessage, { ...clientBase(), [key]: "x" });
      expect(true, label).toBe(true);
    }
  });

  it("Control Plane → Bridge parser stays total for every hostile envelope key", () => {
    for (const [label, key] of HOSTILE_KEYS) {
      expectTotalRejection(parseControlPlaneToBridgeMessage, { ...bridgeBase(), [key]: "x" });
      expect(true, label).toBe(true);
    }
  });

  it("Control Plane → Client and Bridge → Control Plane parsers share the same totality", () => {
    for (const [, key] of HOSTILE_KEYS.slice(0, 4)) {
      expectTotalRejection(parseControlPlaneToClientMessage, {
        ...controlPlaneToClientBase(),
        [key]: "x",
      });
      expectTotalRejection(parseBridgeToControlPlaneMessage, {
        ...bridgeToControlPlaneBase(),
        [key]: "x",
      });
    }
  });

  it("hostile keys inside the payload are handled identically", () => {
    const raw = {
      ...clientBase(),
      payload: { taskId: "task-42", ["bad" + C(2) + "payloadKey"]: 1 },
    };
    const error = expectTotalRejection(parseClientToControlPlaneMessage, raw);
    const paths = (error.fieldErrors ?? []).map((fe) => fe.path);
    expect(paths.some((p) => p.startsWith("$.payload."))).toBe(true);
  });

  it("multiple hostile keys in one message receive distinct deterministic paths", () => {
    const raw = {
      ...clientBase(),
      ["bad" + C(1) + "a"]: 1,
      ["bad" + C(2) + "b"]: 2,
      ["bad/c"]: 3,
    };
    const error = expectTotalRejection(parseClientToControlPlaneMessage, raw);
    const paths = (error.fieldErrors ?? []).map((fe) => fe.path);
    expect(paths.length).toBeGreaterThanOrEqual(3);
    expect(new Set(paths).size).toBe(paths.length);
    const synthetic = paths.filter((p) => /\.unknownFields\[\d+\]$/.test(p));
    expect(synthetic.length).toBeGreaterThanOrEqual(3);
  });

  it("parser output is deterministic for the same hostile input", () => {
    const raw = () => ({
      ...clientBase(),
      ["bad" + C(1) + "a"]: 1,
      ["bad" + C(2) + "b"]: 2,
    });
    const first = expectTotalRejection(parseClientToControlPlaneMessage, raw());
    const second = expectTotalRejection(parseClientToControlPlaneMessage, raw());
    expect(second).toEqual(first);
  });

  it("identifier-safe unknown keys keep their readable named path", () => {
    const error = expectTotalRejection(parseClientToControlPlaneMessage, {
      ...clientBase(),
      smuggled: "field",
    });
    const paths = (error.fieldErrors ?? []).map((fe) => fe.path);
    expect(paths).toContain("$.smuggled");
  });

  it("hostile unknown keys and ordinary field failures coexist in one result", () => {
    const raw = {
      ...clientBase(),
      payload: { taskId: "../not-safe" },
      ["bad" + C(3) + "x"]: 1,
    };
    const error = expectTotalRejection(parseClientToControlPlaneMessage, raw);
    const paths = (error.fieldErrors ?? []).map((fe) => fe.path);
    expect(paths.some((p) => /\.unknownFields\[\d+\]$/.test(p))).toBe(true);
    expect(paths.some((p) => p.startsWith("$.payload"))).toBe(true);
  });
});
