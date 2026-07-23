import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Principal } from "./auth.js";
import { createControlPlane } from "./app.js";
import { ControlPlaneDatabase } from "./database.js";
import { loadM11ConfigurationFile, resolveRuntimeSecret, toControlPlaneConfig, validateM11Configuration } from "./m11-config.js";
import { verifyLocalReleasePackage } from "./m11-package.js";
import { clearStaleRuntimePidRecords, inspectRuntime, startRuntime, stopRuntime, waitForReadiness, WindowsRuntimeProcessAdapter } from "./m11-runtime-manager.js";

const commands = new Set(["validate-config", "migrate", "start", "wait-ready", "health", "stop", "inspect-runtime", "clear-stale-pids", "inspect-emergency-stop", "verify-package", "diagnostics", "upgrade-plan", "retention-preview", "current-version"]);
const command = process.argv[2] ?? "";
const valueFor = (name: string): string | null => { const index = process.argv.indexOf(name); return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : null; };
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."); const configPath = valueFor("--config");
const write = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
const load = () => { if (!configPath) throw new Error("An absolute --config path is required."); return loadM11ConfigurationFile(configPath, { inspectFilesystem: true, requireWindowsPackagingRoot: process.platform === "win32" }); };
const principalFor = (control: ReturnType<typeof createControlPlane>): Principal => { const row = control.database.connection.prepare("SELECT id,username FROM administrators WHERE disabled_at IS NULL ORDER BY created_at LIMIT 1").get() as { id: string; username: string } | undefined; if (!row) throw new Error("An owner account must exist before diagnostics or upgrade planning."); return Object.freeze({ administratorId: row.id, username: row.username, sessionId: "local-operator-command", csrfToken: "not-exported" }); };

try {
  if (!commands.has(command)) throw new Error("A supported bounded runtime command is required.");
  if (command === "verify-package") { const verification = verifyLocalReleasePackage(packageRoot); write(verification); if (!verification.verified) process.exitCode = 1; }
  else if (command === "current-version") { const verification = verifyLocalReleasePackage(packageRoot); if (!verification.verified) throw new Error("package verification failed"); const manifestPath = resolve(packageRoot, "release", "release-manifest.json"); const response = JSON.parse(readFileSync(manifestPath, "utf8")); write({ verification, release: response }); }
  else if (command === "validate-config") { if (!configPath) throw new Error("An absolute --config path is required."); const bytes = readFileSync(configPath); if (bytes.byteLength > 64 * 1024) throw new Error("Configuration file exceeds its bound."); write(validateM11Configuration(JSON.parse(bytes.toString("utf8")), { inspectFilesystem: true, requireWindowsPackagingRoot: process.platform === "win32" })); }
  else if (command === "migrate") { const runtime = load(); mkdirSync(runtime.paths.managedDataRoot, { recursive: true }); const database = new ControlPlaneDatabase(toControlPlaneConfig(runtime, "migration-command-no-secret-value", "production")); const version = database.connection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(); database.close(); write({ migrated: true, schema: version, productionDeployment: false }); }
  else if (command === "start") { const runtime = load(); resolveRuntimeSecret(runtime); write(await startRuntime(runtime, configPath!, packageRoot)); }
  else if (command === "stop") write(await stopRuntime(load()));
  else if (command === "inspect-runtime") write({ components: await inspectRuntime(load(), new WindowsRuntimeProcessAdapter()) });
  else if (command === "clear-stale-pids") write(await clearStaleRuntimePidRecords(load()));
  else if (command === "wait-ready") write(await waitForReadiness(load(), Number(valueFor("--timeout-ms") ?? 30_000)));
  else if (command === "health") { const runtime = load(); const response = await fetch(`${runtime.controlPlane.allowedOrigin}/healthz`, { signal: AbortSignal.timeout(5_000) }); write({ reachable: response.ok, status: await response.json() }); }
  else if (command === "inspect-emergency-stop") { const runtime = load(); const database = new Database(resolve(runtime.paths.managedDataRoot, runtime.paths.databaseFile), { readonly: true, fileMustExist: true }); const stops = database.prepare("SELECT stop_id,scope_type,project_id,status,activated_at,released_at FROM m8_emergency_stops WHERE status='active' ORDER BY activated_at").all(); database.close(); write({ active: stops.length > 0, stops, authoritative: true, mutationPerformed: false }); }
  else {
    const runtime = load(); const secret = resolveRuntimeSecret(runtime); mkdirSync(runtime.paths.managedDataRoot, { recursive: true }); const control = createControlPlane(toControlPlaneConfig(runtime, secret, "production")); const principal = principalFor(control);
    if (command === "diagnostics") write(control.artifacts.generate(principal, { idempotencyKey: `diagnostics-${randomUUID()}`, expectedVersion: 0 }, "diagnostics"));
    else if (command === "upgrade-plan") write(control.artifacts.upgradePlan(principal, { artifactId: valueFor("--artifact-id") }));
    else if (command === "retention-preview") write(control.artifacts.retentionPreview(principal, { supportBundleDays: Number(valueFor("--support-days") ?? 30), operationalLogDays: Number(valueFor("--log-days") ?? 14), expectedVersion: 0, idempotencyKey: `retention-preview-${randomUUID()}` }));
    await control.close();
  }
} catch { process.stderr.write("The bounded local runtime command failed safely. Inspect sanitized operational logs and configuration metadata.\n"); process.exitCode = 1; }
