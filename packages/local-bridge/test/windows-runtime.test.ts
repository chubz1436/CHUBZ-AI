import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { NodeProcessSpawner, ProcessSupervisor, WindowsDpapiProtector, WindowsProcessTreeController } from "../src/index.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => { while (roots.length) { const path = roots.pop()!; for (let attempt = 0; attempt < 5; attempt += 1) { try { await rm(path, { recursive: true, force: true }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } } } });

describe.runIf(process.platform === "win32")("controlled Windows runtime probes", () => {
  it("round-trips synthetic enrollment bytes through CurrentUser DPAPI", async () => {
    const protector = new WindowsDpapiProtector(); const plaintext = Buffer.from(`synthetic-${randomBytes(24).toString("hex")}`);
    const protectedValue = await protector.protect(plaintext);
    expect(Buffer.from(protectedValue).equals(plaintext)).toBe(false); expect(Buffer.from(await protector.unprotect(protectedValue)).equals(plaintext)).toBe(true);
  });

  it("correlates and terminates a synthetic root and descendant process tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "chubz-process-probe-")); roots.push(root); const script = join(root, "worker.cjs");
    await writeFile(script, `const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log('child='+child.pid); process.stdin.resume(); setInterval(()=>{},1000);\n`);
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const result = await new ProcessSupervisor(new NodeProcessSpawner(), new WindowsProcessTreeController()).run({ executable: process.execPath, args: [script], cwd: root, env: environment, taskContent: "synthetic task via stdin", role: "worker", timeoutMs: 500, terminationDeadlineMs: 5_000, maxOutputBytes: 4_096 });
    if (result.terminationEvidence?.proven !== true) {
      const childPid = /child=(\d+)/u.exec(result.stdout)?.[1];
      for (const pid of [childPid, String(result.rootPid)]) if (pid) { try { execFileSync("taskkill.exe", ["/PID", pid, "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { /* already exited */ } }
    }
    expect(result.state).toBe("cancelled"); expect(result.terminationEvidence?.proven).toBe(true); expect(result.terminationEvidence?.rootPid).toBe(result.rootPid); expect(result.terminationEvidence?.observedPids).toContain(result.rootPid); expect(result.terminationEvidence?.observedPids.length).toBeGreaterThanOrEqual(2); expect(result.terminationEvidence?.livePids).toEqual([]); expect(result.terminationEvidence?.unknownPids).toEqual([]);
  }, 15_000);

  it("opens an outbound socket from the Bridge process and no inbound listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "chubz-socket-probe-")); roots.push(root); const script = join(root, "bridge-client.ts");
    const entry = new URL("../src/index.ts", import.meta.url).href;
    await writeFile(script, `import { WebSocketOutboundConnector } from ${JSON.stringify(entry)}; void (async()=>{ const endpoint=process.env.CHUBZ_FIXTURE_ENDPOINT; if(!endpoint) throw new Error('missing endpoint'); const connection=await new WebSocketOutboundConnector().connect(endpoint, 'Bearer synthetic'); console.log('connected'); process.on('SIGTERM',async()=>{await connection.close();process.exit(0)}); setInterval(()=>{},1000); })();\n`);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await new Promise<void>((resolve) => server.once("listening", resolve)); const address = server.address(); if (typeof address === "string" || address === null) throw new Error("fixture listener has no TCP address");
    const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: join(import.meta.dirname, ".."), env: { ...process.env, CHUBZ_FIXTURE_ENDPOINT: `ws://127.0.0.1:${address.port}/bridge` }, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid === undefined || child.stdout === null) throw new Error("socket probe did not start");
    try {
      await new Promise<void>((resolve, reject) => { let output = ""; let errors = ""; const timeout = setTimeout(() => reject(new Error(`Bridge connection probe timed out: ${errors.slice(0, 500)}`)), 5_000); child.stderr?.on("data", (chunk) => { errors += String(chunk); }); child.stdout!.on("data", (chunk) => { output += String(chunk); if (output.includes("connected")) { clearTimeout(timeout); resolve(); } }); child.once("error", reject); child.once("exit", (code) => { if (!output.includes("connected")) { clearTimeout(timeout); reject(new Error(`Bridge connection probe exited ${code}: ${errors.slice(0, 500)}`)); } }); });
      const query = `$connections=@(Get-NetTCPConnection -OwningProcess ([int]$env:CHUBZ_SOCKET_PROBE_PID) -ErrorAction SilentlyContinue); [Console]::Out.Write((@{listen=@($connections|Where-Object State -eq 'Listen').Count;established=@($connections|Where-Object State -eq 'Established').Count}|ConvertTo-Json -Compress))`;
      const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query], { encoding: "utf8", windowsHide: true, env: { ...process.env, CHUBZ_SOCKET_PROBE_PID: String(child.pid) } }); const sockets = JSON.parse(stdout) as { listen: number; established: number };
      expect(sockets.listen).toBe(0); expect(sockets.established).toBeGreaterThanOrEqual(1);
    } finally {
      const evidence = await new WindowsProcessTreeController().terminate(child.pid, "worker", 5_000); expect(evidence.proven).toBe(true); await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});
