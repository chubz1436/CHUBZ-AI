import { z } from "zod";

/**
 * Common protocol primitives and the versioned envelope contract (M1B,
 * D-023). Pure contracts only: no transport, no persistence, no I/O.
 *
 * Every protocol object is strict — unknown fields, unknown message
 * kinds, and unsupported protocol versions are rejected by default.
 */

export const PROTOCOL_VERSION = "1.0" as const;
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(["1.0"] as const);
export const ProtocolVersionSchema = z.enum(SUPPORTED_PROTOCOL_VERSIONS);
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;

/**
 * Message-size and text bounds (D-023 / mission §7). Chosen to allow
 * normal use while forcing large content (diffs, logs, worker output)
 * into artifact references instead of unbounded inline strings.
 */
export const PROTOCOL_LIMITS = Object.freeze({
  /** Max length of any protocol identifier. */
  maxIdLength: 128,
  /** Min length of an idempotency key (collision resistance floor). */
  minIdempotencyKeyLength: 8,
  /** Max inline owner request text (chat input). */
  maxOwnerTextLength: 16_000,
  /** Max inline status/progress/note text. */
  maxStatusTextLength: 2_000,
  /** Max inline worker summary text (full output goes to artifacts). */
  maxWorkerSummaryLength: 8_000,
  /** Max protocol-error summary text. */
  maxErrorSummaryLength: 2_000,
  /** Max structured field errors on one protocol error. */
  maxFieldErrors: 64,
  /** Max entries in list-ish metadata arrays (artifact refs, flags…). */
  maxMetadataEntries: 64,
  /** Max risk flags on an approval card. */
  maxRiskFlags: 16,
} as const);

/**
 * Log-safe bounded identifier: alphanumeric start; letters, digits,
 * dot, underscore, hyphen after. Deliberately excludes `/`, `\`, `:`,
 * whitespace, and any `..` run so an ID can never smuggle an absolute
 * path, drive-letter path, UNC path, or traversal segment.
 */
export const SafeIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    "must be a bounded log-safe identifier (letters, digits, '.', '_', '-')",
  )
  .refine((id) => !id.includes(".."), "identifier must not contain '..'");
export type SafeId = z.infer<typeof SafeIdSchema>;

/** Lowercase slug identifier, matching M1A worker/project id style. */
export const SlugIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "must be a lowercase slug (a-z, 0-9, hyphen)");
export type SlugId = z.infer<typeof SlugIdSchema>;

/** Strict ISO-8601 UTC timestamp, e.g. 2026-07-11T08:30:00Z. */
export const IsoUtcTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
    "must be an ISO-8601 UTC timestamp ending in Z",
  )
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be a real calendar timestamp");
export type IsoUtcTimestamp = z.infer<typeof IsoUtcTimestampSchema>;

/** Idempotency key: log-safe, bounded, with a minimum length floor. */
export const IdempotencyKeySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/,
    "must be a bounded log-safe idempotency key of at least 8 characters",
  )
  .refine((id) => !id.includes(".."), "idempotency key must not contain '..'");
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]");

/** Bounded plain text: no control characters (newline/tab allowed). */
export const boundedText = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => !CONTROL_CHARS.test(value), "must not contain control characters");

/**
 * Bounded DISPLAY text authored by the Control Plane or Bridge for
 * rendering (approval cards, status lines, summaries, errors). On top
 * of boundedText it must be markup-free and must not carry stack
 * traces or local filesystem paths.
 */
export const displayText = (maxLength: number) =>
  boundedText(maxLength)
    .refine((value) => !/<[a-zA-Z!/]/.test(value), "must not contain HTML/markup tags")
    .refine((value) => !/\n\s+at\s/.test(value), "must not contain stack-trace frames")
    .refine(
      (value) => !/[A-Za-z]:[\\/]/.test(value) && !value.includes("\\\\"),
      "must not contain local filesystem paths",
    );

/** The four protocol directions. Kind sets never overlap across directions. */
export const MESSAGE_DIRECTIONS = Object.freeze([
  "client-to-control-plane",
  "control-plane-to-client",
  "control-plane-to-bridge",
  "bridge-to-control-plane",
] as const);
export const MessageDirectionSchema = z.enum(MESSAGE_DIRECTIONS);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

const envelopeBaseFields = {
  protocolVersion: ProtocolVersionSchema,
  messageId: SafeIdSchema,
  sentAt: IsoUtcTimestampSchema,
  correlationId: SafeIdSchema.optional(),
  causationId: SafeIdSchema.optional(),
  projectId: SlugIdSchema.optional(),
  taskId: SafeIdSchema.optional(),
  attemptId: SafeIdSchema.optional(),
} as const;

/**
 * Read-only envelope: no idempotency key field exists, so a read-only
 * message can never be "forced to mutate" (extra keys are rejected by
 * strictness).
 */
export const readonlyEnvelope = <K extends string, P extends z.ZodType>(
  messageKind: K,
  payload: P,
) =>
  z.strictObject({
    ...envelopeBaseFields,
    messageKind: z.literal(messageKind),
    payload,
  });

/**
 * Mutating envelope: an idempotency key is REQUIRED. The payload digest
 * is computed by the receiving runtime from the canonicalized payload
 * (see protocol/idempotency.ts) — it is not sender-supplied.
 */
export const mutatingEnvelope = <K extends string, P extends z.ZodType>(
  messageKind: K,
  payload: P,
) =>
  z.strictObject({
    ...envelopeBaseFields,
    messageKind: z.literal(messageKind),
    idempotencyKey: IdempotencyKeySchema,
    payload,
  });

/** The identity fields an envelope and a payload may both carry. */
export interface EnvelopeIdentityCarrier {
  readonly taskId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly payload: unknown;
}

const SHARED_IDENTITY_FIELDS = ["taskId", "attemptId", "projectId"] as const;

/**
 * Where an envelope and its payload both carry the same identity field
 * (taskId, attemptId, projectId), they must match exactly —
 * contradictory identifiers are rejected (M1B R1). Applied at the
 * direction-union level so every message kind is covered.
 */
export const requireConsistentIdentity = <S extends z.ZodType<EnvelopeIdentityCarrier>>(
  schema: S,
) =>
  schema.superRefine((message, ctx) => {
    const payload = message.payload;
    if (typeof payload !== "object" || payload === null) return;
    const payloadRecord = payload as Record<string, unknown>;
    for (const field of SHARED_IDENTITY_FIELDS) {
      const envelopeValue = message[field];
      const payloadValue = payloadRecord[field];
      if (
        typeof envelopeValue === "string" &&
        typeof payloadValue === "string" &&
        envelopeValue !== payloadValue
      ) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `envelope ${field} '${envelopeValue}' contradicts payload ${field} '${payloadValue}'`,
        });
      }
    }
  });
