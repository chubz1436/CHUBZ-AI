import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  parseAdapterReadiness,
  parseQuotaSnapshot,
  validateWorkerManifest,
  type AdapterReadiness,
  type QuotaSnapshot,
  type WorkerManifest,
} from "@chubz/shared";

const execFileAsync = promisify(execFile);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PROBE_MAX_BUFFER = 512 * 1024;
const WINDOWS_NATIVE_RELATIVE = join(
  "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64",
  "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe",
);

const codexManifestCandidate = {
  workerId: "codex-cli",
  displayName: "Codex CLI",
  provider: "OpenAI",
  runtime: "installed Codex CLI",
  connector: {
    type: "cli-headless",
    invocation: {
      executable: "codex",
      args: ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config"],
      promptDelivery: "stdin",
    },
    healthCheck: "version-invocation",
    timeoutPolicy: { timeoutSec: 900, killGraceSec: 10 },
    cancelable: true,
  },
  capabilities: ["code-write", "review", "design", "text-output"],
  restrictions: ["assigned-only"],
  allowedTaskCategories: ["implementation", "review", "design"],
  defaultRiskLevel: "medium",
  contextLimits: { maxFiles: 1_000, maxBytes: 67_108_864 },
  supportedFileOps: ["read", "write-workspace"],
  requiredApprovals: ["worker-dispatch"],
  provenanceMode: "automated",
} as const;

const manualManifestCandidate = {
  workerId: "manual-relay",
  displayName: "Owner-attested manual relay",
  provider: "owner-selected",
  runtime: "human relay",
  connector: {
    type: "manual-relay",
    healthCheck: "manual-attestation",
    timeoutPolicy: { timeoutSec: 86_400, killGraceSec: 0 },
    cancelable: false,
  },
  capabilities: ["review", "design", "text-output"],
  restrictions: ["assigned-only", "manual-import-only"],
  allowedTaskCategories: ["review", "design", "text-output"],
  defaultRiskLevel: "medium",
  contextLimits: { maxFiles: 16, maxBytes: 16_777_216 },
  supportedFileOps: ["read"],
  requiredApprovals: ["owner-attestation"],
  provenanceMode: "owner-attested",
} as const;

function authoritativeManifest(candidate: unknown): WorkerManifest {
  const parsed = validateWorkerManifest(candidate);
  if (!parsed.valid) throw new Error(`invalid authoritative adapter manifest: ${parsed.issues.map((issue) => issue.path).join(",")}`);
  return parsed.manifest;
}

export const CODEX_CLI_MANIFEST = authoritativeManifest(codexManifestCandidate);
export const MANUAL_RELAY_MANIFEST = authoritativeManifest(manualManifestCandidate);

export type ExecutableResolution = Readonly<{
  requestedName: "codex";
  launcherPath: string;
  executablePath: string;
  launcherKind: "native" | "npm-cmd";
}>;

export type WindowsSandboxImplementation = "elevated" | "unelevated";
export type WindowsSandboxRuntimeProfile = Readonly<{
  configuredImplementation: WindowsSandboxImplementation;
  selectedImplementation: WindowsSandboxImplementation;
  elevatedProbeResult: "passed" | "failed";
  elevatedFailureClassification: "WINDOWS_ELEVATED_SANDBOX_ACCESS_DENIED" | "WINDOWS_ELEVATED_SANDBOX_SETUP_FAILED" | null;
}>;

