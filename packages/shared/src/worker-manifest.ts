import { z } from "zod";

/**
 * Authoritative machine-readable worker-manifest contract
 * (FINAL_ARCHITECTURE_DESIGN.md §8.3, D-011, D-012).
 *
 * Manifests declare identity, capabilities, and limits — NEVER secrets.
 * Every object is strict: unknown fields (including credential-like
 * fields such as apiKey/token/password) are rejected outright.
 */

export const CONNECTOR_TYPES = Object.freeze([
  "cli-headless",
  "http-api",
  "local-process",
  "manual-relay",
  "browser-controlled",
] as const);
export const ConnectorTypeSchema = z.enum(CONNECTOR_TYPES);
export type ConnectorType = z.infer<typeof ConnectorTypeSchema>;

export const WORKER_CAPABILITIES = Object.freeze([
  "code-write",
  "review",
  "design",
  "ops-validate",
  "compare-only",
  "text-output",
] as const);
export const WorkerCapabilitySchema = z.enum(WORKER_CAPABILITIES);
export type WorkerCapability = z.infer<typeof WorkerCapabilitySchema>;

export const WORKER_RESTRICTIONS = Object.freeze([
  "never-write",
  "assigned-only",
  "manual-import-only",
] as const);
export const WorkerRestrictionSchema = z.enum(WORKER_RESTRICTIONS);
export type WorkerRestriction = z.infer<typeof WorkerRestrictionSchema>;

export const RISK_LEVELS = Object.freeze(["low", "medium", "high"] as const);
export const RiskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const FILE_OPERATIONS = Object.freeze(["read", "write-workspace", "none"] as const);
export const FileOperationSchema = z.enum(FILE_OPERATIONS);
export type FileOperation = z.infer<typeof FileOperationSchema>;

export const HEALTH_CHECK_METHODS = Object.freeze([
  "version-invocation",
  "process-ping",
  "http-ping",
  "manual-attestation",
  "none",
] as const);
export const HealthCheckMethodSchema = z.enum(HEALTH_CHECK_METHODS);
export type HealthCheckMethod = z.infer<typeof HealthCheckMethodSchema>;

/**
 * Provenance mode (D-012): automated connectors record real execution
 * provenance; manual relay is owner-attested — the owner's attestation IS
 * the provenance, and no automatic supervision claim is ever made.
 */
export const PROVENANCE_MODES = Object.freeze(["automated", "owner-attested"] as const);
export const ProvenanceModeSchema = z.enum(PROVENANCE_MODES);
export type ProvenanceMode = z.infer<typeof ProvenanceModeSchema>;

const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "must be a lowercase slug (a-z, 0-9, hyphen)");

/** Invocation metadata for automated connectors. Argument arrays only — never shell strings, never credentials. */
export const InvocationSchema = z.strictObject({
  executable: z.string().min(1),
  args: z.array(z.string()).readonly(),
  promptDelivery: z.enum(["argument", "stdin"]),
});
export type Invocation = z.infer<typeof InvocationSchema>;

export const TimeoutPolicySchema = z.strictObject({
  /** Hard per-attempt timeout, 1 second to 24 hours. */
  timeoutSec: z.number().int().min(1).max(86_400),
  /** Grace period between polite stop and process-tree kill. */
  killGraceSec: z.number().int().min(0).max(300),
});
export type TimeoutPolicy = z.infer<typeof TimeoutPolicySchema>;

export const ContextLimitsSchema = z.strictObject({
  maxFiles: z.number().int().min(1).max(10_000),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(1_073_741_824), // 1 GiB hard ceiling
});
export type ContextLimits = z.infer<typeof ContextLimitsSchema>;

export const ConnectorSchema = z.strictObject({
  type: ConnectorTypeSchema,
  /** Required for cli-headless and local-process; forbidden for manual-relay. */
  invocation: InvocationSchema.optional(),
  healthCheck: HealthCheckMethodSchema,
  timeoutPolicy: TimeoutPolicySchema,
  /** Whether the connector can actually cancel in-flight work. */
  cancelable: z.boolean(),
});
export type Connector = z.infer<typeof ConnectorSchema>;

