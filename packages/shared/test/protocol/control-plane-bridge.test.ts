import { describe, expect, it } from "vitest";
import {
  BRIDGE_TO_CONTROL_PLANE_KINDS,
  CONTROL_PLANE_TO_BRIDGE_KINDS,
  CommandAckPayloadSchema,
  CommandResultPayloadSchema,
  MUTATING_BRIDGE_COMMAND_KINDS,
  PROTOCOL_VERSION,
  parseBridgeToControlPlaneMessage,
  parseControlPlaneToBridgeMessage,
} from "../../src/index.js";

const base = (messageKind: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
  protocolVersion: PROTOCOL_VERSION,
  messageId: "cmd-200",
  messageKind,
  sentAt: "2026-07-11T10:00:00Z",
  payload,
  ...extra,
});

const withKey = (messageKind: string, payload: unknown) =>
  base(messageKind, payload, { idempotencyKey: "bridge-cmd-key-01" });

const errCode = (r: ReturnType<typeof parseControlPlaneToBridgeMessage>) => {
  if (r.ok) throw new Error("expected error");
  return r.error.code;
};

const dispatchPayload = () => ({
  projectId: "pilot-project",
  taskId: "task-42",
  attemptId: "attempt-1",
  operationId: "op-disp-1",
  workspaceId: "ws-task-42-a1",
  worker: { manifestId: "codex", manifestVersion: "1.0.0" },
  prompt: { text: "Fix the login timeout in the pilot project.", contextArtifactIds: ["ctx-1"] },
});

