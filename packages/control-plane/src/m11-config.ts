import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { ControlPlaneConfig } from "./config.js";

export const M11_CONFIG_VERSION = 1 as const;
export const M11_CONFIG_LIMITS = Object.freeze({ maxBytes: 64 * 1024, maxProjects: 64, maxStringBytes: 2_048 } as const);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SECRET_REF = /^environment:([A-Z][A-Z0-9_]{2,127})$/u;
const LOOPBACK = new Set(["127.0.0.1", "::1"]);

export type M11RuntimeConfiguration = Readonly<{
  configVersion: 1;
  controlPlane: Readonly<{ host: "127.0.0.1" | "::1"; port: number; allowedOrigin: string; sessionSecretRef: string }>;
  bridge: Readonly<{ endpoint: string; enrollmentIdentity: string; heartbeatIntervalMs: number }>;
  paths: Readonly<{ approvedManagedRoots: readonly string[]; managedDataRoot: string; databaseFile: string; logsDirectory: string; supportBundlesDirectory: string; packagesDirectory: string }>;
  bounds: Readonly<{ logMaxBytes: number; logRetentionFiles: number; captureMaxBytes: number; packageMaxBytes: number; packageMaxFiles: number; supportBundleMaxBytes: number; supportBundleMaxFiles: number; storageWarningPercent: number }>;
  retention: Readonly<{ operationalLogDays: number; resolvedAlertDays: number; supportBundleDays: number; packagingStagingHours: number }>;
  projects: readonly Readonly<{ projectId: string; managedCloneRoot: string }>[];
  display: Readonly<{ productName: string; environmentLabel: string }>;
}>;

export type ConfigValidationResult = Readonly<{
  valid: boolean;
  configVersion: number | null;
  configDigest: string | null;
  sanitized: Readonly<{ host?: string; port?: number; managedRootCount?: number; projectCount?: number; secretReferencePresent?: boolean }>;
  errors: readonly string[];
}>;

