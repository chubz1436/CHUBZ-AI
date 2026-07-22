import { createHash } from "node:crypto";
import {
  detectRedactions,
  digestApprovalAction,
  evaluateLease,
  parseAssignment,
  redactText,
  verifyCapabilityGrant,
  verifyWriteScope,
  type ApprovalAction,
  type Assignment,
  type CapabilityGrant,
  type GrantAuthenticationVerifier,
  type Lease,
  type WriteScope,
} from "@chubz/shared";
import { OperationJournal } from "./journal.js";

export const ECHO_BRIDGE_LIMITS = Object.freeze({ maxInputBytes: 64 * 1024, maxOutputBytes: 48 * 1024 } as const);
const ECHO_WORKER_ID = "synthetic-echo-worker" as const;
const ECHO_ADAPTER_ID = "synthetic-echo-adapter" as const;
const VERIFIER_ID = "local-bridge" as const;
const sha256 = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
};
const deriveApprovalId = (input: Readonly<{ ownerId: string; taskId: string; attemptId: string; operationId: string; actionDigest: string; scopeHash: string; workerId: string; adapterId: string }>): string =>
  `approval-${createHash("sha256").update(`chubz.m4.approval-binding/v1\n${canonical(input)}`, "utf8").digest("hex")}`;
const sanitize = (value: string): string => {
  if (Buffer.byteLength(value) > ECHO_BRIDGE_LIMITS.maxOutputBytes) value = Buffer.from(value).subarray(0, ECHO_BRIDGE_LIMITS.maxOutputBytes).toString("utf8");
  const findings = detectRedactions(value); if (!findings.ok) return "[redacted]";
  const redacted = redactText(value, findings.value); return redacted.ok ? redacted.value.text : "[redacted]";
};

export interface BridgeClock { now(): Date }
export const bridgeSystemClock: BridgeClock = Object.freeze({ now: () => new Date() });

export type EchoDispatchCommand = Readonly<{
  commandId: string; taskId: string; attemptId: string; operationId: string; projectId: string; ownerId: string;
  workerId: typeof ECHO_WORKER_ID; adapterId: typeof ECHO_ADAPTER_ID; action: ApprovalAction; taskInput: string;
  assignment: Assignment; lease: Lease; writeScope: WriteScope; grant: CapabilityGrant;
}>;
export type EchoBridgeResult = Readonly<{
  operationId: string; state: "completed" | "failed" | "cancelled" | "execution-unknown";
  output: string; outputTruncated: boolean; failureCode: string | null; journalRef: string; resultRef: string;
}>;

export type EchoAdapterResult = Readonly<{ version: "1.0"; kind: "echo.result"; text: string }>;
export interface SyntheticEchoAdapter {
  readonly workerId: typeof ECHO_WORKER_ID;
  readonly adapterId: typeof ECHO_ADAPTER_ID;
  execute(input: string, signal: AbortSignal): Promise<unknown>;
}

/** Explicitly test-only, in-memory echo fixture. It opens no socket, reads no repository, and spawns no worker. */
export class TestOnlyEchoAdapter implements SyntheticEchoAdapter {
  public readonly workerId = ECHO_WORKER_ID;
  public readonly adapterId = ECHO_ADAPTER_ID;
  public executions = 0;
  public constructor(private readonly behavior: "success" | "failure" | "malformed" | "hang" = "success", private readonly delayMs = 0) {}
  public async execute(input: string, signal: AbortSignal): Promise<unknown> {
    this.executions += 1;
    if (this.delayMs > 0) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.delayMs);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(new EchoAdapterCancelled()); }, { once: true });
    });
    if (signal.aborted) throw new EchoAdapterCancelled();
    if (this.behavior === "failure") throw new EchoAdapterFailure();
    if (this.behavior === "malformed") return { text: input, unexpected: true };
    if (this.behavior === "hang") return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new EchoAdapterCancelled()), { once: true }));
    return Object.freeze({ version: "1.0", kind: "echo.result", text: input });
  }
}
class EchoAdapterFailure extends Error {}
class EchoAdapterCancelled extends Error {}

