import { z } from "zod";
import {
  PROTOCOL_LIMITS,
  SUPPORTED_PROTOCOL_VERSIONS,
  SafeIdSchema,
  displayText,
} from "./common.js";

/**
 * Standard protocol error contract (M1B, D-023). Machine-readable code,
 * safe human-readable summary, optional structured field errors, and an
 * explicit retryability flag. Strictness plus displayText refinements
 * guarantee: no stack traces, no local paths, no markup, and no
 * smuggled credential/stack fields (unknown keys are rejected).
 */

export const PROTOCOL_ERROR_CODES = Object.freeze([
  "INVALID_ENVELOPE",
  "UNSUPPORTED_PROTOCOL_VERSION",
  "UNKNOWN_MESSAGE_KIND",
  "VALIDATION_ERROR",
  "IDEMPOTENCY_CONFLICT",
  "CURSOR_AHEAD",
  "CURSOR_TOO_OLD",
  "UNKNOWN_STREAM",
  "SEQUENCE_GAP",
  "NOT_FOUND",
  "BUSY",
  "WORKER_OFFLINE",
  "UNAUTHORIZED",
  "INTERNAL_ERROR",
] as const);
export const ProtocolErrorCodeSchema = z.enum(PROTOCOL_ERROR_CODES);
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;

/**
 * Default retryability per code. Transient conditions are retryable;
 * contract violations and conflicts are not (a conflict must never be
 * blindly retried into execution).
 */
export const DEFAULT_RETRYABILITY: Readonly<Record<ProtocolErrorCode, boolean>> = Object.freeze({
  INVALID_ENVELOPE: false,
  UNSUPPORTED_PROTOCOL_VERSION: false,
  UNKNOWN_MESSAGE_KIND: false,
  VALIDATION_ERROR: false,
  IDEMPOTENCY_CONFLICT: false,
  CURSOR_AHEAD: false,
  CURSOR_TOO_OLD: false,
  UNKNOWN_STREAM: false,
  SEQUENCE_GAP: false,
  NOT_FOUND: false,
  BUSY: true,
  WORKER_OFFLINE: true,
  UNAUTHORIZED: false,
  INTERNAL_ERROR: true,
});

export const FieldErrorSchema = z.strictObject({
  /** Dot-joined path into the offending message, e.g. "payload.taskId". */
  path: z.string().min(1).max(256),
  message: displayText(PROTOCOL_LIMITS.maxErrorSummaryLength),
});
export type FieldError = z.infer<typeof FieldErrorSchema>;

export const ProtocolErrorSchema = z.strictObject({
  code: ProtocolErrorCodeSchema,
  summary: displayText(PROTOCOL_LIMITS.maxErrorSummaryLength),
  retryable: z.boolean(),
  fieldErrors: z.array(FieldErrorSchema).min(1).max(PROTOCOL_LIMITS.maxFieldErrors).optional(),
  relatesToMessageId: SafeIdSchema.optional(),
  correlationId: SafeIdSchema.optional(),
});
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

export interface MakeProtocolErrorOptions {
  readonly retryable?: boolean;
  readonly fieldErrors?: readonly FieldError[];
  readonly relatesToMessageId?: string;
  readonly correlationId?: string;
}

/**
 * Pure builder. Runs the result back through the schema, so an unsafe
 * summary (stack trace, path, markup) throws instead of leaking.
 */
export function makeProtocolError(
  code: ProtocolErrorCode,
  summary: string,
  options: MakeProtocolErrorOptions = {},
): ProtocolError {
  return ProtocolErrorSchema.parse({
    code,
    summary,
    retryable: options.retryable ?? DEFAULT_RETRYABILITY[code],
    ...(options.fieldErrors !== undefined && options.fieldErrors.length > 0
      ? { fieldErrors: options.fieldErrors }
      : {}),
    ...(options.relatesToMessageId !== undefined
      ? { relatesToMessageId: options.relatesToMessageId }
      : {}),
    ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
  });
}

export type EnvelopeParseResult<T> =
  | { readonly ok: true; readonly message: T }
  | { readonly ok: false; readonly error: ProtocolError };

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

// Strip anything displayText would refuse (markup openers, stack
// frames, path-like runs) so third-party validator text can never leak
// unsafe content into a protocol error summary.
const sanitizeSummary = (value: string): string => {
  const cleaned = value
    .replace(/<[a-zA-Z!/]/g, " ")
    .replace(/\n\s+at\s/g, " ")
    .replace(/[A-Za-z]:[\\/]/g, " ")
    .replace(/\\\\/g, " ");
  const bounded = truncate(cleaned, PROTOCOL_LIMITS.maxErrorSummaryLength);
  return bounded.trim() === "" ? "invalid value" : bounded;
};

/**
 * Shared strict parse-and-classify helper for one protocol direction.
 *
 * Classification order (tested): non-object → INVALID_ENVELOPE;
 * unsupported protocolVersion → UNSUPPORTED_PROTOCOL_VERSION;
 * messageKind outside this direction's kind set → UNKNOWN_MESSAGE_KIND
 * (this is also what enforces direction: a Bridge kind handed to the
 * client parser is unknown BY CONSTRUCTION); anything else invalid →
 * VALIDATION_ERROR with bounded structured field errors.
 */
export function parseEnvelopeWith<S extends z.ZodType>(
  schema: S,
  supportedKinds: readonly string[],
  raw: unknown,
): EnvelopeParseResult<z.output<S>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      error: makeProtocolError("INVALID_ENVELOPE", "The message is not a protocol envelope object."),
    };
  }
  const candidate = raw as Record<string, unknown>;

  const version = candidate["protocolVersion"];
  if (
    typeof version !== "string" ||
    !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)
  ) {
    return {
      ok: false,
      error: makeProtocolError(
        "UNSUPPORTED_PROTOCOL_VERSION",
        `Supported protocol versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`,
      ),
    };
  }

  const kind = candidate["messageKind"];
  if (typeof kind !== "string" || !supportedKinds.includes(kind)) {
    return {
      ok: false,
      error: makeProtocolError(
        "UNKNOWN_MESSAGE_KIND",
        "The message kind is not part of this protocol direction.",
      ),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: FieldError[] = parsed.error.issues
      .slice(0, PROTOCOL_LIMITS.maxFieldErrors)
      .map((issue) => ({
        path: truncate(issue.path.length === 0 ? "(root)" : issue.path.map(String).join("."), 256),
        message: sanitizeSummary(issue.message),
      }));
    return {
      ok: false,
      error: makeProtocolError("VALIDATION_ERROR", "The message failed schema validation.", {
        fieldErrors,
      }),
    };
  }
  return { ok: true, message: parsed.data };
}
