import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";
import {
  digestApprovalAction,
  digestWriteScope,
  type AdapterReadiness,
  type ApprovalAction,
  type WriteScope,
} from "@chubz/shared";
import {
  ControlPlaneDatabase,
  M4Orchestrator,
  Phase1GrantKey,
  createTestConfig,
  deriveApprovalId,
} from "@chubz/control-plane";
import { AdapterRegistry, CodexConfigIntegrityMonitor, assertIsolatedCodexAuthenticated, prepareCodexAdapterHome, sanitizedCodexConfigDiff, snapshotCodexConfig, type CodexProbeEvidence, type WindowsSandboxRuntimeProfile } from "../src/adapter-registry.js";
import { CodexCliAdapter } from "../src/codex-adapter.js";
import { CodexBridge, type CodexExecutionContext } from "../src/codex-bridge.js";
import { ManagedRepositoryService, type ManagedWorkspace } from "../src/managed-repository.js";
import { ManualRelayConnector } from "../src/manual-relay.js";
import { OperationJournal } from "../src/journal.js";
import { NodeProcessSpawner, ProcessSupervisor, WindowsProcessTreeController, type ProcessSpawner, type SpawnedProcess } from "../src/process-supervisor.js";

const root = mkdtempSync(join(tmpdir(), "chubz-m5-real-canary-test-"));
const git = (cwd: string, args: readonly string[]): string => execFileSync("git", [...args], { cwd, encoding: "utf8", windowsHide: true }).trim();
const sha = (value: string | Buffer): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const hasCode = (code: string) => (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === code;
const codexProcessPids = (): readonly number[] => execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object Name -eq 'codex.exe' | ForEach-Object ProcessId"], { encoding: "utf8", windowsHide: true }).split(/\s+/u).filter(Boolean).map(Number).filter(Number.isInteger);
class CountingSpawner implements ProcessSpawner {
  public readonly pids: number[] = []; public readonly argvs: readonly string[][] = []; private mutableArgvs: string[][] = [];
  public constructor(private readonly delegate = new NodeProcessSpawner()) { (this as { argvs: readonly string[][] }).argvs = this.mutableArgvs; }
  public get executions(): number { return this.pids.length; }
  public spawn(executable: string, args: readonly string[], options: Readonly<{ cwd: string; env: Readonly<Record<string, string>> }>): SpawnedProcess { const child = this.delegate.spawn(executable, args, options); this.pids.push(child.pid); this.mutableArgvs.push([...args]); return child; }
}
const resultSchema = {
  type: "object", additionalProperties: false, required: ["version", "kind", "status", "summary", "artifacts"],
  properties: {
    version: { type: "string", const: "1.0" }, kind: { type: "string", const: "codex.result" }, status: { type: "string", const: "completed" },
    summary: { type: "string", maxLength: 4096 }, artifacts: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false, required: ["path", "purpose"], properties: { path: { type: "string" }, purpose: { type: "string" } } } },
  },
};
const schemaPath = join(root, "codex-result-schema.json"); writeFileSync(schemaPath, JSON.stringify(resultSchema));
const ownerSource = join(root, "owner-synthetic-repository"); mkdirSync(ownerSource); git(ownerSource, ["init", "--quiet"]); writeFileSync(join(ownerSource, "FACT.txt"), "synthetic-real-canary-marker"); writeFileSync(join(ownerSource, "ALLOWED.txt"), "before\n"); writeFileSync(join(ownerSource, "FALLBACK.txt"), "before\n"); git(ownerSource, ["add", "."]); git(ownerSource, ["-c", "user.name=Synthetic Canary", "-c", "user.email=synthetic@example.invalid", "commit", "-m", "synthetic baseline", "--quiet"]);
const repositorySnapshot = (cwd: string) => ({ head: git(cwd, ["rev-parse", "HEAD"]), branch: git(cwd, ["branch", "--show-current"]), refs: git(cwd, ["show-ref", "--head"]), status: git(cwd, ["status", "--porcelain=v1"]), factHash: sha(readFileSync(join(cwd, "FACT.txt"))), allowedHash: sha(readFileSync(join(cwd, "ALLOWED.txt"))), fallbackHash: sha(readFileSync(join(cwd, "FALLBACK.txt"))) });
const ownerBefore = repositorySnapshot(ownerSource);
const managed = new ManagedRepositoryService({ managedRoot: join(root, "managed-clones"), worktreeRoot: join(root, "managed-worktrees") });
const workspaces: ManagedWorkspace[] = [];
const makeWorkspace = async (projectId: string, attemptId: string): Promise<ManagedWorkspace> => { await managed.createManagedClone(ownerSource, projectId); const value = await managed.createWorktree(projectId, attemptId); workspaces.push(value); return value; };
const scope = (taskId: string, attemptId: string, operationId: string, workspace: ManagedWorkspace, write: boolean, exactPath = write ? "ALLOWED.txt" : "FACT.txt"): WriteScope => {
  const core = { scopeVersion: "1.0" as const, scopeId: `scope-${taskId}`, repositoryRootId: `repository-${taskId}`, worktreeRootId: `worktree-${taskId}`, taskId, attemptId, operationId, allowedExactPaths: [exactPath], allowedPathPatterns: [], deniedPathClasses: ["credentials", "production", "infrastructure", "database", "mikrotik", "deployment", "unrelated-repository", "system"] as const, readOnlyPaths: [], generatedArtifactRoot: null, permissions: { create: write, modify: write, delete: write }, maxFiles: 1, maxBytes: 4096 };
  void workspace;
  const digest = digestWriteScope(core); if (!digest.ok) throw new Error("scope digest failed"); return { ...core, deniedPathClasses: [...core.deniedPathClasses], scopeHash: digest.value };
};
const taskPrompt = (instruction: string): string => `${instruction}\nReturn only the structured result required by the supplied JSON schema. Use status completed only after verifying the requested work. Do not commit, create branches, change refs, or touch any other path.`;
const probeEnvironment = (codexHome: string): Record<string, string> => ({ ...Object.fromEntries(["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!] ])), CODEX_HOME: codexHome });
const elevatedWriteProbe = (executable: string, workspace: string, codexHome: string): Readonly<{ result: "passed" | "failed"; classification: WindowsSandboxRuntimeProfile["elevatedFailureClassification"]; exitCode: number | null; fileCreated: boolean; sanitizedError: string; pid: number | null }> => {
  const target = join(workspace, "ELEVATED-PROBE.txt");
  const outcome = spawnSync(executable, ["-c", 'windows.sandbox="elevated"', "sandbox", "-P", ":workspace", "-C", workspace, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Set-Content -LiteralPath '.\\ELEVATED-PROBE.txt' -Value 'ok' -NoNewline"], { cwd: workspace, encoding: "utf8", windowsHide: true, timeout: 30_000, env: probeEnvironment(codexHome), stdio: ["ignore", "pipe", "pipe"] });
  if (outcome.status === 0) return Object.freeze({ result: "passed", classification: null, exitCode: 0, fileCreated: readFileSync(target, "utf8") === "ok", sanitizedError: "", pid: outcome.pid ?? null });
  {
    const text = String(outcome.stderr || outcome.error?.message || "elevated sandbox probe failed").replaceAll(root, "<synthetic-root>").slice(0, 2048);
    const classification = /access.*denied|unauthorizedaccess/iu.test(text) ? "WINDOWS_ELEVATED_SANDBOX_ACCESS_DENIED" as const : "WINDOWS_ELEVATED_SANDBOX_SETUP_FAILED" as const;
    return Object.freeze({ result: "failed", classification, exitCode: outcome.status, fileCreated: false, sanitizedError: text, pid: outcome.pid ?? null });
  }
};

let control: ControlPlaneDatabase | null = null; let activeBridge: CodexBridge | null = null; let manual: ManualRelayConnector | null = null; let key: Phase1GrantKey | null = null; let configMonitor: CodexConfigIntegrityMonitor | null = null;
const summary: Record<string, unknown> = {};
try {
  const compatibilityPath = join(root, "runtime-state", "codex-compatibility.json");
  const registry = new AdapterRegistry(compatibilityPath); const spawner = new CountingSpawner(); const adapter = new CodexCliAdapter(new ProcessSupervisor(spawner, new WindowsProcessTreeController()));
  const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..");
  const sharedCodexHome = resolve(process.env.USERPROFILE ?? "", ".codex");
  const adapterHome = await prepareCodexAdapterHome({ managedDataRoot: resolve(repositoryRoot, "..", "CHUBZ-AI-Worktrees"), repositoryRoot, sharedCodexHome });
  const isolatedConfigBefore = await snapshotCodexConfig(adapterHome.configPath);
  const isolatedConfigTextBefore = readFileSync(adapterHome.configPath, "utf8");
  const preExistingCodexPids = codexProcessPids();
  configMonitor = new CodexConfigIntegrityMonitor(join(sharedCodexHome, "config.toml"), preExistingCodexPids, tmpdir(), false); const configBaseline = await configMonitor.start();
  const stage = async <T>(name: string, action: () => Promise<T> | T, extraPids: () => readonly number[] = () => []): Promise<T> => {
    const firstSpawnerPid = spawner.pids.length;
    return configMonitor!.runStage(name, () => [...spawner.pids.slice(firstSpawnerPid), ...extraPids()], action);
  };
  const resolutionProbe = await stage("isolated-authentication-probe", () => registry.probeCodex({ path: process.env.PATH ?? "", pathext: process.env.PATHEXT, codexHome: adapterHome.codexHome, windowsSandboxProfile: { configuredImplementation: "elevated", selectedImplementation: "unelevated", elevatedProbeResult: "failed", elevatedFailureClassification: "WINDOWS_ELEVATED_SANDBOX_ACCESS_DENIED" } }));
  assertIsolatedCodexAuthenticated(resolutionProbe.evidence.authenticationState, adapterHome.codexHome);
  const elevatedWorkspace = await makeWorkspace("elevated-probe", "attempt-elevated-probe");
  let elevatedPid: number | null = null; const elevated = await stage("elevated-probe", () => { const value = elevatedWriteProbe(resolutionProbe.resolution.executablePath, elevatedWorkspace.worktreePath, adapterHome.codexHome); elevatedPid = value.pid; return value; }, () => elevatedPid === null ? [] : [elevatedPid]);
  assert.equal(elevated.result, "failed", "this machine's elevated sandbox unexpectedly passed; do not select the weaker fallback without a failure");
  assert.equal(elevated.fileCreated, false);
  const windowsSandboxProfile: WindowsSandboxRuntimeProfile = { configuredImplementation: "elevated", selectedImplementation: "unelevated", elevatedProbeResult: "failed", elevatedFailureClassification: elevated.classification };
  const initial = await stage("fallback-readiness-probe", () => registry.probeCodex({ path: process.env.PATH ?? "", pathext: process.env.PATHEXT, codexHome: adapterHome.codexHome, windowsSandboxProfile }));
  assert.equal(initial.readiness.readinessState, "degraded"); assert.equal(initial.evidence.authenticationState, "authenticated");

  const canaryWorkspace = await makeWorkspace("canary-probe", "attempt-canary-probe");
  const canaryScope = scope("task-canary-probe", "attempt-canary-probe", "operation-canary-probe", canaryWorkspace, true, "FALLBACK.txt");
  const canary = await stage("unelevated-fallback-probe", () => adapter.runCanary({ taskId: "task-canary-probe", attemptId: "attempt-canary-probe", operationId: "operation-canary-probe", adapterRunId: "run-canary-probe", taskInstructions: taskPrompt("Replace the complete contents of FALLBACK.txt with exactly: unelevated-fallback-canary followed by one newline. Read it back and include FALLBACK.txt in artifacts."), executablePath: initial.resolution.executablePath, worktreePath: canaryWorkspace.worktreePath, managedWorktreeRoot: join(root, "managed-worktrees"), codexHome: adapterHome.codexHome, managedDataRoot: adapterHome.managedDataRoot, outputSchemaPath: schemaPath, mode: "workspace-write", windowsSandboxImplementation: "unelevated", writeScope: canaryScope, readiness: initial.readiness, provenance: initial.evidence, timeoutMs: 120_000, terminationDeadlineMs: 10_000 }));
  if (canary.state !== "completed") throw new Error(`unelevated fallback canary failed: ${JSON.stringify({ failureCode: canary.failureCode, exitCode: canary.process.exit?.code ?? null, stopReason: canary.process.stopReason, sanitizedStderr: canary.sanitizedStderr, gitFailure: canary.git.failure, eventKinds: canary.events.map((event) => event.kind) })}`);
  assert.equal(canary.state, "completed"); assert.equal(readFileSync(join(canaryWorkspace.worktreePath, "FALLBACK.txt"), "utf8").replace(/\r\n/gu, "\n"), "unelevated-fallback-canary\n"); assert.deepEqual(canary.git.changes.map((change) => change.path), ["FALLBACK.txt"]);
  await registry.recordCompatibleCanary(initial, { passed: true, observedWindowsSandboxImplementation: "unelevated" });
  const ready = await stage("post-canary-readiness-probe", () => registry.probeCodex({ path: process.env.PATH ?? "", pathext: process.env.PATHEXT, codexHome: adapterHome.codexHome, windowsSandboxProfile }));
  assert.equal(ready.readiness.readinessState, "degraded"); assert.equal(ready.readiness.healthStatus, "degraded"); assert.equal(ready.evidence.windowsSandbox.fallbackCanaryResult, "passed");

  control = new ControlPlaneDatabase(createTestConfig(join(root, "control-plane"))); key = new Phase1GrantKey("m5-real-canary-key", Buffer.alloc(32, 11)); const orchestrator = new M4Orchestrator(control, key);
  await stage("readiness-registration", () => orchestrator.registerCodexReadiness("register-real-readiness", { readiness: ready.readiness, evidence: ready.evidence }));
  activeBridge = new CodexBridge(new OperationJournal(join(root, "bridge.sqlite")), key.verifier(), adapter);
  const provision = (name: string, workspace: ManagedWorkspace, write: boolean, instructions: string, timeoutSec = 120) => {
    const taskId = `task-${name}`; const attemptId = `attempt-${name}`; const operationId = `operation-${name}`; const projectId = workspace.projectId; const taskInput = taskPrompt(instructions);
    const action: ApprovalAction = { actionVersion: "1.0", taskId, attemptId, operationId, operation: "worker.dispatch", policyClass: "worker-execution", target: { kind: "worker", resourceId: "codex-cli" }, parameters: { projectId, workspaceId: `workspace-${name}`, worker: { manifestId: "codex-cli", manifestVersion: "1.0.0" }, instructionDigest: sha(taskInput), contextArtifactIds: [] }, constraints: { timeoutSec, requiresCleanWorktree: true, expectedArtifactId: null } };
    const writeScope = scope(taskId, attemptId, operationId, workspace, write);
    orchestrator.createTask(`create-${name}`, { taskId, projectId }); orchestrator.createCodexAttempt(`attempt-command-${name}`, { taskId, attemptId, action, taskInput }); orchestrator.activateAttempt(taskId, "owner-canary");
    const assigned = orchestrator.assignCodex(`assign-${name}`, { taskId, attemptId, assignmentId: `assignment-${name}`, leaseId: `lease-${name}`, ownerAssignmentRef: `owner-assignment-${name}`, leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(), readinessSnapshotRef: ready.readiness.readinessId, writeScope });
    const digest = digestApprovalAction(action); if (!digest.ok) throw new Error("action digest failed"); const approvalId = deriveApprovalId({ ownerId: "owner-canary", taskId, attemptId, operationId, actionDigest: digest.value, scopeHash: assigned.scopeHash, workerId: "codex-cli", adapterId: "codex-cli-adapter" });
    orchestrator.approveAndIssueCodex(`issue-${name}`, { taskId, attemptId, ownerId: "owner-canary", approvalId, grantId: `grant-${name}`, issuerId: "control-plane-canary", lifetimeMs: 300_000 });
    const command = orchestrator.claimNextCodexDispatch(); const context: CodexExecutionContext = { executablePath: ready.resolution.executablePath, worktreePath: workspace.worktreePath, managedWorktreeRoot: join(root, "managed-worktrees"), codexHome: adapterHome.codexHome, managedDataRoot: adapterHome.managedDataRoot, outputSchemaPath: schemaPath, provenance: ready.evidence, windowsSandboxImplementation: "unelevated" };
    return { taskId, attemptId, operationId, command, context };
  };

  const readWorkspace = await makeWorkspace("canary-read", "attempt-read"); const read = provision("read", readWorkspace, false, "Read FACT.txt without modifying any file and summarize its exact marker."); const beforeReadRuns = spawner.executions;
  const startRead = () => { if (orchestrator.getTask(read.taskId).state === "AWAITING_DISPATCH") orchestrator.acknowledgeDispatch(read.taskId, read.operationId); };
  const [readFirst, readDuplicate] = await stage("real-read-only-duplicate-dispatch", () => { activeBridge!.registerAuthorization(read.command); return Promise.all([activeBridge!.execute(read.command, read.context, { onStarted: startRead }), activeBridge!.execute(read.command, read.context, { onStarted: startRead })]); });
  const duplicateExecutionCount = spawner.executions - beforeReadRuns; assert.deepEqual(readFirst, readDuplicate); assert.equal(duplicateExecutionCount, 1); assert.equal(readFirst.state, "completed"); assert.equal(readFirst.adapterOutcome?.git.changes.length, 0); const { adapterOutcome: _readOutcome, ...readControlResult } = readFirst; orchestrator.recordBridgeResult("record-read", read.taskId, readControlResult);

  const writeWorkspace = await makeWorkspace("canary-write", "attempt-write"); const write = provision("write", writeWorkspace, true, "You must edit ALLOWED.txt now using a filesystem tool. Replace its complete contents with exactly: m5-isolated-write-canary followed by one newline. Read ALLOWED.txt back after editing and do not report completion unless that exact change exists. Include ALLOWED.txt in the result artifacts list with purpose isolated write canary."); const writeResult = await stage("isolated-write", () => { activeBridge!.registerAuthorization(write.command); return activeBridge!.execute(write.command, write.context, { onStarted: () => orchestrator.acknowledgeDispatch(write.taskId, write.operationId) }); });
  assert.equal(writeResult.state, "completed"); assert.equal(readFileSync(join(writeWorkspace.worktreePath, "ALLOWED.txt"), "utf8").replace(/\r\n/gu, "\n"), "m5-isolated-write-canary\n"); assert.deepEqual(writeResult.adapterOutcome?.git.changes.map((change) => change.path), ["ALLOWED.txt"]); const { adapterOutcome: _writeOutcome, ...writeControlResult } = writeResult; orchestrator.recordBridgeResult("record-write", write.taskId, writeControlResult);

  const cancelWorkspace = await makeWorkspace("canary-cancel", "attempt-cancel"); const cancel = provision("cancel", cancelWorkspace, false, "First run a harmless 30-second wait command, then read FACT.txt and summarize it.", 90); const abort = new AbortController(); const cancelResult = await stage("cancellation", () => { activeBridge!.registerAuthorization(cancel.command); return activeBridge!.execute(cancel.command, cancel.context, { signal: abort.signal, onStarted: () => { orchestrator.acknowledgeDispatch(cancel.taskId, cancel.operationId); orchestrator.cancel(cancel.taskId); setTimeout(() => abort.abort(), 1_000); } }); });
  assert.equal(cancelResult.state, "cancelled"); assert.equal(cancelResult.adapterOutcome?.process.terminationEvidence?.proven, true); const { adapterOutcome: _cancelOutcome, ...cancelControlResult } = cancelResult; orchestrator.recordBridgeResult("record-cancel", cancel.taskId, cancelControlResult);

  const restartWorkspace = await makeWorkspace("canary-restart", "attempt-restart"); const restart = provision("restart", restartWorkspace, false, "Read FACT.txt and summarize it."); const beforeRestartRuns = spawner.executions;
  await stage("restart-reconciliation", async () => {
    const originalBridge = activeBridge!; originalBridge.registerAuthorization(restart.command); await assert.rejects(originalBridge.execute(restart.command, restart.context, { failpoint: "after-start-before-execution" }));
    originalBridge.close(); activeBridge = new CodexBridge(new OperationJournal(join(root, "bridge.sqlite")), key!.verifier(), adapter);
    assert.throws(() => originalBridge.registerAuthorization(restart.command), /Codex bridge is closed/u);
    const reconciled = activeBridge.reconcileAfterRestart().find((item) => item.operationId === restart.operationId); assert.equal(reconciled?.state, "execution-unknown"); assert.equal((await activeBridge.execute(restart.command, restart.context)).state, "execution-unknown"); assert.equal(spawner.executions, beforeRestartRuns);
    const { adapterOutcome: _restartOutcome, ...restartControlResult } = reconciled!; orchestrator.recordBridgeResult("record-restart-unknown", restart.taskId, restartControlResult);
  });

  await stage("readiness-drift", async () => {
    const beforeDriftRuns = spawner.executions;
    const driftCase = async (name: string, mutate: (context: CodexExecutionContext) => CodexExecutionContext, pattern: RegExp): Promise<void> => {
      const workspace = await makeWorkspace(`canary-drift-${name}`, `attempt-drift-${name}`); const dispatch = provision(`drift-${name}`, workspace, false, "Read FACT.txt and summarize it."); activeBridge!.registerAuthorization(dispatch.command); await assert.rejects(activeBridge!.execute(dispatch.command, mutate(dispatch.context)), pattern);
      orchestrator.acknowledgeDispatch(dispatch.taskId, dispatch.operationId); orchestrator.recordBridgeResult(`record-drift-${name}`, dispatch.taskId, { operationId: dispatch.operationId, state: "failed", output: "", outputTruncated: false, failureCode: "READINESS_DRIFT_BLOCKED", journalRef: `journal-drift-${name}`, resultRef: `result-drift-${name}` });
    };
    const hashEvidence: CodexProbeEvidence = { ...ready.evidence, executableSha256: `sha256:${"f".repeat(64)}`, compatibility: "drifted", windowsSandbox: { ...ready.evidence.windowsSandbox, fallbackCanaryResult: "drifted" } };
    await driftCase("hash", (context) => ({ ...context, provenance: hashEvidence }), /READINESS_NOT_ELIGIBLE/u);
    await driftCase("version", (context) => ({ ...context, provenance: { ...context.provenance, version: "0.0.0-drift" } }), /path, version, or hash changed/u);
    await driftCase("path", (context) => ({ ...context, executablePath: join(root, "different-codex.exe") }), /path, version, or hash changed/u);
    await driftCase("sandbox", (context) => ({ ...context, windowsSandboxImplementation: "elevated" }), /SANDBOX_IMPLEMENTATION_MISMATCH/u);
    assert.equal(spawner.executions, beforeDriftRuns);
  });

  const { manualFirst, artifact } = await stage("manual-relay-validation", async () => {
    manual = new ManualRelayConnector(join(root, "manual.sqlite"), join(root, "quarantine"));
    const manualAssignment = { coordinationVersion: "1.0" as const, kind: "owner-confirmed" as const, assignmentId: "assignment-manual-real", taskId: "task-manual-real", attemptId: "attempt-manual-real", operationId: "operation-manual-real", projectId: "project-manual-real", workerId: "manual-worker", adapterId: "manual-relay", requiredCapabilities: ["text-output"], permittedConnectorTier: "manual-relay" as const, writeScopeRef: null, leaseRequired: false, readinessSnapshotRef: "readiness-manual-real", quotaSnapshotRef: null, approvalGrantRef: null, expectedEvidenceRefs: ["owner-attestation-real"], expiresAt: new Date(Date.now() + 600_000).toISOString(), rationaleEvidenceRefs: ["rationale-manual-real"], ownerApprovalRef: "owner-assignment-manual-real" };
    const manualBase = { active: { taskId: "task-manual-real", attemptId: "attempt-manual-real", operationId: "operation-manual-real", state: "RUNNING" as const, immutableAttempt: true as const }, assignment: manualAssignment, workerIdentityLabel: "manual-worker", readinessSnapshotRef: "readiness-manual-real", attestation: { attestationId: "attestation-manual-real", ownerId: "owner-canary", authenticated: true as const, attestedAt: new Date().toISOString(), selectedImportMode: "text" as const } };
    const manualTextRequest = { ...manualBase, idempotencyKey: "manual-text-real", expectedResponseType: "text" as const, response: { version: "1.0", kind: "manual.text", responseType: "text", text: "bounded owner-attested result" } };
    const manualFirst = manual.importText(manualTextRequest); assert.equal(manual.importText(manualTextRequest).replayed, true); assert.throws(() => manual!.importText({ ...manualTextRequest, response: { ...manualTextRequest.response, text: "conflict" } })); assert.equal(manualFirst.provenance, "owner-attested manual relay");
    assert.throws(() => manual!.importText({ ...manualTextRequest, idempotencyKey: "manual-malformed-real", response: { ...manualTextRequest.response, extra: true } }), hasCode("MALFORMED_IMPORT"));
    assert.throws(() => manual!.importText({ ...manualTextRequest, idempotencyKey: "manual-oversized-real", response: { ...manualTextRequest.response, text: "x".repeat(70_000) } }), hasCode("OVERSIZED_IMPORT"));
    const artifactSource = join(root, "manual-artifact.txt"); writeFileSync(artifactSource, "manual artifact"); const artifact = await manual.importArtifacts({ ...manualBase, idempotencyKey: "manual-artifact-real", importId: "import-manual-real", attestation: { ...manualBase.attestation, selectedImportMode: "artifact" }, files: [{ sourcePath: artifactSource, relativePath: "evidence.txt", declaredPurpose: "synthetic evidence", declaredSha256: sha("manual artifact") }] }); assert.equal(artifact.appliedToProject, false); assert.equal(artifact.artifacts[0]?.state, "quarantined");
    const artifactBase = { ...manualBase, attestation: { ...manualBase.attestation, selectedImportMode: "artifact" as const }, files: [{ sourcePath: artifactSource, relativePath: "safe.txt", declaredPurpose: "synthetic rejection evidence", declaredSha256: sha("manual artifact") }] };
    await assert.rejects(manual.importArtifacts({ ...artifactBase, idempotencyKey: "manual-traversal-real", importId: "import-traversal-real", files: [{ ...artifactBase.files[0]!, relativePath: "../escape.txt" }] }), hasCode("ARTIFACT_REJECTED"));
    await assert.rejects(manual.importArtifacts({ ...artifactBase, idempotencyKey: "manual-executable-real", importId: "import-executable-real", files: [{ ...artifactBase.files[0]!, relativePath: "payload.exe" }] }), hasCode("ARTIFACT_REJECTED"));
    await assert.rejects(manual.importArtifacts({ ...artifactBase, idempotencyKey: "manual-archive-real", importId: "import-archive-real", files: [{ ...artifactBase.files[0]!, relativePath: "payload.zip" }] }), hasCode("ARTIFACT_REJECTED"));
    await assert.rejects(manual.importArtifacts({ ...artifactBase, idempotencyKey: "manual-collision-real", importId: "import-collision-real", files: [{ ...artifactBase.files[0]!, relativePath: "A.txt" }, { ...artifactBase.files[0]!, relativePath: "a.txt" }] }), hasCode("ARTIFACT_REJECTED"));
    await assert.rejects(manual.importArtifacts({ ...artifactBase, idempotencyKey: "manual-invalid-hash-real", importId: "import-invalid-hash-real", files: [{ ...artifactBase.files[0]!, declaredSha256: sha("wrong") }] }), hasCode("ARTIFACT_REJECTED"));
    const linkTarget = join(root, "manual-link-target"); const linkPath = join(root, "manual-source-link"); mkdirSync(linkTarget); writeFileSync(join(linkTarget, "source.txt"), "manual artifact"); symlinkSync(linkTarget, linkPath, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(manual.importArtifacts({ ...artifactBase, idempotencyKey: "manual-link-real", importId: "import-link-real", files: [{ ...artifactBase.files[0]!, sourcePath: join(linkPath, "source.txt") }] }), hasCode("ARTIFACT_REJECTED"));
    writeFileSync(artifactSource, Buffer.alloc(4 * 1024 * 1024 + 1));
    await assert.rejects(manual.importArtifacts({ ...artifactBase, idempotencyKey: "manual-oversized-artifact-real", importId: "import-oversized-real", files: [{ ...artifactBase.files[0]!, declaredSha256: sha(readFileSync(artifactSource)) }] }), hasCode("OVERSIZED_IMPORT"));
    return { manualFirst, artifact };
  });

  const ownerAfter = repositorySnapshot(ownerSource);
  assert.deepEqual(ownerAfter, ownerBefore);
  for (const argv of spawner.argvs) {
    assert.equal(argv.some((arg) => arg.includes("synthetic-real-canary-marker") || arg.includes("m5-isolated-write-canary") || arg.includes("unelevated-fallback-canary")), false);
    assert.equal(argv.includes("windows.sandbox=\"unelevated\""), true); assert.equal(argv.includes("--ask-for-approval"), true); assert.equal(argv.includes("never"), true);
    assert.equal(argv.some((arg) => /danger-full-access|--yolo|default_permissions|permission-profile/u.test(arg)), false);
  }
  for (const pid of spawner.pids) { try { process.kill(pid, 0); assert.fail(`canary process ${pid} remains live`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
  summary.probe = { executablePath: ready.evidence.executablePath, version: ready.evidence.version, sha256: ready.evidence.executableSha256, authentication: ready.evidence.authenticationState, structuredOutput: ready.evidence.structuredOutputSupport, sandbox: ready.evidence.sandboxSupport, cancellation: ready.evidence.cancellationSupport, resume: "UNSUPPORTED by adapter pending independent functional proof", artifact: ready.evidence.artifactSupport, quota: ready.evidence.quotaStatus, rateLimit: ready.evidence.rateLimitStatus, readiness: ready.readiness.readinessState, health: ready.readiness.healthStatus, windowsSandbox: ready.evidence.windowsSandbox, elevatedProbe: elevated };
  summary.real = { fallbackWriteCanary: canary.state, fallbackWritePaths: canary.git.changes.map((change) => change.path), readOnly: readFirst.state, duplicateProcesses: duplicateExecutionCount, write: writeResult.state, writePaths: writeResult.adapterOutcome?.git.changes.map((change) => change.path), writeBaseline: writeResult.adapterOutcome?.git.baseline, writeAfter: writeResult.adapterOutcome?.git.after, cancellation: cancelResult.state, terminationEvidence: cancelResult.adapterOutcome?.process.terminationEvidence, restart: "execution-unknown/no-rerun", readinessDrift: "blocked-before-execution", ownerRepositoryBefore: ownerBefore, ownerRepositoryAfter: ownerAfter, ownerRepositoryUnchanged: true, taskPresentInArgv: false, spawnedPidsRemaining: 0, codexExecutionCount: spawner.executions };
  summary.manualRelay = { text: manualFirst.provenance, duplicateReplay: true, conflictRejected: true, malformedRejected: true, oversizedTextRejected: true, artifactState: artifact.artifacts[0]?.state, traversalRejected: true, linkOrJunctionRejected: true, executableRejected: true, archiveRejected: true, collisionRejected: true, invalidHashRejected: true, oversizedArtifactRejected: true, appliedToProject: artifact.appliedToProject, appliedToWorktree: artifact.appliedToWorktree };
  const isolatedConfigAfter = await snapshotCodexConfig(adapterHome.configPath); const isolatedConfigChanges = sanitizedCodexConfigDiff(isolatedConfigTextBefore, readFileSync(adapterHome.configPath, "utf8"));
  summary.configIntegrity = { shared: { baseline: configBaseline, stages: configMonitor.evidence(), unchanged: true, diagnosticCopiesCreated: false }, isolated: { codexHome: adapterHome.codexHome, before: isolatedConfigBefore, after: isolatedConfigAfter, sanitizedChanges: isolatedConfigChanges } };
  console.log(JSON.stringify(summary, null, 2));
} finally {
  manual?.close(); activeBridge?.close(); configMonitor?.close(); control?.close(); key?.destroy();
  for (const workspace of [...workspaces].reverse()) { try { await managed.cleanup(workspace); } catch { /* the disposable root is removed below */ } }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