export type BridgeFailpoint = "before-consumption" | "after-consumption-before-journal" | "after-journal-before-start" | "after-start-before-evidence" | "after-worker-completion-before-result";
export type BridgeExecuteOptions = Readonly<{ signal?: AbortSignal; onStarted?: () => Promise<void> | void; failpoint?: BridgeFailpoint }>;

export class EchoBridge {
  private readonly inFlight = new Map<string, Readonly<{ digest: string; promise: Promise<EchoBridgeResult> }>>();
  public constructor(
    private readonly journal: OperationJournal,
    private readonly verifier: GrantAuthenticationVerifier,
    private readonly adapter: SyntheticEchoAdapter,
    private readonly clock: BridgeClock = bridgeSystemClock,
  ) {
    if (adapter.workerId !== ECHO_WORKER_ID || adapter.adapterId !== ECHO_ADAPTER_ID) throw new Error("only the synthetic echo adapter is permitted");
  }

  /** Called only for material received on the already-authenticated outbound Bridge session. */
  public registerAuthorization(command: EchoDispatchCommand): "registered" | "duplicate" {
    const actionDigest = digestApprovalAction(command.action); if (!actionDigest.ok) throw new Error("invalid approval action");
    const approvalId = deriveApprovalId({ ownerId: command.ownerId, taskId: command.taskId, attemptId: command.attemptId, operationId: command.operationId, actionDigest: actionDigest.value, scopeHash: command.writeScope.scopeHash, workerId: command.workerId, adapterId: command.adapterId });
    if (command.grant.approval.approvalId !== approvalId) throw new Error("grant approval binding mismatch");
    return this.journal.registerGrantAuthorization({ grantId: command.grant.grantId, approvalId: command.grant.approval.approvalId, ownerId: command.ownerId, taskId: command.taskId, attemptId: command.attemptId, operationId: command.operationId, workerId: command.workerId, adapterId: command.adapterId, scopeHash: command.writeScope.scopeHash, actionDigest: actionDigest.value });
  }

  public revoke(grantId: string): "revoked" | "already-consumed" { return this.journal.revokeGrantAuthorization(grantId); }

  private reject(command: Partial<EchoDispatchCommand>, code: string): never {
    this.journal.recordGrantRejection(command.grant?.grantId ?? null, code);
    throw new Error(`dispatch rejected (${code})`);
  }

