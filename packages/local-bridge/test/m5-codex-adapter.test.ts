import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digestApprovalAction, digestWriteScope, type AdapterReadiness, type ApprovalAction, type WriteScope } from "@chubz/shared";
import { ControlPlaneDatabase, M4Orchestrator, Phase1GrantKey, createTestConfig, deriveApprovalId, type Clock } from "@chubz/control-plane";
import { buildCodexInvocationArgs, CodexCliAdapter, type CodexAdapterRequest } from "../src/codex-adapter.js";
import { CodexBridge } from "../src/codex-bridge.js";
import type { CodexProbeEvidence } from "../src/adapter-registry.js";
import { OperationJournal } from "../src/journal.js";
import { ProcessSupervisor, type ProcessSpawner, type ProcessTreeController, type SpawnedProcess, type TerminationEvidence } from "../src/process-supervisor.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const makeRoot = (): string => { const value = mkdtempSync(join(tmpdir(), "chubz-m5-codex-test-")); roots.push(value); return value; };
const sha = (value: string | Buffer): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const EVIDENCE_ID = `evidence.codex.sha256.${"a".repeat(64)}`;
const READINESS_ID = `readiness.codex.sha256.${"a".repeat(64)}`;
const git = (cwd: string, args: readonly string[]): string => execFileSync("git", [...args], { cwd, encoding: "utf8" });

