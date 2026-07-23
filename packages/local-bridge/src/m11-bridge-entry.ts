import { loadM11ConfigurationFile, resolveRuntimeSecret } from "@chubz/control-plane";
import { PackagedLocalBridgeRuntime } from "./runtime.js";

let runtime: PackagedLocalBridgeRuntime | undefined; let stopping = false;
const stop = async (): Promise<void> => { if (stopping) return; stopping = true; try { await runtime?.stop(); process.exitCode = 0; } catch { process.stderr.write("The bounded Local Bridge shutdown could not be proven complete.\n"); process.exitCode = 1; } };

try {
  const configIndex = process.argv.indexOf("--config"); if (configIndex < 0 || configIndex !== process.argv.length - 2 || !process.argv[configIndex + 1]) throw new Error("invalid invocation");
  const configuration = loadM11ConfigurationFile(process.argv[configIndex + 1]!, { inspectFilesystem: true, requireWindowsPackagingRoot: process.platform === "win32" }); runtime = new PackagedLocalBridgeRuntime({ configuration, sessionSecret: resolveRuntimeSecret(configuration) }); process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); }); runtime.reconcileAfterRestart(); await runtime.start();
} catch { try { await runtime?.stop(); } catch { /* generic failure only */ } process.stderr.write("The bounded outbound-only Local Bridge failed safely. Inspect sanitized Control Plane diagnostics.\n"); process.exitCode = 1; }
