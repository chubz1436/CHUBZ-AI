import { describe, expect, it } from "vitest";
import {
  BRIDGE_TO_CONTROL_PLANE_KINDS,
  CONTROL_PLANE_TO_BRIDGE_KINDS,
  CommandAckPayloadSchema,
  CommandResultPayloadSchema,
  ControlPlaneToBridgeMessageSchema,
  BridgeToControlPlaneMessageSchema,
  MUTATING_BRIDGE_COMMAND_KINDS,
  PROTOCOL_VERSION,
  parseBridgeToControlPlaneMessage,
  parseControlPlaneToBridgeMessage,
  validateBridgeReportAgainstCommand,
  type BridgeToControlPlaneMessage,
  type ControlPlaneToBridgeMessage,
} from "../../src/index.js";

const base = (messageKind: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
  protocolVersion: PROTOCOL_VERSION,
  messageId: "cmd-200",
  messageKind,
  sentAt: "2026-07-11T10:00:00Z",
  payload,
  ...extra,
});

const withKey = (messageKind: string, payload: unknown, extra: Record<string, unknown> = {}) =>
  base(messageKind, payload, { idempotencyKey: "bridge-cmd-key-01", ...extra });

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

const preparePayload = () => ({
  projectId: "pilot-project",
  taskId: "task-42",
  attemptId: "attempt-1",
  operationId: "op-prep-1",
  workspaceId: "ws-task-42-a1",
  baseRef: "a1b2c3d4e5",
  authorizationRef: "authref-001",
});

const dispatchCommand = (): ControlPlaneToBridgeMessage =>
  ControlPlaneToBridgeMessageSchema.parse(withKey("worker.dispatch", dispatchPayload()));

const dispatchResultPayload = () => ({
  commandMessageId: "cmd-200",
  taskId: "task-42",
  attemptId: "attempt-1",
  operationId: "op-disp-1",
  outcome: "succeeded" as const,
  report: {
    commandKind: "worker.dispatch" as const,
    workspaceId: "ws-task-42-a1",
    summary: "Worker finished; 3 files changed.",
    artifactIds: ["artifact-diff-1", "artifact-log-1"],
  },
});

const report = (messageKind: string, payload: unknown, extra: Record<string, unknown> = {}) =>
  base(messageKind, payload, { messageId: "rpt-300", ...extra });

const parsedReport = (messageKind: string, payload: unknown): BridgeToControlPlaneMessage =>
  BridgeToControlPlaneMessageSchema.parse(report(messageKind, payload));

