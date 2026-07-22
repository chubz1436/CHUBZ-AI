import { createControlPlane } from "./app.js";
import { loadConfig } from "./config.js";

export * from "./app.js";
export * from "./auth.js";
export * from "./config.js";
export * from "./database.js";
export * from "./grant-engine.js";
export * from "./m6-ui.js";
export * from "./m7-review.js";
export * from "./orchestrator.js";

if (process.argv[1]?.endsWith("index.ts")) {
  const config = loadConfig();
  const controlPlane = createControlPlane(config);
  const stop = async () => { await controlPlane.close(); process.exitCode = 0; };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  controlPlane.app.listen({ host: config.host, port: config.port }).catch(async () => { await controlPlane.close(); process.exitCode = 1; });
}