export type CodexAdapterHome = Readonly<{ managedDataRoot: string; codexHome: string; configPath: string; configCreated: boolean }>;
const CODEX_ADAPTER_CONFIG = `cli_auth_credentials_store = "file"\n\n[history]\npersistence = "none"\n\n[windows]\nsandbox = "unelevated"\n`;
const canonicalFilesystemPath = (value: string): string => process.platform === "win32" ? resolve(value).replace(/^\\\\\?\\/u, "").toLowerCase() : resolve(value);
const pathContained = (root: string, candidate: string): boolean => {
  const rel = relative(canonicalFilesystemPath(root), canonicalFilesystemPath(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
async function rejectLinkPath(path: string): Promise<void> {
  const absolute = resolve(path); const parsed = parsePath(absolute); const parts = absolute.slice(parsed.root.length).split(sep).filter(Boolean); let cursor = parsed.root;
  for (const part of parts) { cursor = resolve(cursor, part); try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error("isolated CODEX_HOME path contains a link or junction"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; } }
}
export async function prepareCodexAdapterHome(input: Readonly<{ managedDataRoot: string; repositoryRoot: string; sharedCodexHome: string }>): Promise<CodexAdapterHome> {
  if (![input.managedDataRoot, input.repositoryRoot, input.sharedCodexHome].every((value) => isAbsolute(value))) throw new Error("Codex adapter roots must be absolute");
  await rejectLinkPath(input.managedDataRoot); await rejectLinkPath(input.sharedCodexHome); const managedDataRoot = await realpath(input.managedDataRoot); const repositoryRoot = await realpath(input.repositoryRoot); const sharedCodexHome = await realpath(input.sharedCodexHome);
  if (pathContained(repositoryRoot, managedDataRoot) || pathContained(managedDataRoot, repositoryRoot)) throw new Error("Codex adapter state must remain outside the Git working tree");
  const codexHomeCandidate = resolve(managedDataRoot, ".managed-data", "codex-adapter-home");
  if (!pathContained(managedDataRoot, codexHomeCandidate) || canonicalFilesystemPath(codexHomeCandidate) === canonicalFilesystemPath(managedDataRoot)) throw new Error("isolated CODEX_HOME escaped the managed data root");
  if (pathContained(sharedCodexHome, codexHomeCandidate) || pathContained(codexHomeCandidate, sharedCodexHome)) throw new Error("shared CODEX_HOME is forbidden");
  await rejectLinkPath(codexHomeCandidate); await mkdir(codexHomeCandidate, { recursive: true, mode: 0o700 }); await rejectLinkPath(codexHomeCandidate); const codexHome = await realpath(codexHomeCandidate);
  if (!pathContained(managedDataRoot, codexHome)) throw new Error("isolated CODEX_HOME resolved outside the managed data root");
  const configPath = join(codexHome, "config.toml"); let configCreated = false;
  try { await writeFile(configPath, CODEX_ADAPTER_CONFIG, { encoding: "utf8", flag: "wx", mode: 0o600 }); configCreated = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const settings = sanitizedCodexSecuritySettings(await readFile(configPath, "utf8")); assertSafeCodexSecuritySettings(settings);
  return Object.freeze({ managedDataRoot, codexHome, configPath, configCreated });
}

export function assertIsolatedCodexAuthenticated(authenticationState: "authenticated" | "expired" | "missing" | "unknown", codexHome: string): void {
  if (authenticationState !== "authenticated") throw new Error(`isolated CODEX_HOME authentication is unavailable; owner login required at ${codexHome}`);
}

export type CodexConfigSnapshot = Readonly<{
  canonicalPath: string;
  sha256: string;
  size: number;
  lastWriteTimestamp: string;
  fileIdentity: string;
  securityRelevantSettings: Readonly<Record<string, string>>;
}>;
export type CodexConfigStageObservation = Readonly<{
  stage: string;
  before: CodexConfigSnapshot;
  after: CodexConfigSnapshot;
  childCodexPids: readonly number[];
  preExistingCodexPids: readonly number[];
  watcherEvents: readonly Readonly<{ eventType: string; observedAt: string }>[];
}>;
export type SanitizedCodexConfigChange = Readonly<{ path: string; before: string; after: string }>;

const CONFIG_SAFE_VALUE = /(^|\.)(windows\.sandbox|sandbox|sandbox_mode|default_permissions|approval_policy|sandbox_workspace_write|profile|selected_profile|active_profile)$/iu;
const CONFIG_SECURITY_PATH = /sandbox|permission|approval|profile|danger|managed|requirements/iu;
const CONFIG_DANGEROUS_VALUE = /danger-full-access|--yolo|\byolo\b|bypass|full-access/iu;
const stripTomlComment = (value: string): string => {
  let single = false; let double = false; let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && double) { escaped = true; continue; }
    if (character === "'" && !double) single = !single;
    else if (character === '"' && !single) double = !double;
    else if (character === "#" && !single && !double) return value.slice(0, index).trim();
  }
  return value.trim();
};
const tomlAssignments = (text: string): ReadonlyMap<string, string> => {
  let section = ""; const assignments = new Map<string, string>();
  for (const rawLine of text.replaceAll("\r\n", "\n").split("\n")) {
    const line = rawLine.trim(); if (line === "" || line.startsWith("#")) continue;
    const table = /^\[([^\]]+)\]$/u.exec(line); if (table) { section = table[1]!.trim(); continue; }
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/u.exec(line); if (!assignment) continue;
    const path = section === "" ? assignment[1]! : `${section}.${assignment[1]!}`;
    assignments.set(path, stripTomlComment(assignment[2]!));
  }
  return assignments;
};
export const sanitizedCodexSecuritySettings = (text: string): Readonly<Record<string, string>> => Object.freeze(Object.fromEntries(
  [...tomlAssignments(text)].filter(([path]) => CONFIG_SECURITY_PATH.test(path)).map(([path, value]) => [path, CONFIG_SAFE_VALUE.test(path) ? value : "<redacted>"]),
));
export const sanitizedCodexConfigDiff = (before: string, after: string): readonly SanitizedCodexConfigChange[] => {
  const left = tomlAssignments(before); const right = tomlAssignments(after); const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  return Object.freeze(paths.flatMap((path) => left.get(path) === right.get(path) ? [] : [Object.freeze({ path, before: CONFIG_SAFE_VALUE.test(path) ? left.get(path) ?? "<absent>" : left.has(path) ? "<redacted>" : "<absent>", after: CONFIG_SAFE_VALUE.test(path) ? right.get(path) ?? "<absent>" : right.has(path) ? "<redacted>" : "<absent>" })]));
};
export const assertSafeCodexSecuritySettings = (settings: Readonly<Record<string, string>>): void => {
  for (const [path, value] of Object.entries(settings)) if (CONFIG_DANGEROUS_VALUE.test(path) || CONFIG_DANGEROUS_VALUE.test(value)) throw new Error(`dangerous Codex permission setting is active at ${path}`);
};
export const snapshotCodexConfig = async (path: string): Promise<CodexConfigSnapshot> => {
  const canonicalPath = await realpath(path); const [bytes, metadata] = await Promise.all([readFile(canonicalPath), stat(canonicalPath, { bigint: true })]);
  const securityRelevantSettings = sanitizedCodexSecuritySettings(bytes.toString("utf8")); assertSafeCodexSecuritySettings(securityRelevantSettings);
  return Object.freeze({ canonicalPath, sha256: createHash("sha256").update(bytes).digest("hex"), size: Number(metadata.size), lastWriteTimestamp: metadata.mtime.toISOString(), fileIdentity: `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`, securityRelevantSettings });
};
const sameConfigSnapshot = (left: CodexConfigSnapshot, right: CodexConfigSnapshot): boolean => left.canonicalPath === right.canonicalPath && left.sha256 === right.sha256 && left.size === right.size && left.lastWriteTimestamp === right.lastWriteTimestamp && left.fileIdentity === right.fileIdentity && JSON.stringify(left.securityRelevantSettings) === JSON.stringify(right.securityRelevantSettings);

export class CodexConfigIntegrityError extends Error {
  public constructor(public readonly observation: CodexConfigStageObservation, public readonly changes: readonly SanitizedCodexConfigChange[], public readonly diagnosticCopyPath: string | null) { super(`global Codex config changed during stage ${observation.stage}`); this.name = "CodexConfigIntegrityError"; }
}

export class CodexConfigIntegrityMonitor {
  private readonly observations: CodexConfigStageObservation[] = [];
  private readonly events: Array<{ eventType: string; observedAt: string }> = [];
  private watcher: FSWatcher | null = null;
  private baseline: CodexConfigSnapshot | null = null;
  public constructor(private readonly configPath: string, private readonly preExistingCodexPids: readonly number[], private readonly diagnosticParent = tmpdir(), private readonly createDiagnosticCopies = true) {}
  public async start(): Promise<CodexConfigSnapshot> {
    if (this.watcher !== null) throw new Error("Codex config monitor is already active");
    this.baseline = await snapshotCodexConfig(this.configPath);
    this.watcher = watch(this.baseline.canonicalPath, { persistent: false }, (eventType) => this.events.push({ eventType, observedAt: new Date().toISOString() }));
    return this.baseline;
  }
  public async runStage<T>(stage: string, childCodexPids: () => readonly number[], action: () => Promise<T> | T): Promise<T> {
    if (this.watcher === null || this.baseline === null) throw new Error("Codex config monitor is not active");
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(stage)) throw new Error("config stage identity is invalid");
    const before = await snapshotCodexConfig(this.configPath); const eventOffset = this.events.length;
    if (!sameConfigSnapshot(before, this.baseline)) throw new Error(`global Codex config changed before stage ${stage}`);
    let diagnosticDirectory: string | null = null; let diagnosticCopyPath: string | null = null; let beforeText: string | null = null;
    if (this.createDiagnosticCopies) {
      diagnosticDirectory = await mkdtemp(join(this.diagnosticParent, `chubz-codex-config-${stage}-`)); await chmod(diagnosticDirectory, 0o700);
      diagnosticCopyPath = join(diagnosticDirectory, "before-stage.config.toml"); await copyFile(before.canonicalPath, diagnosticCopyPath); await chmod(diagnosticCopyPath, 0o600);
    } else beforeText = await readFile(before.canonicalPath, "utf8");
    let value: T | undefined; let actionError: unknown;
    try { value = await action(); } catch (error) { actionError = error; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    const after = await snapshotCodexConfig(this.configPath); const watcherEvents = Object.freeze(this.events.slice(eventOffset).map((event) => Object.freeze({ ...event })));
    const observation = Object.freeze({ stage, before, after, childCodexPids: Object.freeze([...new Set(childCodexPids())]), preExistingCodexPids: Object.freeze([...this.preExistingCodexPids]), watcherEvents });
    this.observations.push(observation);
    if (!sameConfigSnapshot(before, after) || watcherEvents.length > 0) {
      const changes = sanitizedCodexConfigDiff(diagnosticCopyPath === null ? beforeText! : await readFile(diagnosticCopyPath, "utf8"), await readFile(after.canonicalPath, "utf8"));
      throw new CodexConfigIntegrityError(observation, changes, diagnosticCopyPath);
    }
    if (diagnosticDirectory !== null) await rm(diagnosticDirectory, { recursive: true, force: true });
    if (actionError !== undefined) throw actionError;
    return value as T;
  }
  public evidence(): readonly CodexConfigStageObservation[] { return Object.freeze([...this.observations]); }
  public close(): void { if (this.watcher === null) throw new Error("Codex config monitor is not active"); this.watcher.close(); this.watcher = null; }
}

function validateWindowsSandboxProfile(profile: WindowsSandboxRuntimeProfile): void {
  if (!(["elevated", "unelevated"] as const).includes(profile.configuredImplementation) || !(["elevated", "unelevated"] as const).includes(profile.selectedImplementation)) throw new Error("unknown Windows sandbox implementation");
  if (profile.selectedImplementation === "unelevated") {
    if (profile.configuredImplementation !== "elevated" || profile.elevatedProbeResult !== "failed" || profile.elevatedFailureClassification === null) throw new Error("unelevated fallback requires a classified elevated failure");
  } else if (profile.elevatedProbeResult !== "passed" || profile.elevatedFailureClassification !== null) throw new Error("elevated selection requires a passing elevated probe");
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/** Resolve Windows PATHEXT launchers without executing a shell string. npm's codex.cmd is mapped to its native package binary. */
export async function resolveCodexExecutable(input: Readonly<{ path: string; pathext?: string; platform?: NodeJS.Platform }>): Promise<ExecutableResolution> {
  const platform = input.platform ?? process.platform;
  const directories = input.path.split(delimiter).filter(Boolean);
  const extensions = platform === "win32"
    ? (input.pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").map((value) => value.toLowerCase()).filter(Boolean)
    : [""];
  for (const directory of directories) {
    const base = resolve(directory, "codex");
    const candidates = platform === "win32" ? extensions.map((extension) => `${base}${extension}`) : [base];
    for (const candidate of candidates) {
      if (!(await isFile(candidate))) continue;
      if (candidate.toLowerCase().endsWith(".cmd")) {
        const native = resolve(dirname(candidate), WINDOWS_NATIVE_RELATIVE);
        if (!(await isFile(native))) throw new Error("Codex npm launcher exists but its native executable is missing");
        return Object.freeze({ requestedName: "codex", launcherPath: candidate, executablePath: native, launcherKind: "npm-cmd" });
      }
      if (candidate.toLowerCase().endsWith(".exe") || platform !== "win32") {
        return Object.freeze({ requestedName: "codex", launcherPath: candidate, executablePath: candidate, launcherKind: "native" });
      }
    }
  }
  throw new Error("Codex executable was not found on PATH");
}

export type CodexProbeEvidence = Readonly<{
  evidenceVersion: "1.0";
  evidenceId: string;
  collectedBy: "local-bridge";
  executableIdentity: "codex-cli";
  launcherPath: string;
  executablePath: string;
  executableSha256: `sha256:${string}`;
  version: string;
  authenticationState: "authenticated" | "expired" | "missing" | "unknown";
  connectorTier: "cli";
  noninteractiveSupport: "OBSERVED" | "UNSUPPORTED" | "UNKNOWN";
  structuredOutputSupport: "OBSERVED" | "UNSUPPORTED" | "UNKNOWN";
  sandboxSupport: "OBSERVED" | "UNSUPPORTED" | "UNKNOWN";
  cancellationSupport: "VALIDATED";
  resumeSupport: "OBSERVED" | "UNSUPPORTED" | "UNKNOWN";
  artifactSupport: "OBSERVED" | "UNSUPPORTED" | "UNKNOWN";
  quotaStatus: "UNKNOWN";
  quotaConfidence: "UNKNOWN";
  rateLimitStatus: "UNKNOWN";
  probedAt: string;
  compatibility: "not-run" | "passed" | "failed" | "drifted";
  windowsSandbox: Readonly<{
    configuredImplementation: WindowsSandboxImplementation;
    selectedImplementation: WindowsSandboxImplementation;
    elevatedProbeResult: "passed" | "failed";
    elevatedFailureClassification: WindowsSandboxRuntimeProfile["elevatedFailureClassification"];
    fallbackSelected: boolean;
    fallbackCanaryResult: "not-run" | "passed" | "failed" | "drifted";
    assurance: "elevated" | "degraded-bounded-local";
  }>;
}>;

type CompatibilityRecord = Readonly<{
  version: 2;
  executablePath: string;
  executableSha256: `sha256:${string}`;
  cliVersion: string;
  configuredWindowsSandboxImplementation: WindowsSandboxImplementation;
  selectedWindowsSandboxImplementation: WindowsSandboxImplementation;
  elevatedProbeResult: "passed" | "failed";
  elevatedFailureClassification: WindowsSandboxRuntimeProfile["elevatedFailureClassification"];
  readinessClassification: "elevated" | "degraded-bounded-local";
  canaryAt: string;
  result: "passed";
}>;

const hashFile = async (path: string): Promise<`sha256:${string}`> => {
  const bytes = await readFile(path);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
};
const CODEX_EVIDENCE_ID = /^evidence\.codex\.sha256\.[0-9a-f]{64}$/u;
export const isCodexEvidenceId = (value: unknown): value is string => typeof value === "string" && CODEX_EVIDENCE_ID.test(value);
export const deriveCodexEvidenceId = (path: string, hash: string, version: string, profile: WindowsSandboxRuntimeProfile): string => {
  validateWindowsSandboxProfile(profile);
  const digest = createHash("sha256").update(`${path}\n${hash}\n${version}\n${profile.configuredImplementation}\n${profile.selectedImplementation}\n${profile.elevatedProbeResult}\n${profile.elevatedFailureClassification ?? "none"}`).digest("hex");
  return `evidence.codex.sha256.${digest}`;
};
const probeEnvironment = (codexHome: string): Record<string, string> => {
  const allowed = ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
  return { ...Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!] ])), CODEX_HOME: codexHome };
};
const invokeProbe = async (executable: string, args: readonly string[], codexHome: string): Promise<Readonly<{ stdout: string; stderr: string }>> => {
  const result = await execFileAsync(executable, [...args], { encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: PROBE_MAX_BUFFER, env: probeEnvironment(codexHome) });
  return Object.freeze({ stdout: result.stdout, stderr: result.stderr });
};