describe("control plane → bridge commands", () => {
  it("accepts every command kind", () => {
    const samples: Record<string, unknown> = {
      "bridge.ping": base("bridge.ping", { echo: "ping-1" }),
      "workspace.prepare": withKey("workspace.prepare", preparePayload()),
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
        operationId: "op-coll-1",
        workspaceId: "ws-task-42-a1",
      }),
    };
    for (const kind of CONTROL_PLANE_TO_BRIDGE_KINDS) {
      expect(parseControlPlaneToBridgeMessage(samples[kind]).ok, kind).toBe(true);
    }
  });

  it("workspace.prepare requires an explicit operation ID", () => {
    const { operationId: _omit, ...withoutOperation } = preparePayload();
    expect(
      errCode(parseControlPlaneToBridgeMessage(withKey("workspace.prepare", withoutOperation))),
    ).toBe("VALIDATION_ERROR");
  });

  it("every mutating bridge command without an idempotency key is rejected", () => {
    const payloads: Record<(typeof MUTATING_BRIDGE_COMMAND_KINDS)[number], unknown> = {
      "workspace.prepare": preparePayload(),
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
        operationId: "op-coll-1",
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
      "a/b",
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

  it("envelope/payload identity contradictions are rejected", () => {
    const contradictingTask = withKey("worker.dispatch", dispatchPayload(), {
      taskId: "task-99",
    });
    expect(errCode(parseControlPlaneToBridgeMessage(contradictingTask))).toBe("VALIDATION_ERROR");
    const consistent = withKey("worker.dispatch", dispatchPayload(), {
      taskId: "task-42",
      attemptId: "attempt-1",
      projectId: "pilot-project",
    });
    expect(parseControlPlaneToBridgeMessage(consistent).ok).toBe(true);
  });

  it("client requests cannot masquerade as bridge commands", () => {
    expect(errCode(parseControlPlaneToBridgeMessage(withKey("chat.submit", {})))).toBe(
      "UNKNOWN_MESSAGE_KIND",
    );
  });
});

describe("bridge → control plane reports", () => {
  it("accepts every report kind", () => {
    const samples: Record<string, unknown> = {
      "bridge.pong": report("bridge.pong", { echo: "ping-1", bridgeVersion: "0.1.0" }),
      "command.ack": report("command.ack", { commandMessageId: "cmd-200", taskId: "task-42" }),
      "command.progress": report("command.progress", {
        commandMessageId: "cmd-200",
        taskId: "task-42",
        attemptId: "attempt-1",
        operationId: "op-disp-1",
        progressSequence: 1,
        note: "Worker started.",
      }),
      "command.result": report("command.result", dispatchResultPayload()),
      "command.failed": report("command.failed", {
        commandMessageId: "cmd-200",
        taskId: "task-42",
        attemptId: "attempt-1",
        operationId: "op-disp-1",
        outcome: "failed",
        commandKind: "worker.dispatch",
        failureReason: "timeout",
        summary: "Worker exceeded the manifest timeout and was terminated.",
      }),
      "bridge.health": report("bridge.health", {
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

  it("the bridge cannot claim owner-reconciliation or grant-verified — no evidence field exists", () => {
    for (const smuggled of [
      { ...dispatchResultPayload(), evidenceKinds: ["owner-reconciliation"] },
      { ...dispatchResultPayload(), evidenceKinds: ["grant-verified"] },
      { ...dispatchResultPayload(), evidence: ["bridge-integration-report"] },
      { ...dispatchResultPayload(), ownerReconciliation: true },
      { ...dispatchResultPayload(), grantVerified: true },
    ]) {
      expect(parseBridgeToControlPlaneMessage(report("command.result", smuggled)).ok).toBe(false);
    }
  });

  it("failed reports cannot carry arbitrary evidence arrays", () => {
    const failed = {
      commandMessageId: "cmd-200",
      taskId: "task-42",
      attemptId: "attempt-1",
      operationId: "op-disp-1",
      outcome: "failed",
      commandKind: "worker.dispatch",
      failureReason: "crash",
      summary: "Worker crashed.",
      evidenceKinds: ["grant-verified"],
    };
    expect(parseBridgeToControlPlaneMessage(report("command.failed", failed)).ok).toBe(false);
  });

  it("reports cannot invent or change an authorization reference", () => {
    const withAuth = { ...dispatchResultPayload(), authorizationRef: "authref-forged" };
    expect(parseBridgeToControlPlaneMessage(report("command.result", withAuth)).ok).toBe(false);
    const nestedAuth = {
      ...dispatchResultPayload(),
      report: { ...dispatchResultPayload().report, authorizationRef: "authref-forged" },
    };
    expect(parseBridgeToControlPlaneMessage(report("command.result", nestedAuth)).ok).toBe(false);
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
    expect(
      parseBridgeToControlPlaneMessage(
        report("command.progress", { ...progress, outcome: "succeeded" }),
      ).ok,
    ).toBe(false);
  });

  it("large output must go to artifacts — oversized inline summaries are rejected", () => {
    const oversized = {
      ...dispatchResultPayload(),
      report: { ...dispatchResultPayload().report, summary: "x".repeat(8_001) },
    };
    expect(parseBridgeToControlPlaneMessage(report("command.result", oversized)).ok).toBe(false);
  });

  it("raw stdout-like fields are rejected", () => {
    const withStdout = { ...dispatchResultPayload(), stdout: "PASSWORD=hunter2" };
    expect(parseBridgeToControlPlaneMessage(report("command.result", withStdout)).ok).toBe(false);
  });

  it("bridge commands cannot masquerade as bridge reports", () => {
    const wrongDirection = report("worker.dispatch", dispatchPayload());
    const result = parseBridgeToControlPlaneMessage(wrongDirection);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_MESSAGE_KIND");
  });
});

describe("command/report binding validator (R1)", () => {
  const bindErr = (r: ReturnType<typeof validateBridgeReportAgainstCommand>) => {
    if (r.ok) throw new Error("expected binding error");
    return r.code;
  };

  it("binds a correct dispatch result as final-success", () => {
    const binding = validateBridgeReportAgainstCommand(
      dispatchCommand(),
      parsedReport("command.result", dispatchResultPayload()),
    );
    expect(binding).toEqual({ ok: true, reportClass: "final-success" });
  });

  it("classifies ack, progress, and failure distinctly from final success", () => {
    expect(
      validateBridgeReportAgainstCommand(
        dispatchCommand(),
        parsedReport("command.ack", { commandMessageId: "cmd-200", taskId: "task-42" }),
      ),
    ).toEqual({ ok: true, reportClass: "ack" });
    expect(
      validateBridgeReportAgainstCommand(
        dispatchCommand(),
        parsedReport("command.progress", {
          commandMessageId: "cmd-200",
          taskId: "task-42",
          attemptId: "attempt-1",
          operationId: "op-disp-1",
          progressSequence: 2,
        }),
      ),
    ).toEqual({ ok: true, reportClass: "progress" });
    expect(
      validateBridgeReportAgainstCommand(
        dispatchCommand(),
        parsedReport("command.failed", {
          commandMessageId: "cmd-200",
          taskId: "task-42",
          attemptId: "attempt-1",
          operationId: "op-disp-1",
          outcome: "failed",
          commandKind: "worker.dispatch",
          failureReason: "crash",
          summary: "Worker crashed.",
        }),
      ),
    ).toEqual({ ok: true, reportClass: "final-failure" });
  });

  it("a workspace result cannot answer a dispatch command (kind pairing)", () => {
    const workspaceResult = parsedReport("command.result", {
      commandMessageId: "cmd-200",
      taskId: "task-42",
      attemptId: "attempt-1",
      operationId: "op-disp-1",
      outcome: "succeeded",
      report: {
        commandKind: "workspace.prepare",
        workspaceId: "ws-task-42-a1",
        baseResolution: { kind: "not-requested" },
      },
    });
    expect(bindErr(validateBridgeReportAgainstCommand(dispatchCommand(), workspaceResult))).toBe(
      "REPORT_KIND_MISMATCH",
    );
  });

  it("a failed report with the wrong command kind is rejected", () => {
    const failed = parsedReport("command.failed", {
      commandMessageId: "cmd-200",
      taskId: "task-42",
      attemptId: "attempt-1",
      operationId: "op-disp-1",
      outcome: "failed",
      commandKind: "result.collect",
      failureReason: "internal",
      summary: "Collection failed.",
    });
    expect(bindErr(validateBridgeReportAgainstCommand(dispatchCommand(), failed))).toBe(
      "REPORT_KIND_MISMATCH",
    );
  });

  it("the wrong originating command ID is rejected", () => {
    const wrongOrigin = parsedReport("command.result", {
      ...dispatchResultPayload(),
      commandMessageId: "cmd-999",
    });
    expect(bindErr(validateBridgeReportAgainstCommand(dispatchCommand(), wrongOrigin))).toBe(
      "REPORT_COMMAND_MISMATCH",
    );
  });

  it("task, attempt, and operation mismatches are rejected", () => {
    expect(
      bindErr(
        validateBridgeReportAgainstCommand(
          dispatchCommand(),
          parsedReport("command.result", { ...dispatchResultPayload(), taskId: "task-99" }),
        ),
      ),
    ).toBe("TASK_MISMATCH");
    expect(
      bindErr(
        validateBridgeReportAgainstCommand(
          dispatchCommand(),
          parsedReport("command.result", { ...dispatchResultPayload(), attemptId: "attempt-9" }),
        ),
      ),
    ).toBe("ATTEMPT_MISMATCH");
    expect(
      bindErr(
        validateBridgeReportAgainstCommand(
          dispatchCommand(),
          parsedReport("command.result", { ...dispatchResultPayload(), operationId: "op-other" }),
        ),
      ),
    ).toBe("OPERATION_MISMATCH");
  });

  it("workspace identity must match where applicable", () => {
    const wrongWorkspace = parsedReport("command.result", {
      ...dispatchResultPayload(),
      report: { ...dispatchResultPayload().report, workspaceId: "ws-other" },
    });
    expect(bindErr(validateBridgeReportAgainstCommand(dispatchCommand(), wrongWorkspace))).toBe(
      "WORKSPACE_MISMATCH",
    );
  });

  it("a cancellation may only claim the commanded operation", () => {
    const cancelCommand = ControlPlaneToBridgeMessageSchema.parse(
      withKey("worker.cancel", {
        taskId: "task-42",
        attemptId: "attempt-1",
        operationId: "op-disp-1",
        dispatchCommandId: "cmd-199",
      }),
    );
    const wrongTermination = parsedReport("command.result", {
      commandMessageId: "cmd-200",
      taskId: "task-42",
      attemptId: "attempt-1",
      operationId: "op-disp-1",
      outcome: "succeeded",
      report: { commandKind: "worker.cancel", terminatedOperationId: "op-other" },
    });
    expect(bindErr(validateBridgeReportAgainstCommand(cancelCommand, wrongTermination))).toBe(
      "OPERATION_MISMATCH",
    );
    const correctTermination = parsedReport("command.result", {
      commandMessageId: "cmd-200",
      taskId: "task-42",
      attemptId: "attempt-1",
      operationId: "op-disp-1",
      outcome: "succeeded",
      report: { commandKind: "worker.cancel", terminatedOperationId: "op-disp-1" },
    });
    expect(
      validateBridgeReportAgainstCommand(cancelCommand, correctTermination),
    ).toEqual({ ok: true, reportClass: "final-success" });
  });

  it("regression: payload-borne project identity is authoritative even when the command envelope omits it", () => {
    // Command envelope has NO projectId; the payload carries project-a.
    const command = ControlPlaneToBridgeMessageSchema.parse(
      withKey("worker.dispatch", { ...dispatchPayload(), projectId: "project-a" }),
    );
    const claimsProjectB = BridgeToControlPlaneMessageSchema.parse(
      report("command.result", dispatchResultPayload(), { projectId: "project-b" }),
    );
    expect(bindErr(validateBridgeReportAgainstCommand(command, claimsProjectB))).toBe(
      "PROJECT_MISMATCH",
    );
    // Matching report project is accepted.
    const claimsProjectA = BridgeToControlPlaneMessageSchema.parse(
      report("command.result", dispatchResultPayload(), { projectId: "project-a" }),
    );
    expect(validateBridgeReportAgainstCommand(command, claimsProjectA)).toEqual({
      ok: true,
      reportClass: "final-success",
    });
    // A report that omits the project entirely remains acceptable.
    const omitsProject = parsedReport("command.result", dispatchResultPayload());
    expect(validateBridgeReportAgainstCommand(command, omitsProject)).toEqual({
      ok: true,
      reportClass: "final-success",
    });
  });

  describe("workspace base-ref provenance", () => {
    const prepareCommand = (baseRef?: string) =>
      ControlPlaneToBridgeMessageSchema.parse(
        withKey("workspace.prepare", {
          projectId: "pilot-project",
          taskId: "task-42",
          attemptId: "attempt-1",
          operationId: "op-prep-1",
          workspaceId: "ws-task-42-a1",
          ...(baseRef !== undefined ? { baseRef } : {}),
        }),
      );
    const prepareResult = (baseResolution: unknown) =>
      parsedReport("command.result", {
        commandMessageId: "cmd-200",
        taskId: "task-42",
        attemptId: "attempt-1",
        operationId: "op-prep-1",
        outcome: "succeeded",
        report: {
          commandKind: "workspace.prepare",
          workspaceId: "ws-task-42-a1",
          baseResolution,
        },
      });

    it("a resolved base naming the commanded ref and an immutable commit is accepted", () => {
      expect(
        validateBridgeReportAgainstCommand(
          prepareCommand("a1b2c3d4e5"),
          prepareResult({
            kind: "resolved",
            requestedRef: "a1b2c3d4e5",
            resolvedCommitId: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
          }),
        ),
      ).toEqual({ ok: true, reportClass: "final-success" });
    });

    it("not-requested is accepted only when the command requested no base", () => {
      expect(
        validateBridgeReportAgainstCommand(
          prepareCommand(),
          prepareResult({ kind: "not-requested" }),
        ),
      ).toEqual({ ok: true, reportClass: "final-success" });
      expect(
        bindErr(
          validateBridgeReportAgainstCommand(
            prepareCommand("a1b2c3d4e5"),
            prepareResult({ kind: "not-requested" }),
          ),
        ),
      ).toBe("BASE_REF_MODE_MISMATCH");
    });

    it("resolving a ref that was never requested is rejected", () => {
      expect(
        bindErr(
          validateBridgeReportAgainstCommand(
            prepareCommand(),
            prepareResult({
              kind: "resolved",
              requestedRef: "a1b2c3d4e5",
              resolvedCommitId: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
            }),
          ),
        ),
      ).toBe("BASE_REF_MODE_MISMATCH");
    });

    it("resolving a different ref than commanded is rejected", () => {
      expect(
        bindErr(
          validateBridgeReportAgainstCommand(
            prepareCommand("a1b2c3d4e5"),
            prepareResult({
              kind: "resolved",
              requestedRef: "other-ref-1",
              resolvedCommitId: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
            }),
          ),
        ),
      ).toBe("REQUESTED_BASE_REF_MISMATCH");
    });

    it("full 40- and 64-character lowercase commits are accepted", () => {
      for (const resolvedCommitId of ["ab".repeat(20), "ab".repeat(32)]) {
        expect(
          validateBridgeReportAgainstCommand(
            prepareCommand("main"),
            prepareResult({ kind: "resolved", requestedRef: "main", resolvedCommitId }),
          ),
          `${resolvedCommitId.length} chars`,
        ).toEqual({ ok: true, reportClass: "final-success" });
      }
    });

    it("a symbolic ref must be echoed exactly but may resolve to any full commit", () => {
      expect(
        validateBridgeReportAgainstCommand(
          prepareCommand("main"),
          prepareResult({
            kind: "resolved",
            requestedRef: "main",
            resolvedCommitId: "cd".repeat(20),
          }),
        ),
      ).toEqual({ ok: true, reportClass: "final-success" });
    });

    it("an immutable 40-character request must resolve to exactly itself", () => {
      const pinned = "ab".repeat(20);
      expect(
        validateBridgeReportAgainstCommand(
          prepareCommand(pinned),
          prepareResult({ kind: "resolved", requestedRef: pinned, resolvedCommitId: pinned }),
        ),
      ).toEqual({ ok: true, reportClass: "final-success" });
      expect(
        bindErr(
          validateBridgeReportAgainstCommand(
            prepareCommand(pinned),
            prepareResult({
              kind: "resolved",
              requestedRef: pinned,
              resolvedCommitId: "cd".repeat(20),
            }),
          ),
        ),
      ).toBe("RESOLVED_COMMIT_MISMATCH");
    });

    it("an immutable 64-character request must resolve to exactly itself", () => {
      const pinned = "ab".repeat(32);
      expect(
        validateBridgeReportAgainstCommand(
          prepareCommand(pinned),
          prepareResult({ kind: "resolved", requestedRef: pinned, resolvedCommitId: pinned }),
        ),
      ).toEqual({ ok: true, reportClass: "final-success" });
      expect(
        bindErr(
          validateBridgeReportAgainstCommand(
            prepareCommand(pinned),
            prepareResult({
              kind: "resolved",
              requestedRef: pinned,
              resolvedCommitId: "cd".repeat(32),
            }),
          ),
        ),
      ).toBe("RESOLVED_COMMIT_MISMATCH");
    });

    it("an uppercase immutable request is classified case-insensitively and normalized", () => {
      const pinnedUpper = "AB".repeat(20);
      expect(
        validateBridgeReportAgainstCommand(
          prepareCommand(pinnedUpper),
          prepareResult({
            kind: "resolved",
            requestedRef: pinnedUpper,
            resolvedCommitId: "ab".repeat(20),
          }),
        ),
      ).toEqual({ ok: true, reportClass: "final-success" });
      expect(
        bindErr(
          validateBridgeReportAgainstCommand(
            prepareCommand(pinnedUpper),
            prepareResult({
              kind: "resolved",
              requestedRef: pinnedUpper,
              resolvedCommitId: "cd".repeat(20),
            }),
          ),
        ),
      ).toBe("RESOLVED_COMMIT_MISMATCH");
    });

    it("abbreviated and invalid commit lengths are rejected by the schema", () => {
      for (const resolvedCommitId of [
        "a".repeat(7),
        "a".repeat(12),
        "a".repeat(39),
        "a".repeat(41),
        "a".repeat(63),
        "a".repeat(65),
      ]) {
        expect(
          parseBridgeToControlPlaneMessage(
            report("command.result", {
              commandMessageId: "cmd-200",
              taskId: "task-42",
              attemptId: "attempt-1",
              operationId: "op-prep-1",
              outcome: "succeeded",
              report: {
                commandKind: "workspace.prepare",
                workspaceId: "ws-task-42-a1",
                baseResolution: { kind: "resolved", requestedRef: "main", resolvedCommitId },
              },
            }),
          ).ok,
          `${resolvedCommitId.length} chars`,
        ).toBe(false);
      }
    });

    it("the resolved commit must be an immutable lowercase hex id", () => {
      for (const resolvedCommitId of ["MAIN", "A1B2C3D4E5", "abc12", "refs-heads-main"]) {
        expect(
          parseBridgeToControlPlaneMessage(
            report("command.result", {
              commandMessageId: "cmd-200",
              taskId: "task-42",
              attemptId: "attempt-1",
              operationId: "op-prep-1",
              outcome: "succeeded",
              report: {
                commandKind: "workspace.prepare",
                workspaceId: "ws-task-42-a1",
                baseResolution: { kind: "resolved", requestedRef: "a1b2c3d4e5", resolvedCommitId },
              },
            }),
          ).ok,
          resolvedCommitId,
        ).toBe(false);
      }
    });

    it("the old ambiguous resolvedBaseRef field is no longer representable", () => {
      expect(
        parseBridgeToControlPlaneMessage(
          report("command.result", {
            commandMessageId: "cmd-200",
            taskId: "task-42",
            attemptId: "attempt-1",
            operationId: "op-prep-1",
            outcome: "succeeded",
            report: {
              commandKind: "workspace.prepare",
              workspaceId: "ws-task-42-a1",
              resolvedBaseRef: "a1b2c3d4e5",
            },
          }),
        ).ok,
      ).toBe(false);
    });
  });

  it("project identity must match when both envelopes carry it", () => {
    const command = ControlPlaneToBridgeMessageSchema.parse(
      withKey("worker.dispatch", dispatchPayload(), { projectId: "pilot-project" }),
    );
    const wrongProject = BridgeToControlPlaneMessageSchema.parse(
      report("command.result", dispatchResultPayload(), { projectId: "other-project" }),
    );
    expect(bindErr(validateBridgeReportAgainstCommand(command, wrongProject))).toBe(
      "PROJECT_MISMATCH",
    );
  });

  it("pings are not reportable and pong/health are not command reports", () => {
    const ping = ControlPlaneToBridgeMessageSchema.parse(base("bridge.ping", { echo: "ping-1" }));
    const result = parsedReport("command.result", dispatchResultPayload());
    expect(bindErr(validateBridgeReportAgainstCommand(ping, result))).toBe(
      "COMMAND_NOT_REPORTABLE",
    );
    const pong = parsedReport("bridge.pong", { echo: "ping-1" });
    expect(bindErr(validateBridgeReportAgainstCommand(dispatchCommand(), pong))).toBe(
      "UNSUPPORTED_REPORT_KIND",
    );
  });
});