  private verify(command: EchoDispatchCommand): { actionDigest: `sha256:${string}`; commandDigest: string } {
    if (Buffer.byteLength(command.taskInput) > ECHO_BRIDGE_LIMITS.maxInputBytes) return this.reject(command, "INPUT_TOO_LARGE");
    if (command.workerId !== ECHO_WORKER_ID || command.adapterId !== ECHO_ADAPTER_ID || command.action.operation !== "worker.dispatch") return this.reject(command, "WORKER_NOT_PERMITTED");
    const actionDigest = digestApprovalAction(command.action); if (!actionDigest.ok) return this.reject(command, "MALFORMED_ACTION");
    if (command.action.taskId !== command.taskId || command.action.attemptId !== command.attemptId || command.action.operationId !== command.operationId || command.action.target.resourceId !== command.workerId || command.action.parameters.worker.manifestId !== command.workerId || command.action.parameters.worker.manifestVersion !== "1.0.0" || command.action.parameters.projectId !== command.projectId || command.action.parameters.instructionDigest !== sha256(command.taskInput)) return this.reject(command, "ACTION_BINDING_MISMATCH");
    if (!verifyWriteScope(command.writeScope).ok || command.writeScope.taskId !== command.taskId || command.writeScope.attemptId !== command.attemptId || command.writeScope.operationId !== command.operationId || command.writeScope.permissions.create || command.writeScope.permissions.modify || command.writeScope.permissions.delete) return this.reject(command, "SCOPE_MISMATCH");
    const assignment = parseAssignment(command.assignment); if (!assignment.ok || assignment.value.kind !== "dispatched" || assignment.value.taskId !== command.taskId || assignment.value.attemptId !== command.attemptId || assignment.value.operationId !== command.operationId || assignment.value.workerId !== command.workerId || assignment.value.adapterId !== command.adapterId || assignment.value.writeScopeRef !== command.writeScope.scopeId || assignment.value.approvalGrantRef !== command.grant.grantId) return this.reject(command, "ASSIGNMENT_MISMATCH");
    const now = this.clock.now().toISOString();
    const lease = evaluateLease(command.lease, { taskId: command.taskId, attemptId: command.attemptId, operationId: command.operationId, workerId: command.workerId, adapterId: command.adapterId, now, generation: command.lease.renewalGeneration, action: "use" });
    if (!lease.ok || command.lease.resourceId !== command.writeScope.scopeId) return this.reject(command, `LEASE_${lease.code}`);
    const grant = verifyCapabilityGrant(command.grant, { actionDigest: actionDigest.value, taskId: command.taskId, attemptId: command.attemptId, operationId: command.operationId, intendedVerifier: VERIFIER_ID, now }, this.verifier);
    if (!grant.ok) return this.reject(command, `GRANT_${grant.code}`);
    const approvalId = deriveApprovalId({ ownerId: command.ownerId, taskId: command.taskId, attemptId: command.attemptId, operationId: command.operationId, actionDigest: actionDigest.value, scopeHash: command.writeScope.scopeHash, workerId: command.workerId, adapterId: command.adapterId });
    if (command.grant.approval.approvalId !== approvalId) return this.reject(command, "APPROVAL_BINDING_MISMATCH");
    const commandDigest = sha256(canonical({ commandId: command.commandId, taskId: command.taskId, attemptId: command.attemptId, operationId: command.operationId, projectId: command.projectId, ownerId: command.ownerId, workerId: command.workerId, adapterId: command.adapterId, action: command.action, taskInput: command.taskInput, assignment: command.assignment, lease: command.lease, writeScope: command.writeScope, grant: command.grant }));
    return { actionDigest: actionDigest.value as `sha256:${string}`, commandDigest };
  }

  public execute(command: EchoDispatchCommand, options: BridgeExecuteOptions = {}): Promise<EchoBridgeResult> {
    let verified: ReturnType<EchoBridge["verify"]>;
    try { verified = this.verify(command); }
    catch (error) { return Promise.reject(error); }
    const existing = this.inFlight.get(command.operationId);
    if (existing) {
      if (existing.digest !== verified.commandDigest) return Promise.reject(new Error("dispatch idempotency conflict"));
      return existing.promise;
    }
    const promise = this.executeOnce(command, verified, options).finally(() => this.inFlight.delete(command.operationId));
    this.inFlight.set(command.operationId, Object.freeze({ digest: verified.commandDigest, promise }));
    return promise;
  }

