import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { classifySensitivePath, verifyWriteScope, type WriteScope } from "@chubz/shared";

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type ManagedWorkspace = Readonly<{ projectId: string; attemptId: string; clonePath: string; worktreePath: string; branch: string; state: "active" | "removed" }>;
type Registry = Readonly<{ version: 1; workspaces: readonly ManagedWorkspace[] }>;

function canonical(path: string): string {
  const resolved = resolve(path).replace(/^\\\\\?\\/u, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(canonical(root), canonical(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function rejectLinksOnExistingPath(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsedRoot = absolute.slice(0, absolute.indexOf(sep) + 1);
  const parts = absolute.slice(parsedRoot.length).split(sep).filter(Boolean);
  let cursor = parsedRoot;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`symbolic link or junction rejected: ${cursor}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
}

function safeRelativePath(path: string): string {
  if (path.includes("\\") || /[\u0000-\u001f:]/u.test(path)) throw new Error("unsafe relative path");
  const normalized = path;
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
  if (!normalized || isAbsolute(path) || normalized.startsWith("/") || normalized.split("/").some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git" || part.endsWith(".") || part.endsWith(" ") || reserved.test(part))) throw new Error("unsafe relative path");
  return normalized;
}

function rejectLinksOnExistingPathSync(path: string): void {
  const absolute = resolve(path); const parsedRoot = absolute.slice(0, absolute.indexOf(sep) + 1); const parts = absolute.slice(parsedRoot.length).split(sep).filter(Boolean); let cursor = parsedRoot;
  for (const part of parts) { cursor = resolve(cursor, part); try { if (lstatSync(cursor).isSymbolicLink()) throw new Error(`symbolic link or junction rejected: ${cursor}`); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; } }
}

export class ManagedRepositoryService {
  private readonly managedRoot: string;
  private readonly worktreeRoot: string;
  private readonly hooksRoot: string;
  private readonly registryPath: string;

  public constructor(roots: Readonly<{ managedRoot: string; worktreeRoot: string }>) {
    this.managedRoot = resolve(roots.managedRoot);
    this.worktreeRoot = resolve(roots.worktreeRoot);
    if (this.managedRoot === this.worktreeRoot || contained(this.managedRoot, this.worktreeRoot) || contained(this.worktreeRoot, this.managedRoot)) throw new Error("managed clone and worktree roots must be disjoint");
    this.hooksRoot = resolve(this.managedRoot, `.trusted-empty-hooks-${randomBytes(16).toString("hex")}`);
    this.registryPath = resolve(this.managedRoot, ".workspace-registry.json");
  }

  private async initialize(): Promise<void> {
    await rejectLinksOnExistingPath(this.managedRoot);
    await rejectLinksOnExistingPath(this.worktreeRoot);
    await mkdir(this.managedRoot, { recursive: true });
    await mkdir(this.worktreeRoot, { recursive: true });
    await mkdir(this.hooksRoot, { recursive: true });
  }

  private async git(cwd: string | null, args: readonly string[]): Promise<string> {
    if ((await readdir(this.hooksRoot)).length !== 0) throw new Error("trusted no-hooks directory is not empty");
    const invocation = ["-c", `core.hooksPath=${this.hooksRoot}`, "-c", "core.symlinks=false", ...args];
    const inherited = ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP", "TMPDIR"].reduce<Record<string, string>>((result, key) => { const value = process.env[key]; if (value !== undefined) result[key] = value; return result; }, {});
    const { stdout } = await execFileAsync("git", invocation, { cwd: cwd ?? undefined, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 4_194_304, env: { ...inherited, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TEMPLATE_DIR: this.hooksRoot } });
    return stdout;
  }

  private async inspectTree(clonePath: string): Promise<void> {
    const tree = await this.git(clonePath, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]);
    const attributes: string[] = [];
    for (const line of tree.split("\0").filter(Boolean)) {
      const match = /^(\d+)\s+(\w+)\s+[0-9a-f]+\t(.+)$/u.exec(line);
      if (!match) throw new Error("malformed repository tree");
      const mode = match[1]!;
      const path = safeRelativePath(match[3]!);
      if (mode === "120000" || mode === "160000") throw new Error("repository symlinks, junction-like links, and submodules are rejected");
      if (path === ".gitmodules") throw new Error("submodules are rejected");
      if (path === ".gitattributes" || path.endsWith("/.gitattributes")) attributes.push(path);
    }
    for (const path of attributes) {
      const content = await this.git(clonePath, ["show", `HEAD:${path}`]);
      for (const line of content.split(/\r?\n/u)) {
        const policy = line.replace(/#.*/u, "").trim();
        if (/(^|\s)(-?filter|filter=)/iu.test(policy)) throw new Error("repository-controlled clean/smudge filters are rejected");
      }
    }
    const localConfig = await this.git(clonePath, ["config", "--local", "--get-regexp", "^(filter\\.|core\\.hooksPath$)"]).catch(() => "");
    if (localConfig.trim()) throw new Error("unsafe repository-local Git configuration rejected");
  }

  public async createManagedClone(source: string, projectId: string): Promise<string> {
    if (!SAFE_ID.test(projectId)) throw new Error("unsafe project id");
    await this.initialize();
    const target = resolve(this.managedRoot, projectId);
    if (!contained(this.managedRoot, target) || resolve(source) === target) throw new Error("unsafe managed clone target");
    await rejectLinksOnExistingPath(dirname(target));
    await this.git(null, ["clone", "--no-local", "--no-checkout", "--", source, target]);
    try {
      await this.inspectTree(target);
      await this.git(target, ["checkout", "--force", "HEAD"]);
      return target;
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    }
  }

  private async loadRegistry(): Promise<Registry> {
    try {
      const parsed = JSON.parse(await readFile(this.registryPath, "utf8")) as Registry;
      if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)) throw new Error("malformed workspace registry");
      return parsed;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ version: 1, workspaces: [] }); throw error; }
  }

  private async saveRegistry(registry: Registry): Promise<void> {
    const temporary = `${this.registryPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(registry)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.registryPath);
  }

  public async createWorktree(projectId: string, attemptId: string): Promise<ManagedWorkspace> {
    if (!SAFE_ID.test(projectId) || !SAFE_ID.test(attemptId)) throw new Error("unsafe workspace identity");
    await this.initialize();
    const clonePath = resolve(this.managedRoot, projectId);
    const worktreePath = resolve(this.worktreeRoot, projectId, attemptId);
    if (!contained(this.managedRoot, clonePath) || !contained(this.worktreeRoot, worktreePath)) throw new Error("workspace escaped approved root");
    await rejectLinksOnExistingPath(dirname(worktreePath));
    await mkdir(dirname(worktreePath), { recursive: true });
    const branch = `task/${projectId}/${attemptId}`;
    await this.git(clonePath, ["worktree", "add", "-b", branch, "--", worktreePath, "HEAD"]);
    await rejectLinksOnExistingPath(worktreePath);
    const workspace = Object.freeze({ projectId, attemptId, clonePath, worktreePath, branch, state: "active" as const });
    const registry = await this.loadRegistry();
    await this.saveRegistry(Object.freeze({ version: 1, workspaces: [...registry.workspaces.filter((item) => !(item.projectId === projectId && item.attemptId === attemptId)), workspace] }));
    return workspace;
  }

  public async cleanup(workspace: ManagedWorkspace): Promise<void> {
    await this.initialize();
    if (!contained(this.managedRoot, workspace.clonePath) || !contained(this.worktreeRoot, workspace.worktreePath) || workspace.worktreePath === this.worktreeRoot) throw new Error("refusing unsafe workspace cleanup");
    await rejectLinksOnExistingPath(dirname(workspace.worktreePath));
    await this.git(workspace.clonePath, ["worktree", "remove", "--force", "--", workspace.worktreePath]);
    await this.git(workspace.clonePath, ["branch", "-D", "--", workspace.branch]).catch(() => "");
    const registry = await this.loadRegistry();
    await this.saveRegistry(Object.freeze({ version: 1, workspaces: registry.workspaces.map((item) => item.projectId === workspace.projectId && item.attemptId === workspace.attemptId ? Object.freeze({ ...item, state: "removed" as const }) : item) }));
  }

  public async reconcile(): Promise<readonly ManagedWorkspace[]> {
    await this.initialize();
    const registry = await this.loadRegistry();
    const reconciled: ManagedWorkspace[] = [];
    for (const workspace of registry.workspaces) {
      if (!contained(this.managedRoot, workspace.clonePath) || !contained(this.worktreeRoot, workspace.worktreePath)) throw new Error("unsafe registry entry");
      await rejectLinksOnExistingPath(workspace.clonePath); await rejectLinksOnExistingPath(workspace.worktreePath);
      let exists = true;
      try { await lstat(workspace.worktreePath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
      reconciled.push(Object.freeze({ ...workspace, state: exists ? "active" : "removed" }));
      if (!exists) await this.git(workspace.clonePath, ["worktree", "prune"]);
    }
    await this.saveRegistry(Object.freeze({ version: 1, workspaces: reconciled }));
    return reconciled;
  }
}

function wildcardMatches(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace("*", "[^/]*");
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "iu" : "u").test(path);
}

export class WriteScopeAuthority {
  private readonly scope: WriteScope;
  public constructor(raw: unknown, private readonly worktreeRoot: string) {
    const verified = verifyWriteScope(raw);
    if (!verified.ok) throw new Error("invalid write scope");
    this.scope = verified.value;
  }
  public authorize(path: string, operation: "create" | "modify" | "delete", bytes: number): string {
    const normalized = safeRelativePath(path);
    const absolute = resolve(this.worktreeRoot, ...normalized.split("/"));
    rejectLinksOnExistingPathSync(absolute);
    if (!contained(this.worktreeRoot, absolute) || bytes < 0 || bytes > this.scope.maxBytes) throw new Error("write exceeds approved workspace or size");
    if (!this.scope.permissions[operation]) throw new Error("write operation is not authorized");
    if (classifySensitivePath(normalized).disposition !== "safe") throw new Error("sensitive path rejected");
    if (this.scope.readOnlyPaths.some((rule) => wildcardMatches(rule, normalized))) throw new Error("read-only path rejected");
    const equals = (left: string, right: string): boolean => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
    const within = (root: string, value: string): boolean => equals(root, value) || (process.platform === "win32" ? value.toLowerCase().startsWith(`${root.toLowerCase()}/`) : value.startsWith(`${root}/`));
    const allowed = this.scope.allowedExactPaths.some((rule) => equals(rule, normalized)) || this.scope.allowedPathPatterns.some((rule) => wildcardMatches(rule, normalized)) || (this.scope.generatedArtifactRoot !== null && within(this.scope.generatedArtifactRoot, normalized));
    if (!allowed) throw new Error("path outside write scope");
    return absolute;
  }
  public authorizeBatch(changes: readonly Readonly<{ path: string; operation: "create" | "modify" | "delete"; bytes: number }>[]): readonly string[] {
    if (changes.length > this.scope.maxFiles || changes.reduce((total, change) => total + change.bytes, 0) > this.scope.maxBytes) throw new Error("write batch exceeds approved scope bounds");
    if (new Set(changes.map((change) => process.platform === "win32" ? change.path.toLowerCase() : change.path)).size !== changes.length) throw new Error("duplicate write paths rejected");
    return changes.map((change) => this.authorize(change.path, change.operation, change.bytes));
  }
}