const uniqueItems = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

export const WorkerManifestSchema = z
  .strictObject({
    workerId: slug,
    displayName: z.string().min(1).max(80),
    provider: z.string().min(1).max(120),
    runtime: z.string().min(1).max(120),
    connector: ConnectorSchema,
    capabilities: z.array(WorkerCapabilitySchema).min(1).refine(uniqueItems, "capabilities must be unique"),
    restrictions: z.array(WorkerRestrictionSchema).refine(uniqueItems, "restrictions must be unique"),
    allowedTaskCategories: z.array(slug).min(1).refine(uniqueItems, "allowedTaskCategories must be unique"),
    defaultRiskLevel: RiskLevelSchema,
    contextLimits: ContextLimitsSchema,
    supportedFileOps: z.array(FileOperationSchema).min(1).refine(uniqueItems, "supportedFileOps must be unique"),
    /** Gate identifiers this worker's tasks always require beyond defaults. */
    requiredApprovals: z.array(slug).refine(uniqueItems, "requiredApprovals must be unique"),
    provenanceMode: ProvenanceModeSchema,
  })
  .superRefine((manifest, ctx) => {
    const { connector, supportedFileOps, restrictions, capabilities, provenanceMode } = manifest;

    if (supportedFileOps.includes("none") && supportedFileOps.length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["supportedFileOps"],
        message: "'none' cannot be combined with other file operations",
      });
    }

    if (connector.type === "manual-relay") {
      if (provenanceMode !== "owner-attested") {
        ctx.addIssue({
          code: "custom",
          path: ["provenanceMode"],
          message: "manual-relay workers must be owner-attested (D-012)",
        });
      }
      if (connector.cancelable) {
        ctx.addIssue({
          code: "custom",
          path: ["connector", "cancelable"],
          message: "manual-relay cannot cancel in-flight work; a human is the transport",
        });
      }
      if (connector.invocation !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["connector", "invocation"],
          message: "manual-relay has no automated invocation",
        });
      }
      if (supportedFileOps.includes("write-workspace")) {
        ctx.addIssue({
          code: "custom",
          path: ["supportedFileOps"],
          message:
            "manual-relay has no automatic file supervision; file changes arrive only via explicit artifact import (D-012)",
        });
      }
    }

    if (connector.type === "cli-headless" || connector.type === "local-process") {
      if (connector.invocation === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["connector", "invocation"],
          message: `${connector.type} workers must declare their invocation`,
        });
      }
      if (provenanceMode !== "automated") {
        ctx.addIssue({
          code: "custom",
          path: ["provenanceMode"],
          message: `${connector.type} workers record automated provenance`,
        });
      }
    }

    if (restrictions.includes("never-write")) {
      if (capabilities.includes("code-write")) {
        ctx.addIssue({
          code: "custom",
          path: ["capabilities"],
          message: "a never-write worker cannot declare the code-write capability",
        });
      }
      if (supportedFileOps.includes("write-workspace")) {
        ctx.addIssue({
          code: "custom",
          path: ["supportedFileOps"],
          message: "a never-write worker cannot declare write-workspace",
        });
      }
    }
  })
  .readonly();

export type WorkerManifest = z.infer<typeof WorkerManifestSchema>;

export type ManifestValidationResult =
  | { readonly valid: true; readonly manifest: WorkerManifest }
  | { readonly valid: false; readonly issues: readonly { path: string; message: string }[] };

/** Pure validation helper returning a machine-readable result instead of throwing. */
export function validateWorkerManifest(candidate: unknown): ManifestValidationResult {
  const result = WorkerManifestSchema.safeParse(candidate);
  if (result.success) {
    return Object.freeze({ valid: true, manifest: result.data });
  }
  return Object.freeze({
    valid: false,
    issues: Object.freeze(
      result.error.issues.map((issue) =>
        Object.freeze({ path: issue.path.map(String).join("."), message: issue.message }),
      ),
    ),
  });
}
