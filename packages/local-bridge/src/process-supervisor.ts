import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import type { EmergencyStopGate } from "./emergency-stop.js";

const execFileAsync = promisify(execFile);

export type TreeRole = "worker" | "validator";
export type ProcessExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
export type TerminationEvidence = Readonly<{
  treeRole: TreeRole;
  rootPid: number;
  observedPids: readonly number[];
  terminatedPids: readonly number[];
  livePids: readonly number[];
  unknownPids: readonly number[];
  proven: boolean;
  observedAt: string;
  completedAt: string;
}>;

export interface SpawnedProcess {
  readonly pid: number;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exit: Promise<ProcessExit>;
  writeStdin(value: Uint8Array): Promise<void>;
  closeStdin(): void;
}

export interface ProcessSpawner {
  spawn(executable: string, args: readonly string[], options: Readonly<{ cwd: string; env: Readonly<Record<string, string>> }>): SpawnedProcess;
}

export interface ProcessTreeController {
  terminate(rootPid: number, role: TreeRole, deadlineMs: number): Promise<TerminationEvidence>;
}

export class NodeProcessSpawner implements ProcessSpawner {
  public spawn(executable: string, args: readonly string[], options: Readonly<{ cwd: string; env: Readonly<Record<string, string>> }>): SpawnedProcess {
    if (!executable || executable.includes("\0") || args.some((arg) => arg.includes("\0") || arg.length > 16_384)) throw new Error("invalid parameterized invocation");
    const child = spawn(executable, [...args], { cwd: options.cwd, env: { ...options.env }, shell: false, windowsHide: true, detached: false, stdio: ["pipe", "pipe", "pipe"] });
    if (child.pid === undefined || child.stdout === null || child.stderr === null || child.stdin === null) throw new Error("process did not expose required handles");
    const exit = new Promise<ProcessExit>((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve(Object.freeze({ code, signal }))); });
    return Object.freeze({
      pid: child.pid,
      stdout: child.stdout,
      stderr: child.stderr,
      exit,
      writeStdin: (value: Uint8Array) => new Promise<void>((resolve, reject) => child.stdin!.write(value, (error) => error ? reject(error) : resolve())),
      closeStdin: () => child.stdin!.end(),
    });
  }
}

