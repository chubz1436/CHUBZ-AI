import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneDatabase, toControlPlaneConfig, type M11RuntimeConfiguration } from "@chubz/control-plane";
import type { EmergencyStopGate } from "../src/emergency-stop.js";
import { SqliteEmergencyStopGate } from "../src/emergency-stop.js";
import type { OutboundConnection, OutboundConnector } from "../src/connection.js";
import { NodeProcessSpawner, ProcessSupervisor, WindowsProcessTreeController, type ProcessRunRequest, type ProcessSpawner, type SpawnedProcess } from "../src/process-supervisor.js";
import { PackagedLocalBridgeRuntime } from "../src/runtime.js";
import { SafeApplyExecutor, type M9PrepareRequest } from "../src/safe-apply.js";

const exec = promisify(execFile);
const roots: string[] = [];
const git = async (cwd: string, args: readonly string[]): Promise<string> => (await exec("git", [...args], { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } })).stdout.trim();
const hash = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const identity = (path: string): `sha256:${string}` => hash((process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path)).replace(/^\\\\\?\\/u, ""));

type Repositories = Readonly<{ source: string; target: string; applyRoot: string; baseline: string; reviewed: string }>;

async function repositories(root: string, label: string): Promise<Repositories> {
  const seed = resolve(root, `${label}-seed`); const source = resolve(root, `${label}-source`); const target = resolve(root, `${label}-target`); const remote = resolve(root, `${label}-target.git`); const applyRoot = resolve(root, `${label}-apply`);
  await mkdir(seed); await git(seed, ["init", "-b", "main"]); await writeFile(resolve(seed, "file.txt"), "baseline\n"); await git(seed, ["add", "file.txt"]); await git(seed, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "baseline"]); const baseline = await git(seed, ["rev-parse", "HEAD"]);
  await git(root, ["clone", "--no-local", seed, source]); await git(root, ["clone", "--bare", "--no-local", seed, remote]); await git(root, ["clone", "--no-local", remote, target]); await git(target, ["checkout", "--detach", baseline]);
  await writeFile(resolve(source, "file.txt"), "baseline\nreviewed\n"); await git(source, ["add", "file.txt"]); await git(source, ["-c", "user.name=Worker", "-c", "user.email=worker@invalid", "commit", "-m", "reviewed"]); const reviewed = await git(source, ["rev-parse", "HEAD"]); await mkdir(applyRoot);
  return { source, target, applyRoot, baseline, reviewed };
}

const configuration = (root: string): M11RuntimeConfiguration => Object.freeze({ configVersion: 1, controlPlane: Object.freeze({ host: "127.0.0.1", port: 4317, allowedOrigin: "http://127.0.0.1:4317", sessionSecretRef: "environment:CHUBZ_TEST_SESSION_SECRET" }), bridge: Object.freeze({ endpoint: "ws://127.0.0.1:4317/v1/bridge/ws", enrollmentIdentity: "local-bridge", heartbeatIntervalMs: 60_000 }), paths: Object.freeze({ approvedManagedRoots: Object.freeze([root]), managedDataRoot: join(root, "runtime-data"), databaseFile: "control-plane.sqlite", logsDirectory: "logs", supportBundlesDirectory: "support", packagesDirectory: "packages" }), bounds: Object.freeze({ logMaxBytes: 65_536, logRetentionFiles: 2, captureMaxBytes: 65_536, packageMaxBytes: 1_048_576, packageMaxFiles: 100, supportBundleMaxBytes: 1_048_576, supportBundleMaxFiles: 16, storageWarningPercent: 90 }), retention: Object.freeze({ operationalLogDays: 14, resolvedAlertDays: 30, supportBundleDays: 30, packagingStagingHours: 24 }), projects: Object.freeze([]), display: Object.freeze({ productName: "CHUBZ", environmentLabel: "M9 correction test" }) });
const request = (repos: Repositories, applyId: string, targetProjectId = "project-target"): M9PrepareRequest => ({ applyId, ownerId: "owner-test", sourceProjectId: "project-source", targetProjectId, taskId: "task-test", attemptId: "attempt-test", operationId: "operation-test", workerId: "codex-cli", adapterId: "codex-cli", captureId: "capture-test", packageId: "package-test", packageSchemaVersion: "m7.review-package/v1", packageDigest: hash("package"), manifestDigest: hash("manifest"), sourceRepositoryPath: repos.source, sourceRepositoryIdentity: identity(repos.source), reviewedBaseline: repos.baseline, reviewedCommit: repos.reviewed, reviewedChangedPaths: ["file.txt"], targetRepositoryPath: repos.target, targetRepositoryIdentity: identity(repos.target), targetRef: "refs/heads/main", expectedTargetHead: repos.baseline, applyMode: "exact-reviewed-commit", applyRoot: repos.applyRoot, validationPlanId: "required", validations: [{ validationId: "node-pass", kind: "test", executable: process.execPath, args: ["-e", "console.log('1 test passed')"], cwd: ".", timeoutMs: 10_000 }], preparationDigest: hash("preparation") });

