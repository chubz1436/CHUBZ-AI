import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("safe worker text rendering", () => {
  it("renders hostile worker-reported text as escaped plain text", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>steal()</script>';
    const markup = renderToStaticMarkup(<pre>{hostile}</pre>);
    expect(markup).not.toContain("<script>"); expect(markup).not.toContain("<img"); expect(markup).toContain("&lt;script&gt;");
  });
});

describe("M7 evidence surface", () => {
  it("keeps evidence read-only, explicitly non-applied, safely downloadable, accessible, and responsive", () => {
    const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8"); const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(app).toContain("Worker claims remain separate from system-observed Git and validation evidence"); expect(app).toContain("Download sanitized package"); expect(app).toContain('["Applied", false]'); expect(app).not.toContain("Apply package"); expect(app).not.toContain("Cherry-pick"); expect(app).not.toContain("Reviewer verdict");
    expect(app).toContain("Authoritative validation observations"); expect(app).toContain("Exact command"); expect(app).toContain("Execution unknown"); expect(app).toContain("Artifact quarantine"); expect(app).toContain("Reviewer conclusion");
    expect(app).toContain("Incomplete or bounded evidence"); expect(app).toContain("StatusPill"); expect(styles).toContain(".button-link:focus-visible"); expect(styles).toContain("@media (max-width: 620px)");
  });
});