describe("control plane → bridge commands", () => {
  it("accepts every command kind", () => {
    const samples: Record<string, unknown> = {
      "bridge.ping": base("bridge.ping", { echo: "ping-1" }),
      "workspace.prepare": withKey("workspace.prepare", {
        projectId: "pilot-project",
        taskId: "task-42",
        attemptId: "attempt-1",
        workspaceId: "ws-task-42-a1",
        baseRef: "a1b2c3d4e5",
        authorizationRef: "authref-001",
      }),
      "worker.dispatch": withKey("worker.dispatch", dispatchPayload()),
      "worker.cancel": withKey("worker.cancel", {
        taskId: "task-42",
        attemptId: "attempt-1",
        operationId: "op-disp-1",
        dispatchCommandId: "cmd-199",
      }),
      "result.collect": withKey("result.collect", {
        taskId: "task-42",
        attemptId: "attempt-1",
        operationId: "op-disp-1",
        workspaceId: "ws-task-42-a1",
      }),
    };
    for (const kind of CONTROL_PLANE_TO_BRIDGE_KINDS) {
      expect(parseControlPlaneToBridgeMessage(samples[kind]).ok, kind).toBe(true);
    }
  });

  it("every mutating bridge command without an idempotency key is rejected", () => {
    const payloads: Record<(typeof MUTATING_BRIDGE_COMMAND_KINDS)[number], unknown> = {
      "workspace.prepare": {
        projectId: "pilot-project",
        taskId: "task-42",
        attemptId: "attempt-1",
        workspaceId: "ws-task-42-a1",
      },
      "worker.dispatch": dispatchPayload(),
      "worker.cancel": {
        taskId: "task-42",
        attemptId: "attempt-1",
        operationId: "op-disp-1",
        dispatchCommandId: "cmd-199",
      },
      "result.collect": {
        taskId: "task-42",
        attemptId: "attempt-1",
        operationId: "op-disp-1",
        workspaceId: "ws-task-42-a1",
      },
    };
    for (const kind of MUTATING_BRIDGE_COMMAND_KINDS) {
      expect(errCode(parseControlPlaneToBridgeMessage(base(kind, payloads[kind]))), kind).toBe(
        "VALIDATION_ERROR",
      );
    }
  });

  it("bridge.ping stays read-only — a supplied key is rejected", () => {
    expect(errCode(parseControlPlaneToBridgeMessage(withKey("bridge.ping", {})))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("raw shell/executable fields are rejected structurally", () => {
    for (const smuggled of [
      { ...dispatchPayload(), shellCommand: "rm -rf /" },
      { ...dispatchPayload(), executable: "cmd.exe" },
      { ...dispatchPayload(), args: ["/c", "del"] },
      { ...dispatchPayload(), cwd: "B:/somewhere" },
      {
        ...dispatchPayload(),
        worker: { manifestId: "codex", manifestVersion: "1.0.0", executablePath: "C:/codex.exe" },
      },
    ]) {
      expect(errCode(parseControlPlaneToBridgeMessage(withKey("worker.dispatch", smuggled)))).toBe(
        "VALIDATION_ERROR",
      );
    }
  });

  it("path-shaped identifiers are rejected: absolute, drive-letter, UNC, traversal", () => {
    for (const workspaceId of [
      "/etc/passwd",
      "C:\\Windows\\System32",
      "C:relative",
      "\\\\server\\share",
      "../parent",
      "..",
      "a/b",
      "a\\b",
    ]) {
      const payload = { ...dispatchPayload(), workspaceId };
      expect(
        errCode(parseControlPlaneToBridgeMessage(withKey("worker.dispatch", payload))),
        workspaceId,
      ).toBe("VALIDATION_ERROR");
    }
  });

  it("dispatch requires a validated manifest reference", () => {
    for (const worker of [
      undefined,
      { manifestId: "Codex", manifestVersion: "1.0.0" },
      { manifestId: "codex", manifestVersion: "latest" },
      { manifestId: "codex" },
    ]) {
      const payload = { ...dispatchPayload(), worker };
      expect(errCode(parseControlPlaneToBridgeMessage(withKey("worker.dispatch", payload)))).toBe(
        "VALIDATION_ERROR",
      );
    }
  });

  it("cancellation must identify the exact operation and originating dispatch", () => {
    const missingOperation = withKey("worker.cancel", {
      taskId: "task-42",
      attemptId: "attempt-1",
      dispatchCommandId: "cmd-199",
    });
    expect(errCode(parseControlPlaneToBridgeMessage(missingOperation))).toBe("VALIDATION_ERROR");
    const missingDispatchRef = withKey("worker.cancel", {
      taskId: "task-42",
      attemptId: "attempt-1",
      operationId: "op-disp-1",
    });
    expect(errCode(parseControlPlaneToBridgeMessage(missingDispatchRef))).toBe("VALIDATION_ERROR");
  });

  it("client requests cannot masquerade as bridge commands", () => {
    expect(errCode(parseControlPlaneToBridgeMessage(withKey("chat.submit", {})))).toBe(
      "UNKNOWN_MESSAGE_KIND",
    );
  });

  it("bridge reports cannot masquerade as bridge commands", () => {
    expect(errCode(parseControlPlaneToBridgeMessage(base("command.result", {})))).toBe(
      "UNKNOWN_MESSAGE_KIND",
    );
  });
});

describe("bridge → control plane reports", () => {
  const resultPayload = () => ({
    commandMessageId: "cmd-200",
    taskId: "task-42",
    attemptId: "attempt-1",
    operationId: "op-disp-1",
    outcome: "succeeded" as const,
    evidenceKinds: ["bridge-execution-report"],
    summary: "Worker finished; 3 files changed.",
    artifactIds: ["artifact-diff-1", "artifact-log-1"],
  });

  it("accepts every report kind", () => {
    const samples: Record<string, unknown> = {
      "bridge.pong": base("bridge.pong", { echo: "ping-1", bridgeVersion: "0.1.0" }),
      "command.ack": base("command.ack", { commandMessageId: "cmd-200", taskId: "task-42" }),
      "command.progress": base("command.progress", {
        commandMessageId: "cmd-200",
        taskId: "task-42",
        attemptId: "attempt-1",
        operationId: "op-disp-1",
        progressSequence: 1,
        note: "Worker started.",
      }),
      "command.result": base("command.result", resultPayload()),
      "command.failed": base("command.failed", {
        commandMessageId: "cmd-200",
        taskId: "task-42",
        attemptId: "attempt-1",
        operationId: "op-disp-1",
        outcome: "failed",
        failureReason: "timeout",
        summary: "Worker exceeded the manifest timeout and was terminated.",
      }),
      "bridge.health": base("bridge.health", {
        status: "ok",
        activeOperationIds: ["op-disp-1"],
        queuedCount: 0,
        reportedAt: "2026-07-11T10:00:30Z",
      }),
    };
    for (const kind of BRIDGE_TO_CONTROL_PLANE_KINDS) {
      expect(parseBridgeToControlPlaneMessage(samples[kind]).ok, kind).toBe(true);
    }
  });

  it("reports must reference the originating command", () => {
    const { commandMessageId: _omit, ...withoutOrigin } = resultPayload();
    expect(
      parseBridgeToControlPlaneMessage(base("command.result", withoutOrigin)).ok,
    ).toBe(false);
  });

  it("final reports identify task, attempt, and operation", () => {
    const { operationId: _omit, ...withoutOperation } = resultPayload();
    expect(
      parseBridgeToControlPlaneMessage(base("command.result", withoutOperation)).ok,
    ).toBe(false);
  });

  it("an acknowledgement cannot satisfy the final-result schema", () => {
    const ack = { commandMessageId: "cmd-200", taskId: "task-42" };
    expect(CommandAckPayloadSchema.safeParse(ack).success).toBe(true);
    expect(CommandResultPayloadSchema.safeParse(ack).success).toBe(false);
  });

  it("a progress report cannot satisfy the final-result schema", () => {
    const progress = {
      commandMessageId: "cmd-200",
      taskId: "task-42",
      attemptId: "attempt-1",
      operationId: "op-disp-1",
      progressSequence: 3,
    };
    expect(CommandResultPayloadSchema.safeParse(progress).success).toBe(false);
    const smuggledOutcome = { ...progress, outcome: "succeeded" };
    expect(
      parseBridgeToControlPlaneMessage(base("command.progress", smuggledOutcome)).ok,
    ).toBe(false);
  });

  it("result evidence aligns with the M1A evidence vocabulary", () => {
    const badEvidence = { ...resultPayload(), evidenceKinds: ["pinky-promise"] };
    expect(parseBridgeToControlPlaneMessage(base("command.result", badEvidence)).ok).toBe(false);
    const emptyEvidence = { ...resultPayload(), evidenceKinds: [] };
    expect(parseBridgeToControlPlaneMessage(base("command.result", emptyEvidence)).ok).toBe(false);
  });

  it("large output must go to artifacts — oversized inline summaries are rejected", () => {
    const oversized = { ...resultPayload(), summary: "x".repeat(8_001) };
    expect(parseBridgeToControlPlaneMessage(base("command.result", oversized)).ok).toBe(false);
  });

  it("raw stdout-like fields are rejected", () => {
    const withStdout = { ...resultPayload(), stdout: "PASSWORD=hunter2" };
    expect(parseBridgeToControlPlaneMessage(base("command.result", withStdout)).ok).toBe(false);
  });

  it("failure summaries refuse stack traces and local paths", () => {
    const withStack = {
      commandMessageId: "cmd-200",
      taskId: "task-42",
      attemptId: "attempt-1",
      operationId: "op-disp-1",
      outcome: "failed",
      failureReason: "crash",
      summary: "Error: boom\n    at Object.run (bridge.js:10:5)",
    };
    expect(parseBridgeToControlPlaneMessage(base("command.failed", withStack)).ok).toBe(false);
  });

  it("bridge commands cannot masquerade as bridge reports", () => {
    const wrongDirection = base("worker.dispatch", dispatchPayload());
    const result = parseBridgeToControlPlaneMessage(wrongDirection);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_MESSAGE_KIND");
  });
});
