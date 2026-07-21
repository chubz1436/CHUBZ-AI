import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestWriteScope } from "@chubz/shared";
import { ManagedRepositoryService, WriteScopeAuthority } from "../src/index.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
function sourceRepository(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `chubz-source-${name}-`)); roots.push(root); git(root, "init", "-b", "main"); git(root, "config", "user.email", "fixture@example.test"); git(root, "config", "user.name", "Fixture"); writeFileSync(join(root, "README.md"), "owner baseline\n"); git(root, "add", "README.md"); git(root, "commit", "-m", "fixture"); return root;
}
const checksum = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("managed clone and isolated worktree foundation", () => {
  it("creates and cleans an isolated per-attempt branch without changing the owner tree", async () => {
    const source = sourceRepository("safe"); const beforeStatus = git(source, "status", "--porcelain"); const beforeChecksum = checksum(join(source, "README.md"));
    const base = mkdtempSync(join(tmpdir(), "chubz-managed-")); roots.push(base); const service = new ManagedRepositoryService({ managedRoot: join(base, "clones"), worktreeRoot: join(base, "worktrees") });
    const clone = await service.createManagedClone(source, "demo"); const workspace = await service.createWorktree("demo", "attempt-one");
    writeFileSync(join(workspace.worktreePath, "README.md"), "isolated change\n");
    expect(clone).not.toBe(source); expect(workspace.branch).toBe("task/demo/attempt-one"); expect(readFileSync(join(source, "README.md"), "utf8")).toBe("owner baseline\n");
    expect(git(source, "status", "--porcelain")).toBe(beforeStatus); expect(checksum(join(source, "README.md"))).toBe(beforeChecksum);
    await service.cleanup(workspace); expect(existsSync(workspace.worktreePath)).toBe(false); expect((await service.reconcile())[0]?.state).toBe("removed");
  });

  it("rejects traversal and unsafe identifiers before filesystem writes", async () => {
    const source = sourceRepository("paths"); const base = mkdtempSync(join(tmpdir(), "chubz-paths-")); roots.push(base); const service = new ManagedRepositoryService({ managedRoot: join(base, "clones"), worktreeRoot: join(base, "worktrees") });
    await expect(service.createManagedClone(source, "../escape")).rejects.toThrow("unsafe project id");
    await service.createManagedClone(source, "safe"); await expect(service.createWorktree("safe", "../escape")).rejects.toThrow("unsafe workspace identity");
  });

  it("fails closed before checkout for repository-controlled filters and symlinks", async () => {
    const filtered = sourceRepository("filter"); writeFileSync(join(filtered, ".gitattributes"), "*.md filter=evil\n"); git(filtered, "add", ".gitattributes"); git(filtered, "commit", "-m", "filter");
    const base = mkdtempSync(join(tmpdir(), "chubz-hostile-")); roots.push(base); const service = new ManagedRepositoryService({ managedRoot: join(base, "clones"), worktreeRoot: join(base, "worktrees") });
    await expect(service.createManagedClone(filtered, "filtered")).rejects.toThrow("filters are rejected");

    const linked = sourceRepository("link"); const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: linked, input: "../outside", encoding: "utf8" }).trim();
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `120000,${blob},escape-link`], { cwd: linked }); git(linked, "commit", "-m", "link");
    await expect(service.createManagedClone(linked, "linked")).rejects.toThrow("symlinks");
  });

  it("neutralizes source-controlled hook configuration", async () => {
    const source = sourceRepository("hooks"); const sentinel = join(source, "hook-ran.txt"); writeFileSync(join(source, "post-checkout.cmd"), `@echo hook-ran>"${sentinel}"\r\n`); git(source, "add", "post-checkout.cmd"); git(source, "commit", "-m", "tracked hook"); git(source, "config", "core.hooksPath", ".");
    const base = mkdtempSync(join(tmpdir(), "chubz-hooks-")); roots.push(base); const service = new ManagedRepositoryService({ managedRoot: join(base, "clones"), worktreeRoot: join(base, "worktrees") });
    await service.createManagedClone(source, "hooks"); expect(existsSync(sentinel)).toBe(false);
  });

  it.runIf(process.platform === "win32")("rejects a junction introduced inside an approved worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "chubz-junction-")); roots.push(root); const worktree = join(root, "worktree"); const outside = join(root, "outside"); mkdirSync(worktree); mkdirSync(outside); symlinkSync(outside, join(worktree, "src"), "junction");
    const core = { scopeVersion: "1.0" as const, scopeId: "scope-junction", repositoryRootId: "repo-junction", worktreeRootId: "worktree-junction", taskId: "task-junction", attemptId: "attempt-junction", operationId: "operation-junction", allowedExactPaths: ["src/app.ts"], allowedPathPatterns: [], deniedPathClasses: ["credentials" as const], readOnlyPaths: [], generatedArtifactRoot: null, permissions: { create: true, modify: true, delete: false }, maxFiles: 10, maxBytes: 1024 }; const digest = digestWriteScope(core); if (!digest.ok) throw new Error("fixture digest failed");
    expect(() => new WriteScopeAuthority({ ...core, scopeHash: digest.value }, worktree).authorize("src/app.ts", "create", 10)).toThrow("junction rejected");
  });
});

describe("scoped write authority", () => {
  it("accepts allowed paths and rejects read-only, sensitive, traversal, and unlisted paths", () => {
    const core = { scopeVersion: "1.0" as const, scopeId: "scope-one", repositoryRootId: "repo-one", worktreeRootId: "worktree-one", taskId: "task-one", attemptId: "attempt-one", operationId: "operation-one", allowedExactPaths: ["src/app.ts"], allowedPathPatterns: ["test/*.test.ts"], deniedPathClasses: ["credentials" as const, "production" as const], readOnlyPaths: ["test/locked.test.ts"], generatedArtifactRoot: "artifacts", permissions: { create: true, modify: true, delete: false }, maxFiles: 10, maxBytes: 1024 };
    const digest = digestWriteScope(core); if (!digest.ok) throw new Error("fixture digest failed"); const authority = new WriteScopeAuthority({ ...core, scopeHash: digest.value }, "C:\\managed\\attempt");
    expect(authority.authorize("src/app.ts", "modify", 100)).toContain("app.ts"); expect(authority.authorize("test/new.test.ts", "create", 100)).toContain("new.test.ts");
    for (const path of ["test/locked.test.ts", "../escape", ".env", "other.txt"]) expect(() => authority.authorize(path, "modify", 100)).toThrow();
    expect(() => authority.authorize("src/app.ts", "delete", 0)).toThrow(); expect(() => authority.authorize("src/app.ts", "modify", 2048)).toThrow();
    expect(() => authority.authorizeBatch([{ path: "src/app.ts", operation: "modify", bytes: 800 }, { path: "test/new.test.ts", operation: "modify", bytes: 800 }])).toThrow("batch exceeds");
  });
});
