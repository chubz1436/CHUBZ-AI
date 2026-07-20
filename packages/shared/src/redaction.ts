import { z } from "zod";

/**
 * M1D pure redaction primitives.  These helpers never read paths or process
 * state: path inputs are policy strings only and text is supplied by callers.
 * Redaction is defense in depth, not proof that arbitrary text is secret-free.
 */
export const REDACTION_VERSION = "1.0" as const;
export const REDACTION_LIMITS = Object.freeze({
  maxInputChars: 262_144,
  maxFindings: 256,
  minEntropyCandidateLength: 24,
  maxEntropyCandidateLength: 256,
} as const);

export const REDACTION_CATEGORIES = Object.freeze([
  "private-key", "authorization", "token-assignment", "connection-credential",
  "jwt", "entropy-candidate", "sensitive-path", "credential-store",
] as const);
export type RedactionCategory = (typeof REDACTION_CATEGORIES)[number];
export const RedactionCategorySchema = z.enum(REDACTION_CATEGORIES);
export const RedactionFindingSourceSchema = z.enum(["pattern", "entropy", "path-policy"]);
export type RedactionFindingSource = z.infer<typeof RedactionFindingSourceSchema>;
export const RedactionConfidenceSchema = z.enum(["high", "medium", "candidate"]);
export type RedactionConfidence = z.infer<typeof RedactionConfidenceSchema>;

export const RedactionFindingSchema = z.strictObject({
  start: z.number().int().min(0).max(REDACTION_LIMITS.maxInputChars),
  end: z.number().int().min(0).max(REDACTION_LIMITS.maxInputChars),
  category: RedactionCategorySchema,
  source: RedactionFindingSourceSchema,
  confidence: RedactionConfidenceSchema,
}).superRefine((finding, ctx) => {
  if (finding.end <= finding.start) ctx.addIssue({ code: "custom", path: ["end"], message: "must follow start" });
});
export type RedactionFinding = z.infer<typeof RedactionFindingSchema>;

export const RedactionPolicySchema = z.strictObject({
  version: z.literal(REDACTION_VERSION),
  maxInputChars: z.number().int().min(1).max(REDACTION_LIMITS.maxInputChars),
  maxFindings: z.number().int().min(1).max(REDACTION_LIMITS.maxFindings),
  entropy: z.strictObject({
    enabled: z.literal(true),
    minLength: z.number().int().min(REDACTION_LIMITS.minEntropyCandidateLength).max(REDACTION_LIMITS.maxEntropyCandidateLength),
    maxLength: z.number().int().min(REDACTION_LIMITS.minEntropyCandidateLength).max(REDACTION_LIMITS.maxEntropyCandidateLength),
    minBitsPerCharacter: z.number().min(3).max(6),
  }).superRefine((entropy, ctx) => {
    if (entropy.maxLength < entropy.minLength) ctx.addIssue({ code: "custom", path: ["maxLength"], message: "must not be below minLength" });
  }),
}).superRefine((policy, ctx) => {
  if (policy.entropy.maxLength > policy.maxInputChars) ctx.addIssue({ code: "custom", path: ["entropy", "maxLength"], message: "must fit input limit" });
});
export type RedactionPolicy = z.infer<typeof RedactionPolicySchema>;
export const DEFAULT_REDACTION_POLICY: Readonly<RedactionPolicy> = Object.freeze({
  version: REDACTION_VERSION, maxInputChars: REDACTION_LIMITS.maxInputChars, maxFindings: REDACTION_LIMITS.maxFindings,
  entropy: { enabled: true as const, minLength: 32, maxLength: 128, minBitsPerCharacter: 4.1 },
});

export const RedactionFailureSchema = z.strictObject({
  code: z.enum(["MALFORMED_INPUT", "INPUT_TOO_LARGE", "TOO_MANY_FINDINGS", "INVALID_OFFSETS"]),
  message: z.enum(["The redaction input is invalid.", "The redaction input exceeds the configured limit.", "The redaction finding limit was reached.", "The redaction findings are invalid."]),
});
export type RedactionFailure = z.infer<typeof RedactionFailureSchema>;
export type RedactionParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RedactionFailure };
const fail = (code: RedactionFailure["code"], message: RedactionFailure["message"]): RedactionParseResult<never> => Object.freeze({ ok: false, error: Object.freeze({ code, message }) });

export const PathDispositionSchema = z.enum(["exclude", "redact", "safe"]);
export type PathDisposition = z.infer<typeof PathDispositionSchema>;
export const PathClassificationSchema = z.strictObject({ disposition: PathDispositionSchema, category: RedactionCategorySchema.optional() });
export type PathClassification = z.infer<typeof PathClassificationSchema>;

