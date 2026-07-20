import { describe, expect, it } from "vitest";
import {
  DEFAULT_REDACTION_POLICY, REDACTION_LIMITS, classifySensitivePath,
  detectRedactions, redactText,
} from "../src/index.js";

describe("M1D path denylist", () => {
  it.each([
    [".env", "exclude"], ["config/.env.production", "exclude"], ["C:\\repo\\.ENV.local  ", "exclude"],
    ["//server/share/.env.test", "exclude"], ["keys/id_rsa", "exclude"], ["certs/server.pem", "exclude"],
    ["C:/Users/x/.aws/credentials", "exclude"], ["a/../.ssh/id_ed25519", "exclude"], [".npmrc", "exclude"],
    ["token/config.json", "redact"], ["src/index.ts", "safe"], ["docs/guide.md", "safe"],
  ])("classifies %s", (path, disposition) => expect(classifySensitivePath(path).disposition).toBe(disposition));

  it("fails closed for malformed and confusable path values without filesystem access", () => {
    expect(classifySensitivePath(".еnv").disposition).toBe("exclude");
    expect(classifySensitivePath("safe\u0000.txt").disposition).toBe("redact");
    expect(classifySensitivePath({ toString: () => { throw new Error("no"); } }).disposition).toBe("redact");
  });
});