export class M11ConfigurationError extends Error {
  public constructor(public readonly issues: readonly string[]) { super("Local runtime configuration is invalid."); this.name = "M11ConfigurationError"; }
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
};
const digest = (value: unknown): string => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string, issues: string[]): void => {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${label} contains an unsupported field.`);
  for (const key of keys) if (!(key in value)) issues.push(`${label} is missing a required field.`);
};
const boundedString = (value: unknown, label: string, issues: string[], pattern?: RegExp): string => {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > M11_CONFIG_LIMITS.maxStringBytes || pattern && !pattern.test(value)) { issues.push(`${label} is invalid.`); return ""; }
  return value;
};
const integer = (value: unknown, label: string, minimum: number, maximum: number, issues: string[]): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) { issues.push(`${label} is outside its safe bound.`); return minimum; }
  return Number(value);
};
const contained = (root: string, candidate: string): boolean => {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Refuses any existing symlink, junction, or reparse point in a managed path. */
export function assertNoLinkedPath(target: string): void {
  const absolute = resolve(target); const parsed = parse(absolute); let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try {
      const metadata = lstatSync(cursor);
      if (metadata.isSymbolicLink() || process.platform === "win32" && (metadata.mode & 0o160000) === 0o160000) throw new M11ConfigurationError(["A managed path contains a link or reparse point."]);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
}

export function parseM11Configuration(raw: unknown, options: Readonly<{ inspectFilesystem?: boolean; requireWindowsPackagingRoot?: boolean }> = {}): M11RuntimeConfiguration {
  const issues: string[] = [];
  if (!object(raw)) throw new M11ConfigurationError(["The configuration document must be an object."]);
  exactKeys(raw, ["configVersion", "controlPlane", "bridge", "paths", "bounds", "retention", "projects", "display"], "configuration", issues);
  if (raw["configVersion"] !== M11_CONFIG_VERSION) issues.push("The configuration version is unsupported.");
  const cp = object(raw["controlPlane"]) ? raw["controlPlane"] : {}; exactKeys(cp, ["host", "port", "allowedOrigin", "sessionSecretRef"], "controlPlane", issues);
  const host = boundedString(cp["host"], "controlPlane.host", issues); if (!LOOPBACK.has(host)) issues.push("Control Plane host must be explicit loopback.");
  const port = integer(cp["port"], "controlPlane.port", 1, 65_535, issues);
  const allowedOrigin = boundedString(cp["allowedOrigin"], "controlPlane.allowedOrigin", issues);
  try { const origin = new URL(allowedOrigin); if (origin.protocol !== "http:" || !LOOPBACK.has(origin.hostname) || origin.origin !== allowedOrigin || Number(origin.port || 80) !== port) issues.push("Allowed origin must match the loopback host and port."); } catch { issues.push("Allowed origin is invalid."); }
  const sessionSecretRef = boundedString(cp["sessionSecretRef"], "controlPlane.sessionSecretRef", issues, SECRET_REF);
  const bridge = object(raw["bridge"]) ? raw["bridge"] : {}; exactKeys(bridge, ["endpoint", "enrollmentIdentity", "heartbeatIntervalMs"], "bridge", issues);
  const endpoint = boundedString(bridge["endpoint"], "bridge.endpoint", issues); try { const url = new URL(endpoint); if (!(["ws:", "wss:"] as string[]).includes(url.protocol) || !LOOPBACK.has(url.hostname) || url.username || url.password || url.hash || url.pathname !== "/v1/bridge/ws") issues.push("Bridge endpoint must be the bounded loopback Bridge WebSocket route."); } catch { issues.push("Bridge endpoint is invalid."); }
  const enrollmentIdentity = boundedString(bridge["enrollmentIdentity"], "bridge.enrollmentIdentity", issues, ID);
  if (enrollmentIdentity !== "local-bridge") issues.push("The packaged runtime supports only the local-bridge enrollment identity.");
  const heartbeatIntervalMs = integer(bridge["heartbeatIntervalMs"], "bridge.heartbeatIntervalMs", 1_000, 300_000, issues);
  const paths = object(raw["paths"]) ? raw["paths"] : {}; exactKeys(paths, ["approvedManagedRoots", "managedDataRoot", "databaseFile", "logsDirectory", "supportBundlesDirectory", "packagesDirectory"], "paths", issues);
  const rootsRaw = Array.isArray(paths["approvedManagedRoots"]) ? paths["approvedManagedRoots"] : [];
  if (rootsRaw.length < 1 || rootsRaw.length > 8) issues.push("Approved managed roots must contain between one and eight paths.");
  const approvedManagedRoots = rootsRaw.map((entry, index) => resolve(boundedString(entry, `paths.approvedManagedRoots[${index}]`, issues))).filter((entry) => isAbsolute(entry));
  const managedDataRoot = resolve(boundedString(paths["managedDataRoot"], "paths.managedDataRoot", issues));
  if (!isAbsolute(managedDataRoot) || !approvedManagedRoots.some((root) => contained(root, managedDataRoot)) || approvedManagedRoots.some((root) => resolve(root) === managedDataRoot)) issues.push("Managed data root must be a child of an approved root.");
  const fileName = (value: unknown, label: string): string => { const result = boundedString(value, label, issues, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u); if (result === "." || result === "..") issues.push(`${label} is invalid.`); return result; };
  const databaseFile = fileName(paths["databaseFile"], "paths.databaseFile"); const logsDirectory = fileName(paths["logsDirectory"], "paths.logsDirectory"); const supportBundlesDirectory = fileName(paths["supportBundlesDirectory"], "paths.supportBundlesDirectory"); const packagesDirectory = fileName(paths["packagesDirectory"], "paths.packagesDirectory");
  if (new Set([databaseFile, logsDirectory, supportBundlesDirectory, packagesDirectory]).size !== 4) issues.push("Managed path names must be distinct.");
  if (options.requireWindowsPackagingRoot && !managedDataRoot.toLowerCase().startsWith("b:\\ai_agent_folder\\")) issues.push("Persistent packaging data must remain under the approved B:\\AI_Agent_folder root.");
  if (options.inspectFilesystem) for (const path of [...approvedManagedRoots, managedDataRoot]) { try { assertNoLinkedPath(path); } catch { issues.push("A managed path failed canonical link inspection."); } }
  const bounds = object(raw["bounds"]) ? raw["bounds"] : {}; exactKeys(bounds, ["logMaxBytes", "logRetentionFiles", "captureMaxBytes", "packageMaxBytes", "packageMaxFiles", "supportBundleMaxBytes", "supportBundleMaxFiles", "storageWarningPercent"], "bounds", issues);
  const parsedBounds = { logMaxBytes: integer(bounds["logMaxBytes"], "bounds.logMaxBytes", 65_536, 64 * 1024 * 1024, issues), logRetentionFiles: integer(bounds["logRetentionFiles"], "bounds.logRetentionFiles", 1, 32, issues), captureMaxBytes: integer(bounds["captureMaxBytes"], "bounds.captureMaxBytes", 65_536, 256 * 1024 * 1024, issues), packageMaxBytes: integer(bounds["packageMaxBytes"], "bounds.packageMaxBytes", 1_048_576, 512 * 1024 * 1024, issues), packageMaxFiles: integer(bounds["packageMaxFiles"], "bounds.packageMaxFiles", 1, 20_000, issues), supportBundleMaxBytes: integer(bounds["supportBundleMaxBytes"], "bounds.supportBundleMaxBytes", 65_536, 32 * 1024 * 1024, issues), supportBundleMaxFiles: integer(bounds["supportBundleMaxFiles"], "bounds.supportBundleMaxFiles", 1, 256, issues), storageWarningPercent: integer(bounds["storageWarningPercent"], "bounds.storageWarningPercent", 50, 95, issues) };
  const retention = object(raw["retention"]) ? raw["retention"] : {}; exactKeys(retention, ["operationalLogDays", "resolvedAlertDays", "supportBundleDays", "packagingStagingHours"], "retention", issues);
  const parsedRetention = { operationalLogDays: integer(retention["operationalLogDays"], "retention.operationalLogDays", 1, 365, issues), resolvedAlertDays: integer(retention["resolvedAlertDays"], "retention.resolvedAlertDays", 1, 3650, issues), supportBundleDays: integer(retention["supportBundleDays"], "retention.supportBundleDays", 1, 365, issues), packagingStagingHours: integer(retention["packagingStagingHours"], "retention.packagingStagingHours", 1, 168, issues) };
  const projectsRaw = Array.isArray(raw["projects"]) ? raw["projects"] : []; if (projectsRaw.length > M11_CONFIG_LIMITS.maxProjects) issues.push("Project registration count exceeds its bound.");
  const projects: Array<{ projectId: string; managedCloneRoot: string }> = projectsRaw.flatMap((entry, index): Array<{ projectId: string; managedCloneRoot: string }> => { if (!object(entry)) { issues.push(`projects[${index}] is invalid.`); return []; } exactKeys(entry, ["projectId", "managedCloneRoot"], `projects[${index}]`, issues); const projectId = boundedString(entry["projectId"], `projects[${index}].projectId`, issues, ID); const managedCloneRoot = resolve(boundedString(entry["managedCloneRoot"], `projects[${index}].managedCloneRoot`, issues)); if (!approvedManagedRoots.some((root) => contained(root, managedCloneRoot))) issues.push(`projects[${index}] is outside approved managed roots.`); return [{ projectId, managedCloneRoot }]; });
  if (new Set(projects.map((entry) => entry.projectId)).size !== projects.length) issues.push("Project identifiers must be unique.");
  const display = object(raw["display"]) ? raw["display"] : {}; exactKeys(display, ["productName", "environmentLabel"], "display", issues); const productName = boundedString(display["productName"], "display.productName", issues); const environmentLabel = boundedString(display["environmentLabel"], "display.environmentLabel", issues);
  if (issues.length > 0) throw new M11ConfigurationError(Object.freeze([...new Set(issues)]));
  return Object.freeze({ configVersion: 1, controlPlane: Object.freeze({ host: host as "127.0.0.1" | "::1", port, allowedOrigin, sessionSecretRef }), bridge: Object.freeze({ endpoint, enrollmentIdentity, heartbeatIntervalMs }), paths: Object.freeze({ approvedManagedRoots: Object.freeze(approvedManagedRoots), managedDataRoot, databaseFile, logsDirectory, supportBundlesDirectory, packagesDirectory }), bounds: Object.freeze(parsedBounds), retention: Object.freeze(parsedRetention), projects: Object.freeze(projects.map((entry) => Object.freeze(entry))), display: Object.freeze({ productName, environmentLabel }) });
}

export function validateM11Configuration(raw: unknown, options: Parameters<typeof parseM11Configuration>[1] = {}): ConfigValidationResult {
  try { const config = parseM11Configuration(raw, options); return Object.freeze({ valid: true, configVersion: config.configVersion, configDigest: digest(config), sanitized: Object.freeze({ host: config.controlPlane.host, port: config.controlPlane.port, managedRootCount: config.paths.approvedManagedRoots.length, projectCount: config.projects.length, secretReferencePresent: true }), errors: Object.freeze([]) }); }
  catch (error) { const issues = error instanceof M11ConfigurationError ? error.issues : ["Configuration validation could not be completed."]; return Object.freeze({ valid: false, configVersion: object(raw) && typeof raw["configVersion"] === "number" ? raw["configVersion"] : null, configDigest: null, sanitized: Object.freeze({}), errors: Object.freeze([...issues]) }); }
}

export function loadM11ConfigurationFile(path: string, options: Parameters<typeof parseM11Configuration>[1] = {}): M11RuntimeConfiguration {
  if (!isAbsolute(path)) throw new M11ConfigurationError(["Configuration path must be absolute."]);
  assertNoLinkedPath(path);
  const bytes = readFileSync(realpathSync(path)); if (bytes.byteLength > M11_CONFIG_LIMITS.maxBytes) throw new M11ConfigurationError(["Configuration file exceeds its safe bound."]);
  let raw: unknown; try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw new M11ConfigurationError(["Configuration file is not valid JSON."]); }
  return parseM11Configuration(raw, options);
}

export function resolveRuntimeSecret(config: M11RuntimeConfiguration, env: NodeJS.ProcessEnv = process.env): string {
  const match = SECRET_REF.exec(config.controlPlane.sessionSecretRef); if (!match) throw new M11ConfigurationError(["Secret reference is invalid."]);
  const secret = env[match[1]!]; if (secret === undefined || secret.length < 32 || secret.length > 4096) throw new M11ConfigurationError(["Referenced runtime secret is unavailable."]);
  return secret;
}

export function toControlPlaneConfig(config: M11RuntimeConfiguration, secret: string, environment: ControlPlaneConfig["environment"] = "production"): ControlPlaneConfig {
  const root = config.paths.managedDataRoot;
  return Object.freeze({ environment, dataDirectory: root, databasePath: resolve(root, config.paths.databaseFile), host: config.controlPlane.host, port: config.controlPlane.port, allowedOrigin: config.controlPlane.allowedOrigin, sessionSecret: secret, cookieName: "chubz_session", secureCookie: false, logLevel: "info", sessionTtlMs: 8 * 60 * 60_000, sessionIdleMs: 30 * 60_000, requestBodyLimit: 64 * 1024, websocketMessageLimit: 64 * 1024, loginAttemptWindowMs: 60_000, loginBucketMaximum: 1_024, authEventRetentionMs: 30 * 24 * 60 * 60_000, authEventMaximum: 10_000, m11: Object.freeze({ logsDirectory: config.paths.logsDirectory, supportBundlesDirectory: config.paths.supportBundlesDirectory, packagesDirectory: config.paths.packagesDirectory, logMaxBytes: config.bounds.logMaxBytes, logRetentionFiles: config.bounds.logRetentionFiles, supportBundleMaxBytes: config.bounds.supportBundleMaxBytes, supportBundleMaxFiles: config.bounds.supportBundleMaxFiles, packageMaxBytes: config.bounds.packageMaxBytes, packageMaxFiles: config.bounds.packageMaxFiles, storageWarningPercent: config.bounds.storageWarningPercent }) });
}

export function configurationDigest(config: M11RuntimeConfiguration): string { return digest(config); }
