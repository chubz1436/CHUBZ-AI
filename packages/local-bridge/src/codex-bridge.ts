import { createHash } from "node:crypto";
import {
  detectRedactions,
  digestApprovalAction,
  evaluateLease,
  parseAssignment,
  redactText,
  verifyCapabilityGrant,
  verifyWriteScope,
  type GrantAuthenticationVerifier,
} from "@chubz/shared";
import type { CodexDispatchCommand } from "@chubz/control-plane";
import { buildCodexInvocationArgs, CodexCliAdapter, isBoundedFallbackEvidence, type CodexAdapterOutcome } from "./codex-adapter.js";
import type { CodexProbeEvidence, WindowsSandboxImplementation } from "./adapter-registry.js";
import { EvidenceCaptureService, type ReviewCaptureRequest } from "./evidence-capture.js";
import { OperationJournal } from "./journal.js";

const WORKER_ID = "codex-cli" as const;
const ADAPTER_ID = "codex-cli-adapter" as const;
const VERIFIER_ID = "local-bridge" as const;
const sha256 = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
};
const approvalIdFor = (input: Readonly<{ ownerId: string; taskId: string; attemptId: string; operationId: string; actionDigest: string; scopeHash: string; workerId: string; adapterId: string }>): string =>
  `approval-${createHash("sha256").update(`chubz.m4.approval-binding/v1\n${canonical(input)}`, "utf8").digest("hex")}`;
const sanitize = (value: string): string => {
  const bounded = Buffer.from(value).subarray(0, 48 * 1024).toString("utf8");
  const findings = detectRedactions(bounded); if (!findings.ok) return "[redacted]";
  const redacted = redactText(bounded, findings.value); return redacted.ok ? redacted.value.text : "[redacted]";
};

export type CodexExecutionContext = Readonly<{
  executablePath: string;
  worktreePath: string;
  managedWorktreeRoot: string;
  codexHome: string;
  managedDataRoot: string;
  outputSchemaPath: string;
  provenance: CodexProbeEvidence;
  windowsSandboxImplementation: WindowsSandboxImplementation;
  reviewCapture?: Readonly<{
    service: EvidenceCaptureService;
    captureId: string;
    managedClonePath: string;
    managedCloneRoot: string;
    packageRoot: string;
  }>;
}>;
export type CodexBridgeResult = Readonly<{
  operationId: string;
  state: "completed" | "failed" | "cancelled" | "execution-unknown";
  output: string;
  outputTruncated: boolean;
  failureCode: string | null;
  journalRef: string;
  resultRef: string;
  adapterOutcome: CodexAdapterOutcome | null;
  reviewPackage: Readonly<{ captureId: string; packageId: string | null; status: "captured" | "incomplete" | "quarantined" | "failed"; packageDigest: string | null; manifestDigest: string | null }> | null;
}>;
export type CodexBridgeOptions = Readonly<{ signal?: AbortSignal; onStarted?: () => Promise<void> | void; failpoint?: "after-journal-before-start" | "after-start-before-execution" }>;

