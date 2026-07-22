import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceCaptureService, ManagedRepositoryService, verifyFinalizedReviewPackage, type ReviewCaptureRequest } from "../src/index.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

async function fixture(): Promise<{ request: ReviewCaptureRequest; worktree: string }> {
  const source = mkdtempSync(join(tmpdir(), "chubz-m7-source-")); roots.push(source); git(source, "init", "-b", "main"); git(source, "config", "user.email", "fixture@example.test"); git(source, "config", "user.name", "Fixture"); writeFileSync(join(source, "README.md"), "baseline\n"); writeFileSync(join(source, "old.txt"), "old\n"); writeFileSync(join(source, "delete.txt"), "delete me\n"); git(source, "add", "."); git(source, "commit", "-m", "baseline");
  const base = mkdtempSync(join(tmpdir(), "chubz-m7-managed-test-")); roots.push(base); const cloneRoot = join(base, "clones"); const worktreeRoot = join(base, "worktrees"); const dataRoot = join(base, "managed-data"); const packageRoot = join(dataRoot, "review-packages"); mkdirSync(dataRoot); mkdirSync(packageRoot);
  const repositories = new ManagedRepositoryService({ managedRoot: cloneRoot, worktreeRoot }); const clone = await repositories.createManagedClone(source, "project-one"); const workspace = await repositories.createWorktree("project-one", "attempt-one"); const baseline = git(workspace.worktreePath, "rev-parse", "HEAD");
  writeFileSync(join(workspace.worktreePath, "README.md"), "changed\n"); writeFileSync(join(workspace.worktreePath, "new.txt"), "new evidence\n");
  const at = "2026-07-22T10:00:00.000Z";
  const process = { rootPid: 42, state: "completed" as const, exit: { code: 0, signal: null }, stdout: "Tests 2 passed | 1 skipped\n", stderr: "", stdoutTruncated: false, stderrTruncated: false, terminationEvidence: null, stopReason: null };
  return { worktree: workspace.worktreePath, request: { captureId: "capture-one", ownerId: "owner-one", projectId: "project-one", taskId: "task-one", attemptId: "attempt-one", operationId: "operation-one", journalId: "journal-one", workerId: "codex-cli", adapterId: "codex-cli-adapter", adapterRunId: "run-one", managedClonePath: clone, managedCloneRoot: cloneRoot, worktreePath: workspace.worktreePath, managedWorktreeRoot: worktreeRoot, packageRoot, managedDataRoot: dataRoot, baselineCommit: baseline, expectedFinalHead: baseline, workerClaim: "I changed two files and tests passed", readiness: { state: "ready" }, sandbox: { assurance: "elevated" }, terminalState: "completed", executionUnknown: false, applied: false, validations: [{ validationId: "validation-one", kind: "test", command: ["pnpm", "test"], cwdLabel: "managed://project-one/attempt-one", startedAt: at, finishedAt: at, process }], capturedAt: at } };
}

