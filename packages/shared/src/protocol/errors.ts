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
  "EXECUTION_UNKNOWN",
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
 * Default retryability per code (R3). Only genuinely transient
 * PRE-EXECUTION conditions default to retryable. INTERNAL_ERROR defaults
 * to NON-retryable because a generic internal failure cannot prove the
 * operation never started — blind retry could hide ambiguous execution.
 *
 * EXECUTION_UNKNOWN is the dedicated machine-readable code for "the
 * outcome of the operation cannot be proven; owner-reviewed
 * reconciliation is required" (D-020/D-021/D-022). It is never
 * retryable and cannot be overridden to retryable.
 */
export const DEFAULT_RETRYABILITY: Readonly<Record<ProtocolErrorCode, boolean>> = Object.freeze({
  INVALID_ENVELOPE: false,
  UNSUPPORTED_PROTOCOL_VERSION: false,
  UNKNOWN_MESSAGE_KIND: false,
  VALIDATION_ERROR: false,
  IDEMPOTENCY_CONFLICT: false,
  EXECUTION_UNKNOWN: false,
  CURSOR_AHEAD: false,
  CURSOR_TOO_OLD: false,
  UNKNOWN_STREAM: false,
  SEQUENCE_GAP: false,
  NOT_FOUND: false,
  BUSY: true,
  WORKER_OFFLINE: true,
  UNAUTHORIZED: false,
  INTERNAL_ERROR: false,
});

/**
 * Codes whose non-retryability is FIXED (R3): contract/validation
 * violations, idempotency conflicts, and execution-unknown must never
 * be presented as retryable. The schema itself rejects
 * `retryable: true` for these codes, so neither makeProtocolError
 * options nor a hand-built object can override them.
 */
export const FIXED_NON_RETRYABLE_CODES = Object.freeze([
  "INVALID_ENVELOPE",
  "UNSUPPORTED_PROTOCOL_VERSION",
  "UNKNOWN_MESSAGE_KIND",
  "VALIDATION_ERROR",
  "IDEMPOTENCY_CONFLICT",
  "EXECUTION_UNKNOWN",
] as const);
export type FixedNonRetryableCode = (typeof FIXED_NON_RETRYABLE_CODES)[number];

const isFixedNonRetryable = (code: ProtocolErrorCode): boolean =>
  (FIXED_NON_RETRYABLE_CODES as readonly string[]).includes(code);

/**
 * Bounded dot/index field-path notation (R3): an optional `$` root,
 * identifier segments, and bounded numeric indexes only — e.g.
 * "payload", "payload.taskId", "payload.items[0].name", "$",
 * "$.payload.items[0]". Control characters, whitespace, `/`, `\`, `:`
 * (drive letters), UNC prefixes, `..`, empty segments, and stack-trace
 * text are unrepresentable by construction.
 */
const FIELD_ERROR_PATH_RE =
  /^(?:\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d{1,16}\])*|[A-Za-z_][A-Za-z0-9_]*(?:\[\d{1,16}\])*(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\d{1,16}\])*)*)$/;

export const FieldErrorSchema = z.strictObject({
  /** Bounded dot/index path into the offending message, e.g. "payload.taskId". */
  path: z
    .string()
    .min(1)
    .max(256)
    .regex(
      FIELD_ERROR_PATH_RE,
      "must be a bounded dot/index field path (e.g. $.payload.items[0].name)",
    ),
  message: displayText(PROTOCOL_LIMITS.maxErrorSummaryLength),
});
export type FieldError = z.infer<typeof FieldErrorSchema>;

