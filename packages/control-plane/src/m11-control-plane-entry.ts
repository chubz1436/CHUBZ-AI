import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createControlPlane, type ControlPlane } from "./app.js";
import { loadM11ConfigurationFile, resolveRuntimeSecret, toControlPlaneConfig } from "./m11-config.js";
import type { BoundedOperationalLog } from "./m11-artifacts.js";

let control: ControlPlane | undefined; let log: BoundedOperationalLog | undefined; let stopping = false;
const stop = async (): Promise<void> => { if (stopping) return; stopping = true; try { log?.write("info", "runtime-shutdown-requested", { graceful: true }); await control?.close(); process.exitCode = 0; } catch { process.stderr.write("The bounded Control Plane shutdown could not be proven complete.\n"); process.exitCode = 1; } };

try {
  const configIndex = process.argv.indexOf("--config"); if (configIndex < 0 || configIndex !== process.argv.length - 2 || !process.argv[configIndex + 1]) throw new Error("invalid invocation");
  const runtimeConfig = loadM11ConfigurationFile(process.argv[configIndex + 1]!, { inspectFilesystem: true, requireWindowsPackagingRoot: process.platform === "win32" }); process.env["CHUBZ_PACKAGED_WEB_ROOT"] = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
  const config = toControlPlaneConfig(runtimeConfig, resolveRuntimeSecret(runtimeConfig), "production"); mkdirSync(config.dataDirectory, { recursive: true }); control = createControlPlane(config); log = control.artifacts.logger("control-plane");
  process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); }); await control.app.listen({ host: config.host, port: config.port }); log.write("info", "runtime-started", { hostClass: "loopback", port: config.port, releaseStatus: "local MVP candidate" });
} catch { try { log?.write("critical", "runtime-startup-failed", { sanitized: true }); await control?.close(); } catch { /* generic failure only */ } process.stderr.write("The bounded Control Plane failed safely. Inspect sanitized operational logs and configuration metadata.\n"); process.exitCode = 1; }