const WINDOWS_TREE_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$RootProcessId=[int]$env:CHUBZ_PROCESS_TREE_ROOT_PID
$DeadlineMs=[int]$env:CHUBZ_PROCESS_TREE_DEADLINE_MS
$observedAt=[DateTime]::UtcNow.ToString('o')
$unknown=@()
try { $snapshot=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId) } catch {
  [Console]::Out.Write((@{observedPids=@();terminatedPids=@();livePids=@();unknownPids=@($RootProcessId);proven=$false;observedAt=$observedAt;completedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress)); exit 0
}
$ids=New-Object 'System.Collections.Generic.HashSet[int]'; [void]$ids.Add($RootProcessId)
do { $before=$ids.Count; foreach($p in $snapshot) { if($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } } } while($ids.Count -ne $before)
$observed=@($ids | Sort-Object); $terminated=@()
foreach($id in @($observed | Sort-Object -Descending)) { try { Stop-Process -Id $id -Force -ErrorAction Stop; $terminated += $id } catch { if(Get-Process -Id $id -ErrorAction SilentlyContinue) { $unknown += $id } } }
$until=[DateTime]::UtcNow.AddMilliseconds($DeadlineMs); do { $live=@($observed | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }); if($live.Count -eq 0) { break }; Start-Sleep -Milliseconds 25 } while([DateTime]::UtcNow -lt $until)
$live=@($observed | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }); $proven=($live.Count -eq 0 -and $unknown.Count -eq 0 -and $observed -contains $RootProcessId)
[Console]::Out.Write((@{observedPids=$observed;terminatedPids=@($terminated|Sort-Object -Unique);livePids=$live;unknownPids=@($unknown|Sort-Object -Unique);proven=$proven;observedAt=$observedAt;completedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress))
`;

export class WindowsProcessTreeController implements ProcessTreeController {
  public async terminate(rootPid: number, role: TreeRole, deadlineMs: number): Promise<TerminationEvidence> {
    if (process.platform !== "win32") throw new Error("Windows process-tree controller is unavailable");
    if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || deadlineMs < 1 || deadlineMs > 60_000) throw new Error("invalid termination request");
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TREE_SCRIPT], { encoding: "utf8", windowsHide: true, timeout: deadlineMs + 5_000, maxBuffer: 262_144, env: { ...process.env, CHUBZ_PROCESS_TREE_ROOT_PID: String(rootPid), CHUBZ_PROCESS_TREE_DEADLINE_MS: String(deadlineMs) } });
      const value = JSON.parse(stdout) as Omit<TerminationEvidence, "treeRole" | "rootPid">;
      const numbers = (raw: unknown, fallback: readonly number[]): number[] => Array.isArray(raw) ? raw.map(Number) : typeof raw === "number" ? [raw] : [...fallback];
      const observedPids = numbers(value.observedPids, []);
      const livePids = numbers(value.livePids, [rootPid]);
      const unknownPids = numbers(value.unknownPids, [rootPid]);
      const proven = value.proven === true && observedPids.includes(rootPid) && livePids.length === 0 && unknownPids.length === 0;
      return Object.freeze({ ...value, treeRole: role, rootPid, observedPids, livePids, unknownPids, terminatedPids: numbers(value.terminatedPids, []), proven });
    } catch {
      const now = new Date().toISOString();
      return Object.freeze({ treeRole: role, rootPid, observedPids: [], terminatedPids: [], livePids: [], unknownPids: [rootPid], proven: false, observedAt: now, completedAt: now });
    }
  }
}

class BoundedCapture {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  public truncated = false;
  public constructor(private readonly maximum: number) {}
  public add(chunk: Uint8Array): void {
    const remaining = this.maximum - this.bytes;
    if (remaining <= 0) { this.truncated = true; return; }
    const buffer = Buffer.from(chunk);
    this.chunks.push(buffer.subarray(0, remaining));
    this.bytes += Math.min(buffer.byteLength, remaining);
    if (buffer.byteLength > remaining) this.truncated = true;
  }
  public text(): string { return Buffer.concat(this.chunks).toString("utf8"); }
}

export type ProcessRunRequest = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  taskContent: string;
  role: TreeRole;
  timeoutMs: number;
  terminationDeadlineMs: number;
  maxOutputBytes: number;
  emergencyScope?: Readonly<{ projectId: string; operationId: string }>;
  signal?: AbortSignal;
}>;
export type ProcessRunResult = Readonly<{
  rootPid: number;
  state: "completed" | "failed" | "cancelled" | "execution-unknown";
  exit: ProcessExit | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  terminationEvidence: TerminationEvidence | null;
  stopReason: "timeout" | "cancel" | null;
}>;

export class ProcessSupervisor {
  public constructor(private readonly spawner: ProcessSpawner, private readonly trees: ProcessTreeController, private readonly emergencyGate?: EmergencyStopGate) {}

  public async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    if (request.timeoutMs < 1 || request.timeoutMs > 86_400_000 || request.maxOutputBytes < 1 || request.maxOutputBytes > 16_777_216) throw new Error("invalid process bounds");
    if (Buffer.byteLength(request.taskContent) > 1_048_576) throw new Error("task content exceeds stdin bound");
    if (request.args.includes(request.taskContent)) throw new Error("task content must be delivered on stdin, not argv");
    const spawn = () => this.spawner.spawn(request.executable, request.args, { cwd: request.cwd, env: request.env });
    const child = this.emergencyGate ? request.emergencyScope ? this.emergencyGate.runBeforeSpawn(request.emergencyScope.projectId, request.emergencyScope.operationId, spawn) : (() => { throw new Error("emergency-stop scope is required before external process spawn"); })() : spawn();
    const stdout = new BoundedCapture(request.maxOutputBytes);
    const stderr = new BoundedCapture(request.maxOutputBytes);
    const drain = async (source: AsyncIterable<Uint8Array>, capture: BoundedCapture): Promise<void> => { for await (const chunk of source) capture.add(chunk); };
    const drains = Promise.all([drain(child.stdout, stdout), drain(child.stderr, stderr)]);
    try {
      await child.writeStdin(Buffer.from(request.taskContent, "utf8"));
      child.closeStdin();
    } catch (error) {
      const evidence = await this.safeTerminate(child.pid, request.role, request.terminationDeadlineMs);
      if (!evidence.proven) throw new Error("stdin delivery failed and process termination is unproven", { cause: error });
      throw error;
    }

    let timeout: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const stopReason = new Promise<"timeout" | "cancel">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), request.timeoutMs);
      abortHandler = () => resolve("cancel");
      request.signal?.addEventListener("abort", abortHandler, { once: true });
      if (request.signal?.aborted) resolve("cancel");
    });
    const outcome = await Promise.race([child.exit.then((exit) => ({ kind: "exit" as const, exit })), stopReason.then((reason) => ({ kind: "stop" as const, reason }))]);
    if (timeout) clearTimeout(timeout);
    if (abortHandler) request.signal?.removeEventListener("abort", abortHandler);

    let exit: ProcessExit | null = null;
    let terminationEvidence: TerminationEvidence | null = null;
    let resolvedStopReason: "timeout" | "cancel" | null = null;
    let state: ProcessRunResult["state"];
    if (outcome.kind === "exit") { exit = outcome.exit; state = exit.code === 0 ? "completed" : "failed"; }
    else {
      resolvedStopReason = outcome.reason;
      terminationEvidence = await this.safeTerminate(child.pid, request.role, request.terminationDeadlineMs);
      state = terminationEvidence.proven ? "cancelled" : "execution-unknown";
      if (terminationEvidence.proven) exit = await Promise.race([child.exit, new Promise<null>((resolve) => setTimeout(() => resolve(null), request.terminationDeadlineMs))]);
    }
    await Promise.race([drains, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    return Object.freeze({ rootPid: child.pid, state, exit, stdout: stdout.text(), stderr: stderr.text(), stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated, terminationEvidence, stopReason: resolvedStopReason });
  }

  private async safeTerminate(rootPid: number, role: TreeRole, deadlineMs: number): Promise<TerminationEvidence> {
    try { return await this.trees.terminate(rootPid, role, deadlineMs); }
    catch { const now = new Date().toISOString(); return Object.freeze({ treeRole: role, rootPid, observedPids: [], terminatedPids: [], livePids: [], unknownPids: [rootPid], proven: false, observedAt: now, completedAt: now }); }
  }
}

export function combineTreeEvidence(worker: TerminationEvidence | null, validator: TerminationEvidence | null): Readonly<{ worker: TerminationEvidence | null; validator: TerminationEvidence | null; proven: boolean }> {
  const complete = (value: TerminationEvidence | null): boolean => value !== null && value.proven && value.observedPids.includes(value.rootPid) && value.livePids.length === 0 && value.unknownPids.length === 0;
  return Object.freeze({ worker, validator, proven: complete(worker) && complete(validator) });
}