export const ProtocolErrorSchema = z
  .strictObject({
    code: ProtocolErrorCodeSchema,
    summary: displayText(PROTOCOL_LIMITS.maxErrorSummaryLength),
    retryable: z.boolean(),
    fieldErrors: z.array(FieldErrorSchema).min(1).max(PROTOCOL_LIMITS.maxFieldErrors).optional(),
    relatesToMessageId: SafeIdSchema.optional(),
    correlationId: SafeIdSchema.optional(),
  })
  .superRefine((error, ctx) => {
    if (error.retryable && isFixedNonRetryable(error.code)) {
      ctx.addIssue({
        code: "custom",
        path: ["retryable"],
        message: `${error.code} is never retryable; it cannot be overridden to retryable`,
      });
    }
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

const IDENTIFIER_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_FIELD_PATH_LENGTH = 256;

/**
 * Renders a validator issue path in the bounded `$`-rooted dot/index
 * notation (R3). Array indexes become `[n]`; property names that are
 * not plain identifiers (unknown-key names can be arbitrary attacker
 * text) are sanitized to identifier characters, never emitted verbatim.
 * Segments that would exceed the length bound are dropped, so the
 * result is always a valid (possibly shortened) prefix path.
 */
const formatIssuePath = (segments: ReadonlyArray<PropertyKey>): string => {
  let path = "$";
  for (const segment of segments) {
    let rendered: string;
    if (typeof segment === "number" && Number.isInteger(segment) && segment >= 0) {
      rendered = `[${segment}]`;
    } else {
      const cleaned = String(segment).replace(/[^A-Za-z0-9_]/g, "_");
      rendered = `.${IDENTIFIER_SEGMENT_RE.test(cleaned) ? cleaned : `_${cleaned}`}`;
    }
    if (path.length + rendered.length > MAX_FIELD_PATH_LENGTH) break;
    path += rendered;
  }
  return path;
};

const SUMMARY_TEXT_SCHEMA = displayText(PROTOCOL_LIMITS.maxErrorSummaryLength);
const FALLBACK_MESSAGE = "invalid value";

/**
 * Totality-safe sanitizer (hostile-input patch). Validator text can
 * embed arbitrary attacker content — unknown-key names are echoed into
 * zod messages — so everything displayText refuses is removed BEFORE
 * re-validation: the entire stack-trace tail, markup openers, drive and
 * UNC path runs, and every C0/C1 control character (including newline,
 * carriage return, and tab) is replaced, whitespace is collapsed, and
 * the result is bounded. The sanitized text is then checked against the
 * SAME display-text contract ProtocolErrorSchema enforces; if nothing
 * readable survives — or anything unsafe ever did — the fixed fallback
 * is returned instead. This function never throws and its result always
 * satisfies the summary/message schema, keeping the public parsers
 * total.
 */
const sanitizeSummary = (value: string): string => {
  const cleaned = value
    .replace(/\r?\n\s+at\s[\s\S]*$/, " ")
    .replace(/<[a-zA-Z!/]/g, " ")
    .replace(/[A-Za-z]:[\\/]/g, " ")
    .replace(/\\\\/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  const bounded = truncate(cleaned, PROTOCOL_LIMITS.maxErrorSummaryLength);
  if (bounded === "") return FALLBACK_MESSAGE;
  return SUMMARY_TEXT_SCHEMA.safeParse(bounded).success ? bounded : FALLBACK_MESSAGE;
};

const UNKNOWN_FIELD_SEGMENT = "unknownFields";

type ValidatorIssues = z.ZodError["issues"];

/**
 * Builds bounded field errors from validator issues (hostile-input
 * patch). Unrecognized-key issues are expanded to one entry PER KEY so
 * multiple hostile unknown fields never collapse into a single path:
 * keys that are plain identifiers keep their real name
 * (`$.smuggled`); keys that cannot be represented safely (control
 * characters, separators, drive/UNC shapes, numerics, oversized text)
 * receive a deterministic synthetic path — `<base>.unknownFields[n]`
 * with a per-parse counter — that satisfies FieldErrorSchema without
 * ever carrying any of the hostile key text. Never throws: every path
 * is valid by construction and every message is sanitized.
 */
const buildFieldErrors = (issues: ValidatorIssues): FieldError[] => {
  const fieldErrors: FieldError[] = [];
  let syntheticIndex = 0;
  for (const issue of issues) {
    if (fieldErrors.length >= PROTOCOL_LIMITS.maxFieldErrors) break;
    const base = formatIssuePath(issue.path);
    if (issue.code === "unrecognized_keys" && Array.isArray(issue.keys)) {
      for (const key of issue.keys) {
        if (fieldErrors.length >= PROTOCOL_LIMITS.maxFieldErrors) break;
        const named = `${base}.${key}`;
        if (IDENTIFIER_SEGMENT_RE.test(key) && named.length <= MAX_FIELD_PATH_LENGTH) {
          fieldErrors.push({ path: named, message: "unrecognized key" });
        } else {
          const synthetic = `${base}.${UNKNOWN_FIELD_SEGMENT}[${syntheticIndex}]`;
          const rooted = `$.${UNKNOWN_FIELD_SEGMENT}[${syntheticIndex}]`;
          syntheticIndex += 1;
          fieldErrors.push({
            path: synthetic.length <= MAX_FIELD_PATH_LENGTH ? synthetic : rooted,
            message: "unrecognized key (name unsafe to display)",
          });
        }
      }
    } else {
      fieldErrors.push({ path: base, message: sanitizeSummary(issue.message) });
    }
  }
  return fieldErrors;
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
    try {
      return {
        ok: false,
        error: makeProtocolError("VALIDATION_ERROR", "The message failed schema validation.", {
          fieldErrors: buildFieldErrors(parsed.error.issues),
        }),
      };
    } catch {
      // Absolute totality backstop (hostile-input patch): if an
      // unforeseen issue shape ever produced an unrepresentable field
      // error, the parser still returns its documented result — built
      // from literals only, so this branch cannot throw.
      return {
        ok: false,
        error: makeProtocolError("VALIDATION_ERROR", "The message failed schema validation."),
      };
    }
  }
  return { ok: true, message: parsed.data };
}
