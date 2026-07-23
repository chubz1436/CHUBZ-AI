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
    expect(app).toContain("Worker claims remain separate from system-observed Git and validation evidence"); expect(app).toContain("Download sanitized package"); expect(app).toContain('["Applied", false]'); expect(app).toContain("never applied by evidence capture"); expect(app).not.toContain("Reviewer verdict");
    expect(app).toContain("Authoritative validation observations"); expect(app).toContain("Exact command"); expect(app).toContain("Execution unknown"); expect(app).toContain("Artifact quarantine"); expect(app).toContain("Reviewer conclusion");
    expect(app).toContain("Incomplete or bounded evidence"); expect(app).toContain("StatusPill"); expect(styles).toContain(".button-link:focus-visible"); expect(styles).toContain("@media (max-width: 620px)");
  });
});

describe("M8 operations surface", () => {
  it("exposes prominent truthful stop, uncertainty, projection, and recovery controls without unsafe authority", () => {
    const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8"); const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(app).toContain("Emergency stop active"); expect(app).toContain("Activate global stop"); expect(app).toContain("Activate project stop"); expect(app).toContain("Cancellation remains uncertain"); expect(app).toContain("release never auto-resumes work"); expect(app).toContain("Rebuild projection"); expect(app).toContain("Acknowledge incident"); expect(app).toContain("Non-authoritative");
    expect(app).toContain("window.confirm"); expect(app).toContain("window.prompt"); expect(app).toContain("disabled={pending}"); expect(app).not.toContain("Force success"); expect(app).not.toContain("Edit database"); expect(app).not.toContain("Retry execution-unknown");
    expect(styles).toContain(".emergency-panel.active"); expect(styles).toContain("@media (max-width: 800px)");
  });
});

describe("M9 bounded apply surface", () => {
  it("separates preparation from owner-confirmed promotion and exposes truthful failure states without unsafe controls", () => {
    const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8"); const api = readFileSync(new URL("./api.ts", import.meta.url), "utf8"); const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(app).toContain("Plan exact commit application"); expect(app).toContain("Prepare in isolation"); expect(app).toContain("Confirm atomic promotion"); expect(app).toContain("Outcome unknown — retry unavailable"); expect(app).toContain("No automatic push, deployment, conflict override, retry, reset, force update, or rollback"); expect(app).toContain("Expected old HEAD"); expect(app).toContain("Authoritative preparation validation"); expect(app).toContain("emergencyActive");
    expect(api).toContain("/v1/ui/apply/eligibility"); expect(api).toContain("/v1/ui/apply-plans"); expect(api).toContain('"prepare" | "promote" | "cancel"'); expect(app).not.toContain("Force update"); expect(app).not.toContain("Resolve conflict"); expect(app).not.toContain("Deploy now"); expect(styles).toContain(".apply-card"); expect(styles).toContain("@media (max-width: 620px)");
  });
});