// NFKC handles full-width punctuation; this tiny conservative map makes the
// most common Cyrillic/Greek lookalikes fail closed for sensitive basenames.
const confusables = (value: string): string => value.normalize("NFKC").replace(/[аΑ]/g, "a").replace(/[еΕ]/g, "e").replace(/[оΟ]/g, "o").replace(/[рΡ]/g, "p").replace(/[сϹ]/g, "c").replace(/[ѕЅ]/g, "s").replace(/[іΙ]/g, "i").replace(/[кΚ]/g, "k").replace(/[хΧ]/g, "x");
const normalizePath = (value: string): string => {
  const parts: string[] = [];
  for (const raw of confusables(value).replace(/\\/g, "/").split("/")) {
    const part = raw.trimEnd().replace(/[.]+$/g, "").toLowerCase();
    if (part === "" || part === ".") continue;
    if (part === "..") { parts.pop(); continue; }
    parts.push(part);
  }
  return parts.join("/");
};

/** Classifies a path string without resolving, opening, or retaining it. */
export function classifySensitivePath(raw: unknown): PathClassification {
  try {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) return Object.freeze({ disposition: "redact", category: "sensitive-path" });
    const path = normalizePath(raw);
    const base = path.split("/").at(-1) ?? "";
    const segments = path.split("/");
    if (base === ".env" || base.startsWith(".env.") || /\.(pem|key|pfx|p12|keystore)$/.test(base) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(base) || /^(credentials|credential|\.git-credentials|\.npmrc|\.pypirc|\.netrc|auth\.json|tokens?\.json)$/.test(base)) return Object.freeze({ disposition: "exclude", category: base.includes("credential") || base === ".npmrc" || base === ".pypirc" || base === ".netrc" ? "credential-store" : "sensitive-path" });
    if (segments.some((s) => s === ".ssh" || s === ".aws" || s === ".azure" || s === ".gcp" || s === "cookies" || s === "sessions" || s === "credentialmanager")) return Object.freeze({ disposition: "exclude", category: "credential-store" });
    if (/(^|\/)(secrets?|tokens?|private)(\/|$)/.test(path)) return Object.freeze({ disposition: "redact", category: "sensitive-path" });
    return Object.freeze({ disposition: "safe" });
  } catch { return Object.freeze({ disposition: "redact", category: "sensitive-path" }); }
}

const add = (out: RedactionFinding[], start: number, end: number, category: RedactionCategory, source: RedactionFindingSource, confidence: RedactionConfidence, max: number): boolean => {
  if (out.length >= max) return false;
  out.push(Object.freeze({ start, end, category, source, confidence })); return true;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_HASH_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const entropy = (value: string): number => { const counts = new Map<string, number>(); for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1); let result = 0; for (const count of counts.values()) { const p = count / value.length; result -= p * Math.log2(p); } return result; };
const isEntropyCandidate = (value: string, policy: RedactionPolicy): boolean => value.length >= policy.entropy.minLength && value.length <= policy.entropy.maxLength && /^[A-Za-z0-9_+\/-]+$/.test(value) && !UUID_RE.test(value) && !HEX_HASH_RE.test(value) && entropy(value) >= policy.entropy.minBitsPerCharacter;
const ASSIGNMENT_HEAD_RE = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|webhook[_-]?secret|password|secret)\s*[:=]\s*/gi;

const lineEnd = (text: string, start: number): number => {
  const lf = text.indexOf("\n", start);
  const cr = text.indexOf("\r", start);
  if (lf === -1) return cr === -1 ? text.length : cr;
  return cr === -1 ? lf : Math.min(lf, cr);
};

/**
 * Returns the end of one assignment value. Quoted values consume their
 * matching quote, respecting a backslash escape. An unclosed quote masks the
 * remainder of its physical line. A trailing backslash explicitly continues a
 * quoted value across LF or CRLF; the scan is linear and bounded by input size.
 */
