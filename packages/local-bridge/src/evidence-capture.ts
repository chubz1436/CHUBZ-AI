import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { classifySensitivePath, detectRedactions, redactText } from "@chubz/shared";
import type { ProcessRunResult } from "./process-supervisor.js";

const execFileAsync = promisify(execFile);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OID = /^[0-9a-f]{40,64}$/u;
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials?|secrets?|tokens?|cookies?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|kdbx))(?:$|\/)/iu;
const FORBIDDEN_EVIDENCE_KEY = /password|secret|token|credential|authorization|cookie|private.?key|capability.?grant|grant.?json|raw.?environment|authentication.?file/iu;

export const M7_CAPTURE_LIMITS = Object.freeze({
  maxFiles: 512,
  maxDiffBytes: 512 * 1024,
  maxLogBytes: 128 * 1024,
  maxPackageBytes: 2 * 1024 * 1024,
  maxPathBytes: 512,
  maxGitOutputBytes: 4 * 1024 * 1024,
} as const);

export type CaptureStatus = "pending" | "capturing" | "captured" | "failed" | "incomplete" | "quarantined";
export type ValidationKind = "test" | "build" | "typecheck" | "lint" | "format" | "runtime-smoke" | "browser-e2e" | "unknown";
export type ValidationObservation = Readonly<{
  validationId: string;
  kind: ValidationKind;
  command: readonly string[];
  cwdLabel: string;
  startedAt: string;
  finishedAt: string;
  process: ProcessRunResult;
  toolVersions?: Readonly<Record<string, string>>;
  artifactHashes?: readonly Readonly<{ name: string; hash: string }>[];
}>;

export type ReviewCaptureRequest = Readonly<{
  captureId: string;
  ownerId: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  operationId: string;
  journalId: string;
  workerId: string;
  adapterId: string;
  adapterRunId: string | null;
  managedClonePath: string;
  managedCloneRoot: string;
  worktreePath: string;
  managedWorktreeRoot: string;
  packageRoot: string;
  managedDataRoot: string;
  baselineCommit: string;
  expectedFinalHead?: string;
  workerClaim: string | null;
  manualEvidence?: Readonly<{ attestationId: string; attestedAt: string }>;
  readiness: Readonly<Record<string, unknown>> | null;
  sandbox: Readonly<Record<string, unknown>> | null;
  terminalState: string;
  executionUnknown: boolean;
  applied: false;
  validations: readonly ValidationObservation[];
  capturedAt: string;
}>;

export type ReviewPackageResult = Readonly<{
  captureId: string;
  packageId: string;
  status: "captured" | "incomplete" | "quarantined";
  packageDirectory: string;
  packagePath: string;
  manifestPath: string;
  packageDigest: `sha256:${string}`;
  manifestDigest: `sha256:${string}`;
  byteLength: number;
  summary: Readonly<Record<string, unknown>>;
}>;