class FakeConnector implements OutboundConnector { public connect(): Promise<OutboundConnection> { return Promise.resolve({ send: () => undefined, close: () => undefined }); } }
class RecordingSpawner implements ProcessSpawner {
  public calls = 0;
  public constructor(private readonly delegate = new NodeProcessSpawner()) {}
  public spawn(executable: string, args: readonly string[], options: Readonly<{ cwd: string; env: Readonly<Record<string, string>> }>): SpawnedProcess { this.calls += 1; return this.delegate.spawn(executable, args, options); }
}
class ObservingGate implements EmergencyStopGate {
  public scopes: Array<Readonly<{ projectId: string; operationId: string }>> = [];
  public assertAllowed(): void {}
  public runBeforeSpawn<T>(projectId: string, operationId: string, spawn: () => T): T { this.scopes.push({ projectId, operationId }); return spawn(); }
  public close(): void {}
}
const activate = (database: ControlPlaneDatabase, stopId: string, scope: "global" | "project", projectId: string | null): void => { database.connection.prepare("INSERT INTO m8_emergency_stops(stop_id,scope_type,project_id,owner_id,reason,status,activated_at) VALUES(?,?,?,?,?,'active',?)").run(stopId, scope, projectId, "owner", "correction test", new Date().toISOString()); };
const processRequest = (scope?: Readonly<{ projectId: string; operationId: string }>): ProcessRunRequest => ({ executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: process.cwd(), env: {}, taskContent: "", role: "validator", timeoutMs: 10_000, terminationDeadlineMs: 1_000, maxOutputBytes: 8_192, emergencyScope: scope });

afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