class MutableClock implements Clock { public constructor(public milliseconds = Date.parse("2026-07-22T08:00:00.000Z")) {} public now(): Date { return new Date(this.milliseconds); } }
class FakeTrees implements ProcessTreeController {
  public constructor(private readonly proven = true) {}
  public async terminate(rootPid: number): Promise<TerminationEvidence> { const at = new Date().toISOString(); return { treeRole: "worker", rootPid, observedPids: [rootPid], terminatedPids: this.proven ? [rootPid] : [], livePids: this.proven ? [] : [rootPid], unknownPids: [], proven: this.proven, observedAt: at, completedAt: at }; }
}
type FakeBehavior = Readonly<{ stdout: string; stderr?: string; exitCode?: number; hang?: boolean; onClose?: (cwd: string) => void }>;
class FakeSpawner implements ProcessSpawner {
  public executions = 0; public stdin = ""; public args: readonly string[] = []; public cwd = ""; public env: Readonly<Record<string, string>> = {};
  public constructor(private readonly behavior: FakeBehavior) {}
  public spawn(_executable: string, args: readonly string[], options: Readonly<{ cwd: string; env: Readonly<Record<string, string>> }>): SpawnedProcess {
    this.executions += 1; this.args = [...args]; this.cwd = options.cwd; this.env = options.env;
    let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveExit = resolve; });
    return {
      pid: 42, stdout: Readable.from([Buffer.from(this.behavior.stdout)]), stderr: Readable.from([Buffer.from(this.behavior.stderr ?? "")]), exit,
      writeStdin: async (value) => { this.stdin += Buffer.from(value).toString("utf8"); },
      closeStdin: () => { this.behavior.onClose?.(options.cwd); if (!this.behavior.hang) resolveExit({ code: this.behavior.exitCode ?? 0, signal: null }); },
    };
  }
}
const providerOutput = (summary = "synthetic complete"): string => [
  { type: "thread.started", thread_id: "thread-synthetic" }, { type: "turn.started" },
  { type: "item.completed", item: { id: "item-1", type: "agent_message", text: JSON.stringify({ version: "1.0", kind: "codex.result", status: "completed", summary, artifacts: [] }) } },
  { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
].map((value) => JSON.stringify(value)).join("\n");

function workspace(write = false): Readonly<{ root: string; managedRoot: string; managedDataRoot: string; codexHome: string; worktree: string; executable: string; schema: string; scope: WriteScope; readiness: AdapterReadiness; provenance: CodexProbeEvidence }> {
  const root = makeRoot(); const managedRoot = join(root, "managed worktrees"); const worktree = join(managedRoot, "attempt-one"); const managedDataRoot = join(root, "managed data"); const codexHome = join(managedDataRoot, "codex-adapter-home"); mkdirSync(worktree, { recursive: true }); mkdirSync(codexHome, { recursive: true });
  git(worktree, ["init", "--quiet"]); writeFileSync(join(worktree, "base.txt"), "base"); git(worktree, ["add", "base.txt"]); git(worktree, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-m", "base", "--quiet"]);
  const executable = join(root, "codex fake.exe"); writeFileSync(executable, "fake codex executable");
  const schema = join(root, "result-schema.json"); writeFileSync(schema, JSON.stringify({ type: "object" }));
  const core = { scopeVersion: "1.0" as const, scopeId: "scope-one", repositoryRootId: "repository-one", worktreeRootId: "worktree-one", taskId: "task-one", attemptId: "attempt-one", operationId: "operation-one", allowedExactPaths: ["allowed.txt"], allowedPathPatterns: [], deniedPathClasses: ["credentials", "production", "infrastructure", "database", "mikrotik", "deployment", "unrelated-repository", "system"] as const, readOnlyPaths: [], generatedArtifactRoot: null, permissions: { create: write, modify: write, delete: write }, maxFiles: 1, maxBytes: 1024 };
  const digest = digestWriteScope(core); if (!digest.ok) throw new Error("scope digest failed"); const scope: WriteScope = { ...core, deniedPathClasses: [...core.deniedPathClasses], scopeHash: digest.value };
  const executableHash = sha(readFileSync(executable));
  const readiness: AdapterReadiness = { coordinationVersion: "1.0", readinessId: READINESS_ID, adapterId: "codex-cli-adapter", workerId: "codex-cli", connectorTier: "cli", providerId: "openai", runtimeId: "codex-cli", installedVersion: "0.144.4", executableId: "codex-native", executableHash, authenticationState: "authenticated", sandboxCapability: "validated", noninteractiveCapability: "validated", structuredOutputCapability: "validated", cancellationCapability: "validated", resumeCapability: "observed", healthStatus: "degraded", quotaVisibility: "unknown", freezeState: "enabled", capabilityProbeAt: "2026-07-22T08:00:00.000Z", readinessState: "degraded", capabilities: [{ capability: "code-write", assurance: "validated", evidenceRef: EVIDENCE_ID }, { capability: "review", assurance: "validated", evidenceRef: EVIDENCE_ID }], evidenceRefs: [EVIDENCE_ID] };
  const provenance: CodexProbeEvidence = { evidenceVersion: "1.0", evidenceId: EVIDENCE_ID, collectedBy: "local-bridge", executableIdentity: "codex-cli", launcherPath: executable, executablePath: executable, executableSha256: executableHash, version: "0.144.4", authenticationState: "authenticated", connectorTier: "cli", noninteractiveSupport: "OBSERVED", structuredOutputSupport: "OBSERVED", sandboxSupport: "OBSERVED", cancellationSupport: "VALIDATED", resumeSupport: "OBSERVED", artifactSupport: "OBSERVED", quotaStatus: "UNKNOWN", quotaConfidence: "UNKNOWN", rateLimitStatus: "UNKNOWN", probedAt: "2026-07-22T08:00:00.000Z", compatibility: "passed", windowsSandbox: { configuredImplementation: "elevated", selectedImplementation: "unelevated", elevatedProbeResult: "failed", elevatedFailureClassification: "WINDOWS_ELEVATED_SANDBOX_ACCESS_DENIED", fallbackSelected: true, fallbackCanaryResult: "passed", assurance: "degraded-bounded-local" } };
  return { root, managedRoot, managedDataRoot, codexHome, worktree, executable, schema, scope, readiness, provenance };
}
function request(value: ReturnType<typeof workspace>, signal?: AbortSignal): CodexAdapterRequest { return { taskId: "task-one", attemptId: "attempt-one", operationId: "operation-one", adapterRunId: "run-one", taskInstructions: "synthetic private task marker", executablePath: value.executable, worktreePath: value.worktree, managedWorktreeRoot: value.managedRoot, codexHome: value.codexHome, managedDataRoot: value.managedDataRoot, outputSchemaPath: value.schema, mode: value.scope.permissions.create ? "workspace-write" : "read-only", windowsSandboxImplementation: "unelevated", writeScope: value.scope, readiness: value.readiness, provenance: value.provenance, timeoutMs: 1_000, terminationDeadlineMs: 20, signal }; }

describe("M5 Codex CLI adapter evidence boundaries", () => {
  it("delivers task content only through stdin and accepts exit-zero strict structured completion", async () => {
    const value = workspace(); const spawner = new FakeSpawner({ stdout: providerOutput() }); const adapter = new CodexCliAdapter(new ProcessSupervisor(spawner, new FakeTrees()));
    const outcome = await adapter.run(request(value));
    expect(outcome).toMatchObject({ state: "completed", failureCode: null, parsedResult: { status: "completed" }, git: { valid: true, changes: [] } });
    expect(spawner.stdin).toBe("synthetic private task marker"); expect(spawner.args).not.toContain(spawner.stdin); expect(spawner.args.at(-1)).toBe("-"); expect(spawner.args).toEqual(expect.arrayContaining(["-c", "windows.sandbox=\"unelevated\"", "--sandbox", "read-only", "--ask-for-approval", "never"])); expect(spawner.args).not.toEqual(expect.arrayContaining(["default_permissions=:workspace"])); expect(spawner.args.join(" ")).not.toMatch(/projects\.|trust_level/u); expect(spawner.cwd.toLowerCase()).toContain(join("managed worktrees", "attempt-one").toLowerCase()); expect(spawner.env.CODEX_HOME?.toLowerCase()).toBe(realpathSync.native(value.codexHome).toLowerCase()); expect(spawner.env).not.toHaveProperty("OPENAI_API_KEY"); expect(spawner.env).not.toHaveProperty("CODEX_PERMISSION_PROFILE");
  });

  it("routes child state persistence only to the isolated CODEX_HOME and strips dangerous inheritance", async () => {
    const value = workspace(); const inheritedHome = join(value.root, "inherited shared home"); mkdirSync(inheritedHome); const inheritedConfig = join(inheritedHome, "config.toml"); const isolatedConfig = join(value.codexHome, "config.toml"); writeFileSync(inheritedConfig, "shared-baseline\n"); writeFileSync(isolatedConfig, "isolated-baseline\n");
    const previousHome = process.env.CODEX_HOME; const previousProfile = process.env.CODEX_PERMISSION_PROFILE; process.env.CODEX_HOME = inheritedHome; process.env.CODEX_PERMISSION_PROFILE = ":danger-full-access";
    const spawner = new FakeSpawner({ stdout: providerOutput(), onClose: () => writeFileSync(isolatedConfig, 'isolated-baseline\n[projects."C:/synthetic"]\ntrust_level="trusted"\n') });
    try {
      expect((await new CodexCliAdapter(new ProcessSupervisor(spawner, new FakeTrees())).run(request(value))).state).toBe("completed");
      expect(spawner.env.CODEX_HOME?.toLowerCase()).toBe(realpathSync.native(value.codexHome).toLowerCase()); expect(spawner.env).not.toHaveProperty("CODEX_PERMISSION_PROFILE");
      expect(readFileSync(inheritedConfig, "utf8")).toBe("shared-baseline\n"); expect(readFileSync(isolatedConfig, "utf8")).toContain("trust_level");
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
      if (previousProfile === undefined) delete process.env.CODEX_PERMISSION_PROFILE; else process.env.CODEX_PERMISSION_PROFILE = previousProfile;
    }
  });

  it("builds only bounded legacy permissions and rejects unknown, full-access, yolo, or profile mixing", () => {
    const args = buildCodexInvocationArgs({ mode: "workspace-write", windowsSandboxImplementation: "unelevated", outputSchemaPath: "C:\\schema.json", worktreePath: "C:\\worktree" });
    expect(args).toEqual(expect.arrayContaining(["windows.sandbox=\"unelevated\"", "--sandbox", "workspace-write", "--ask-for-approval", "never"]));
    expect(args.join(" ")).not.toMatch(/projects\.|trust_level/u);
    expect(args.join(" ")).not.toMatch(/default_permissions|permission-profile|danger-full-access|--yolo/u);
    expect(() => buildCodexInvocationArgs({ mode: "danger-full-access" as "workspace-write", windowsSandboxImplementation: "unelevated", outputSchemaPath: "x", worktreePath: "y" })).toThrow("unsupported Codex sandbox permission mode");
    expect(() => buildCodexInvocationArgs({ mode: "workspace-write", windowsSandboxImplementation: "unknown" as "unelevated", outputSchemaPath: "x", worktreePath: "y" })).toThrow("unknown Windows sandbox implementation");
  });

  it("blocks fallback canary failure, implementation mismatch, version drift, and silent read-only fallback", async () => {
    const unproven = workspace(true); const unprovenEvidence: CodexProbeEvidence = { ...unproven.provenance, compatibility: "not-run", windowsSandbox: { ...unproven.provenance.windowsSandbox, fallbackCanaryResult: "failed" } };
    const adapter = new CodexCliAdapter(new ProcessSupervisor(new FakeSpawner({ stdout: providerOutput() }), new FakeTrees()));
    await expect(adapter.run({ ...request(unproven), provenance: unprovenEvidence })).rejects.toThrow("not eligible");
    const mismatch = workspace(); await expect(adapter.run({ ...request(mismatch), windowsSandboxImplementation: "elevated" })).rejects.toThrow("differs from readiness evidence");
    const drift = workspace(); await expect(adapter.run({ ...request(drift), readiness: { ...drift.readiness, installedVersion: "0.145.0" } })).rejects.toThrow("path, version, or hash changed");
    const readOnly = workspace(true); const readOnlyAdapter = new CodexCliAdapter(new ProcessSupervisor(new FakeSpawner({ stdout: providerOutput(), stderr: "writing is blocked by read-only sandbox; rejected: blocked by policy" }), new FakeTrees()));
    expect(await readOnlyAdapter.run(request(readOnly))).toMatchObject({ state: "failed", failureCode: "SANDBOX_READ_ONLY_FALLBACK" });
  });

  it("separates nonzero exit authority from false-success text and rejects malformed, truncated, and unknown output", async () => {
    for (const behavior of [
      { stdout: providerOutput("claims success"), exitCode: 1, code: "NONZERO_EXIT" },
      { stdout: `${JSON.stringify({ type: "thread.started", thread_id: "x" })}\n`, code: "MALFORMED_OUTPUT" },
      { stdout: `${JSON.stringify({ type: "provider.unknown" })}\n`, code: "MALFORMED_OUTPUT" },
      { stdout: "x".repeat(600_000), code: "TRUNCATED_OUTPUT" },
    ]) {
      const value = workspace(); const adapter = new CodexCliAdapter(new ProcessSupervisor(new FakeSpawner(behavior), new FakeTrees()));
      const outcome = await adapter.run(request(value)); expect(outcome).toMatchObject({ state: "failed", failureCode: behavior.code });
      if (behavior.code !== "NONZERO_EXIT") expect(outcome.parsedResult).toBeNull();
    }
  });

  it("maps authentication expiry, rate limits, and quota exhaustion honestly", async () => {
    for (const [stderr, code] of [["authentication expired", "AUTHENTICATION_EXPIRED"], ["HTTP 429 rate limit", "RATE_LIMITED"], ["insufficient quota exhausted", "QUOTA_EXHAUSTED"]] as const) {
      const value = workspace(); const adapter = new CodexCliAdapter(new ProcessSupervisor(new FakeSpawner({ stdout: providerOutput(), stderr, exitCode: 1 }), new FakeTrees()));
      expect((await adapter.run(request(value))).failureCode).toBe(code);
    }
  });

  it("distinguishes proven timeout/cancellation from termination-unknown", async () => {
    const timedValue = workspace(); const timed = new CodexCliAdapter(new ProcessSupervisor(new FakeSpawner({ stdout: "", hang: true }), new FakeTrees()));
    expect(await timed.run({ ...request(timedValue), timeoutMs: 5 })).toMatchObject({ state: "failed", failureCode: "TIMEOUT" });
    const cancelledValue = workspace(); const controller = new AbortController(); controller.abort(); const cancelled = new CodexCliAdapter(new ProcessSupervisor(new FakeSpawner({ stdout: "", hang: true }), new FakeTrees()));
    expect(await cancelled.run(request(cancelledValue, controller.signal))).toMatchObject({ state: "cancelled", failureCode: "CANCELLED", run: { cancellationState: "confirmed" } });
    const unknownValue = workspace(); const unknownController = new AbortController(); unknownController.abort(); const unknown = new CodexCliAdapter(new ProcessSupervisor(new FakeSpawner({ stdout: "", hang: true }), new FakeTrees(false)));
    expect(await unknown.run(request(unknownValue, unknownController.signal))).toMatchObject({ state: "execution-unknown", failureCode: "EXECUTION_UNKNOWN" });
  });

  it("accepts one allowed write and blocks out-of-scope writes and Git ref movement", async () => {
    const allowed = workspace(true); const allowedAdapter = new CodexCliAdapter(new ProcessSupervisor(new FakeSpawner({ stdout: providerOutput(), onClose: (cwd) => writeFileSync(join(cwd, "allowed.txt"), "allowed") }), new FakeTrees()));
    expect(await allowedAdapter.run(request(allowed))).toMatchObject({ state: "completed", git: { valid: true, changes: [{ path: "allowed.txt", operation: "create", bytes: 7 }] } });
    const escaped = workspace(true); const escapedAdapter = new CodexCliAdapter(new ProcessSupervisor(new FakeSpawner({ stdout: providerOutput(), onClose: (cwd) => writeFileSync(join(cwd, "outside.txt"), "no") }), new FakeTrees()));
    expect(await escapedAdapter.run(request(escaped))).toMatchObject({ state: "failed", failureCode: "WORKTREE_POLICY_VIOLATION", git: { valid: false } });
    const committed = workspace(true); const committedAdapter = new CodexCliAdapter(new ProcessSupervisor(new FakeSpawner({ stdout: providerOutput(), onClose: (cwd) => { writeFileSync(join(cwd, "allowed.txt"), "commit"); git(cwd, ["add", "allowed.txt"]); git(cwd, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-m", "forbidden", "--quiet"]); } }), new FakeTrees()));
    expect(await committedAdapter.run(request(committed))).toMatchObject({ state: "failed", failureCode: "WORKTREE_POLICY_VIOLATION", git: { valid: false, failure: expect.stringContaining("HEAD") } });
  });
});

describe("M5 Codex integration with M4 assignment, grant, journal, and replay", () => {
  it("registers the typed full-digest evidence identity and rejects malformed, truncated, oversized, non-hex, or mismatched identities", () => {
    const value = workspace(); const database = new ControlPlaneDatabase(createTestConfig(value.root)); const key = new Phase1GrantKey("key-readiness-id", Buffer.alloc(32, 7)); const orchestrator = new M4Orchestrator(database, key);
    expect(orchestrator.registerCodexReadiness("valid-readiness-id", { readiness: value.readiness, evidence: value.provenance })).toEqual({ readinessId: READINESS_ID, state: "degraded" });
    const malformed = [
      `evidence.codex.sha256.${"b".repeat(63)}`,
      `evidence.codex.sha256.${"b".repeat(65)}`,
      `evidence.codex.sha256.${"B".repeat(64)}`,
      `evidence.codex.sha256.${"g".repeat(64)}`,
      `evidence-codex-${"b".repeat(48)}`,
    ];
    for (const [index, evidenceId] of malformed.entries()) {
      expect(() => orchestrator.registerCodexReadiness(`invalid-readiness-${index}`, { readiness: { ...value.readiness, readinessId: `readiness.codex.sha256.${"b".repeat(64)}`, evidenceRefs: [evidenceId], capabilities: value.readiness.capabilities.map((capability) => ({ ...capability, evidenceRef: evidenceId })) }, evidence: { ...value.provenance, evidenceId } })).toThrow("evidence identity is invalid");
    }
    expect(() => orchestrator.registerCodexReadiness("mismatched-readiness-id", { readiness: { ...value.readiness, readinessId: `readiness.codex.sha256.${"b".repeat(64)}` }, evidence: value.provenance })).toThrow("evidence identity is invalid");
    database.close(); key.destroy();
  });

  it("executes an explicitly assigned Codex attempt at most once and replays the durable result after restart", async () => {
    const value = workspace(); const database = new ControlPlaneDatabase(createTestConfig(value.root)); const clock = new MutableClock(); const key = new Phase1GrantKey("key-m5", Buffer.alloc(32, 9)); const orchestrator = new M4Orchestrator(database, key, clock);
    const taskInput = "synthetic Codex task"; const action: ApprovalAction = { actionVersion: "1.0", taskId: "task-one", attemptId: "attempt-one", operationId: "operation-one", operation: "worker.dispatch", policyClass: "worker-execution", target: { kind: "worker", resourceId: "codex-cli" }, parameters: { projectId: "project-one", workspaceId: "workspace-one", worker: { manifestId: "codex-cli", manifestVersion: "1.0.0" }, instructionDigest: sha(taskInput), contextArtifactIds: [] }, constraints: { timeoutSec: 5, requiresCleanWorktree: true, expectedArtifactId: null } };
    orchestrator.createTask("create-one", { taskId: "task-one", projectId: "project-one" }); orchestrator.createCodexAttempt("attempt-command-one", { taskId: "task-one", attemptId: "attempt-one", action, taskInput }); orchestrator.activateAttempt("task-one", "owner-one");
    orchestrator.registerCodexReadiness("readiness-command-one", { readiness: value.readiness, evidence: value.provenance });
    const assigned = orchestrator.assignCodex("assign-one", { taskId: "task-one", attemptId: "attempt-one", assignmentId: "assignment-one", leaseId: "lease-one", ownerAssignmentRef: "assignment-approval-one", leaseExpiresAt: new Date(clock.milliseconds + 600_000).toISOString(), readinessSnapshotRef: value.readiness.readinessId, writeScope: value.scope });
    const actionDigest = digestApprovalAction(action); if (!actionDigest.ok) throw new Error("digest failed");
    const approvalId = deriveApprovalId({ ownerId: "owner-one", taskId: "task-one", attemptId: "attempt-one", operationId: "operation-one", actionDigest: actionDigest.value, scopeHash: assigned.scopeHash, workerId: "codex-cli", adapterId: "codex-cli-adapter" });
    orchestrator.approveAndIssueCodex("issue-one", { taskId: "task-one", attemptId: "attempt-one", ownerId: "owner-one", approvalId, grantId: "grant-one", issuerId: "control-plane-one", lifetimeMs: 300_000 });
    const command = orchestrator.claimNextCodexDispatch(); const spawner = new FakeSpawner({ stdout: providerOutput() }); const adapter = new CodexCliAdapter(new ProcessSupervisor(spawner, new FakeTrees())); const journalPath = join(value.root, "bridge.sqlite"); const journal = new OperationJournal(journalPath); const bridge = new CodexBridge(journal, key.verifier(), adapter, () => clock.now()); bridge.registerAuthorization(command);
    const context = { executablePath: value.executable, worktreePath: value.worktree, managedWorktreeRoot: value.managedRoot, codexHome: value.codexHome, managedDataRoot: value.managedDataRoot, outputSchemaPath: value.schema, provenance: value.provenance, windowsSandboxImplementation: "unelevated" as const };
    const start = () => { if (orchestrator.getTask("task-one").state === "AWAITING_DISPATCH") orchestrator.acknowledgeDispatch("task-one", "operation-one"); };
    const [first, duplicate] = await Promise.all([bridge.execute(command, context, { onStarted: start }), bridge.execute(command, context, { onStarted: start })]);
    expect(first).toEqual(duplicate); expect(first.state).toBe("completed"); expect(spawner.executions).toBe(1);
    const { adapterOutcome: _ignored, ...controlResult } = first; expect(orchestrator.recordBridgeResult("result-command-one", "task-one", controlResult)).toMatchObject({ state: "RESULT_CAPTURED" });
    journal.close(); const reopened = new OperationJournal(journalPath); const replacementSpawner = new FakeSpawner({ stdout: providerOutput() }); const replacement = new CodexBridge(reopened, key.verifier(), new CodexCliAdapter(new ProcessSupervisor(replacementSpawner, new FakeTrees())), () => clock.now());
    expect(replacement.registerAuthorization(command)).toBe("duplicate"); expect((await replacement.execute(command, context)).state).toBe("completed"); expect(replacementSpawner.executions).toBe(0);
    reopened.close(); database.close(); key.destroy();
  });

  it("checks disabled state before dispatch and reconciles ambiguous started work without rerun", async () => {
    const value = workspace(); const database = new ControlPlaneDatabase(createTestConfig(value.root)); const clock = new MutableClock(); const key = new Phase1GrantKey("key-disabled", Buffer.alloc(32, 8)); const orchestrator = new M4Orchestrator(database, key, clock);
    const taskInput = "synthetic"; const action: ApprovalAction = { actionVersion: "1.0", taskId: "task-one", attemptId: "attempt-one", operationId: "operation-one", operation: "worker.dispatch", policyClass: "worker-execution", target: { kind: "worker", resourceId: "codex-cli" }, parameters: { projectId: "project-one", workspaceId: "workspace-one", worker: { manifestId: "codex-cli", manifestVersion: "1.0.0" }, instructionDigest: sha(taskInput), contextArtifactIds: [] }, constraints: { timeoutSec: 5, requiresCleanWorktree: true, expectedArtifactId: null } };
    orchestrator.createTask("create-two", { taskId: "task-one", projectId: "project-one" }); orchestrator.createCodexAttempt("attempt-two", { taskId: "task-one", attemptId: "attempt-one", action, taskInput }); orchestrator.activateAttempt("task-one", "owner-one"); orchestrator.registerCodexReadiness("readiness-two", { readiness: value.readiness, evidence: value.provenance }); const assigned = orchestrator.assignCodex("assign-two", { taskId: "task-one", attemptId: "attempt-one", assignmentId: "assignment-one", leaseId: "lease-one", ownerAssignmentRef: "owner-assignment", leaseExpiresAt: new Date(clock.milliseconds + 600_000).toISOString(), readinessSnapshotRef: value.readiness.readinessId, writeScope: value.scope }); const digest = digestApprovalAction(action); if (!digest.ok) throw new Error(); const approvalId = deriveApprovalId({ ownerId: "owner-one", taskId: "task-one", attemptId: "attempt-one", operationId: "operation-one", actionDigest: digest.value, scopeHash: assigned.scopeHash, workerId: "codex-cli", adapterId: "codex-cli-adapter" }); orchestrator.approveAndIssueCodex("issue-two", { taskId: "task-one", attemptId: "attempt-one", ownerId: "owner-one", approvalId, grantId: "grant-one", issuerId: "control-plane", lifetimeMs: 300_000 });
    orchestrator.setM5WorkerState("codex-cli", "disabled"); expect(() => orchestrator.claimNextCodexDispatch()).toThrow("disabled"); orchestrator.setM5WorkerState("codex-cli", "enabled"); const command = orchestrator.claimNextCodexDispatch();
    const journalPath = join(value.root, "restart.sqlite"); const journal = new OperationJournal(journalPath); const originalClose = vi.spyOn(journal, "close"); const bridge = new CodexBridge(journal, key.verifier(), new CodexCliAdapter(new ProcessSupervisor(new FakeSpawner({ stdout: providerOutput() }), new FakeTrees())), () => clock.now()); bridge.registerAuthorization(command); const context = { executablePath: value.executable, worktreePath: value.worktree, managedWorktreeRoot: value.managedRoot, codexHome: value.codexHome, managedDataRoot: value.managedDataRoot, outputSchemaPath: value.schema, provenance: value.provenance, windowsSandboxImplementation: "unelevated" as const };
    await expect(bridge.execute(command, context, { failpoint: "after-start-before-execution" })).rejects.toThrow(); bridge.close(); expect(originalClose).toHaveBeenCalledTimes(1); expect(() => bridge.registerAuthorization(command)).toThrow("Codex bridge is closed"); await expect(bridge.execute(command, context)).rejects.toThrow("Codex bridge is closed");
    const reopened = new OperationJournal(journalPath); const replacementClose = vi.spyOn(reopened, "close"); const replacementSpawner = new FakeSpawner({ stdout: providerOutput() }); const replacement = new CodexBridge(reopened, key.verifier(), new CodexCliAdapter(new ProcessSupervisor(replacementSpawner, new FakeTrees())), () => clock.now());
    expect(replacement.registerAuthorization(command)).toBe("duplicate"); expect(replacement.reconcileAfterRestart()[0]).toMatchObject({ state: "execution-unknown" }); expect((await replacement.execute(command, context)).state).toBe("execution-unknown");
    const drifted: CodexProbeEvidence = { ...value.provenance, compatibility: "drifted", windowsSandbox: { ...value.provenance.windowsSandbox, fallbackCanaryResult: "drifted" } }; await expect(replacement.execute(command, { ...context, provenance: drifted })).rejects.toThrow("READINESS_NOT_ELIGIBLE"); expect(replacementSpawner.executions).toBe(0);
    replacement.close(); expect(replacementClose).toHaveBeenCalledTimes(1); expect(() => replacement.close()).toThrow("Codex bridge is closed"); expect(replacementClose).toHaveBeenCalledTimes(1); database.close(); key.destroy();
  });
});
