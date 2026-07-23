import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  parseAdapterRun,
  type AdapterReadiness,
  type AdapterRun,
  type WriteScope,
} from "@chubz/shared";
import { ProcessSupervisor, type ProcessRunResult } from "./process-supervisor.js";
import { WriteScopeAuthority } from "./managed-repository.js";
import type { CodexProbeEvidence, WindowsSandboxImplementation } from "./adapter-registry.js";

const execFileAsync = promisify(execFile);
export const CODEX_ADAPTER_LIMITS = Object.freeze({
  maxTaskBytes: 256 * 1024,
  maxStdoutBytes: 512 * 1024,
  maxStderrBytes: 256 * 1024,
  maxEvents: 512,
  maxEventBytes: 64 * 1024,
  maxResultBytes: 64 * 1024,
  maxSummaryBytes: 48 * 1024,
  maxArtifacts: 64,
  maxRuntimeMs: 3_600_000,
} as const);

const safeId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && !value.includes("..");
const canonicalPath = (value: string): string => {
  const path = resolve(value).replace(/^\\\\\?\\/u, "");
  return process.platform === "win32" ? path.toLowerCase() : path;
};
const contained = (root: string, candidate: string): boolean => {
  const rel = relative(canonicalPath(root), canonicalPath(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const hashFile = async (path: string): Promise<`sha256:${string}`> => `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
const boundedSanitizedText = async (text: string, maximum: number): Promise<string> => {
  const { detectRedactions, redactText } = await import("@chubz/shared");
  const bytes = Buffer.from(text, "utf8");
  const bounded = bytes.subarray(0, maximum).toString("utf8");
  const findings = detectRedactions(bounded);
  if (!findings.ok) return "[redacted]";
  const redacted = redactText(bounded, findings.value);
  return redacted.ok ? redacted.value.text : "[redacted]";
};

export type CodexStructuredResult = Readonly<{
  version: "1.0";
  kind: "codex.result";
  status: "completed";
  summary: string;
  artifacts: readonly Readonly<{ path: string; purpose: string }>[];
}>;

type ProviderEvent = Readonly<Record<string, unknown>>;
export type NormalizedCodexEvent = Readonly<{
  sequence: number;
  kind: "run-started" | "worker-message" | "command-claim" | "run-completed" | "run-failed";
  authority: "worker-claim";
  text: string | null;
}>;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function parseStructuredResult(text: string): CodexStructuredResult | null {
  if (Buffer.byteLength(text) > CODEX_ADAPTER_LIMITS.maxResultBytes) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!object(value) || !exactKeys(value, ["version", "kind", "status", "summary", "artifacts"])) return null;
  if (value.version !== "1.0" || value.kind !== "codex.result" || value.status !== "completed" || typeof value.summary !== "string" || Buffer.byteLength(value.summary) > CODEX_ADAPTER_LIMITS.maxSummaryBytes || !Array.isArray(value.artifacts) || value.artifacts.length > CODEX_ADAPTER_LIMITS.maxArtifacts) return null;
  const artifacts: Array<{ path: string; purpose: string }> = [];
  for (const raw of value.artifacts) {
    if (!object(raw) || !exactKeys(raw, ["path", "purpose"]) || typeof raw.path !== "string" || typeof raw.purpose !== "string" || Buffer.byteLength(raw.purpose) > 1_000 || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(raw.path) || raw.path.includes("..") || raw.path.includes("\\")) return null;
    artifacts.push(Object.freeze({ path: raw.path, purpose: raw.purpose }));
  }
  return Object.freeze({ version: "1.0", kind: "codex.result", status: "completed", summary: value.summary, artifacts: Object.freeze(artifacts) });
}

function normalizeProviderEvents(stdout: string): Readonly<{ ok: true; events: readonly NormalizedCodexEvent[]; result: CodexStructuredResult } | { ok: false; reason: "MALFORMED_OUTPUT" | "TRUNCATED_OUTPUT"; events: readonly NormalizedCodexEvent[] }> {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  const normalized: NormalizedCodexEvent[] = [];
  if (lines.length > CODEX_ADAPTER_LIMITS.maxEvents) return Object.freeze({ ok: false, reason: "TRUNCATED_OUTPUT", events: normalized });
  let finalMessage: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line) > CODEX_ADAPTER_LIMITS.maxEventBytes) return Object.freeze({ ok: false, reason: "TRUNCATED_OUTPUT", events: normalized });
    let event: ProviderEvent;
    try { const parsed = JSON.parse(line) as unknown; if (!object(parsed) || typeof parsed.type !== "string") throw new Error(); event = parsed; } catch { return Object.freeze({ ok: false, reason: "MALFORMED_OUTPUT", events: normalized }); }
    if (event.type === "thread.started") {
      if (!exactKeys(event, ["type", "thread_id"]) || typeof event.thread_id !== "string") return Object.freeze({ ok: false, reason: "MALFORMED_OUTPUT", events: normalized });
      normalized.push(Object.freeze({ sequence: index, kind: "run-started", authority: "worker-claim", text: null }));
    } else if (event.type === "turn.started") {
      if (!exactKeys(event, ["type"])) return Object.freeze({ ok: false, reason: "MALFORMED_OUTPUT", events: normalized });
    } else if (event.type === "item.started" || event.type === "item.completed") {
      if (!exactKeys(event, ["type", "item"]) || !object(event.item) || typeof event.item.type !== "string" || typeof event.item.id !== "string") return Object.freeze({ ok: false, reason: "MALFORMED_OUTPUT", events: normalized });
      if (event.item.type === "agent_message") {
        if (!exactKeys(event.item, ["id", "type", "text"]) || typeof event.item.text !== "string") return Object.freeze({ ok: false, reason: "MALFORMED_OUTPUT", events: normalized });
        if (event.type === "item.completed") finalMessage = event.item.text;
        normalized.push(Object.freeze({ sequence: index, kind: "worker-message", authority: "worker-claim", text: event.item.text }));
      } else if (event.item.type === "command_execution") {
        if (!exactKeys(event.item, ["id", "type", "command", "aggregated_output", "exit_code", "status"]) || typeof event.item.command !== "string" || typeof event.item.aggregated_output !== "string" || !(typeof event.item.exit_code === "number" || event.item.exit_code === null) || typeof event.item.status !== "string") return Object.freeze({ ok: false, reason: "MALFORMED_OUTPUT", events: normalized });
        normalized.push(Object.freeze({ sequence: index, kind: "command-claim", authority: "worker-claim", text: null }));
      } else return Object.freeze({ ok: false, reason: "MALFORMED_OUTPUT", events: normalized });
    } else if (event.type === "turn.completed") {
      if (!exactKeys(event, ["type", "usage"]) || !object(event.usage)) return Object.freeze({ ok: false, reason: "MALFORMED_OUTPUT", events: normalized });
      normalized.push(Object.freeze({ sequence: index, kind: "run-completed", authority: "worker-claim", text: null }));
    } else if (event.type === "turn.failed" || event.type === "error") {
      normalized.push(Object.freeze({ sequence: index, kind: "run-failed", authority: "worker-claim", text: null }));
    } else return Object.freeze({ ok: false, reason: "MALFORMED_OUTPUT", events: normalized });
  }
  if (finalMessage === null) return Object.freeze({ ok: false, reason: "MALFORMED_OUTPUT", events: normalized });
  const result = parseStructuredResult(finalMessage);
  return result === null ? Object.freeze({ ok: false, reason: "MALFORMED_OUTPUT", events: normalized }) : Object.freeze({ ok: true, events: Object.freeze(normalized), result });
}

type GitSnapshot = Readonly<{ head: string; branch: string; refs: string }>;
export type GitInspection = Readonly<{
  baseline: GitSnapshot;
  after: GitSnapshot;
  changes: readonly Readonly<{ path: string; operation: "create" | "modify" | "delete"; bytes: number }>[];
  valid: boolean;
  failure: string | null;
}>;

const gitEnvironment = (): Record<string, string> => {
  const inherited = ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]);
  return { ...Object.fromEntries(inherited), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" };
};
async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: gitEnvironment() });
  return result.stdout;
}
async function snapshot(cwd: string): Promise<GitSnapshot> {
  const [head, branch, refs] = await Promise.all([git(cwd, ["rev-parse", "HEAD"]), git(cwd, ["symbolic-ref", "--short", "HEAD"]), git(cwd, ["show-ref", "--head"])]);
  return Object.freeze({ head: head.trim(), branch: branch.trim(), refs: refs.split(/\r?\n/u).filter(Boolean).sort().join("\n") });
}
async function statusChanges(cwd: string): Promise<readonly Readonly<{ path: string; operation: "create" | "modify" | "delete"; bytes: number }>[]> {
  const raw = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const records = raw.split("\0").filter(Boolean);
  const changes: Array<{ path: string; operation: "create" | "modify" | "delete"; bytes: number }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4 || record[2] !== " ") throw new Error("malformed Git status");
    const state = record.slice(0, 2);
    let path = record.slice(3).replaceAll("\\", "/");
    if (state.includes("R") || state.includes("C")) {
      const destination = records[++index];
      if (!destination) throw new Error("malformed Git rename status");
      changes.push(Object.freeze({ path, operation: "delete", bytes: 0 }));
      path = destination.replaceAll("\\", "/");
    }
    const operation = state === "??" || state.includes("A") || state.includes("R") || state.includes("C") ? "create" as const : state.includes("D") ? "delete" as const : "modify" as const;
    const absolute = resolve(cwd, ...path.split("/"));
    let bytes = 0;
    if (operation !== "delete") {
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("symlinks, junctions, and non-files are rejected");
      bytes = info.size;
    }
    changes.push(Object.freeze({ path, operation, bytes }));
  }
  return Object.freeze(changes);
}

export async function inspectCodexWorktree(input: Readonly<{ worktreePath: string; baseline: GitSnapshot; writeScope: WriteScope }>): Promise<GitInspection> {
  const after = await snapshot(input.worktreePath);
  let changes: readonly Readonly<{ path: string; operation: "create" | "modify" | "delete"; bytes: number }>[] = [];
  try {
    if (after.head !== input.baseline.head || after.branch !== input.baseline.branch || after.refs !== input.baseline.refs) throw new Error("Git HEAD, branch, or refs moved");
    changes = await statusChanges(input.worktreePath);
    new WriteScopeAuthority(input.writeScope, input.worktreePath).authorizeBatch(changes);
    return Object.freeze({ baseline: input.baseline, after, changes, valid: true, failure: null });
  } catch (error) {
    return Object.freeze({ baseline: input.baseline, after, changes, valid: false, failure: error instanceof Error ? error.message : "worktree inspection failed" });
  }
}

export type CodexAdapterRequest = Readonly<{
  taskId: string; attemptId: string; operationId: string; adapterRunId: string; projectId?: string;
  taskInstructions: string;
  executablePath: string;
  worktreePath: string;
  managedWorktreeRoot: string;
  codexHome: string;
  managedDataRoot: string;
  outputSchemaPath: string;
  mode: "read-only" | "workspace-write";
  windowsSandboxImplementation: WindowsSandboxImplementation;
  writeScope: WriteScope;
  readiness: AdapterReadiness;
  provenance: CodexProbeEvidence;
  timeoutMs: number;
  terminationDeadlineMs: number;
  signal?: AbortSignal;
}>;
export type CodexAdapterOutcome = Readonly<{
  state: "completed" | "failed" | "cancelled" | "execution-unknown";
  failureCode: string | null;
  run: AdapterRun;
  process: ProcessRunResult;
  parsedResult: CodexStructuredResult | null;
  events: readonly NormalizedCodexEvent[];
  git: GitInspection;
  sanitizedStderr: string;
}>;

function sanitizedEnvironment(codexHome: string): Record<string, string> {
  const allowed = ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
  const env = Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  return { ...env, CODEX_HOME: codexHome, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
}

export function buildCodexInvocationArgs(input: Readonly<{ mode: "read-only" | "workspace-write"; windowsSandboxImplementation: WindowsSandboxImplementation; outputSchemaPath: string; worktreePath: string }>): readonly string[] {
  if (!(["elevated", "unelevated"] as const).includes(input.windowsSandboxImplementation)) throw new Error("unknown Windows sandbox implementation");
  if (!(["read-only", "workspace-write"] as const).includes(input.mode)) throw new Error("unsupported Codex sandbox permission mode");
  const args = [
    "-c", `windows.sandbox=${JSON.stringify(input.windowsSandboxImplementation)}`,
    "--sandbox", input.mode,
    "--ask-for-approval", "never",
    "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config", "--color", "never",
    "--output-schema", input.outputSchemaPath, "-C", input.worktreePath, "-",
  ] as const;
  const forbidden = new Set(["danger-full-access", "--yolo", "--dangerously-bypass-approvals-and-sandbox", "--permission-profile", "-P"]);
  if (args.some((arg) => forbidden.has(arg)) || args.some((arg) => arg.includes("default_permissions"))) throw new Error("unsafe or split Codex permissions are forbidden");
  return Object.freeze([...args]);
}

export function isBoundedFallbackEvidence(readiness: AdapterReadiness, evidence: CodexProbeEvidence): boolean {
  return readiness.readinessState === "degraded" && readiness.healthStatus === "degraded" && readiness.freezeState === "enabled" &&
    evidence.compatibility === "passed" && evidence.windowsSandbox.configuredImplementation === "elevated" && evidence.windowsSandbox.selectedImplementation === "unelevated" &&
    evidence.windowsSandbox.elevatedProbeResult === "failed" && evidence.windowsSandbox.elevatedFailureClassification !== null && evidence.windowsSandbox.fallbackSelected &&
    evidence.windowsSandbox.fallbackCanaryResult === "passed" && evidence.windowsSandbox.assurance === "degraded-bounded-local";
}
function classifyFailure(processResult: ProcessRunResult, stderr: string): string {
  const lower = stderr.toLowerCase();
  if (processResult.state === "execution-unknown") return "EXECUTION_UNKNOWN";
  if (processResult.stopReason === "cancel") return "CANCELLED";
  if (processResult.stopReason === "timeout") return "TIMEOUT";
  if (/not logged in|authentication.*expired|unauthenticated/u.test(lower)) return "AUTHENTICATION_EXPIRED";
  if (/rate.?limit|too many requests|\b429\b/u.test(lower)) return "RATE_LIMITED";
  if (/quota.*exhaust|insufficient.*quota/u.test(lower)) return "QUOTA_EXHAUSTED";
  if (processResult.exit?.code !== 0) return "NONZERO_EXIT";
  return "WORKER_FAILURE";
}

export class CodexCliAdapter {
  public constructor(private readonly supervisor: ProcessSupervisor) {}

  public resumeAttempt(): never { throw new Error("resumeAttempt is UNSUPPORTED until independently capability-proven"); }

  public run(request: CodexAdapterRequest): Promise<CodexAdapterOutcome> { return this.execute(request, false); }

  /** The only degraded-readiness exception: a bounded compatibility canary used to decide whether readiness may become ready. */
  public runCanary(request: CodexAdapterRequest): Promise<CodexAdapterOutcome> { return this.execute(request, true); }

  private async execute(request: CodexAdapterRequest, compatibilityCanary: boolean): Promise<CodexAdapterOutcome> {
    for (const [label, value] of Object.entries({ taskId: request.taskId, attemptId: request.attemptId, operationId: request.operationId, adapterRunId: request.adapterRunId })) if (!safeId(value)) throw new Error(`${label} is invalid`);
    if (Buffer.byteLength(request.taskInstructions) > CODEX_ADAPTER_LIMITS.maxTaskBytes) throw new Error("task instructions exceed stdin bound");
    if (request.timeoutMs < 1 || request.timeoutMs > CODEX_ADAPTER_LIMITS.maxRuntimeMs) throw new Error("runtime bound is invalid");
    const boundedFallback = isBoundedFallbackEvidence(request.readiness, request.provenance);
    const fallbackCanaryEligible = compatibilityCanary && request.readiness.readinessState === "degraded" && request.readiness.freezeState === "enabled" && request.provenance.compatibility !== "passed" && request.provenance.windowsSandbox.selectedImplementation === "unelevated" && request.provenance.windowsSandbox.fallbackSelected && request.provenance.windowsSandbox.elevatedProbeResult === "failed" && request.provenance.windowsSandbox.elevatedFailureClassification !== null;
    const eligibleReadiness = request.readiness.readinessState === "ready" || boundedFallback || fallbackCanaryEligible;
    if (request.readiness.adapterId !== "codex-cli-adapter" || request.readiness.workerId !== "codex-cli" || !eligibleReadiness || request.readiness.freezeState !== "enabled") throw new Error("Codex adapter is not eligible");
    if (request.provenance.executablePath !== request.executablePath || request.readiness.executableHash !== request.provenance.executableSha256 || request.readiness.installedVersion !== request.provenance.version || await hashFile(request.executablePath) !== request.provenance.executableSha256) throw new Error("Codex executable path, version, or hash changed after readiness probe");
    if (request.windowsSandboxImplementation !== request.provenance.windowsSandbox.selectedImplementation) throw new Error("effective Windows sandbox differs from readiness evidence");
    const root = await realpath(request.managedWorktreeRoot); const worktree = await realpath(request.worktreePath);
    if (!contained(root, worktree) || canonicalPath(root) === canonicalPath(worktree)) throw new Error("Codex cwd is not an exact managed worktree");
    const managedDataRoot = await realpath(request.managedDataRoot); const codexHome = await realpath(request.codexHome);
    if (!contained(managedDataRoot, codexHome) || canonicalPath(managedDataRoot) === canonicalPath(codexHome)) throw new Error("isolated CODEX_HOME escaped the managed data root");
    const sharedCodexHome = resolve(process.env.USERPROFILE ?? "", ".codex");
    if (canonicalPath(codexHome) === canonicalPath(sharedCodexHome) || contained(sharedCodexHome, codexHome) || contained(codexHome, sharedCodexHome)) throw new Error("shared CODEX_HOME is forbidden");
    if (!isAbsolute(request.outputSchemaPath) || !(await stat(request.outputSchemaPath)).isFile()) throw new Error("structured output schema is unavailable");
    const baseline = await snapshot(worktree);
    const args = buildCodexInvocationArgs({ mode: request.mode, windowsSandboxImplementation: request.windowsSandboxImplementation, outputSchemaPath: request.outputSchemaPath, worktreePath: worktree });
    if (args.some((arg) => arg === request.taskInstructions || arg.includes("\0"))) throw new Error("task instructions must not enter argv");
    const startedAt = new Date().toISOString();
    const processResult = await this.supervisor.run({ executable: request.executablePath, args, cwd: worktree, env: sanitizedEnvironment(codexHome), taskContent: request.taskInstructions, role: "worker", timeoutMs: request.timeoutMs, terminationDeadlineMs: request.terminationDeadlineMs, maxOutputBytes: CODEX_ADAPTER_LIMITS.maxStdoutBytes, emergencyScope: request.projectId === undefined ? undefined : { projectId: request.projectId, operationId: request.operationId }, signal: request.signal });
    const parsed = processResult.stdoutTruncated || processResult.stderrTruncated ? Object.freeze({ ok: false as const, reason: "TRUNCATED_OUTPUT" as const, events: [] as readonly NormalizedCodexEvent[] }) : normalizeProviderEvents(processResult.stdout);
    const gitInspection = await inspectCodexWorktree({ worktreePath: worktree, baseline, writeScope: request.writeScope });
    const silentlyReadOnly = request.mode === "workspace-write" && /(?:read-only (?:filesystem|sandbox|policy)|writing is blocked by read-only sandbox|rejected: blocked by policy)/iu.test(`${processResult.stdout}\n${processResult.stderr}`);
    let state: CodexAdapterOutcome["state"] = "failed";
    let failureCode: string | null = null;
    if (processResult.state === "execution-unknown") { state = "execution-unknown"; failureCode = "EXECUTION_UNKNOWN"; }
    else if (processResult.stopReason === "cancel") { state = processResult.terminationEvidence?.proven ? "cancelled" : "execution-unknown"; failureCode = state === "cancelled" ? "CANCELLED" : "EXECUTION_UNKNOWN"; }
    else if (processResult.stopReason === "timeout") { state = processResult.terminationEvidence?.proven ? "failed" : "execution-unknown"; failureCode = state === "failed" ? "TIMEOUT" : "EXECUTION_UNKNOWN"; }
    else if (processResult.exit?.code !== 0) failureCode = classifyFailure(processResult, processResult.stderr);
    else if (silentlyReadOnly) failureCode = "SANDBOX_READ_ONLY_FALLBACK";
    else if (!parsed.ok) failureCode = parsed.reason;
    else if (!gitInspection.valid) failureCode = "WORKTREE_POLICY_VIOLATION";
    else state = "completed";
    const endedAt = new Date().toISOString();
    const runCandidate = {
      coordinationVersion: "1.0", adapterRunId: request.adapterRunId, taskId: request.taskId, attemptId: request.attemptId, operationId: request.operationId,
      workerId: "codex-cli", adapterId: "codex-cli-adapter", connectorTier: "cli", readinessSnapshotRef: request.readiness.readinessId, invocationMode: "noninteractive",
      requestedCapability: request.mode === "workspace-write" ? "code-write" : "review", startedAt, endedAt,
      structuredOutputState: parsed.ok ? "received" : parsed.reason === "TRUNCATED_OUTPUT" ? "malformed" : "malformed",
      cancellationState: state === "cancelled" ? "confirmed" : request.signal?.aborted ? "unconfirmed" : "not-requested",
      resumedFromRunId: null, quotaSnapshotRef: null, lifecycleState: state, captureRefs: [], evidenceRefs: [request.provenance.evidenceId],
      blockedReason: state === "execution-unknown" ? "execution-unknown" : null, runtimeProvenanceRefs: [request.provenance.evidenceId],
      cancellationEvidenceRefs: state === "cancelled" ? [`termination-${request.adapterRunId}`] : [],
    };
    const run = parseAdapterRun(runCandidate);
    if (!run.ok) throw new Error(`adapter run violated M1F (${run.code})`);
    return Object.freeze({ state, failureCode, run: run.value, process: processResult, parsedResult: parsed.ok ? parsed.result : null, events: parsed.events, git: gitInspection, sanitizedStderr: await boundedSanitizedText(processResult.stderr, CODEX_ADAPTER_LIMITS.maxStderrBytes) });
  }
}
