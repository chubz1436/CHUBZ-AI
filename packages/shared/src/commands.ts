import { z } from "zod";

/**
 * The twelve primary commands (docs/PROJECT_OVERVIEW.md, D-002,
 * FINAL_ARCHITECTURE_DESIGN.md §9). No hidden aliases exist; any future
 * alias must be documented in the architecture first.
 */
export const PRIMARY_COMMANDS = Object.freeze([
  "codex",
  "claude",
  "antigravity",
  "santos",
  "bantay",
  "compare",
  "go",
  "stop",
  "status",
  "files",
  "diff",
  "review",
] as const);

export const CommandNameSchema = z.enum(PRIMARY_COMMANDS);
export type CommandName = z.infer<typeof CommandNameSchema>;

export const PARSE_ERROR_CODES = Object.freeze([
  "EMPTY_INPUT",
  "EMPTY_COMMAND",
  "UNKNOWN_COMMAND",
  "GO_TAKES_NO_ARGUMENTS",
  "COMPARE_REQUIRES_WORKERS",
] as const);

export type ParseErrorCode = (typeof PARSE_ERROR_CODES)[number];

export const ParsedCommandSchema = z.strictObject({
  kind: z.literal("command"),
  /** Always lowercase — matching is case-insensitive, output is normalized. */
  command: CommandNameSchema,
  /**
   * Owner-supplied text after the command token: outer whitespace
   * trimmed, interior whitespace preserved byte-for-byte. Empty string
   * when the command was given alone.
   */
  argumentText: z.string(),
});

export const ParsedNaturalLanguageSchema = z.strictObject({
  kind: z.literal("natural-language"),
  /** The owner's request with outer whitespace trimmed. */
  text: z.string().min(1),
});

export const ParsedInvalidSchema = z.strictObject({
  kind: z.literal("invalid"),
  code: z.enum(PARSE_ERROR_CODES),
  message: z.string().min(1),
});

export const ParsedInputSchema = z.discriminatedUnion("kind", [
  ParsedCommandSchema,
  ParsedNaturalLanguageSchema,
  ParsedInvalidSchema,
]);

export type ParsedCommand = z.infer<typeof ParsedCommandSchema>;
export type ParsedNaturalLanguage = z.infer<typeof ParsedNaturalLanguageSchema>;
export type ParsedInvalid = z.infer<typeof ParsedInvalidSchema>;
export type ParsedInput = z.infer<typeof ParsedInputSchema>;

const invalid = (code: ParseErrorCode, message: string): ParsedInvalid =>
  Object.freeze({ kind: "invalid", code, message });

/**
 * Pure, deterministic owner-input parser.
 *
 * Explicit normalization rules:
 *  - Outer whitespace (including tabs/newlines) is trimmed first.
 *  - A leading "/" marks a slash command; the command token runs to the
 *    first whitespace character and is matched case-insensitively, then
 *    normalized to lowercase.
 *  - Text after the first whitespace run becomes argumentText with outer
 *    whitespace trimmed and interior whitespace preserved.
 *  - Unknown slash commands are rejected — never treated as text.
 *  - Input without a leading "/" is a natural-language owner request.
 *  - "/go" parses ONLY as a bare approval intent for the single currently
 *    displayed pending action. It accepts no arguments and carries no
 *    authority payload; any argument text is a parse error.
 *
 * No execution, routing, or side effects happen here.
 */
export function parseOwnerInput(raw: string): ParsedInput {
  const trimmed = z.string().parse(raw).trim();

  if (trimmed === "") {
    return invalid("EMPTY_INPUT", "Input is empty.");
  }

  if (!trimmed.startsWith("/")) {
    return Object.freeze({ kind: "natural-language", text: trimmed });
  }

  const firstWhitespace = trimmed.search(/\s/);
  const token = firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
  const rest = firstWhitespace === -1 ? "" : trimmed.slice(firstWhitespace).trim();

  const name = token.slice(1).toLowerCase();
  if (name === "") {
    return invalid("EMPTY_COMMAND", "A slash with no command name is not a command.");
  }

  const parsedName = CommandNameSchema.safeParse(name);
  if (!parsedName.success) {
    return invalid("UNKNOWN_COMMAND", `Unknown command '/${name}'. Unknown slash commands are rejected.`);
  }

  if (parsedName.data === "go" && rest !== "") {
    return invalid(
      "GO_TAKES_NO_ARGUMENTS",
      "/go is a bare approval intent for the single displayed pending action; it accepts no arguments and grants no broader authority.",
    );
  }

  // The architecture defines "/compare <workers>": a bare /compare has
  // no meaning. Worker existence is NOT checked here — that is routing,
  // owned by later milestones; the grammar only demands selector text.
  if (parsedName.data === "compare" && rest === "") {
    return invalid(
      "COMPARE_REQUIRES_WORKERS",
      "/compare requires worker-selector text (e.g. '/compare codex claude').",
    );
  }

  return Object.freeze({ kind: "command", command: parsedName.data, argumentText: rest });
}
