import { cwd } from "node:process";
import { describe, expect, it } from "vitest";
import { ProcessSupervisor, combineTreeEvidence, type ProcessExit, type ProcessSpawner, type ProcessTreeController, type SpawnedProcess, type TerminationEvidence, type TreeRole } from "../src/index.js";

async function* chunks(values: readonly string[]): AsyncIterable<Uint8Array> { for (const value of values) yield Buffer.from(value); }

class FakeSpawner implements ProcessSpawner {
  public taskInput = ""; public executable = ""; public args: readonly string[] = []; public exitResolver: ((exit: ProcessExit) => void) | null = null;
  public constructor(private readonly output: readonly string[] = [], private readonly error: readonly string[] = []) {}
  public spawn(executable: string, args: readonly string[]): SpawnedProcess {
    this.executable = executable; this.args = args;
    const exit = new Promise<ProcessExit>((resolve) => { this.exitResolver = resolve; });
    return Object.freeze({ pid: 4242, stdout: chunks(this.output), stderr: chunks(this.error), exit, writeStdin: async (value: Uint8Array) => { this.taskInput += Buffer.from(value).toString("utf8"); }, closeStdin: () => undefined });
  }
}

class FakeTrees implements ProcessTreeController {
  public constructor(private readonly proven: boolean) {}
  public async terminate(rootPid: number, role: TreeRole, _deadlineMs: number): Promise<TerminationEvidence> { const now = new Date().toISOString(); return Object.freeze({ treeRole: role, rootPid, observedPids: this.proven ? [rootPid, rootPid + 1] : [], terminatedPids: this.proven ? [rootPid, rootPid + 1] : [], livePids: [], unknownPids: this.proven ? [] : [rootPid], proven: this.proven, observedAt: now, completedAt: now }); }
}

class ThrowingTrees implements ProcessTreeController { public async terminate(): Promise<TerminationEvidence> { throw new Error("synthetic evidence failure"); } }

const request = (overrides: Record<string, unknown> = {}) => ({ executable: "synthetic-worker.exe", args: ["--structured"], cwd: cwd(), env: {}, taskContent: "private task body", role: "worker" as const, timeoutMs: 1_000, terminationDeadlineMs: 100, maxOutputBytes: 8, ...overrides });

describe("process supervisor", () => {
  it("uses parameterized invocation, sends task content only on stdin, and bounds output", async () => {
    const spawner = new FakeSpawner(["123456", "789"], ["abcdefghijk"]); const supervisor = new ProcessSupervisor(spawner, new FakeTrees(true));
    const pending = supervisor.run(request()); await new Promise((resolve) => setImmediate(resolve)); spawner.exitResolver!({ code: 0, signal: null });
    const result = await pending;
    expect(spawner.args).toEqual(["--structured"]); expect(spawner.args.join(" ")).not.toContain("private task body"); expect(spawner.taskInput).toBe("private task body");
    expect(result.stdout).toBe("12345678"); expect(result.stderr).toBe("abcdefgh"); expect(result.stdoutTruncated).toBe(true); expect(result.stderrTruncated).toBe(true); expect(result.state).toBe("completed"); expect(result.rootPid).toBe(4242);
  });

  it("rejects task content in argv", async () => {
    const supervisor = new ProcessSupervisor(new FakeSpawner(), new FakeTrees(true));
    await expect(supervisor.run(request({ args: ["private task body"] }))).rejects.toThrow("stdin, not argv");
  });

  it("handles cancellation and timeout but only claims cancelled with complete tree proof", async () => {
    const controller = new AbortController(); const provenSpawner = new FakeSpawner(); const provenRun = new ProcessSupervisor(provenSpawner, new FakeTrees(true)).run(request({ signal: controller.signal }));
    controller.abort(); expect((await provenRun).state).toBe("cancelled");
    const unknownSpawner = new FakeSpawner(); const unknown = await new ProcessSupervisor(unknownSpawner, new FakeTrees(false)).run(request({ timeoutMs: 5 }));
    expect(unknown.state).toBe("execution-unknown"); expect(unknown.terminationEvidence?.unknownPids).toEqual([4242]);
    const throwingSpawner = new FakeSpawner(); const throwing = await new ProcessSupervisor(throwingSpawner, new ThrowingTrees()).run(request({ timeoutMs: 5 }));
    expect(throwing.state).toBe("execution-unknown"); expect(throwing.terminationEvidence?.unknownPids).toEqual([4242]);
  });

  it("requires complete independent worker and validator termination evidence", async () => {
    const worker = await new FakeTrees(true).terminate(10, "worker", 10); const validatorUnknown = await new FakeTrees(false).terminate(20, "validator", 10); const validator = await new FakeTrees(true).terminate(20, "validator", 10);
    expect(combineTreeEvidence(worker, validatorUnknown).proven).toBe(false);
    const complete = combineTreeEvidence(worker, validator); expect(complete.proven).toBe(true); expect(complete.worker?.rootPid).toBe(10); expect(complete.validator?.rootPid).toBe(20);
  });
});
