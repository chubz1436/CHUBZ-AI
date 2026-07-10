import { describe, expect, it } from "vitest";
import { PRIMARY_COMMANDS, parseOwnerInput, type CommandName } from "../src/index.js";

describe("command vocabulary", () => {
  it("defines exactly the twelve primary commands", () => {
    expect([...PRIMARY_COMMANDS]).toEqual([
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
    ]);
    expect(PRIMARY_COMMANDS).toHaveLength(12);
    expect(Object.isFrozen(PRIMARY_COMMANDS)).toBe(true);
  });

  it("parses every command given alone", () => {
    for (const name of PRIMARY_COMMANDS) {
      const parsed = parseOwnerInput(`/${name}`);
      expect(parsed).toEqual({ kind: "command", command: name, argumentText: "" });
    }
  });
});

describe("case normalization", () => {
  it("matches case-insensitively and normalizes to lowercase", () => {
    for (const raw of ["/CODEX", "/Codex", "/cOdEx"]) {
      const parsed = parseOwnerInput(`${raw} fix the login timeout`);
      expect(parsed).toEqual({
        kind: "command",
        command: "codex" satisfies CommandName,
        argumentText: "fix the login timeout",
      });
    }
    expect(parseOwnerInput("/GO")).toEqual({ kind: "command", command: "go", argumentText: "" });
  });
});

describe("whitespace behavior", () => {
  it("trims leading and trailing whitespace deterministically", () => {
    expect(parseOwnerInput("   /status   ")).toEqual({
      kind: "command",
      command: "status",
      argumentText: "",
    });
  });

  it("collapses nothing inside argument text but trims its edges", () => {
    const parsed = parseOwnerInput("/codex   fix   the    spacing   ");
    expect(parsed).toEqual({
      kind: "command",
      command: "codex",
      argumentText: "fix   the    spacing",
    });
  });

  it("handles tabs and newlines as whitespace separators", () => {
    expect(parseOwnerInput("/review\tlast task")).toEqual({
      kind: "command",
      command: "review",
      argumentText: "last task",
    });
    expect(parseOwnerInput("\n/diff\n")).toEqual({
      kind: "command",
      command: "diff",
      argumentText: "",
    });
  });
});

describe("command with request text", () => {
  it("separates the command from the owner-supplied text", () => {
    const parsed = parseOwnerInput("/claude review the bridge grant verifier");
    expect(parsed).toEqual({
      kind: "command",
      command: "claude",
      argumentText: "review the bridge grant verifier",
    });
  });

  it("keeps slashes inside argument text intact", () => {
    const parsed = parseOwnerInput("/compare codex/claude on task 42");
    expect(parsed).toEqual({
      kind: "command",
      command: "compare",
      argumentText: "codex/claude on task 42",
    });
  });
});

describe("natural-language input", () => {
  it("treats text without a leading slash as an owner request", () => {
    expect(parseOwnerInput("please fix the login timeout in project X")).toEqual({
      kind: "natural-language",
      text: "please fix the login timeout in project X",
    });
  });

  it("a slash later in the text does not make it a command", () => {
    expect(parseOwnerInput("rename docs/old.md please")).toEqual({
      kind: "natural-language",
      text: "rename docs/old.md please",
    });
  });
});

describe("rejections", () => {
  it("rejects unknown slash commands instead of treating them as text", () => {
    const parsed = parseOwnerInput("/deploy production now");
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") expect(parsed.code).toBe("UNKNOWN_COMMAND");
  });

  it("rejects near-miss command tokens", () => {
    for (const raw of ["/go!", "/codexx", "/ go"]) {
      const parsed = parseOwnerInput(raw);
      expect(parsed.kind).toBe("invalid");
    }
  });

  it("rejects empty input and a bare slash", () => {
    const empty = parseOwnerInput("   ");
    expect(empty).toEqual({ kind: "invalid", code: "EMPTY_INPUT", message: "Input is empty." });
    const bare = parseOwnerInput("/");
    expect(bare.kind).toBe("invalid");
    if (bare.kind === "invalid") expect(bare.code).toBe("EMPTY_COMMAND");
  });

  it("rejects non-string input at the boundary", () => {
    expect(() => parseOwnerInput(undefined as never)).toThrow();
    expect(() => parseOwnerInput(42 as never)).toThrow();
  });
});

describe("/go stays a bounded approval intent", () => {
  it("parses bare /go as approval intent with no payload", () => {
    expect(parseOwnerInput("/go")).toEqual({ kind: "command", command: "go", argumentText: "" });
    expect(parseOwnerInput("  /GO  ")).toEqual({ kind: "command", command: "go", argumentText: "" });
  });

  it("refuses /go with any argument text — approval cannot carry authority", () => {
    for (const raw of ["/go deploy", "/go all", "/go and also restart the server", "/go 42"]) {
      const parsed = parseOwnerInput(raw);
      expect(parsed.kind).toBe("invalid");
      if (parsed.kind === "invalid") expect(parsed.code).toBe("GO_TAKES_NO_ARGUMENTS");
    }
  });

  it("carries no authority fields in the parsed shape", () => {
    const parsed = parseOwnerInput("/go");
    expect(Object.keys(parsed).sort()).toEqual(["argumentText", "command", "kind"]);
  });
});
