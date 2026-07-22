import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectRedactions } from "@chubz/shared";
import { AdapterRegistry, CODEX_CLI_MANIFEST, CodexConfigIntegrityError, CodexConfigIntegrityMonitor, MANUAL_RELAY_MANIFEST, assertIsolatedCodexAuthenticated, assertSafeCodexSecuritySettings, deriveCodexEvidenceId, isCodexEvidenceId, prepareCodexAdapterHome, resolveCodexExecutable, sanitizedCodexConfigDiff, sanitizedCodexSecuritySettings, type AdapterRegistryRuntime } from "../src/adapter-registry.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const root = (): string => { const value = mkdtempSync(join(tmpdir(), "chubz-m5-registry-test-")); roots.push(value); return value; };
const fallbackProfile = { configuredImplementation: "elevated", selectedImplementation: "unelevated", elevatedProbeResult: "failed", elevatedFailureClassification: "WINDOWS_ELEVATED_SANDBOX_ACCESS_DENIED" } as const;

describe("M5 authoritative adapter registry", () => {
  it("derives deterministic redaction-safe evidence identities from the complete canonical executable and sandbox identity", () => {
    const identity = ["C:\\Program Files\\Codex\\codex.exe", `sha256:${"a".repeat(64)}`, "0.144.4", fallbackProfile] as const;
    const evidenceId = deriveCodexEvidenceId(...identity);
    expect(evidenceId).toMatch(/^evidence\.codex\.sha256\.[0-9a-f]{64}$/u);
    expect(isCodexEvidenceId(evidenceId)).toBe(true);
    expect(deriveCodexEvidenceId(...identity)).toBe(evidenceId);
    expect(deriveCodexEvidenceId("C:\\Other\\codex.exe", identity[1], identity[2], identity[3])).not.toBe(evidenceId);
    expect(deriveCodexEvidenceId(identity[0], `sha256:${"b".repeat(64)}`, identity[2], identity[3])).not.toBe(evidenceId);
    expect(deriveCodexEvidenceId(identity[0], identity[1], "0.145.0", identity[3])).not.toBe(evidenceId);
    expect(deriveCodexEvidenceId(identity[0], identity[1], identity[2], { configuredImplementation: "elevated", selectedImplementation: "elevated", elevatedProbeResult: "passed", elevatedFailureClassification: null })).not.toBe(evidenceId);
    const safeScan = detectRedactions(JSON.stringify({ evidenceId })); expect(safeScan.ok).toBe(true); if (!safeScan.ok) throw new Error("redaction scan failed"); expect(safeScan.value).toEqual([]);

    for (const malformed of [
      `evidence.codex.sha256.${"a".repeat(63)}`,
      `evidence.codex.sha256.${"a".repeat(65)}`,
      `evidence.codex.sha256.${"A".repeat(64)}`,
      `evidence.codex.sha256.${"g".repeat(64)}`,
      `evidence-codex-${"a".repeat(48)}`,
    ]) expect(isCodexEvidenceId(malformed)).toBe(false);
  });

  it("keeps ordinary high-entropy and credential-shaped material detectable", () => {
    for (const unsafe of [
      "api_key=ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD",
      "hmac_secret=qwertyuiopasdfghjklzxcvbnmQWERTY1234567890",
      "entropy=Ab3dEf5hIj7lMn9pQr2tUv4xYz6Bcd8Fgh1Jkl3Nop5Rst7V",
    ]) {
      const findings = detectRedactions(unsafe);
      expect(findings.ok).toBe(true);
      if (!findings.ok) throw new Error("redaction scan failed");
      expect(findings.value.length).toBeGreaterThan(0);
    }
  });

  it("records unchanged stage metadata and removes its temporary before-stage copy", async () => {
    const base = root(); const config = join(base, "config.toml"); writeFileSync(config, '[windows]\nsandbox = "elevated"\n');
    const monitor = new CodexConfigIntegrityMonitor(config, [41, 42], base); const baseline = await monitor.start();
    try {
      expect(baseline).toMatchObject({ canonicalPath: expect.stringMatching(/config\.toml$/u), size: expect.any(Number), lastWriteTimestamp: expect.any(String), securityRelevantSettings: { "windows.sandbox": '"elevated"' } });
      expect(await monitor.runStage("unchanged", () => [101], async () => "passed")).toBe("passed");
      expect(monitor.evidence()).toEqual([expect.objectContaining({ stage: "unchanged", childCodexPids: [101], preExistingCodexPids: [41, 42], watcherEvents: [] })]);
      expect(readdirSync(base).filter((name) => name.startsWith("chubz-codex-config-"))).toEqual([]);
    } finally { monitor.close(); }
  });

  it("stops on config drift, retains only the protected before-stage copy, redacts semantic changes, and never restores the file", async () => {
    const base = root(); const config = join(base, "config.toml"); const before = '[windows]\nsandbox = "elevated"\napi_token = "secret-before"\n[projects."C:/synthetic"]\ntrust_level = "trusted"\n'; const after = '[windows]\nsandbox = "unelevated"\napi_token = "secret-after"\n[projects."C:/other"]\ntrust_level = "trusted"\n'; writeFileSync(config, before);
    const monitor = new CodexConfigIntegrityMonitor(config, [77], base); await monitor.start(); let failure: unknown;
    try {
      try { await monitor.runStage("changed", () => [202], () => { writeFileSync(config, after); }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(CodexConfigIntegrityError); const drift = failure as CodexConfigIntegrityError;
      expect(drift.observation).toMatchObject({ stage: "changed", childCodexPids: [202], preExistingCodexPids: [77] });
      expect(drift.changes).toEqual(expect.arrayContaining([
        { path: "windows.sandbox", before: '"elevated"', after: '"unelevated"' },
        { path: "windows.api_token", before: "<redacted>", after: "<redacted>" },
        expect.objectContaining({ before: expect.stringMatching(/<redacted>|<absent>/u), after: expect.stringMatching(/<redacted>|<absent>/u) }),
      ]));
      expect(drift.diagnosticCopyPath).not.toBeNull(); const diagnosticCopyPath = drift.diagnosticCopyPath!; expect(existsSync(diagnosticCopyPath)).toBe(true); expect(readFileSync(diagnosticCopyPath, "utf8")).toBe(before); expect(readFileSync(config, "utf8")).toBe(after);
    } finally { monitor.close(); }
  });

  it("monitors shared config without creating a diagnostic copy", async () => {
    const base = root(); const config = join(base, "config.toml"); writeFileSync(config, '[windows]\nsandbox = "elevated"\n');
    const monitor = new CodexConfigIntegrityMonitor(config, [], base, false); await monitor.start();
    try {
      expect(await monitor.runStage("no-copy", () => [303], () => "unchanged")).toBe("unchanged");
      expect(readdirSync(base)).toEqual(["config.toml"]);
    } finally { monitor.close(); }
  });

  it("sanitizes unknown TOML values and rejects dangerous permission settings", () => {
    const settings = sanitizedCodexSecuritySettings('[windows]\nsandbox="elevated"\n[managed]\nrequirements="private-path"\n');
    expect(settings).toEqual({ "windows.sandbox": '"elevated"', "managed.requirements": "<redacted>" });
    expect(sanitizedCodexConfigDiff('credential="one"\n', 'credential="two"\n')).toEqual([{ path: "credential", before: "<redacted>", after: "<redacted>" }]);
    expect(() => assertSafeCodexSecuritySettings({ sandbox_mode: '"danger-full-access"' })).toThrow("dangerous Codex permission setting");
  });

  it("publishes honest Codex and owner-attested manual manifests", () => {
    expect(CODEX_CLI_MANIFEST).toMatchObject({ workerId: "codex-cli", connector: { type: "cli-headless", invocation: { promptDelivery: "stdin" } }, provenanceMode: "automated" });
    expect(MANUAL_RELAY_MANIFEST).toMatchObject({ workerId: "manual-relay", connector: { type: "manual-relay", cancelable: false }, provenanceMode: "owner-attested", restrictions: expect.arrayContaining(["manual-import-only"]) });
    expect(MANUAL_RELAY_MANIFEST.supportedFileOps).not.toContain("write-workspace");
  });

  it("resolves a Windows npm .cmd launcher in a path containing spaces to the native executable", async () => {
    const base = join(root(), "npm path with spaces");
    const launcher = join(base, "codex.cmd");
    const native = join(base, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    mkdirSync(dirname(native), { recursive: true }); writeFileSync(launcher, "@echo off\r\n"); writeFileSync(native, "synthetic-native");
    await expect(resolveCodexExecutable({ path: base, pathext: ".CMD;.EXE", platform: "win32" })).resolves.toEqual({ requestedName: "codex", launcherPath: launcher, executablePath: native, launcherKind: "npm-cmd" });
  });

  it("creates a minimal contained isolated CODEX_HOME without copying shared state", async () => {
    const base = root(); const repositoryRoot = join(base, "repository"); const managedDataRoot = join(base, "managed data"); const sharedCodexHome = join(base, "shared-codex-home");
    mkdirSync(repositoryRoot); mkdirSync(managedDataRoot); mkdirSync(sharedCodexHome); writeFileSync(join(sharedCodexHome, "auth.json"), "do-not-copy"); writeFileSync(join(sharedCodexHome, "config.toml"), "shared=true\n");
    const isolated = await prepareCodexAdapterHome({ managedDataRoot, repositoryRoot, sharedCodexHome });
    expect(isolated.codexHome.toLowerCase()).toContain(realpathSync.native(managedDataRoot).toLowerCase());
    expect(readdirSync(isolated.codexHome)).toEqual(["config.toml"]);
    expect(readFileSync(isolated.configPath, "utf8")).toBe('cli_auth_credentials_store = "file"\n\n[history]\npersistence = "none"\n\n[windows]\nsandbox = "unelevated"\n');
    expect(readFileSync(join(sharedCodexHome, "auth.json"), "utf8")).toBe("do-not-copy");
    expect(readFileSync(join(sharedCodexHome, "config.toml"), "utf8")).toBe("shared=true\n");
  });

  it("rejects isolated-home overlap with the repository or shared CODEX_HOME", async () => {
    const base = root(); const repositoryRoot = join(base, "repository"); const managedDataRoot = join(base, "managed"); const sharedCodexHome = join(base, "shared"); mkdirSync(repositoryRoot); mkdirSync(managedDataRoot); mkdirSync(sharedCodexHome);
    await expect(prepareCodexAdapterHome({ managedDataRoot: repositoryRoot, repositoryRoot, sharedCodexHome })).rejects.toThrow("outside the Git working tree"); mkdirSync(join(managedDataRoot, ".managed-data"));
    await expect(prepareCodexAdapterHome({ managedDataRoot, repositoryRoot, sharedCodexHome: join(managedDataRoot, ".managed-data") })).rejects.toThrow("shared CODEX_HOME");
  });

  it("hard-stops when the isolated CODEX_HOME is not authenticated", () => {
    expect(() => assertIsolatedCodexAuthenticated("missing", "C:\\managed\\codex-home")).toThrow("owner login required");
    expect(() => assertIsolatedCodexAuthenticated("authenticated", "C:\\managed\\codex-home")).not.toThrow();
  });

  it("keeps readiness degraded until canary success and degrades again on version/hash drift", async () => {
    const base = root(); const executable = join(base, "codex.exe"); writeFileSync(executable, "one");
    let hash = `sha256:${"1".repeat(64)}` as const; let version = "0.144.4";
    const runtime: AdapterRegistryRuntime = {
      resolve: async () => ({ requestedName: "codex", launcherPath: executable, executablePath: executable, launcherKind: "native" }),
      hash: async () => hash,
      invoke: async (_path, args) => {
        if (args[0] === "--version") return { stdout: `codex-cli ${version}`, stderr: "" };
        if (args[0] === "login") return { stdout: "Logged in using ChatGPT", stderr: "" };
        if (args[0] === "exec" && args[1] === "resume") return { stdout: "Resume a previous session", stderr: "" };
        return { stdout: "Run Codex non-interactively --json --sandbox --output-last-message", stderr: "" };
      },
    };
    const registry = new AdapterRegistry(join(base, "state", "compatibility.json"), runtime);
    const first = await registry.probeCodex({ path: base, codexHome: base, windowsSandboxProfile: fallbackProfile, now: new Date("2026-07-22T00:00:00Z") });
    expect(first.readiness).toMatchObject({ readinessState: "degraded", authenticationState: "authenticated", quotaVisibility: "unknown" });
    expect(first.evidence).toMatchObject({ compatibility: "not-run", quotaStatus: "UNKNOWN", rateLimitStatus: "UNKNOWN", windowsSandbox: { configuredImplementation: "elevated", selectedImplementation: "unelevated", elevatedProbeResult: "failed", fallbackSelected: true, fallbackCanaryResult: "not-run", assurance: "degraded-bounded-local" } });
    await registry.recordCompatibleCanary(first, { passed: true, observedWindowsSandboxImplementation: "unelevated" }, new Date("2026-07-22T00:01:00Z"));
    const ready = await registry.probeCodex({ path: base, codexHome: base, windowsSandboxProfile: fallbackProfile, now: new Date("2026-07-22T00:02:00Z") });
    expect(ready.readiness).toMatchObject({ readinessState: "degraded", healthStatus: "degraded", freezeState: "enabled" });
    expect(ready.evidence.windowsSandbox).toMatchObject({ fallbackCanaryResult: "passed", assurance: "degraded-bounded-local" });
    expect(ready.readiness.capabilities).toEqual(expect.arrayContaining([expect.objectContaining({ capability: "code-write", assurance: "validated" })]));
    version = "0.145.0"; hash = `sha256:${"2".repeat(64)}`;
    const drifted = await registry.probeCodex({ path: base, codexHome: base, windowsSandboxProfile: fallbackProfile, now: new Date("2026-07-22T00:03:00Z") });
    expect(drifted.readiness.readinessState).toBe("degraded"); expect(drifted.evidence.compatibility).toBe("drifted");
    registry.setCodexFreezeState("frozen");
    expect((await registry.probeCodex({ path: base, codexHome: base, windowsSandboxProfile: fallbackProfile })).readiness.readinessState).toBe("frozen");
  });

  it("fails closed for unknown or inconsistent sandbox implementations and mismatched canary evidence", async () => {
    const base = root(); const executable = join(base, "codex.exe"); writeFileSync(executable, "one");
    const runtime: AdapterRegistryRuntime = { resolve: async () => ({ requestedName: "codex", launcherPath: executable, executablePath: executable, launcherKind: "native" }), hash: async () => `sha256:${"1".repeat(64)}`, invoke: async (_path, args) => args[0] === "--version" ? { stdout: "codex-cli 0.144.4", stderr: "" } : args[0] === "login" ? { stdout: "Logged in", stderr: "" } : { stdout: "Run Codex non-interactively --json --sandbox --output-last-message Resume", stderr: "" } };
    const registry = new AdapterRegistry(join(base, "compatibility.json"), runtime);
    await expect(registry.probeCodex({ path: base, codexHome: base, windowsSandboxProfile: { ...fallbackProfile, selectedImplementation: "unknown" as "unelevated" } })).rejects.toThrow("unknown Windows sandbox implementation");
    await expect(registry.probeCodex({ path: base, codexHome: base, windowsSandboxProfile: { ...fallbackProfile, elevatedProbeResult: "passed" } })).rejects.toThrow("classified elevated failure");
    const probe = await registry.probeCodex({ path: base, codexHome: base, windowsSandboxProfile: fallbackProfile });
    await expect(registry.recordCompatibleCanary(probe, { passed: true, observedWindowsSandboxImplementation: "elevated" })).rejects.toThrow("does not match");
    expect(registry.manualRelayReadiness().readiness.readinessState).toBe("manual-only");
  });

  it("marks manual relay manual-only with unsupported automation capabilities", () => {
    const registry = new AdapterRegistry(join(root(), "compatibility.json"));
    expect(registry.manualRelayReadiness(new Date("2026-07-22T00:00:00Z")).readiness).toMatchObject({ readinessState: "manual-only", connectorTier: "manual-relay", sandboxCapability: "unavailable", cancellationCapability: "unavailable", resumeCapability: "unavailable" });
  });
});
