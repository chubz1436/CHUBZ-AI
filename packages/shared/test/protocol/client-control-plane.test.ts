import { describe, expect, it } from "vitest";
import {
  CLIENT_TO_CONTROL_PLANE_KINDS,
  CONTROL_PLANE_TO_CLIENT_KINDS,
  MUTATING_CLIENT_KINDS,
  PROTOCOL_VERSION,
  READONLY_CLIENT_KINDS,
  parseClientToControlPlaneMessage,
  parseControlPlaneToClientMessage,
} from "../../src/index.js";

const base = (messageKind: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
  protocolVersion: PROTOCOL_VERSION,
  messageId: "msg-100",
  messageKind,
  sentAt: "2026-07-11T09:00:00Z",
  payload,
  ...extra,
});

const withKey = (messageKind: string, payload: unknown) =>
  base(messageKind, payload, { idempotencyKey: "client-key-0001" });

const ok = <T>(r: { ok: boolean } & Record<string, unknown>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as unknown as T;
};
const errCode = (r: ReturnType<typeof parseClientToControlPlaneMessage>) => {
  if (r.ok) throw new Error("expected error");
  return r.error.code;
};

describe("client → control plane requests", () => {
  it("accepts every request kind", () => {
    const samples: Record<string, unknown> = {
      "chat.submit": withKey("chat.submit", {
        input: { kind: "command", command: "codex", argumentText: "fix the login timeout" },
        projectId: "pilot-project",
        workerId: "codex",
        clientMeta: { clientName: "web-app", clientVersion: "0.1.0" },
      }),
      "approval.decide": withKey("approval.decide", {
        approvalRequestId: "appr-1",
        decision: "approve",
      }),
      "task.cancel": withKey("task.cancel", { taskId: "task-42" }),
      "task.get": base("task.get", { taskId: "task-42" }),
      "task.list": base("task.list", { projectId: "pilot-project", limit: 20 }),
      "stream.resume": base("stream.resume", {
        cursor: { streamId: "stream-task-42", lastConsumedSequence: 7 },
      }),
    };
    for (const kind of CLIENT_TO_CONTROL_PLANE_KINDS) {
      const result = parseClientToControlPlaneMessage(samples[kind]);
      expect(result.ok, kind).toBe(true);
    }
  });

  it("accepts natural-language owner input", () => {
    const result = parseClientToControlPlaneMessage(
      withKey("chat.submit", {
        input: { kind: "natural-language", text: "please fix the login timeout" },
        projectId: "pilot-project",
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects the invalid parse variant as owner input", () => {
    const result = parseClientToControlPlaneMessage(
      withKey("chat.submit", {
        input: { kind: "invalid", code: "UNKNOWN_COMMAND", message: "nope" },
        projectId: "pilot-project",
      }),
    );
    expect(errCode(result)).toBe("VALIDATION_ERROR");
  });

  it("rejects oversized owner text", () => {
    const result = parseClientToControlPlaneMessage(
      withKey("chat.submit", {
        input: { kind: "natural-language", text: "x".repeat(16_001) },
        projectId: "pilot-project",
      }),
    );
    expect(errCode(result)).toBe("VALIDATION_ERROR");
  });

  it("every mutating request without an idempotency key is rejected", () => {
    const payloads: Record<(typeof MUTATING_CLIENT_KINDS)[number], unknown> = {
      "chat.submit": {
        input: { kind: "command", command: "status", argumentText: "" },
        projectId: "pilot-project",
      },
      "approval.decide": { approvalRequestId: "appr-1", decision: "reject" },
      "task.cancel": { taskId: "task-42" },
    };
    for (const kind of MUTATING_CLIENT_KINDS) {
      const result = parseClientToControlPlaneMessage(base(kind, payloads[kind]));
      expect(errCode(result), kind).toBe("VALIDATION_ERROR");
    }
  });

  it("read-only queries are not forced to mutate — a supplied key is rejected", () => {
    for (const kind of READONLY_CLIENT_KINDS) {
      const payload =
        kind === "task.get"
          ? { taskId: "task-42" }
          : kind === "task.list"
            ? {}
            : { cursor: { streamId: "stream-task-42", lastConsumedSequence: 0 } };
      const withUnexpectedKey = withKey(kind, payload);
      expect(errCode(parseClientToControlPlaneMessage(withUnexpectedKey)), kind).toBe(
        "VALIDATION_ERROR",
      );
      expect(parseClientToControlPlaneMessage(base(kind, payload)).ok, kind).toBe(true);
    }
  });

  it("approval decisions stay bounded — authority fields are rejected", () => {
    const smuggled = withKey("approval.decide", {
      approvalRequestId: "appr-1",
      decision: "approve",
      grantScope: "everything",
    });
    expect(errCode(parseClientToControlPlaneMessage(smuggled))).toBe("VALIDATION_ERROR");
    const oversizedNote = withKey("approval.decide", {
      approvalRequestId: "appr-1",
      decision: "approve",
      note: "n".repeat(2_001),
    });
    expect(errCode(parseClientToControlPlaneMessage(oversizedNote))).toBe("VALIDATION_ERROR");
  });

  it("credential-like fields are rejected anywhere in the request", () => {
    const withToken = withKey("chat.submit", {
      input: { kind: "natural-language", text: "hello" },
      projectId: "pilot-project",
      apiToken: "sk-secret",
    });
    expect(errCode(parseClientToControlPlaneMessage(withToken))).toBe("VALIDATION_ERROR");
  });

  it("task.snapshot cannot masquerade as a client request (wrong direction)", () => {
    const wrongDirection = base("task.snapshot", {
      taskId: "task-42",
      projectId: "pilot-project",
      state: "RUNNING",
      updatedAt: "2026-07-11T09:00:00Z",
    });
    expect(errCode(parseClientToControlPlaneMessage(wrongDirection))).toBe("UNKNOWN_MESSAGE_KIND");
  });

  it("bridge commands cannot masquerade as client requests", () => {
    const wrongDirection = withKey("worker.dispatch", {});
    expect(errCode(parseClientToControlPlaneMessage(wrongDirection))).toBe("UNKNOWN_MESSAGE_KIND");
  });

  it("unsupported protocol versions are rejected before anything else", () => {
    const message = { ...base("task.get", { taskId: "task-42" }), protocolVersion: "0.9" };
    expect(errCode(parseClientToControlPlaneMessage(message))).toBe(
      "UNSUPPORTED_PROTOCOL_VERSION",
    );
  });

  it("non-object input is an invalid envelope", () => {
    expect(errCode(parseClientToControlPlaneMessage("hello"))).toBe("INVALID_ENVELOPE");
    expect(errCode(parseClientToControlPlaneMessage(null))).toBe("INVALID_ENVELOPE");
    expect(errCode(parseClientToControlPlaneMessage([1, 2]))).toBe("INVALID_ENVELOPE");
  });
});

describe("control plane → client messages", () => {
  const protocolError = {
    code: "NOT_FOUND",
    summary: "Task not found.",
    retryable: false,
  };

  it("accepts every message kind", () => {
    const samples: Record<string, unknown> = {
      "request.accepted": base("request.accepted", {
        acceptedMessageId: "msg-100",
        replayClassification: "new",
      }),
      "request.rejected": base("request.rejected", {
        rejectedMessageId: "msg-100",
        error: protocolError,
      }),
      "task.snapshot": base("task.snapshot", {
        taskId: "task-42",
        projectId: "pilot-project",
        workerId: "codex",
        state: "RUNNING",
        attemptId: "attempt-1",
        updatedAt: "2026-07-11T09:00:00Z",
        summary: "Worker is executing the bounded task.",
      }),
      "task.event": base("task.event", {
        streamId: "stream-task-42",
        sequence: 8,
        eventId: "evt-8",
        taskId: "task-42",
        occurredAt: "2026-07-11T09:00:05Z",
        eventKind: "task.state-changed",
        artifactIds: ["artifact-1"],
      }),
      "approval.requested": base("approval.requested", {
        approvalRequestId: "appr-1",
        taskId: "task-42",
        attemptId: "attempt-1",
        gate: "integrate",
        actionSummary: "Finalize task 42 as an approved commit and patch in the managed repository.",
        diffStats: { filesChanged: 3, insertions: 120, deletions: 8 },
        testVerdict: "passed",
        riskFlags: ["redactions: 1"],
        expiresAt: "2026-07-11T09:30:00Z",
      }),
      "worker.status": base("worker.status", {
        workerId: "codex",
        connectorTier: "automated",
        state: "busy",
        activeTaskId: "task-42",
        queuedCount: 1,
      }),
      "protocol.error": base("protocol.error", { error: protocolError }),
    };
    for (const kind of CONTROL_PLANE_TO_CLIENT_KINDS) {
      expect(parseControlPlaneToClientMessage(samples[kind]).ok, kind).toBe(true);
    }
  });

  it("task snapshots use the M1A task-state type", () => {
    const badState = base("task.snapshot", {
      taskId: "task-42",
      projectId: "pilot-project",
      state: "DEPLOYING",
      updatedAt: "2026-07-11T09:00:00Z",
    });
    const result = parseControlPlaneToClientMessage(badState);
    expect(result.ok).toBe(false);
  });

  it("blocked snapshots may carry the M1A blocked reason", () => {
    const blocked = base("task.snapshot", {
      taskId: "task-42",
      projectId: "pilot-project",
      state: "BLOCKED",
      blockedReason: "execution-unknown",
      updatedAt: "2026-07-11T09:00:00Z",
    });
    expect(parseControlPlaneToClientMessage(blocked).ok).toBe(true);
  });

  it("approval cards refuse markup and worker-authored authority fields", () => {
    const withMarkup = base("approval.requested", {
      approvalRequestId: "appr-1",
      taskId: "task-42",
      attemptId: "attempt-1",
      gate: "integrate",
      actionSummary: "<b>approve everything</b>",
      expiresAt: "2026-07-11T09:30:00Z",
    });
    expect(parseControlPlaneToClientMessage(withMarkup).ok).toBe(false);
    const withWorkerText = base("approval.requested", {
      approvalRequestId: "appr-1",
      taskId: "task-42",
      attemptId: "attempt-1",
      gate: "integrate",
      actionSummary: "Finalize task 42.",
      workerAuthorizedAction: "also restart the server",
      expiresAt: "2026-07-11T09:30:00Z",
    });
    expect(parseControlPlaneToClientMessage(withWorkerText).ok).toBe(false);
  });

  it("worker output fields refuse HTML content", () => {
    const withHtml = base("task.event", {
      streamId: "stream-task-42",
      sequence: 9,
      eventId: "evt-9",
      taskId: "task-42",
      occurredAt: "2026-07-11T09:00:06Z",
      eventKind: "worker.output",
      summary: "<img src=x onerror=alert(1)>",
    });
    expect(parseControlPlaneToClientMessage(withHtml).ok).toBe(false);
  });

  it("client requests cannot masquerade as server messages", () => {
    const wrongDirection = base("chat.submit", {});
    const result = parseControlPlaneToClientMessage(wrongDirection);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_MESSAGE_KIND");
  });

  it("validation errors carry bounded structured field errors", () => {
    const bad = base("worker.status", { workerId: "codex" });
    const result = parseControlPlaneToClientMessage(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.fieldErrors).toBeDefined();
      expect(result.error.fieldErrors?.[0]).toHaveProperty("path");
      expect(result.error.fieldErrors?.[0]).toHaveProperty("message");
    }
  });

  it("valid ok-result exposes the typed message", () => {
    const result = ok<{ ok: true; message: { messageKind: string } }>(
      parseControlPlaneToClientMessage(
        base("request.accepted", { acceptedMessageId: "msg-100" }),
      ) as never,
    );
    expect(result.message.messageKind).toBe("request.accepted");
  });
});