describe("M7 authoritative evidence capture", () => {
  it("observes managed Git state, bounds untracked content, parses real process evidence, and creates a hash-verifiable immutable package", async () => {
    const { request } = await fixture(); const service = new EvidenceCaptureService(request.managedDataRoot); mkdirSync(join(request.packageRoot, ".staging-orphan")); expect(await service.reconcileStaging({ managedDataRoot: request.managedDataRoot, packageRoot: request.packageRoot })).toBe(1); const [first, duplicate] = await Promise.all([service.capture(request), service.capture(request)]);
    expect(duplicate).toEqual(first); expect(first.status).toBe("incomplete"); expect(await verifyFinalizedReviewPackage(first)).toBe(true);
    const document = JSON.parse(readFileSync(first.packagePath, "utf8")) as Record<string, unknown>; const paths = document["changedPaths"] as Array<Record<string, unknown>>; const validations = document["validations"] as Array<Record<string, unknown>>;
    expect(paths.map((entry) => entry.path)).toEqual(["new.txt", "README.md"]); expect(paths[0]?.content).toMatchObject({ included: false, reason: "untracked-content-omitted-from-text-diff" });
    expect(validations[0]).toMatchObject({ exitCode: 0, authoritativeOutcome: "passed", parser: { parsed: true, passed: 2, failed: 0, skipped: 1, total: 3 } }); expect(document["applied"]).toBeUndefined(); expect((document["provenance"] as Record<string, unknown>)["applied"]).toBe(false);
    await expect(service.capture({ ...request, workerClaim: "different claim" })).rejects.toThrow("immutable package conflict");
  });

  it("redacts secret-like diff and worker output without presenting evidence as complete", async () => {
    const { request, worktree } = await fixture(); const secret = "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"; writeFileSync(join(worktree, "README.md"), `changed\napi_key=${secret}\n`);
    const validation = request.validations[0]!; const result = await new EvidenceCaptureService(request.managedDataRoot).capture({ ...request, captureId: "capture-redacted", workerClaim: `token=${secret}`, validations: [{ ...validation, command: ["tool", `--api-key=${secret}`], process: { ...validation.process, stdout: `token=${secret}\nTests 1 passed` } }] }); const text = readFileSync(result.packagePath, "utf8");
    expect(text).not.toContain(secret); expect(text).toContain("REDACTED"); expect(result.status).toBe("incomplete");
  });

  it("captures rename, delete, binary metadata, modes, aggregate statistics, and explicit diff truncation", async () => {
    const { request, worktree } = await fixture(); git(worktree, "mv", "old.txt", "renamed.txt"); git(worktree, "rm", "delete.txt"); writeFileSync(join(worktree, "binary.bin"), Buffer.from([0, 1, 2, 3])); writeFileSync(join(worktree, "README.md"), "line changed\n".repeat(70_000));
    const result = await new EvidenceCaptureService(request.managedDataRoot).capture({ ...request, captureId: "capture-metadata" }); const document = JSON.parse(readFileSync(result.packagePath, "utf8")) as { changedPaths: Array<Record<string, unknown>>; diff: Record<string, unknown>; diffStatistics: Record<string, unknown> };
    expect(document.changedPaths.find((entry) => entry.path === "renamed.txt")).toMatchObject({ originalPath: "old.txt", operation: "renamed", staged: true });
    expect(document.changedPaths.find((entry) => entry.path === "delete.txt")).toMatchObject({ operation: "deleted", afterHash: null });
    expect(document.changedPaths.find((entry) => entry.path === "binary.bin")?.content).toMatchObject({ binary: true, included: false, reason: "binary-content-omitted" });
    expect(document.diff).toMatchObject({ truncated: true, complete: false }); expect(Number(document.diffStatistics.additions)).toBeGreaterThan(1); expect(result.status).toBe("incomplete");
  });

  it("rejects owner copies, traversal roots, sensitive paths, and validation success inferred only from text", async () => {
    const { request, worktree } = await fixture(); const service = new EvidenceCaptureService(request.managedDataRoot);
    await expect(service.capture({ ...request, captureId: "capture-owner-copy", worktreePath: request.managedWorktreeRoot })).rejects.toThrow("exact managed clone and attempt worktree");
    writeFileSync(join(worktree, ".env"), "API_KEY=unsafe\n"); await expect(service.capture({ ...request, captureId: "capture-sensitive" })).rejects.toThrow("sensitive path"); rmSync(join(worktree, ".env"));
    const failedProcess = { ...request.validations[0]!.process, state: "failed" as const, exit: { code: 1, signal: null }, stdout: "100 tests passed" }; const result = await service.capture({ ...request, captureId: "capture-failed-validation", validations: [{ ...request.validations[0]!, process: failedProcess }] }); const document = JSON.parse(readFileSync(result.packagePath, "utf8")) as { validations: Array<{ authoritativeOutcome: string; parser: { passed: number } }> };
    expect(document.validations[0]).toMatchObject({ authoritativeOutcome: "failed", parser: { passed: 100 } });
    const drift = await service.capture({ ...request, captureId: "capture-drift", expectedFinalHead: "f".repeat(40) }); expect(drift.status).toBe("quarantined"); expect(drift.summary["limitations"]).toContain("repository-drift-detected");
  });

  it.runIf(process.platform === "win32")("rejects a junction introduced inside the capture worktree", async () => {
    const { request, worktree } = await fixture(); const outside = mkdtempSync(join(tmpdir(), "chubz-m7-outside-")); roots.push(outside); writeFileSync(join(outside, "probe.txt"), "outside\n"); symlinkSync(outside, join(worktree, "linked"), "junction");
    await expect(new EvidenceCaptureService(request.managedDataRoot).capture({ ...request, captureId: "capture-junction" })).rejects.toThrow("symbolic links, junctions, and reparse points");
  });
});
