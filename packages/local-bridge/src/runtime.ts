import { createHash, createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { CodexDispatchCommand } from "@chubz/control-plane";
import { Phase1GrantKey, type M11RuntimeConfiguration } from "@chubz/control-plane";
import { CodexCliAdapter } from "./codex-adapter.js";
import { CodexBridge, type CodexBridgeOptions, type CodexBridgeResult, type CodexExecutionContext } from "./codex-bridge.js";
import { WebSocketOutboundConnector, type OutboundConnection, type OutboundConnector } from "./connection.js";
import { SqliteEmergencyStopGate } from "./emergency-stop.js";
import { OperationJournal } from "./journal.js";
import { NodeProcessSpawner, ProcessSupervisor, WindowsProcessTreeController, type ProcessSpawner, type ProcessTreeController } from "./process-supervisor.js";
import { SafeApplyExecutor, type M9PrepareRequest, type M9PrepareResult, type M9PromoteRequest, type M9PromotionResult } from "./safe-apply.js";

export const M11_BRIDGE_RUNTIME_VERSION = "0.11.0-mvp.1" as const;
export type PackagedBridgeRuntimeState = "created" | "connecting" | "connected" | "stopped" | "failed";

export function bridgeSessionAuthorization(secret: string, enrollmentIdentity = "local-bridge"): string {
  if (secret.length < 32 || enrollmentIdentity !== "local-bridge") throw new Error("Bridge runtime authentication configuration is invalid");
  return `Bearer ${createHmac("sha256", secret).update(`chubz.m11.bridge-session/v1\n${enrollmentIdentity}`).digest("base64url")}`;
}

export type PackagedLocalBridgeOptions = Readonly<{
  configuration: M11RuntimeConfiguration;
  sessionSecret: string;
  connector?: OutboundConnector;
  processSpawner?: ProcessSpawner;
  processTreeController?: ProcessTreeController;
}>;

/**
 * Production-shaped local Bridge composition. It only initiates an outbound
 * WebSocket. The authoritative SQLite emergency gate is mandatory both before
 * journal consumption and at the final shell-free process spawn boundary.
 */
export class PackagedLocalBridgeRuntime {
  private readonly gate: SqliteEmergencyStopGate;
  private readonly journal: OperationJournal;
  private readonly grantKey: Phase1GrantKey;
  private readonly codexBridge: CodexBridge;
  private readonly safeApply: SafeApplyExecutor;
  private readonly connector: OutboundConnector;
  private connection: OutboundConnection | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private state: PackagedBridgeRuntimeState = "created";
  public readonly assemblyEvidence: Readonly<{ outboundOnly: true; inboundListener: false; journalBeforeExecution: true; approvalGrantRequired: true; adapterIsolated: true; emergencyGateAtBridge: true; emergencyGateAtSpawn: true; applyClaimResultSeparated: true; routingConfirmationRequiredUpstream: true }>;

  public constructor(private readonly options: PackagedLocalBridgeOptions) {
    const config = options.configuration; const dataRoot = config.paths.managedDataRoot; mkdirSync(dataRoot, { recursive: true });
    const databasePath = resolve(dataRoot, config.paths.databaseFile); const journalPath = resolve(dataRoot, "bridge-operation-journal.sqlite");
    this.gate = new SqliteEmergencyStopGate(databasePath); this.journal = new OperationJournal(journalPath);
    const grantSecret = createHash("sha256").update(`chubz.m6.runtime-grant/v1\n${options.sessionSecret}`, "utf8").digest(); this.grantKey = new Phase1GrantKey("control-plane-runtime", grantSecret); grantSecret.fill(0);
    const supervisor = new ProcessSupervisor(options.processSpawner ?? new NodeProcessSpawner(), options.processTreeController ?? new WindowsProcessTreeController(), this.gate);
    this.codexBridge = new CodexBridge(this.journal, this.grantKey.verifier(), new CodexCliAdapter(supervisor), () => new Date(), this.gate);
    this.safeApply = new SafeApplyExecutor(config.paths.approvedManagedRoots[0], (projectId, operationId) => this.gate.assertAllowed(projectId), supervisor);
    this.connector = options.connector ?? new WebSocketOutboundConnector();
    this.assemblyEvidence = Object.freeze({ outboundOnly: true, inboundListener: false, journalBeforeExecution: true, approvalGrantRequired: true, adapterIsolated: true, emergencyGateAtBridge: true, emergencyGateAtSpawn: true, applyClaimResultSeparated: true, routingConfirmationRequiredUpstream: true });
  }

  public status(): Readonly<{ state: PackagedBridgeRuntimeState; runtimeVersion: string; assembly: PackagedLocalBridgeRuntime["assemblyEvidence"] }> { return Object.freeze({ state: this.state, runtimeVersion: M11_BRIDGE_RUNTIME_VERSION, assembly: this.assemblyEvidence }); }
  public reconcileAfterRestart(): readonly CodexBridgeResult[] { if (this.state === "stopped") throw new Error("Bridge runtime is stopped"); return this.codexBridge.reconcileAfterRestart(); }
  public async start(): Promise<void> {
    if (this.state !== "created") throw new Error("Bridge runtime cannot be started twice"); this.state = "connecting";
    try { this.connection = await this.connector.connect(this.options.configuration.bridge.endpoint, bridgeSessionAuthorization(this.options.sessionSecret, this.options.configuration.bridge.enrollmentIdentity)); this.state = "connected"; await this.sendHeartbeat(); this.heartbeat = setInterval(() => { void this.sendHeartbeat().catch(() => { this.state = "failed"; }); }, this.options.configuration.bridge.heartbeatIntervalMs); this.heartbeat.unref(); }
    catch (error) { this.state = "failed"; throw error; }
  }
  private async sendHeartbeat(): Promise<void> { if (this.connection === null) throw new Error("outbound Bridge connection is unavailable"); await this.connection.send(JSON.stringify({ kind: "bridge.heartbeat", enrollmentIdentity: this.options.configuration.bridge.enrollmentIdentity, sentAt: new Date().toISOString(), runtimeVersion: M11_BRIDGE_RUNTIME_VERSION, emergencyGate: "required" })); }
  public registerAuthorization(command: CodexDispatchCommand): "registered" | "duplicate" { if (this.state !== "connected") throw new Error("Bridge dispatch is unavailable without the authenticated outbound session"); this.gate.assertAllowed(command.projectId); return this.codexBridge.registerAuthorization(command); }
  public executeCodex(command: CodexDispatchCommand, context: CodexExecutionContext, options: CodexBridgeOptions = {}): Promise<CodexBridgeResult> { if (this.state !== "connected") return Promise.reject(new Error("Bridge dispatch is unavailable without the authenticated outbound session")); return this.codexBridge.execute(command, context, options); }
  public prepareApply(request: M9PrepareRequest): Promise<M9PrepareResult> { if (this.state !== "connected") return Promise.reject(new Error("Bridge apply is unavailable without the authenticated outbound session")); this.gate.assertAllowed(request.targetProjectId); return this.safeApply.prepare(request); }
  public promoteApply(request: M9PromoteRequest): Promise<M9PromotionResult> { if (this.state !== "connected") return Promise.reject(new Error("Bridge promotion is unavailable without the authenticated outbound session")); this.gate.assertAllowed(request.targetProjectId); return this.safeApply.promote(request); }
  public async stop(): Promise<void> { if (this.state === "stopped") return; if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null; let closeFailure: unknown; try { await this.connection?.close(); } catch (error) { closeFailure = error; } finally { this.connection = null; this.codexBridge.close(); this.gate.close(); this.grantKey.destroy(); this.state = "stopped"; } if (closeFailure) throw new Error("outbound Bridge connection shutdown was not confirmed", { cause: closeFailure }); }
}