export type AdapterRegistryRuntime = Readonly<{
  resolve: typeof resolveCodexExecutable;
  hash: (path: string) => Promise<`sha256:${string}`>;
  invoke: (executable: string, args: readonly string[], codexHome: string) => Promise<Readonly<{ stdout: string; stderr: string }>>;
}>;
const defaultRegistryRuntime: AdapterRegistryRuntime = Object.freeze({ resolve: resolveCodexExecutable, hash: hashFile, invoke: invokeProbe });

export class AdapterRegistry {
  private freezeState: "enabled" | "disabled" | "frozen" = "enabled";
  public constructor(private readonly compatibilityPath: string, private readonly runtime: AdapterRegistryRuntime = defaultRegistryRuntime) {}

  public setCodexFreezeState(state: "enabled" | "disabled" | "frozen"): void { this.freezeState = state; }

  private async compatibility(): Promise<CompatibilityRecord | null> {
    try {
      const parsed = JSON.parse(await readFile(this.compatibilityPath, "utf8")) as CompatibilityRecord;
      if (parsed.version !== 2 || parsed.result !== "passed" || !SHA256.test(parsed.executableSha256) || !(["elevated", "unelevated"] as const).includes(parsed.selectedWindowsSandboxImplementation)) throw new Error("malformed compatibility record");
      return Object.freeze(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  public async probeCodex(input: Readonly<{ path: string; pathext?: string; codexHome: string; windowsSandboxProfile: WindowsSandboxRuntimeProfile; now?: Date }>): Promise<Readonly<{ manifest: WorkerManifest; readiness: AdapterReadiness; quota: QuotaSnapshot; evidence: CodexProbeEvidence; resolution: ExecutableResolution }>> {
    validateWindowsSandboxProfile(input.windowsSandboxProfile);
    const now = (input.now ?? new Date()).toISOString();
    const resolution = await this.runtime.resolve({ path: input.path, pathext: input.pathext, platform: process.platform });
    await access(resolution.executablePath);
    const executableSha256 = await this.runtime.hash(resolution.executablePath);
    let version = "unknown";
    let authenticationState: CodexProbeEvidence["authenticationState"] = "unknown";
    let execHelp = "";
    let resumeHelp = "";
    try {
      const versionOutput = (await this.runtime.invoke(resolution.executablePath, ["--version"], input.codexHome)).stdout.trim();
      version = /([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)/u.exec(versionOutput)?.[1] ?? "unknown";
      const loginResult = await this.runtime.invoke(resolution.executablePath, ["login", "status"], input.codexHome);
      const login = `${loginResult.stdout}\n${loginResult.stderr}`.toLowerCase();
      authenticationState = login.includes("logged in") ? "authenticated" : login.includes("expired") ? "expired" : login.includes("not logged") ? "missing" : "unknown";
      execHelp = (await this.runtime.invoke(resolution.executablePath, ["exec", "--help"], input.codexHome)).stdout;
      resumeHelp = (await this.runtime.invoke(resolution.executablePath, ["exec", "resume", "--help"], input.codexHome)).stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("not logged") || message.includes("authentication")) authenticationState = "missing";
    }
    const support = (needle: string): "OBSERVED" | "UNSUPPORTED" | "UNKNOWN" => execHelp ? (execHelp.includes(needle) ? "OBSERVED" : "UNSUPPORTED") : "UNKNOWN";
    const compatible = await this.compatibility();
    const drifted = compatible !== null && (compatible.executablePath !== resolution.executablePath || compatible.executableSha256 !== executableSha256 || compatible.cliVersion !== version || compatible.configuredWindowsSandboxImplementation !== input.windowsSandboxProfile.configuredImplementation || compatible.selectedWindowsSandboxImplementation !== input.windowsSandboxProfile.selectedImplementation || compatible.elevatedProbeResult !== input.windowsSandboxProfile.elevatedProbeResult || compatible.elevatedFailureClassification !== input.windowsSandboxProfile.elevatedFailureClassification);
    const compatibility = drifted ? "drifted" as const : compatible ? "passed" as const : "not-run" as const;
    const fallbackSelected = input.windowsSandboxProfile.selectedImplementation === "unelevated";
    const evidence: CodexProbeEvidence = Object.freeze({
      evidenceVersion: "1.0", evidenceId: deriveCodexEvidenceId(resolution.executablePath, executableSha256, version, input.windowsSandboxProfile), collectedBy: "local-bridge",
      executableIdentity: "codex-cli", launcherPath: resolution.launcherPath, executablePath: resolution.executablePath, executableSha256, version,
      authenticationState, connectorTier: "cli", noninteractiveSupport: support("Run Codex non-interactively"), structuredOutputSupport: support("--json"),
      sandboxSupport: support("--sandbox"), cancellationSupport: "VALIDATED", resumeSupport: resumeHelp.includes("Resume") ? "OBSERVED" : resumeHelp ? "UNSUPPORTED" : "UNKNOWN",
      artifactSupport: support("--output-last-message"), quotaStatus: "UNKNOWN", quotaConfidence: "UNKNOWN", rateLimitStatus: "UNKNOWN", probedAt: now, compatibility,
      windowsSandbox: Object.freeze({
        configuredImplementation: input.windowsSandboxProfile.configuredImplementation,
        selectedImplementation: input.windowsSandboxProfile.selectedImplementation,
        elevatedProbeResult: input.windowsSandboxProfile.elevatedProbeResult,
        elevatedFailureClassification: input.windowsSandboxProfile.elevatedFailureClassification,
        fallbackSelected,
        fallbackCanaryResult: drifted ? "drifted" : compatible ? "passed" : "not-run",
        assurance: fallbackSelected ? "degraded-bounded-local" : "elevated",
      }),
    });
    const observed = (value: "OBSERVED" | "UNSUPPORTED" | "UNKNOWN") => value === "OBSERVED" ? "observed" as const : value === "UNSUPPORTED" ? "unavailable" as const : "unknown" as const;
    const compatibleCapabilities = compatibility === "passed" && authenticationState === "authenticated" && [evidence.noninteractiveSupport, evidence.structuredOutputSupport, evidence.sandboxSupport, evidence.resumeSupport].every((value) => value === "OBSERVED");
    const canBeReady = compatibleCapabilities && !fallbackSelected;
    const boundedFallbackEligible = compatibleCapabilities && fallbackSelected && evidence.windowsSandbox.fallbackCanaryResult === "passed";
    const readinessCandidate = {
      coordinationVersion: "1.0", readinessId: `readiness.codex.sha256.${evidence.evidenceId.slice("evidence.codex.sha256.".length)}`, adapterId: "codex-cli-adapter", workerId: "codex-cli",
      connectorTier: "cli", providerId: "openai", runtimeId: "codex-cli", installedVersion: version, executableId: "codex-cli-native", executableHash: executableSha256,
      authenticationState, sandboxCapability: observed(evidence.sandboxSupport), noninteractiveCapability: observed(evidence.noninteractiveSupport),
      structuredOutputCapability: observed(evidence.structuredOutputSupport), cancellationCapability: "validated", resumeCapability: observed(evidence.resumeSupport),
      healthStatus: canBeReady ? "healthy" : authenticationState === "authenticated" ? "degraded" : "unhealthy", quotaVisibility: "unknown", freezeState: this.freezeState,
      capabilityProbeAt: now, readinessState: this.freezeState !== "enabled" ? "frozen" : canBeReady ? "ready" : boundedFallbackEligible || drifted || authenticationState === "authenticated" ? "degraded" : "blocked",
      capabilities: [
        { capability: "code-write", assurance: canBeReady || boundedFallbackEligible ? "validated" : "declared", evidenceRef: evidence.evidenceId },
        { capability: "review", assurance: canBeReady || boundedFallbackEligible ? "validated" : "declared", evidenceRef: evidence.evidenceId },
        { capability: "artifact-support", assurance: observed(evidence.artifactSupport), evidenceRef: evidence.evidenceId },
        { capability: "quota-status", assurance: "unknown", evidenceRef: null },
        { capability: "rate-limit-status", assurance: "unknown", evidenceRef: null },
      ],
      evidenceRefs: [evidence.evidenceId],
    };
    const parsedReadiness = parseAdapterReadiness(readinessCandidate);
    if (!parsedReadiness.ok) throw new Error(`generated Codex readiness violated M1F (${parsedReadiness.code})`);
    const quotaCandidate = {
      coordinationVersion: "1.0", quotaId: `quota-${evidence.evidenceId.slice("evidence-".length)}`, providerId: "openai", adapterId: "codex-cli-adapter", workerId: "codex-cli",
      quotaKind: "unknown", remaining: null, used: null, limit: null, resetAt: null, window: "unknown", source: "unknown", confidence: "unknown",
      observedAt: now, expiresAt: null, rateLimitState: "unknown", circuitBreakerState: "unknown", authenticationState, evidenceRefs: [evidence.evidenceId],
    };
    const parsedQuota = parseQuotaSnapshot(quotaCandidate);
    if (!parsedQuota.ok) throw new Error(`generated quota snapshot violated M1F (${parsedQuota.code})`);
    return Object.freeze({ manifest: CODEX_CLI_MANIFEST, readiness: parsedReadiness.value, quota: parsedQuota.value, evidence, resolution });
  }

  public manualRelayReadiness(now = new Date()): Readonly<{ manifest: WorkerManifest; readiness: AdapterReadiness; quota: QuotaSnapshot }> {
    const at = now.toISOString();
    const readiness = parseAdapterReadiness({
      coordinationVersion: "1.0", readinessId: `readiness-manual-${createHash("sha256").update(at).digest("hex").slice(0, 40)}`, adapterId: "manual-relay", workerId: "manual-relay",
      connectorTier: "manual-relay", providerId: "owner-selected", runtimeId: "human-relay", installedVersion: "1.0.0", executableId: null, executableHash: null,
      authenticationState: "not-required", sandboxCapability: "unavailable", noninteractiveCapability: "unavailable", structuredOutputCapability: "declared",
      cancellationCapability: "unavailable", resumeCapability: "unavailable", healthStatus: "healthy", quotaVisibility: "unknown", freezeState: "enabled",
      capabilityProbeAt: at, readinessState: "manual-only", capabilities: [
        { capability: "text-output", assurance: "declared", evidenceRef: null }, { capability: "review", assurance: "declared", evidenceRef: null },
        { capability: "design", assurance: "declared", evidenceRef: null }, { capability: "artifact-import", assurance: "declared", evidenceRef: null },
      ], evidenceRefs: [],
    });
    const quota = parseQuotaSnapshot({
      coordinationVersion: "1.0", quotaId: `quota-manual-${createHash("sha256").update(at).digest("hex").slice(0, 40)}`, providerId: "owner-selected", adapterId: "manual-relay", workerId: "manual-relay",
      quotaKind: "unknown", remaining: null, used: null, limit: null, resetAt: null, window: "unknown", source: "unknown", confidence: "unknown",
      observedAt: null, expiresAt: null, rateLimitState: "unknown", circuitBreakerState: "unknown", authenticationState: "not-required", evidenceRefs: [],
    });
    if (!readiness.ok || !quota.ok) throw new Error("generated manual-relay readiness violated M1F");
    return Object.freeze({ manifest: MANUAL_RELAY_MANIFEST, readiness: readiness.value, quota: quota.value });
  }

  public async recordCompatibleCanary(probe: Readonly<{ evidence: CodexProbeEvidence }>, canary: Readonly<{ passed: true; observedWindowsSandboxImplementation: WindowsSandboxImplementation }>, canaryPassedAt = new Date()): Promise<void> {
    const evidence = probe.evidence;
    if (!isCodexEvidenceId(evidence.evidenceId)) throw new Error("malformed Codex readiness evidence identifier");
    if (evidence.authenticationState !== "authenticated" || evidence.noninteractiveSupport !== "OBSERVED" || evidence.structuredOutputSupport !== "OBSERVED" || evidence.sandboxSupport !== "OBSERVED") throw new Error("incomplete probe cannot be accepted as compatible");
    if (canary.observedWindowsSandboxImplementation !== evidence.windowsSandbox.selectedImplementation) throw new Error("canary sandbox implementation does not match readiness evidence");
    if (evidence.windowsSandbox.fallbackSelected && evidence.windowsSandbox.assurance !== "degraded-bounded-local") throw new Error("unelevated fallback cannot be recorded as elevated assurance");
    const record: CompatibilityRecord = Object.freeze({
      version: 2, executablePath: evidence.executablePath, executableSha256: evidence.executableSha256, cliVersion: evidence.version,
      configuredWindowsSandboxImplementation: evidence.windowsSandbox.configuredImplementation,
      selectedWindowsSandboxImplementation: evidence.windowsSandbox.selectedImplementation,
      elevatedProbeResult: evidence.windowsSandbox.elevatedProbeResult,
      elevatedFailureClassification: evidence.windowsSandbox.elevatedFailureClassification,
      readinessClassification: evidence.windowsSandbox.assurance,
      canaryAt: canaryPassedAt.toISOString(), result: "passed",
    });
    await mkdir(dirname(this.compatibilityPath), { recursive: true });
    const temporary = `${this.compatibilityPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.compatibilityPath);
  }
}