const sha256 = (value: string | Buffer): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
};
const canonicalPath = (value: string): string => {
  const path = resolve(value).replace(/^\\\\\?\\/u, "");
  return process.platform === "win32" ? path.toLowerCase() : path;
};
const contained = (root: string, candidate: string): boolean => {
  const rel = relative(canonicalPath(root), canonicalPath(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const safeId = (value: string, label: string): void => { if (!ID.test(value) || value.includes("..")) throw new Error(`${label} is invalid`); };
const safeRelative = (value: string): string => {
  const path = value.replaceAll("\\", "/");
  if (!path || Buffer.byteLength(path) > M7_CAPTURE_LIMITS.maxPathBytes || path.startsWith("/") || path.includes("\0") || /[\u0000-\u001f]/u.test(path) || path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error("unsafe Git path");
  return path;
};
const rejectLinkChain = async (target: string): Promise<void> => {
  const absolute = resolve(target); const root = absolute.slice(0, absolute.indexOf(sep) + 1); let cursor = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try { const info = await lstat(cursor); if (info.isSymbolicLink()) throw new Error("symbolic links, junctions, and reparse points are rejected"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
};
const gitEnv = (): Record<string, string> => {
  const allowed = ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP"];
  return { ...Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
};
const git = async (cwd: string, args: readonly string[], allowFailure = false): Promise<Readonly<{ stdout: string; exitCode: number }>> => {
  try {
    const result = await execFileAsync("git", ["-c", "core.hooksPath=NUL", "-c", "diff.external=", "-c", "core.attributesFile=NUL", ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: M7_CAPTURE_LIMITS.maxGitOutputBytes, env: gitEnv() });
    return { stdout: result.stdout, exitCode: 0 };
  } catch (error) {
    const failure = error as Error & { stdout?: string; code?: number };
    if (allowFailure && typeof failure.code === "number") return { stdout: failure.stdout ?? "", exitCode: failure.code };
    throw new Error("bounded Git observation failed");
  }
};
const gitBytes = async (cwd: string, args: readonly string[]): Promise<Buffer | null> => {
  try { const result = await execFileAsync("git", ["-c", "core.hooksPath=NUL", "-c", "diff.external=", "-c", "core.attributesFile=NUL", ...args], { cwd, encoding: "buffer", windowsHide: true, timeout: 30_000, maxBuffer: M7_CAPTURE_LIMITS.maxGitOutputBytes, env: gitEnv() }); return Buffer.from(result.stdout); }
  catch (error) { if (typeof (error as Error & { code?: number }).code === "number") return null; throw new Error("bounded Git object observation failed"); }
};
const boundedSanitized = (input: string, limit: number): Readonly<{ text: string; truncated: boolean; redacted: boolean; redactionCount: number }> => {
  const bytes = Buffer.from(input, "utf8"); const truncated = bytes.length > limit; const bounded = bytes.subarray(0, limit).toString("utf8");
  const findings = detectRedactions(bounded);
  if (!findings.ok) return { text: "[REDACTED: scanner failure]", truncated, redacted: true, redactionCount: 1 };
  const redacted = redactText(bounded, findings.value);
  if (!redacted.ok) return { text: "[REDACTED: scanner failure]", truncated, redacted: true, redactionCount: 1 };
  return { text: redacted.value.text, truncated, redacted: findings.value.length > 0, redactionCount: findings.value.length };
};
type SanitizedValue = Readonly<{ value: unknown; truncated: boolean; redactionCount: number }>;
const sanitizeStructured = (input: unknown, depth = 0): SanitizedValue => {
  if (depth > 8) throw new Error("structured evidence exceeds depth bound");
  if (input === null || typeof input === "boolean" || typeof input === "number" && Number.isFinite(input)) return { value: input, truncated: false, redactionCount: 0 };
  if (typeof input === "string") { const sanitized = boundedSanitized(input, 8 * 1024); return { value: sanitized.text, truncated: sanitized.truncated, redactionCount: sanitized.redactionCount }; }
  if (Array.isArray(input)) {
    if (input.length > 128) throw new Error("structured evidence exceeds array bound");
    const items = input.map((item) => sanitizeStructured(item, depth + 1));
    return { value: items.map((item) => item.value), truncated: items.some((item) => item.truncated), redactionCount: items.reduce((total, item) => total + item.redactionCount, 0) };
  }
  if (typeof input === "object" && input !== null) {
    const entries = Object.entries(input as Record<string, unknown>); if (entries.length > 128) throw new Error("structured evidence exceeds object bound");
    const output: Record<string, unknown> = {}; let truncated = false; let redactionCount = 0;
    for (const [key, value] of entries) {
      if (!key || Buffer.byteLength(key) > 128 || /[\u0000-\u001f]/u.test(key) || FORBIDDEN_EVIDENCE_KEY.test(key)) throw new Error("structured evidence contains a forbidden field");
      const sanitized = sanitizeStructured(value, depth + 1); output[key] = sanitized.value; truncated ||= sanitized.truncated; redactionCount += sanitized.redactionCount;
    }
    return { value: output, truncated, redactionCount };
  }
  throw new Error("structured evidence contains an unsupported value");
};
const parseCounts = (text: string): Readonly<{ parsed: boolean; passed: number | null; failed: number | null; skipped: number | null; total: number | null }> => {
  const patterns = {
    passed: /(?:^|\s)(\d+)\s+(?:tests?\s+)?passed\b/iu,
    failed: /(?:^|\s)(\d+)\s+(?:tests?\s+)?failed\b/iu,
    skipped: /(?:^|\s)(\d+)\s+(?:tests?\s+)?skipped\b/iu,
  };
  const passed = patterns.passed.exec(text)?.[1]; const failed = patterns.failed.exec(text)?.[1]; const skipped = patterns.skipped.exec(text)?.[1];
  if (passed === undefined && failed === undefined && skipped === undefined) return { parsed: false, passed: null, failed: null, skipped: null, total: null };
  const values = [passed, failed, skipped].map((value) => Number(value ?? 0));
  return { parsed: true, passed: values[0]!, failed: values[1]!, skipped: values[2]!, total: values.reduce((sum, value) => sum + value, 0) };
};

type StatusEntry = { path: string; originalPath: string | null; operation: "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed" | "unmerged"; staged: boolean; unstaged: boolean; untracked: boolean; headMode: string | null; indexMode: string | null; worktreeMode: string | null };
const operationFor = (xy: string, renameOrCopy = false): StatusEntry["operation"] => renameOrCopy && xy.includes("R") ? "renamed" : renameOrCopy && xy.includes("C") ? "copied" : xy.includes("U") ? "unmerged" : xy.includes("D") ? "deleted" : xy.includes("A") || xy === "??" ? "added" : xy.includes("T") ? "type-changed" : "modified";
const parseStatus = (raw: string): readonly StatusEntry[] => {
  const records = raw.split("\0").filter(Boolean); const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith("? ")) entries.push({ path: safeRelative(record.slice(2)), originalPath: null, operation: "added", staged: false, unstaged: false, untracked: true, headMode: null, indexMode: null, worktreeMode: null });
    else if (record.startsWith("1 ")) { const parts = record.split(" "); const xy = parts[1]!; entries.push({ path: safeRelative(parts.slice(8).join(" ")), originalPath: null, operation: operationFor(xy), staged: xy[0] !== ".", unstaged: xy[1] !== ".", untracked: false, headMode: parts[3] ?? null, indexMode: parts[4] ?? null, worktreeMode: parts[5] ?? null }); }
    else if (record.startsWith("2 ")) { const parts = record.split(" "); const xy = parts[1]!; const path = safeRelative(parts.slice(9).join(" ")); const originalPath = safeRelative(records[++index] ?? ""); entries.push({ path, originalPath, operation: operationFor(xy, true), staged: xy[0] !== ".", unstaged: xy[1] !== ".", untracked: false, headMode: parts[3] ?? null, indexMode: parts[4] ?? null, worktreeMode: parts[5] ?? null }); }
    else if (record.startsWith("u ")) { const parts = record.split(" "); entries.push({ path: safeRelative(parts.slice(10).join(" ")), originalPath: null, operation: "unmerged", staged: true, unstaged: true, untracked: false, headMode: parts[3] ?? null, indexMode: parts[4] ?? null, worktreeMode: parts[5] ?? null }); }
    else if (!record.startsWith("# ")) throw new Error("malformed Git status evidence");
  }
  if (entries.length > M7_CAPTURE_LIMITS.maxFiles) throw new Error("changed-path count exceeds capture bound");
  return entries.sort((left, right) => left.path.localeCompare(right.path));
};

export class EvidenceCaptureService {
  private readonly inFlight = new Map<string, Readonly<{ requestDigest: string; promise: Promise<ReviewPackageResult> }>>();
  private readonly approvedOperationalRoot: string;
  public constructor(approvedOperationalRoot = "B:\\AI_Agent_folder") { this.approvedOperationalRoot = resolve(approvedOperationalRoot); }

  public capture(input: ReviewCaptureRequest): Promise<ReviewPackageResult> {
    safeId(input.captureId, "captureId");
    const requestDigest = sha256(canonical(input)); const existing = this.inFlight.get(input.captureId); if (existing) return existing.requestDigest === requestDigest ? existing.promise : Promise.reject(new Error("capture idempotency conflict"));
    const promise = this.captureOnce(input).finally(() => this.inFlight.delete(input.captureId));
    this.inFlight.set(input.captureId, { requestDigest, promise }); return promise;
  }

  /** Bridge-startup reconciliation. Call before accepting capture work. */
  public async reconcileStaging(input: Readonly<{ managedDataRoot: string; packageRoot: string }>): Promise<number> {
    const [approved, dataRoot, packageRoot] = await Promise.all([realpath(this.approvedOperationalRoot), realpath(input.managedDataRoot), realpath(input.packageRoot)]); if (!contained(approved, dataRoot) || !contained(dataRoot, packageRoot) || canonicalPath(dataRoot) === canonicalPath(packageRoot)) throw new Error("review-package staging root is not approved"); await rejectLinkChain(packageRoot); let removed = 0;
    for (const entry of await readdir(packageRoot, { withFileTypes: true })) { if (!entry.name.startsWith(".staging-")) continue; if (!entry.isDirectory()) throw new Error("unsafe review-package staging entry"); const target = resolve(packageRoot, entry.name); if (!contained(packageRoot, target)) throw new Error("review-package staging escaped approved root"); await rejectLinkChain(target); await rm(target, { recursive: true, force: true }); removed += 1; }
    return removed;
  }

  private async captureOnce(input: ReviewCaptureRequest): Promise<ReviewPackageResult> {
    for (const [label, value] of Object.entries({ ownerId: input.ownerId, projectId: input.projectId, taskId: input.taskId, attemptId: input.attemptId, operationId: input.operationId, journalId: input.journalId, workerId: input.workerId, adapterId: input.adapterId })) safeId(value, label);
    if (input.adapterRunId !== null) safeId(input.adapterRunId, "adapterRunId"); if (input.manualEvidence !== undefined) safeId(input.manualEvidence.attestationId, "attestationId");
    if (Number.isNaN(Date.parse(input.capturedAt))) throw new Error("capture timestamp is invalid");
    if (!OID.test(input.baselineCommit) || input.expectedFinalHead !== undefined && !OID.test(input.expectedFinalHead)) throw new Error("Git identity is invalid");
    const [cloneRoot, clone, worktreeRoot, worktree, dataRoot, approvedOperationalRoot] = await Promise.all([realpath(input.managedCloneRoot), realpath(input.managedClonePath), realpath(input.managedWorktreeRoot), realpath(input.worktreePath), realpath(input.managedDataRoot), realpath(this.approvedOperationalRoot)]);
    if (!contained(approvedOperationalRoot, dataRoot)) throw new Error("managed data escaped the approved operational root");
    const requestedDataRoot = resolve(input.managedDataRoot); const requestedPackageRoot = resolve(input.packageRoot); if (!contained(requestedDataRoot, requestedPackageRoot) || canonicalPath(requestedDataRoot) === canonicalPath(requestedPackageRoot)) throw new Error("package root escaped managed data"); await rejectLinkChain(requestedPackageRoot); await mkdir(requestedPackageRoot, { recursive: true }); const packageRoot = await realpath(requestedPackageRoot);
    if (!contained(cloneRoot, clone) || canonicalPath(cloneRoot) === canonicalPath(clone) || !contained(worktreeRoot, worktree) || canonicalPath(worktreeRoot) === canonicalPath(worktree)) throw new Error("capture source is not an exact managed clone and attempt worktree");
    if (!contained(dataRoot, packageRoot) || canonicalPath(dataRoot) === canonicalPath(packageRoot)) throw new Error("package root escaped managed data");
    await Promise.all([rejectLinkChain(clone), rejectLinkChain(worktree), rejectLinkChain(packageRoot)]);
    const common = (await git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
    if (canonicalPath(common) !== canonicalPath(resolve(clone, ".git"))) throw new Error("worktree repository identity changed");
    const startHead = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
    const startRefs = (await git(worktree, ["show-ref", "--head"])).stdout.split(/\r?\n/u).filter(Boolean).sort().join("\n");
    const status = parseStatus((await git(worktree, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])).stdout);
    for (const entry of status) {
      if ([entry.path, entry.originalPath].filter((path): path is string => path !== null).some((path) => SECRET_PATH.test(path) || classifySensitivePath(path).disposition !== "safe")) throw new Error("sensitive path is quarantined from evidence capture");
      if (!entry.untracked) continue;
      const absolute = resolve(worktree, ...entry.path.split("/")); if (!contained(worktree, absolute)) throw new Error("changed path escaped worktree");
      await rejectLinkChain(absolute); const info = await lstat(absolute); if (!info.isFile()) throw new Error("non-file worktree content is quarantined");
    }
    const branchResult = await git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
    const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
    const parentResult = await git(worktree, ["rev-parse", "HEAD^"], true);
    const mergeBaseResult = await git(worktree, ["merge-base", input.baselineCommit, startHead], true);
    const subjects = (await git(worktree, ["log", "--format=%H%x09%s", "--max-count=128", `${input.baselineCommit}..${startHead}`], true)).stdout.split(/\r?\n/u).filter(Boolean).map((line) => boundedSanitized(line, 1024).text);
    const rawMeta = (await git(worktree, ["diff", "--raw", "--no-abbrev", "--find-renames", "--find-copies", "-z", input.baselineCommit, "--"])).stdout;
    const numstat = (await git(worktree, ["diff", "--numstat", input.baselineCommit, "--"])).stdout;
    let additions = 0; let deletions = 0; let binaryFiles = 0; const perPathStats = new Map<string, { additions: number | null; deletions: number | null }>();
    for (const line of numstat.split(/\r?\n/u).filter(Boolean)) { const match = /^(\d+|-)\t(\d+|-)\t(.+)$/u.exec(line); if (!match) throw new Error("malformed Git numstat evidence"); if (match[1] === "-" || match[2] === "-") { binaryFiles += 1; continue; } const added = Number(match[1]); const deleted = Number(match[2]); additions += added; deletions += deleted; try { perPathStats.set(safeRelative(match[3]!), { additions: added, deletions: deleted }); } catch { /* rename display forms remain represented by aggregate statistics */ } }
    const diffRaw = (await git(worktree, ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--find-copies", "--unified=3", input.baselineCommit, "--"])).stdout;
    const diff = boundedSanitized(diffRaw, M7_CAPTURE_LIMITS.maxDiffBytes);
    const pathEvidence = await Promise.all(status.map(async (entry) => {
      const beforePath = entry.originalPath ?? entry.path;
      const before = await gitBytes(worktree, ["show", `${input.baselineCommit}:${beforePath}`]);
      const afterPath = resolve(worktree, ...entry.path.split("/"));
      await rejectLinkChain(afterPath); const afterExists = await lstat(afterPath).then((value) => value.isFile()).catch(() => false);
      const after = afterExists ? await readFile(afterPath) : null; const binary = after?.subarray(0, 8_192).includes(0) ?? before?.subarray(0, 8_192).includes(0) ?? false; const stats = perPathStats.get(entry.path) ?? { additions: null, deletions: null };
      return {
        path: entry.path, originalPath: entry.originalPath, operation: entry.operation, staged: entry.staged, unstaged: entry.unstaged, untracked: entry.untracked, fileModes: { head: entry.headMode, index: entry.indexMode, worktree: entry.worktreeMode }, additions: stats.additions, deletions: stats.deletions,
        beforeHash: before === null ? null : sha256(before),
        afterHash: after === null ? null : sha256(after),
        content: binary ? { included: false, reason: "binary-content-omitted", binary: true } : entry.untracked ? { included: false, reason: "untracked-content-omitted-from-text-diff", binary: false } : { included: true, reason: null, binary: false },
      };
    }));
    const validations = input.validations.slice(0, 64).map((validation) => {
      safeId(validation.validationId, "validationId");
      if (Number.isNaN(Date.parse(validation.startedAt)) || Number.isNaN(Date.parse(validation.finishedAt))) throw new Error("validation timestamp is invalid");
      const stdout = boundedSanitized(validation.process.stdout, M7_CAPTURE_LIMITS.maxLogBytes); const stderr = boundedSanitized(validation.process.stderr, M7_CAPTURE_LIMITS.maxLogBytes);
      const commandItems = validation.command.slice(0, 64).map((item) => boundedSanitized(item, 8 * 1024)); const workingDirectory = boundedSanitized(validation.cwdLabel, 8 * 1024); const toolVersions = sanitizeStructured(validation.toolVersions ?? {}); const artifactHashes = sanitizeStructured(validation.artifactHashes ?? []);
      const counts = parseCounts(`${stdout.text}\n${stderr.text}`);
      const authoritativeOutcome = validation.process.state === "execution-unknown" ? "unknown" : validation.process.stopReason === "timeout" ? "timeout" : validation.process.stopReason === "cancel" ? "cancelled" : validation.process.exit?.code === 0 ? "passed" : "failed";
      return { validationId: validation.validationId, kind: validation.kind, command: commandItems.map((item) => item.text), workingDirectory: workingDirectory.text, startedAt: validation.startedAt, finishedAt: validation.finishedAt, exitCode: validation.process.exit?.code ?? null, exitSignal: validation.process.exit?.signal ?? null, terminationReason: validation.process.stopReason, authoritativeOutcome, parser: counts, stdout, stderr, processTreeTermination: sanitizeStructured(validation.process.terminationEvidence ?? null).value, toolVersions: toolVersions.value, artifactHashes: artifactHashes.value, sanitization: { truncated: validation.command.length > 64 || commandItems.some((item) => item.truncated) || workingDirectory.truncated || toolVersions.truncated || artifactHashes.truncated, redactionCount: commandItems.reduce((total, item) => total + item.redactionCount, 0) + workingDirectory.redactionCount + toolVersions.redactionCount + artifactHashes.redactionCount } };
    });
    const finishHead = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
    const finishRefs = (await git(worktree, ["show-ref", "--head"])).stdout.split(/\r?\n/u).filter(Boolean).sort().join("\n");
    const workerClaim = input.workerClaim === null ? null : boundedSanitized(input.workerClaim, 48 * 1024); const readiness = sanitizeStructured(input.readiness); const sandbox = sanitizeStructured(input.sandbox); const terminalState = boundedSanitized(input.terminalState, 1024);
    const limitations: string[] = [];
    if (diff.truncated) limitations.push("text-diff-truncated"); if (diff.redacted) limitations.push("text-diff-redacted"); if (status.some((entry) => entry.untracked)) limitations.push("untracked-text-content-omitted");
    if (input.validations.length > 64) limitations.push("validation-list-truncated"); if (validations.some((item) => item.stdout.truncated || item.stderr.truncated || item.sanitization.truncated)) limitations.push("validation-evidence-truncated"); if (validations.some((item) => item.stdout.redacted || item.stderr.redacted || item.sanitization.redactionCount > 0)) limitations.push("validation-evidence-redacted");
    if (readiness.truncated || sandbox.truncated || terminalState.truncated) limitations.push("provenance-evidence-truncated"); if (readiness.redactionCount + sandbox.redactionCount + terminalState.redactionCount > 0) limitations.push("provenance-evidence-redacted"); if (input.executionUnknown) limitations.push("execution-unknown");
    if (mergeBaseResult.exitCode !== 0) limitations.push("merge-base-unavailable");
    if (startHead !== finishHead || startRefs !== finishRefs || input.expectedFinalHead !== undefined && finishHead !== input.expectedFinalHead) limitations.push("repository-drift-detected");
    const packageStatus = limitations.includes("repository-drift-detected") ? "quarantined" : limitations.length > 0 ? "incomplete" : "captured";
    const core = {
      schemaVersion: "m7.review-package/v1", captureId: input.captureId,
      binding: { ownerId: input.ownerId, projectId: input.projectId, taskId: input.taskId, attemptId: input.attemptId, operationId: input.operationId, journalId: input.journalId, workerId: input.workerId, adapterId: input.adapterId, adapterRunId: input.adapterRunId },
      capturedAt: input.capturedAt, packageStatus,
      git: { repositoryId: sha256(canonicalPath(clone)), worktree: `managed://${input.projectId}/${input.attemptId}`, branch, detached: branch === null, head: finishHead, directParent: parentResult.exitCode === 0 ? parentResult.stdout.trim() : null, baselineCommit: input.baselineCommit, mergeBase: mergeBaseResult.exitCode === 0 ? mergeBaseResult.stdout.trim() : null, commitSubjects: subjects, refsStable: startRefs === finishRefs, configurationAssurance: { systemConfigDisabled: true, globalConfigDisabled: true, hooksDisabled: true, externalDiffDisabled: true, textConversionDisabled: true }, rawMetadataDigest: sha256(rawMeta), numstatDigest: sha256(numstat) },
      changedPaths: pathEvidence, diffStatistics: { files: status.length, additions, deletions, binaryFiles },
      diff: { format: "unified", text: diff.text, byteLimit: M7_CAPTURE_LIMITS.maxDiffBytes, truncated: diff.truncated, redacted: diff.redacted, redactionCount: diff.redactionCount, complete: !diff.truncated && !diff.redacted && !status.some((entry) => entry.untracked) },
      validations,
      artifacts: { references: validations.flatMap((item) => Array.isArray(item.artifactHashes) ? item.artifactHashes : []), quarantineStatus: validations.some((item) => Array.isArray(item.artifactHashes) && item.artifactHashes.length > 0) ? "metadata-only-not-executed" : "none-observed" },
      evidence: { workerReportedClaim: workerClaim, systemObserved: true, ownerAttestedManualEvidence: input.manualEvidence === undefined ? null : sanitizeStructured(input.manualEvidence).value, reviewerConclusion: null },
      provenance: { readiness: readiness.value, sandbox: sandbox.value, terminalState: terminalState.text, executionUnknown: input.executionUnknown, cancellation: validations.map((item) => item.processTreeTermination).filter(Boolean), applied: false, artifactExecution: false, manualRelay: input.manualEvidence !== undefined },
      limitations, redactions: { diff: diff.redactionCount, workerClaim: workerClaim?.redactionCount ?? 0, validations: validations.reduce((total, item) => total + item.stdout.redactionCount + item.stderr.redactionCount + item.sanitization.redactionCount, 0), provenance: readiness.redactionCount + sandbox.redactionCount + terminalState.redactionCount }, omissions: limitations.filter((item) => item.includes("omitted") || item.includes("truncated")),
    };
    const packageDigest = sha256(`chubz.m7.review-package/v1\n${canonical(core)}`);
    const packageId = `package-${packageDigest.slice("sha256:".length, "sha256:".length + 48)}`;
    const packageDocument = { ...core, packageId, packageDigest };
    const packageBytes = Buffer.from(`${canonical(packageDocument)}\n`, "utf8");
    if (packageBytes.length > M7_CAPTURE_LIMITS.maxPackageBytes) throw new Error("review package exceeds bound");
    const manifestCore = { schemaVersion: "m7.review-manifest/v1", packageId, captureId: input.captureId, files: [{ name: "review-package.json", sha256: sha256(packageBytes), byteLength: packageBytes.length }], totalByteLength: packageBytes.length, applied: false };
    const manifestDigest = sha256(`chubz.m7.review-manifest/v1\n${canonical(manifestCore)}`); const manifest = { ...manifestCore, manifestDigest };
    const targetDirectory = resolve(packageRoot, packageId); const staging = resolve(packageRoot, `.staging-${input.captureId}`);
    const captureMarker = resolve(packageRoot, `.capture-${input.captureId}.json`);
    if (!contained(packageRoot, targetDirectory) || !contained(packageRoot, staging)) throw new Error("package target escaped approved root");
    await Promise.all([rejectLinkChain(targetDirectory), rejectLinkChain(staging), rejectLinkChain(captureMarker)]);
    try { const marker = JSON.parse(await readFile(captureMarker, "utf8")) as { packageId?: string; packageDigest?: string }; if (marker.packageId !== packageId || marker.packageDigest !== packageDigest) throw new Error("immutable package conflict"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const existingPackage = resolve(targetDirectory, "review-package.json");
    try {
      const existing = await readFile(existingPackage); if (sha256(existing) !== manifestCore.files[0]!.sha256) throw new Error("immutable package conflict");
      return Object.freeze({ captureId: input.captureId, packageId, status: packageStatus, packageDirectory: targetDirectory, packagePath: existingPackage, manifestPath: resolve(targetDirectory, "manifest.json"), packageDigest, manifestDigest, byteLength: packageBytes.length, summary: Object.freeze({ baselineCommit: input.baselineCommit, finalHead: finishHead, changedPathCount: status.length, packageStatus, limitations }) });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: false }); await rejectLinkChain(staging);
    await writeFile(resolve(staging, "review-package.json"), packageBytes, { flag: "wx", mode: 0o400 });
    await writeFile(resolve(staging, "manifest.json"), `${canonical(manifest)}\n`, { flag: "wx", mode: 0o400 });
    await rename(staging, targetDirectory);
    try { await writeFile(captureMarker, `${canonical({ captureId: input.captureId, packageId, packageDigest })}\n`, { flag: "wx", mode: 0o400 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const marker = JSON.parse(await readFile(captureMarker, "utf8")) as { packageId?: string; packageDigest?: string }; if (marker.packageId !== packageId || marker.packageDigest !== packageDigest) throw new Error("immutable package conflict"); }
    return Object.freeze({ captureId: input.captureId, packageId, status: packageStatus, packageDirectory: targetDirectory, packagePath: resolve(targetDirectory, "review-package.json"), manifestPath: resolve(targetDirectory, "manifest.json"), packageDigest, manifestDigest, byteLength: packageBytes.length, summary: Object.freeze({ baselineCommit: input.baselineCommit, finalHead: finishHead, changedPathCount: status.length, packageStatus, limitations }) });
  }
}

export async function verifyFinalizedReviewPackage(result: ReviewPackageResult): Promise<boolean> {
  await Promise.all([rejectLinkChain(result.packagePath), rejectLinkChain(result.manifestPath)]);
  const [packageBytes, manifestBytes] = await Promise.all([readFile(result.packagePath), readFile(result.manifestPath)]);
  if (packageBytes.length !== result.byteLength) return false;
  const document = JSON.parse(packageBytes.toString("utf8")) as Record<string, unknown>; const documentDigest = document["packageDigest"]; const documentId = document["packageId"]; const { packageId: _packageId, packageDigest: _packageDigest, ...packageCore } = document;
  if (documentDigest !== result.packageDigest || documentId !== result.packageId || documentDigest !== sha256(`chubz.m7.review-package/v1\n${canonical(packageCore)}`)) return false;
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { packageId?: string; captureId?: string; files?: Array<{ name?: string; sha256?: string; byteLength?: number }>; manifestDigest?: string };
  if (manifest.packageId !== result.packageId || manifest.captureId !== result.captureId || !Array.isArray(manifest.files) || manifest.files.length !== 1 || manifest.files[0]?.name !== "review-package.json" || manifest.files[0].sha256 !== sha256(packageBytes) || manifest.files[0].byteLength !== packageBytes.length) return false;
  const { manifestDigest, ...core } = manifest;
  return manifestDigest === sha256(`chubz.m7.review-manifest/v1\n${canonical(core)}`) && manifestDigest === result.manifestDigest;
}