describe("M11 correction: M9 validation emergency-stop scope", () => {
  it("runs the packaged Bridge prepare-to-validation path with no stop and binds the target project plus apply operation", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chubz-m11-m9-packaged-"))); roots.push(root); const config = configuration(root); await mkdir(config.paths.managedDataRoot, { recursive: true }); const database = new ControlPlaneDatabase(toControlPlaneConfig(config, "synthetic-session-secret-at-least-thirty-two-bytes", "test")); const repos = await repositories(root, "packaged"); const runtime = new PackagedLocalBridgeRuntime({ configuration: config, sessionSecret: "synthetic-session-secret-at-least-thirty-two-bytes", connector: new FakeConnector() });
    try { await runtime.start(); const result = await runtime.prepareApply(request(repos, "apply-packaged-pass")); expect(result.status).toBe("ready"); expect(result.validations).toMatchObject([{ outcome: "passed", exitCode: 0 }]); expect(result.preparedHead).not.toBe(repos.baseline); expect(await git(repos.target, ["rev-parse", "refs/heads/main"])).toBe(repos.baseline); }
    finally { await runtime.stop(); database.close(); }
  }, 30_000);

  it("derives the final supervisor scope from authoritative M9 target and apply bindings", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chubz-m11-m9-scope-"))); roots.push(root); const repos = await repositories(root, "scope"); const spawner = new RecordingSpawner(); const gate = new ObservingGate(); const executor = new SafeApplyExecutor(root, undefined, new ProcessSupervisor(spawner, new WindowsProcessTreeController(), gate)); const input = request(repos, "apply-authoritative-scope", "project-authoritative-target"); const result = await executor.prepare(input);
    expect(result.status).toBe("ready"); expect(spawner.calls).toBe(1); expect(gate.scopes).toEqual([{ projectId: "project-authoritative-target", operationId: "apply-authoritative-scope" }]);
  }, 30_000);

  it("blocks matching project and global validation spawns while allowing an unrelated project", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chubz-m11-m9-stops-"))); roots.push(root); const config = configuration(root); await mkdir(config.paths.managedDataRoot, { recursive: true }); const database = new ControlPlaneDatabase(toControlPlaneConfig(config, "synthetic-session-secret-at-least-thirty-two-bytes", "test")); database.connection.prepare("INSERT INTO administrators(id,username,password_hash,created_at) VALUES('owner','owner','synthetic',?)").run(new Date().toISOString()); const gate = new SqliteEmergencyStopGate(join(config.paths.managedDataRoot, config.paths.databaseFile)); const spawner = new RecordingSpawner(); const executor = new SafeApplyExecutor(root, undefined, new ProcessSupervisor(spawner, new WindowsProcessTreeController(), gate));
    try {
      activate(database, "stop-project", "project", "project-target"); const blocked = await repositories(root, "blocked"); await expect(executor.prepare(request(blocked, "apply-project-blocked"))).rejects.toThrow("emergency stop"); expect(spawner.calls).toBe(0);
      const allowed = await repositories(root, "allowed"); expect((await executor.prepare(request(allowed, "apply-other-allowed", "project-other"))).status).toBe("ready"); expect(spawner.calls).toBe(1);
      activate(database, "stop-global", "global", null); const globallyBlocked = await repositories(root, "global"); await expect(executor.prepare(request(globallyBlocked, "apply-global-blocked", "project-other"))).rejects.toThrow("emergency stop"); expect(spawner.calls).toBe(1);
    } finally { gate.close(); database.close(); }
  }, 60_000);

  it("blocks a stop activated at the serialized pre-spawn boundary and never auto-resumes after release", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chubz-m11-m9-race-"))); roots.push(root); const config = configuration(root); await mkdir(config.paths.managedDataRoot, { recursive: true }); const database = new ControlPlaneDatabase(toControlPlaneConfig(config, "synthetic-session-secret-at-least-thirty-two-bytes", "test")); database.connection.prepare("INSERT INTO administrators(id,username,password_hash,created_at) VALUES('owner','owner','synthetic',?)").run(new Date().toISOString()); const authoritative = new SqliteEmergencyStopGate(join(config.paths.managedDataRoot, config.paths.databaseFile)); const boundaryGate: EmergencyStopGate = { assertAllowed: (projectId) => authoritative.assertAllowed(projectId), runBeforeSpawn: (projectId, operationId, spawn) => { activate(database, "stop-boundary", "project", projectId); return authoritative.runBeforeSpawn(projectId, operationId, spawn); }, close: () => authoritative.close() }; const spawner = new RecordingSpawner(); const repos = await repositories(root, "race"); const executor = new SafeApplyExecutor(root, undefined, new ProcessSupervisor(spawner, new WindowsProcessTreeController(), boundaryGate)); const input = request(repos, "apply-boundary-race");
    try { await expect(executor.prepare(input)).rejects.toThrow("emergency stop"); expect(spawner.calls).toBe(0); database.connection.prepare("UPDATE m8_emergency_stops SET status='released',released_at=? WHERE stop_id='stop-boundary'").run(new Date().toISOString()); await new Promise((resolvePromise) => setImmediate(resolvePromise)); expect(spawner.calls).toBe(0); await expect(executor.prepare(input)).rejects.toThrow("uncertain"); expect(spawner.calls).toBe(0); const journal = JSON.parse(await readFile(resolve(repos.applyRoot, input.applyId, "apply-journal.json"), "utf8")) as { stage: string; result: unknown }; expect(journal).toMatchObject({ stage: "apply-unknown", result: null }); }
    finally { boundaryGate.close(); database.close(); }
  }, 30_000);

  it("fails closed before spawning for missing, malformed, stale, or unqueryable scope authority", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chubz-m11-m9-invalid-"))); roots.push(root); const config = configuration(root); await mkdir(config.paths.managedDataRoot, { recursive: true }); const database = new ControlPlaneDatabase(toControlPlaneConfig(config, "synthetic-session-secret-at-least-thirty-two-bytes", "test")); const gate = new SqliteEmergencyStopGate(join(config.paths.managedDataRoot, config.paths.databaseFile)); const spawner = new RecordingSpawner(); const supervisor = new ProcessSupervisor(spawner, new WindowsProcessTreeController(), gate);
    await expect(supervisor.run(processRequest())).rejects.toThrow("scope is required"); await expect(supervisor.run(processRequest({ projectId: "../invalid", operationId: "apply-one" }))).rejects.toThrow("scope identity is invalid"); database.connection.exec("DROP TABLE m8_emergency_stops"); await expect(supervisor.run(processRequest({ projectId: "project-one", operationId: "apply-one" }))).rejects.toThrow("state is unavailable"); gate.close(); await expect(supervisor.run(processRequest({ projectId: "project-one", operationId: "apply-one" }))).rejects.toThrow("authority is unavailable"); expect(spawner.calls).toBe(0); database.close();
  });
});
