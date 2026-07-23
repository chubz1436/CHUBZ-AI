import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type ControlPlaneConfig = Readonly<{
  environment: "development" | "test" | "production";
  dataDirectory: string;
  databasePath: string;
  host: "127.0.0.1" | "::1";
  port: number;
  allowedOrigin: string;
  sessionSecret: string;
  cookieName: string;
  secureCookie: boolean;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug";
  sessionTtlMs: number;
  sessionIdleMs: number;
  requestBodyLimit: number;
  websocketMessageLimit: number;
  loginAttemptWindowMs: number;
  loginBucketMaximum: number;
  authEventRetentionMs: number;
  authEventMaximum: number;
  m11?: Readonly<{
    logsDirectory: string;
    supportBundlesDirectory: string;
    packagesDirectory: string;
    logMaxBytes: number;
    logRetentionFiles: number;
    supportBundleMaxBytes: number;
    supportBundleMaxFiles: number;
    packageMaxBytes: number;
    packageMaxFiles: number;
    storageWarningPercent: number;
  }>;
}>;

export class ConfigurationError extends Error {
  constructor(message = "Invalid control-plane configuration.") { super(message); this.name = "ConfigurationError"; }
}

const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const levels = new Set(["fatal", "error", "warn", "info", "debug"]);
const parsePort = (value: string | undefined): number => {
  const port = Number(value ?? "4317");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new ConfigurationError();
  return port;
};
const positive = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 31 * 86_400_000) throw new ConfigurationError();
  return parsed;
};
const originFor = (host: string, port: number): string => `http://${host === "::1" ? "[::1]" : host}:${port}`;

/** Parses only the small allow-list of runtime settings. It never exposes raw environment data. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  const environment = env["NODE_ENV"] ?? "development";
  if (environment !== "development" && environment !== "test" && environment !== "production") throw new ConfigurationError();
  const host = env["CONTROL_PLANE_HOST"] ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) throw new ConfigurationError("Control Plane must bind to an explicit loopback address.");
  const port = parsePort(env["CONTROL_PLANE_PORT"]);
  const rawDir = env["CONTROL_PLANE_DATA_DIR"];
  if (rawDir === undefined || rawDir.length === 0) throw new ConfigurationError("Control Plane data directory is required.");
  const dataDirectory = resolve(rawDir);
  if (environment === "test" && !dataDirectory.toLowerCase().includes("test")) throw new ConfigurationError("Test data directory must be isolated.");
  const rawDatabase = env["CONTROL_PLANE_DATABASE_PATH"] ?? resolve(dataDirectory, "control-plane.sqlite");
  const databasePath = resolve(rawDatabase);
  const databaseRelativePath = relative(dataDirectory, databasePath);
  if (!isAbsolute(databasePath) || databaseRelativePath === "" || databaseRelativePath.startsWith("..") || isAbsolute(databaseRelativePath)) throw new ConfigurationError("Database path must remain inside the data directory.");
  const allowedOrigin = env["CONTROL_PLANE_ALLOWED_ORIGIN"] ?? originFor(host, port);
  let origin: URL;
  try { origin = new URL(allowedOrigin); } catch { throw new ConfigurationError("Allowed browser origin is invalid."); }
  if (origin.origin !== allowedOrigin || origin.protocol !== "http:" || !LOOPBACK.has(origin.hostname)) throw new ConfigurationError("Allowed browser origin must be explicit loopback HTTP.");
  const sessionSecret = env["CONTROL_PLANE_SESSION_SECRET"];
  if (sessionSecret === undefined || sessionSecret.length < 32) throw new ConfigurationError("A non-default session secret is required.");
  const logLevel = env["CONTROL_PLANE_LOG_LEVEL"] ?? "info";
  if (!levels.has(logLevel)) throw new ConfigurationError();
  const secureCookie = env["CONTROL_PLANE_SECURE_COOKIE"] === "true";
  if (secureCookie) throw new ConfigurationError("Secure cookies require a future TLS-only surface and are unavailable locally.");
  mkdirSync(dataDirectory, { recursive: true });
  return Object.freeze({ environment, dataDirectory, databasePath, host: host as "127.0.0.1" | "::1", port, allowedOrigin, sessionSecret, cookieName: "chubz_session", secureCookie, logLevel: logLevel as ControlPlaneConfig["logLevel"], sessionTtlMs: positive(env["CONTROL_PLANE_SESSION_TTL_MS"], 8 * 60 * 60_000), sessionIdleMs: positive(env["CONTROL_PLANE_SESSION_IDLE_MS"], 30 * 60_000), requestBodyLimit: positive(env["CONTROL_PLANE_BODY_LIMIT"], 64 * 1024), websocketMessageLimit: positive(env["CONTROL_PLANE_WS_MESSAGE_LIMIT"], 64 * 1024), loginAttemptWindowMs: positive(env["CONTROL_PLANE_LOGIN_ATTEMPT_WINDOW_MS"], 60_000), loginBucketMaximum: positive(env["CONTROL_PLANE_LOGIN_BUCKET_MAXIMUM"], 1_024), authEventRetentionMs: positive(env["CONTROL_PLANE_AUTH_EVENT_RETENTION_MS"], 30 * 24 * 60 * 60_000), authEventMaximum: positive(env["CONTROL_PLANE_AUTH_EVENT_MAXIMUM"], 10_000) });
}

export function createTestConfig(dataDirectory: string): ControlPlaneConfig {
  const secret = createHash("sha256").update(randomBytes(32)).digest("hex");
  return loadConfig({ NODE_ENV: "test", CONTROL_PLANE_DATA_DIR: dataDirectory, CONTROL_PLANE_SESSION_SECRET: secret, CONTROL_PLANE_PORT: "4317" });
}