const assignmentEnd = (text: string, start: number): number => {
  const first = text[start];
  if (first === "\"" || first === "'") {
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index]!;
      if (char === "\\") {
        if (text[index + 1] === "\r" && text[index + 2] === "\n") index += 2;
        else index += 1;
        continue;
      }
      if (char === first) return index + 1;
      if (char === "\r" || char === "\n") return index;
    }
    return text.length;
  }
  let end = start;
  while (end < text.length && !/[\s,;#]/.test(text[end]!)) end += 1;
  return end;
};

const isSurrogateSplit = (text: string, boundary: number): boolean =>
  boundary > 0 &&
  boundary < text.length &&
  text.charCodeAt(boundary - 1) >= 0xd800 &&
  text.charCodeAt(boundary - 1) <= 0xdbff &&
  text.charCodeAt(boundary) >= 0xdc00 &&
  text.charCodeAt(boundary) <= 0xdfff;

/** Detects bounded known shapes plus conservative token-like entropy candidates. */
export function detectRedactions(rawText: unknown, rawPolicy: unknown = DEFAULT_REDACTION_POLICY): RedactionParseResult<readonly RedactionFinding[]> {
  let policy: RedactionPolicy;
  try { const parsed = RedactionPolicySchema.safeParse(rawPolicy); if (!parsed.success) return fail("MALFORMED_INPUT", "The redaction input is invalid."); policy = parsed.data; } catch { return fail("MALFORMED_INPUT", "The redaction input is invalid."); }
  if (typeof rawText !== "string") return fail("MALFORMED_INPUT", "The redaction input is invalid.");
  if (rawText.length > policy.maxInputChars) return fail("INPUT_TOO_LARGE", "The redaction input exceeds the configured limit.");
  const findings: RedactionFinding[] = [];
  // All expressions are fixed, bounded by input length, and have no nested quantifiers.
  const patterns: readonly [RegExp, RedactionCategory, RedactionConfidence][] = [
    [/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]{0,16384}?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, "private-key", "high"],
    [/(?:authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]{8,}/gi, "authorization", "high"],
    [/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^\s@/]+@[^\s/]+/g, "connection-credential", "high"],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "jwt", "medium"],
  ];
  for (const [re, category, confidence] of patterns) { re.lastIndex = 0; let match: RegExpExecArray | null; while ((match = re.exec(rawText)) !== null) { if (!add(findings, match.index, match.index + match[0].length, category, "pattern", confidence, policy.maxFindings)) return fail("TOO_MANY_FINDINGS", "The redaction finding limit was reached."); } }
  ASSIGNMENT_HEAD_RE.lastIndex = 0;
  let assignment: RegExpExecArray | null;
  while ((assignment = ASSIGNMENT_HEAD_RE.exec(rawText)) !== null) {
    const end = assignmentEnd(rawText, ASSIGNMENT_HEAD_RE.lastIndex);
    if (end > assignment.index && !add(findings, assignment.index, end, "token-assignment", "pattern", "medium", policy.maxFindings)) return fail("TOO_MANY_FINDINGS", "The redaction finding limit was reached.");
    ASSIGNMENT_HEAD_RE.lastIndex = Math.max(ASSIGNMENT_HEAD_RE.lastIndex, end);
  }
  if (policy.entropy.enabled) { const candidates = /[A-Za-z0-9_+\/-]{24,256}/g; let match: RegExpExecArray | null; while ((match = candidates.exec(rawText)) !== null) { if (isEntropyCandidate(match[0], policy) && !add(findings, match.index, match.index + match[0].length, "entropy-candidate", "entropy", "candidate", policy.maxFindings)) return fail("TOO_MANY_FINDINGS", "The redaction finding limit was reached."); } }
  return Object.freeze({ ok: true, value: Object.freeze(findings) });
}

export const RedactionResultSchema = z.strictObject({ text: z.string().max(REDACTION_LIMITS.maxInputChars + REDACTION_LIMITS.maxFindings * 40), count: z.number().int().min(0).max(REDACTION_LIMITS.maxFindings), categories: z.array(RedactionCategorySchema).max(REDACTION_LIMITS.maxFindings) });
export type RedactionResult = z.infer<typeof RedactionResultSchema>;
const placeholder = (category: RedactionCategory): string => `[REDACTED:${category}]`;

/** Replaces validated ranges; overlapping and adjacent spans are merged. */
export function redactText(rawText: unknown, rawFindings: unknown, rawPolicy: unknown = DEFAULT_REDACTION_POLICY): RedactionParseResult<RedactionResult> {
  if (typeof rawText !== "string") return fail("MALFORMED_INPUT", "The redaction input is invalid.");
  let policy: RedactionPolicy; let parsedFindings: RedactionFinding[];
  try { const parsedPolicy = RedactionPolicySchema.safeParse(rawPolicy); if (!parsedPolicy.success) return fail("MALFORMED_INPUT", "The redaction input is invalid."); policy = parsedPolicy.data; const parsed = z.array(RedactionFindingSchema).max(policy.maxFindings).safeParse(rawFindings); if (!parsed.success) return fail("INVALID_OFFSETS", "The redaction findings are invalid."); parsedFindings = parsed.data; } catch { return fail("MALFORMED_INPUT", "The redaction input is invalid."); }
  if (rawText.length > policy.maxInputChars) return fail("INPUT_TOO_LARGE", "The redaction input exceeds the configured limit.");
  if (parsedFindings.some((item) => item.end > rawText.length || isSurrogateSplit(rawText, item.start) || isSurrogateSplit(rawText, item.end))) return fail("INVALID_OFFSETS", "The redaction findings are invalid.");
  const sorted = [...parsedFindings].sort((a, b) => a.start - b.start || b.end - a.end || a.category.localeCompare(b.category));
  const spans: Array<{ start: number; end: number; categories: RedactionCategory[] }> = [];
  for (const item of sorted) { const previous = spans.at(-1); if (previous && item.start <= previous.end) { previous.end = Math.max(previous.end, item.end); if (!previous.categories.includes(item.category)) previous.categories.push(item.category); } else spans.push({ start: item.start, end: item.end, categories: [item.category] }); }
  let cursor = 0; let text = ""; const categories: RedactionCategory[] = [];
  for (const span of spans) { text += rawText.slice(cursor, span.start); const category = [...span.categories].sort()[0]!; text += placeholder(category); categories.push(...span.categories); cursor = span.end; }
  text += rawText.slice(cursor);
  return Object.freeze({ ok: true, value: Object.freeze({ text, count: spans.length, categories: [...new Set(categories)].sort() }) });
}