describe("M1D detectors and redaction", () => {
  const corpus = [
    "Authorization: Bearer synthetic-token-987654321",
    "api_key=synthetic-value-987654321",
    "postgres://user:synthetic-password@example.test/db",
    "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.synthetic-signature",
    "-----BEGIN PRIVATE KEY-----\nFAKE-NOT-A-KEY\n-----END PRIVATE KEY-----",
  ];
  it.each(corpus)("detects an approved synthetic shape", (text) => {
    const result = detectRedactions(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.length).toBeGreaterThan(0);
  });

  it.each([
    "ordinary prose with sourceCodeIdentifier and test names",
    "550e8400-e29b-41d4-a716-446655440000",
    "facf2f090274e74e0b60edcdce68e64ee34fb102",
    "a3".repeat(32), "2026-07-20T12:34:56Z", "version 1.2.3", "https://example.test/safe",
  ])("does not entropy-flag safe corpus: %s", (text) => {
    const result = detectRedactions(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.filter((item) => item.source === "entropy")).toHaveLength(0);
  });

  it("redacts all detected spans without returning source values", () => {
    const input = "x api_key=synthetic-value-987654321 y api_key=synthetic-value-987654321";
    const found = detectRedactions(input);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const result = redactText(input, found.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).not.toContain("synthetic-value-987654321");
    expect(JSON.stringify(result.value)).not.toContain("synthetic-value-987654321");
    expect(input).toContain("synthetic-value-987654321");
    const again = redactText(result.value.text, []);
    expect(again).toEqual({ ok: true, value: { text: result.value.text, count: 0, categories: [] } });
  });

  it("fully redacts quoted assignments, escapes, adjacent values, and preserves comments", () => {
    const fixtures = [
      "password=\"synthetic value, punctuation; # remains secret\"",
      "secret='synthetic value, punctuation; # remains secret'",
      "password=\"synthetic escaped \\\"quote\\\" value\"",
      "password=synthetic-unquoted-value # harmless comment",
      "password=synthetic-first-value api_key=\"synthetic second value\"",
    ];
    for (const input of fixtures) {
      const detected = detectRedactions(input);
      expect(detected.ok).toBe(true);
      if (!detected.ok) continue;
      const redacted = redactText(input, detected.value);
      expect(redacted.ok).toBe(true);
      if (!redacted.ok) continue;
      expect(redacted.value.text).not.toContain("synthetic");
      expect(JSON.stringify(redacted.value)).not.toContain("synthetic");
    }
    const withComment = "password=synthetic-unquoted-value # harmless comment";
    const detected = detectRedactions(withComment);
    if (detected.ok) expect(redactText(withComment, detected.value)).toMatchObject({ ok: true, value: { text: "[REDACTED:token-assignment] # harmless comment" } });
    expect(detectRedactions("A password should remain ordinary prose.")).toEqual({ ok: true, value: [] });
  });

  it("fails closed to the physical line boundary for unclosed quoted assignments", () => {
    for (const input of [
      "password=\"synthetic unclosed value\nnext=safe",
      "secret='synthetic unclosed value\r\nnext=safe",
    ]) {
      const detected = detectRedactions(input);
      expect(detected.ok).toBe(true);
      if (!detected.ok) continue;
      const redacted = redactText(input, detected.value);
      expect(redacted).toMatchObject({ ok: true, value: { text: `[REDACTED:token-assignment]${input.includes("\r\n") ? "\r\n" : "\n"}next=safe` } });
      expect(JSON.stringify(redacted)).not.toContain("synthetic unclosed value");
    }
  });

  it("preserves CRLF and LF boundaries after quoted assignment redaction", () => {
    for (const input of [
      "password=\"synthetic CRLF value\"\r\nnext=safe",
      "password='synthetic LF value'\nnext=safe",
    ]) {
      const detected = detectRedactions(input);
      expect(detected.ok).toBe(true);
      if (!detected.ok) continue;
      const redacted = redactText(input, detected.value);
      expect(redacted.ok).toBe(true);
      if (redacted.ok) expect(redacted.value.text).toBe(`[REDACTED:token-assignment]${input.includes("\r\n") ? "\r\n" : "\n"}next=safe`);
    }
  });

  it("safely consumes explicit backslash-continued quoted values", () => {
    for (const input of [
      "password=\"synthetic continued \\\n+value\"\nnext=safe",
      "secret='synthetic continued \\\r\nvalue'\r\nnext=safe",
    ]) {
      const detected = detectRedactions(input);
      expect(detected.ok).toBe(true);
      if (!detected.ok) continue;
      const redacted = redactText(input, detected.value);
      expect(redacted.ok).toBe(true);
      if (redacted.ok) {
        expect(redacted.value.text).not.toContain("synthetic continued");
        expect(redacted.value.text).not.toContain("value'");
        expect(redacted.value.text).not.toContain("value\"");
      }
    }
  });

  it("merges overlapping and adjacent spans deterministically", () => {
    const result = redactText("abcdef\r\ngh", [
      { start: 1, end: 4, category: "jwt", source: "pattern", confidence: "medium" },
      { start: 3, end: 6, category: "authorization", source: "pattern", confidence: "high" },
      { start: 6, end: 8, category: "entropy-candidate", source: "entropy", confidence: "candidate" },
    ]);
    expect(result).toEqual({ ok: true, value: { text: "a[REDACTED:authorization]gh", count: 1, categories: ["authorization", "entropy-candidate", "jwt"] } });
  });

  it("rejects surrogate-splitting offsets while accepting complete code points", () => {
    const splitStart = redactText("A😀B", [{ start: 2, end: 3, category: "jwt", source: "pattern", confidence: "high" }]);
    const splitEnd = redactText("A😀B", [{ start: 1, end: 2, category: "jwt", source: "pattern", confidence: "high" }]);
    expect(splitStart).toEqual({ ok: false, error: { code: "INVALID_OFFSETS", message: "The redaction findings are invalid." } });
    expect(splitEnd).toEqual({ ok: false, error: { code: "INVALID_OFFSETS", message: "The redaction findings are invalid." } });
    const complete = redactText("A😀B😀C", [{ start: 1, end: 3, category: "jwt", source: "pattern", confidence: "high" }]);
    expect(complete).toEqual({ ok: true, value: { text: "A[REDACTED:jwt]B😀C", count: 1, categories: ["jwt"] } });
    const detected = detectRedactions("😀 password=\"synthetic Unicode value\" 😀");
    expect(detected.ok).toBe(true);
    if (detected.ok) {
      const redacted = redactText("😀 password=\"synthetic Unicode value\" 😀", detected.value);
      expect(redacted.ok).toBe(true);
      if (redacted.ok) expect(redacted.value.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it("has conservative, deterministic entropy boundaries", () => {
    const token = "Ab3dEf6gHi9jKl2mNo5pQr8sTu1vWx4y";
    const policy = { ...DEFAULT_REDACTION_POLICY, entropy: { ...DEFAULT_REDACTION_POLICY.entropy, minLength: 32, maxLength: 32, minBitsPerCharacter: 4 } };
    const once = detectRedactions(token, policy); const twice = detectRedactions(token, policy);
    expect(once).toEqual(twice);
    expect(once.ok && once.value.some((item) => item.source === "entropy")).toBe(true);
    expect(detectRedactions(token.slice(0, 31), policy)).toEqual({ ok: true, value: [] });
  });

  it("fails closed on limits, invalid offsets, unknown fields, and hostile input", () => {
    expect(detectRedactions("x".repeat(REDACTION_LIMITS.maxInputChars + 1)).ok).toBe(false);
    expect(detectRedactions("Authorization: Bearer synthetic-token-987654321 Authorization: Bearer synthetic-token-987654321", { ...DEFAULT_REDACTION_POLICY, maxFindings: 1 })).toEqual({ ok: false, error: { code: "TOO_MANY_FINDINGS", message: "The redaction finding limit was reached." } });
    expect(detectRedactions("x", { ...DEFAULT_REDACTION_POLICY, extra: true }).ok).toBe(false);
    expect(redactText("safe", [{ start: 0, end: 9, category: "jwt", source: "pattern", confidence: "high" }]).ok).toBe(false);
    expect(detectRedactions(new Proxy({}, { get() { throw new Error("no"); } }))).toEqual({ ok: false, error: { code: "MALFORMED_INPUT", message: "The redaction input is invalid." } });
  });
});
