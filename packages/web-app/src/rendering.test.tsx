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

describe("M10 routing and quota surface", () => {
  it("separates recommendation from dispatch and presents risk, quota, cost, limitations, and fallback truthfully", () => {
    const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8"); const api = readFileSync(new URL("./api.ts", import.meta.url), "utf8"); const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(app).toContain("Routing and quota recommendation"); expect(app).toContain("Recommendation is separate from dispatch"); expect(app).toContain("Confirm selected route"); expect(app).toContain("A separate dispatch approval and grant are still required"); expect(app).toContain("Unknown is not available"); expect(app).toContain("estimated only — never authorization"); expect(app).toContain("Weaker manual provenance"); expect(app).toContain("Execution is unknown. No fallback or retry control is available");
    expect(app).toContain("Rejection reasons"); expect(app).toContain("Score components"); expect(app).toContain("Sandbox assurance"); expect(app).toContain("Stale recommendation — confirmation unavailable"); expect(app).toContain("snapshot.operations.emergency.active"); expect(app).toContain("Safe fallback plan"); expect(app).toContain("Confirm plan only"); expect(app).toContain("No attempt, grant, dispatch, retry, or external execution will be created");
    expect(api).toContain("/routing/recommendations"); expect(api).toContain("/routing/fallback/"); expect(api).toContain('"generate" | "confirm" | "reject"'); expect(app).not.toContain("Automatic dispatch toggle"); expect(styles).toContain(".routing-candidates"); expect(styles).toContain("@media (max-width: 720px)");
  });
});

describe("M11 operational and release-readiness surface", () => {
  it("renders confidence, critical labels, alert semantics, diagnostics, and safe local release limits accessibly", () => {
    const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8"); const api = readFileSync(new URL("./api.ts", import.meta.url), "utf8"); const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(app).toContain("AUTHORITATIVE OPERATIONAL OVERVIEW"); expect(app).toContain("Every card states the evidence confidence"); expect(app).toContain("Unknown and stale are never promoted to healthy"); expect(app).toContain("Acknowledgement records owner awareness"); expect(app).toContain("Acknowledged; underlying condition is still active"); expect(app).toContain("Safe operator action"); expect(app).toContain("Generate diagnostics"); expect(app).toContain("Generate support bundle"); expect(app).toContain("Verify release package"); expect(app).toContain("Preview retention only"); expect(app).toContain("No installation or deployment"); expect(app).toContain("Upgrade readiness is evidence, not authority");
    expect(api).toContain("/v1/ui/alerts/"); expect(api).toContain("/v1/ui/runtime-packages/verify"); expect(api).toContain("/v1/ui/support-bundles/"); expect(api).toContain("retention-preview-${crypto.randomUUID()}"); expect(app).toContain("disabled={pending}"); expect(styles).toContain(".severity-critical"); expect(styles).toContain(":focus-visible"); expect(styles).toContain("@media (max-width: 720px)");
    expect(app).not.toContain("Deploy now"); expect(app).not.toContain("Automatic upgrade"); expect(app).not.toContain("Open terminal"); expect(app).not.toContain("Database editor");
  });
});
