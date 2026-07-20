import { describe, expect, it } from "vitest";
import * as sharedRoot from "../src/index.js";
import { detectRedactions, redactText } from "../src/index.js";
// @ts-expect-error raw entropy helper is intentionally internal
import { entropy } from "../src/index.js";

describe("M1D public export boundary", () => {
  it("exports only safe operations", () => {
    expect(typeof detectRedactions).toBe("function");
    expect(typeof redactText).toBe("function");
    expect("entropy" in sharedRoot).toBe(false);
    void entropy;
  });
});