export class CodexBridge {
  private readonly inFlight = new Map<string, Readonly<{ digest: string; promise: Promise<CodexBridgeResult> }>>();
  private closed = false;
  public constructor(
    private readonly journal: OperationJournal,
    private readonly verifier: GrantAuthenticationVerifier,
    private readonly adapter: CodexCliAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private assertOpen(): void { if (this.closed) throw new Error("Codex bridge is closed"); }
  public close(): void {
    this.assertOpen();
    if (this.inFlight.size !== 0) throw new Error("Codex bridge cannot close while work is in flight");
    this.journal.close(); this.closed = true;
  }

  public registerAuthorization(command: CodexDispatchCommand): "registered" | "duplicate" {
    this.assertOpen();
    const actionDigest = digestApprovalAction(command.action); if (!actionDigest.ok) throw new Error("invalid approval action");
    const approvalId = approvalIdFor({ ownerId: command.ownerId, taskId: command.taskId, attemptId: command.attemptId, operationId: command.operationId, actionDigest: actionDigest.value, scopeHash: command.writeScope.scopeHash, workerId: command.workerId, adapterId: command.adapterId });
    if (command.grant.approval.approvalId !== approvalId) throw new Error("grant approval binding mismatch");
    return this.journal.registerGrantAuthorization({ grantId: command.grant.grantId, approvalId, ownerId: command.ownerId, taskId: command.taskId, attemptId: command.attemptId, operationId: command.operationId, workerId: command.workerId, adapterId: command.adapterId, scopeHash: command.writeScope.scopeHash, actionDigest: actionDigest.value });
  }

  private verify(command: CodexDispatchCommand, context: CodexExecutionContext): Readonly<{ actionDigest: `sha256:${string}`; commandDigest: string }> {
    if (command.workerId !== WORKER_ID || command.adapterId !== ADAPTER_ID || command.action.operation !== "worker.dispatch" || command.action.target.resourceId !== WORKER_ID || command.action.parameters.worker.manifestId !== WORKER_ID || command.action.parameters.worker.manifestVersion !== "1.0.0") throw new Error("dispatch rejected (WORKER_NOT_PERMITTED)");
    const actionDigest = digestApprovalAction(command.action); if (!actionDigest.ok) throw new Error("dispatch rejected (MALFORMED_ACTION)");
    if (command.action.taskId !== command.taskId || command.action.attemptId !== command.attemptId || command.action.operationId !== command.operationId || command.action.parameters.projectId !== command.projectId || command.action.parameters.instructionDigest !== sha256(command.taskInput)) throw new Error("dispatch rejected (ACTION_BINDING_MISMATCH)");
    if (!verifyWriteScope(command.writeScope).ok || command.writeScope.taskId !== command.taskId || command.writeScope.attemptId !== command.attemptId || command.writeScope.operationId !== command.operationId) throw new Error("dispatch rejected (SCOPE_MISMATCH)");
    const assignment = parseAssignment(command.assignment);
    if (!assignment.ok || assignment.value.kind !== "dispatched" || assignment.value.taskId !== command.taskId || assignment.value.attemptId !== command.attemptId || assignment.value.operationId !== command.operationId || assignment.value.workerId !== WORKER_ID || assignment.value.adapterId !== ADAPTER_ID || assignment.value.writeScopeRef !== command.writeScope.scopeId || assignment.value.approvalGrantRef !== command.grant.grantId || assignment.value.readinessSnapshotRef !== command.readiness.readinessId) throw new Error("dispatch rejected (ASSIGNMENT_MISMATCH)");
    if ((command.readiness.readinessState !== "ready" && !isBoundedFallbackEvidence(command.readiness, context.provenance)) || command.readiness.freezeState !== "enabled") throw new Error("dispatch rejected (READINESS_NOT_ELIGIBLE)");
    if (context.windowsSandboxImplementation !== context.provenance.windowsSandbox.selectedImplementation) throw new Error("dispatch rejected (SANDBOX_IMPLEMENTATION_MISMATCH)");
    const at = this.now().toISOString();
    const lease = evaluateLease(command.lease, { taskId: command.taskId, attemptId: command.attemptId, operationId: command.operationId, workerId: WORKER_ID, adapterId: ADAPTER_ID, now: at, generation: command.lease.renewalGeneration, action: "use" });
    if (!lease.ok || command.lease.resourceId !== command.writeScope.scopeId) throw new Error(`dispatch rejected (LEASE_${lease.code})`);
    const grant = verifyCapabilityGrant(command.grant, { actionDigest: actionDigest.value, taskId: command.taskId, attemptId: command.attemptId, operationId: command.operationId, intendedVerifier: VERIFIER_ID, now: at }, this.verifier);
    if (!grant.ok) throw new Error(`dispatch rejected (GRANT_${grant.code})`);
    const expectedApproval = approvalIdFor({ ownerId: command.ownerId, taskId: command.taskId, attemptId: command.attemptId, operationId: command.operationId, actionDigest: actionDigest.value, scopeHash: command.writeScope.scopeHash, workerId: WORKER_ID, adapterId: ADAPTER_ID });
    if (command.grant.approval.approvalId !== expectedApproval) throw new Error("dispatch rejected (APPROVAL_BINDING_MISMATCH)");
    const commandDigest = sha256(canonical({ commandId: command.commandId, taskId: command.taskId, attemptId: command.attemptId, operationId: command.operationId, projectId: command.projectId, ownerId: command.ownerId, workerId: command.workerId, adapterId: command.adapterId, actionDigest: actionDigest.value, taskInputDigest: sha256(command.taskInput), assignment: command.assignment, lease: command.lease, writeScope: command.writeScope, grant: command.grant, readinessId: command.readiness.readinessId, executableHash: context.provenance.executableSha256, windowsSandboxImplementation: context.windowsSandboxImplementation, worktreePath: context.worktreePath, codexHome: context.codexHome, outputSchemaPath: context.outputSchemaPath }));
    return Object.freeze({ actionDigest: actionDigest.value as `sha256:${string}`, commandDigest });
  }

  public execute(command: CodexDispatchCommand, context: CodexExecutionContext, options: CodexBridgeOptions = {}): Promise<CodexBridgeResult> {
    try { this.assertOpen(); } catch (error) { return Promise.reject(error); }
    let verified: ReturnType<CodexBridge["verify"]>;
    try { verified = this.verify(command, context); } catch (error) { return Promise.reject(error); }
    const existing = this.inFlight.get(command.operationId);
    if (existing) return existing.digest === verified.commandDigest ? existing.promise : Promise.reject(new Error("dispatch idempotency conflict"));
    const promise = this.executeOnce(command, context, verified, options).finally(() => this.inFlight.delete(command.operationId));
    this.inFlight.set(command.operationId, Object.freeze({ digest: verified.commandDigest, promise }));
    return promise;
  }

  private async executeOnce(command: CodexDispatchCommand, context: CodexExecutionContext, verified: Readonly<{ actionDigest: `sha256:${string}`; commandDigest: string }>, options: CodexBridgeOptions): Promise<CodexBridgeResult> {
    const claim = this.journal.claimGrantedOperation({ grantId: command.grant.grantId, approvalId: command.grant.approval.approvalId, ownerId: command.ownerId, taskId: command.taskId, attemptId: command.attemptId, operationId: command.operationId, workerId: command.workerId, adapterId: command.adapterId, scopeHash: command.writeScope.scopeHash, actionDigest: verified.actionDigest, commandDigest: verified.commandDigest });
    if (claim.classification === "replay" && claim.result !== undefined) return Object.freeze({ ...(claim.result as Omit<CodexBridgeResult, "adapterOutcome">), adapterOutcome: null });
    if (claim.classification === "execution-unknown" || claim.classification === "in-progress") return this.unknown(command, claim.record.journalEntryId);
    if (options.failpoint === "after-journal-before-start") throw new Error("injected failure after journal preparation");
    const started = this.journal.startGrantedOperation(command.operationId);
    if (options.failpoint === "after-start-before-execution") throw new Error("injected failure after start");
    try { await options.onStarted?.(); } catch {
      const result = this.result(command, "failed", "", false, "CONTROL_PLANE_DISCONNECTED", started.journalEntryId, null, null);
      this.journal.failGrantedOperation(command.operationId, command.grant.grantId, result.resultRef, { ...result, adapterOutcome: undefined }, "CONTROL_PLANE_DISCONNECTED");
      return result;
    }
    const outcome = await this.adapter.run({
      taskId: command.taskId, attemptId: command.attemptId, operationId: command.operationId, adapterRunId: command.assignment.kind === "dispatched" ? command.assignment.adapterRunId : `run-${command.grant.grantId}`,
      taskInstructions: command.taskInput, executablePath: context.executablePath, worktreePath: context.worktreePath, managedWorktreeRoot: context.managedWorktreeRoot, codexHome: context.codexHome, managedDataRoot: context.managedDataRoot,
      outputSchemaPath: context.outputSchemaPath, mode: command.writeScope.permissions.create || command.writeScope.permissions.modify || command.writeScope.permissions.delete ? "workspace-write" : "read-only", windowsSandboxImplementation: context.windowsSandboxImplementation,
      writeScope: command.writeScope, readiness: command.readiness, provenance: context.provenance, timeoutMs: command.action.constraints.timeoutSec * 1_000, terminationDeadlineMs: 10_000, signal: options.signal,
    });
    const output = outcome.parsedResult === null ? "" : sanitize(outcome.parsedResult.summary);
    let reviewPackage: CodexBridgeResult["reviewPackage"] = null;
    if (context.reviewCapture !== undefined) {
      const captureAt = outcome.run.endedAt ?? outcome.run.startedAt ?? new Date().toISOString();
      const invocation = buildCodexInvocationArgs({ mode: command.writeScope.permissions.create || command.writeScope.permissions.modify || command.writeScope.permissions.delete ? "workspace-write" : "read-only", windowsSandboxImplementation: context.windowsSandboxImplementation, outputSchemaPath: context.outputSchemaPath, worktreePath: context.worktreePath });
      const captureRequest: ReviewCaptureRequest = {
        captureId: context.reviewCapture.captureId, ownerId: command.ownerId, projectId: command.projectId, taskId: command.taskId, attemptId: command.attemptId, operationId: command.operationId,
        journalId: started.journalEntryId, workerId: command.workerId, adapterId: command.adapterId, adapterRunId: outcome.run.adapterRunId,
        managedClonePath: context.reviewCapture.managedClonePath, managedCloneRoot: context.reviewCapture.managedCloneRoot, worktreePath: context.worktreePath, managedWorktreeRoot: context.managedWorktreeRoot,
        packageRoot: context.reviewCapture.packageRoot, managedDataRoot: context.managedDataRoot, baselineCommit: outcome.git.baseline.head, expectedFinalHead: outcome.git.after.head,
        workerClaim: output || null, readiness: command.readiness as unknown as Readonly<Record<string, unknown>>, sandbox: { implementation: context.windowsSandboxImplementation, assurance: context.provenance.windowsSandbox.assurance },
        terminalState: outcome.state, executionUnknown: outcome.state === "execution-unknown", applied: false,
        validations: [{ validationId: `validation-${context.reviewCapture.captureId}`, kind: "unknown", command: [context.executablePath, ...invocation], cwdLabel: `managed://${command.projectId}/${command.attemptId}`, startedAt: outcome.run.startedAt ?? captureAt, finishedAt: captureAt, process: outcome.process, toolVersions: { codex: context.provenance.version ?? "unknown" } }], capturedAt: captureAt,
      };
      try {
        const captured = await context.reviewCapture.service.capture(captureRequest);
        reviewPackage = { captureId: captured.captureId, packageId: captured.packageId, status: captured.status, packageDigest: captured.packageDigest, manifestDigest: captured.manifestDigest };
      } catch {
        reviewPackage = { captureId: context.reviewCapture.captureId, packageId: null, status: "failed", packageDigest: null, manifestDigest: null };
      }
    }
    const result = this.result(command, outcome.state, output, outcome.process.stdoutTruncated || outcome.process.stderrTruncated, outcome.failureCode, started.journalEntryId, outcome, reviewPackage);
    const durable = { ...result, adapterOutcome: undefined };
    if (outcome.state === "completed") this.journal.completeGrantedOperation(command.operationId, command.grant.grantId, result.resultRef, durable);
    else if (outcome.state === "execution-unknown") this.journal.markGrantedOperationUnknown(command.operationId, command.grant.grantId, result.resultRef, durable);
    else this.journal.failGrantedOperation(command.operationId, command.grant.grantId, result.resultRef, durable, outcome.failureCode ?? "CODEX_FAILED");
    return result;
  }

  private result(command: CodexDispatchCommand, state: CodexBridgeResult["state"], output: string, outputTruncated: boolean, failureCode: string | null, journalRef: string, adapterOutcome: CodexAdapterOutcome | null, reviewPackage: CodexBridgeResult["reviewPackage"]): CodexBridgeResult {
    return Object.freeze({ operationId: command.operationId, state, output, outputTruncated, failureCode, journalRef, resultRef: `result-${createHash("sha256").update(command.operationId).digest("hex").slice(0, 48)}`, adapterOutcome, reviewPackage });
  }
  private unknown(command: CodexDispatchCommand, journalRef: string): CodexBridgeResult { return this.result(command, "execution-unknown", "", false, "EXECUTION_UNKNOWN", journalRef, null, null); }

  public reconcileAfterRestart(): readonly CodexBridgeResult[] {
    this.assertOpen();
    return this.journal.reconcileAfterRestart(() => ({ outcome: "unknown" })).map((record) => record.state === "failed"
      ? Object.freeze({ operationId: record.operationId, state: "failed" as const, output: "", outputTruncated: false, failureCode: "RESTART_BEFORE_EXECUTION", journalRef: record.journalEntryId, resultRef: `result-${createHash("sha256").update(record.operationId).digest("hex").slice(0, 48)}`, adapterOutcome: null, reviewPackage: null })
      : Object.freeze({ operationId: record.operationId, state: "execution-unknown" as const, output: "", outputTruncated: false, failureCode: "EXECUTION_UNKNOWN", journalRef: record.journalEntryId, resultRef: `result-${createHash("sha256").update(record.operationId).digest("hex").slice(0, 48)}`, adapterOutcome: null, reviewPackage: null }));
  }
}