  private async executeOnce(command: EchoDispatchCommand, verified: { actionDigest: `sha256:${string}`; commandDigest: string }, options: BridgeExecuteOptions): Promise<EchoBridgeResult> {
    if (options.failpoint === "before-consumption") throw new Error("injected failure before consumption");
    let claim: ReturnType<OperationJournal["claimGrantedOperation"]>;
    try {
      claim = this.journal.claimGrantedOperation({ grantId: command.grant.grantId, approvalId: command.grant.approval.approvalId, ownerId: command.ownerId, taskId: command.taskId, attemptId: command.attemptId, operationId: command.operationId, workerId: command.workerId, adapterId: command.adapterId, scopeHash: command.writeScope.scopeHash, actionDigest: verified.actionDigest, commandDigest: verified.commandDigest, failAfterConsumption: options.failpoint === "after-consumption-before-journal" });
    } catch (error) {
      this.journal.recordGrantRejection(command.grant.grantId, error instanceof Error && error.message.includes("conflict") ? "IDEMPOTENCY_CONFLICT" : "CONSUMPTION_REJECTED");
      throw error;
    }
    if (claim.classification === "replay" && claim.result !== undefined) return claim.result as EchoBridgeResult;
    if (claim.classification === "execution-unknown") return this.unknownResult(command, claim.record.journalEntryId);
    if (claim.classification === "in-progress") return this.unknownResult(command, claim.record.journalEntryId);
    if (options.failpoint === "after-journal-before-start") throw new Error("injected failure after journal preparation");
    const started = this.journal.startGrantedOperation(command.operationId);
    if (options.failpoint === "after-start-before-evidence") throw new Error("injected failure after start");
    try { await options.onStarted?.(); }
    catch {
      const result = this.makeResult(command, "failed", "", false, "CONTROL_PLANE_DISCONNECTED", started.journalEntryId);
      this.journal.failGrantedOperation(command.operationId, command.grant.grantId, result.resultRef, result, "Control Plane disconnected before synthetic execution");
      return result;
    }

    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    options.signal?.addEventListener("abort", relayAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timeoutMs = command.action.constraints.timeoutSec * 1_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let raw: unknown;
    try {
      raw = await this.adapter.execute(command.taskInput, controller.signal);
    } catch (error) {
      clearTimeout(timer); options.signal?.removeEventListener("abort", relayAbort);
      const cancelled = options.signal?.aborted === true;
      const failureCode = cancelled ? "CANCELLED" : error instanceof EchoAdapterFailure ? "WORKER_FAILURE" : controller.signal.aborted ? "TIMEOUT" : "WORKER_FAILURE";
      const state = cancelled ? "cancelled" as const : "failed" as const;
      const result = this.makeResult(command, state, "", false, failureCode, started.journalEntryId);
      this.journal.failGrantedOperation(command.operationId, command.grant.grantId, result.resultRef, result, failureCode);
      return result;
    }
    clearTimeout(timer); options.signal?.removeEventListener("abort", relayAbort);
    if (options.failpoint === "after-worker-completion-before-result") throw new Error("injected failure after worker completion");
    if (!this.isEchoResult(raw)) {
      const result = this.makeResult(command, "failed", "", false, "MALFORMED_RESULT", started.journalEntryId);
      this.journal.failGrantedOperation(command.operationId, command.grant.grantId, result.resultRef, result, "MALFORMED_RESULT");
      return result;
    }
    const originalBytes = Buffer.byteLength(raw.text);
    const boundedOutput = Buffer.from(raw.text).subarray(0, ECHO_BRIDGE_LIMITS.maxOutputBytes).toString("utf8");
    const result = this.makeResult(command, "completed", sanitize(boundedOutput), originalBytes > ECHO_BRIDGE_LIMITS.maxOutputBytes, null, started.journalEntryId);
    this.journal.completeGrantedOperation(command.operationId, command.grant.grantId, result.resultRef, result);
    return result;
  }

  private isEchoResult(raw: unknown): raw is EchoAdapterResult {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    const keys = Object.keys(raw).sort(); const value = raw as Record<string, unknown>;
    return keys.join(",") === "kind,text,version" && value["version"] === "1.0" && value["kind"] === "echo.result" && typeof value["text"] === "string";
  }
  private makeResult(command: EchoDispatchCommand, state: EchoBridgeResult["state"], output: string, outputTruncated: boolean, failureCode: string | null, journalRef: string): EchoBridgeResult {
    return Object.freeze({ operationId: command.operationId, state, output, outputTruncated, failureCode, journalRef, resultRef: `result-${createHash("sha256").update(command.operationId).digest("hex").slice(0, 48)}` });
  }
  private unknownResult(command: EchoDispatchCommand, journalRef: string): EchoBridgeResult { return this.makeResult(command, "execution-unknown", "", false, "EXECUTION_UNKNOWN", journalRef); }

  public reconcileAfterRestart(): readonly EchoBridgeResult[] {
    const records = this.journal.reconcileAfterRestart(() => ({ outcome: "unknown" }));
    return records.map((record) => Object.freeze({ operationId: record.operationId, state: record.state === "failed" ? "failed" as const : "execution-unknown" as const, output: "", outputTruncated: false, failureCode: record.state === "failed" ? "RESTART_BEFORE_EXECUTION" : "EXECUTION_UNKNOWN", journalRef: record.journalEntryId, resultRef: `result-${createHash("sha256").update(record.operationId).digest("hex").slice(0, 48)}` }));
  }
}
