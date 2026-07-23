import { describe, expect, it } from "vitest";
import { classifyM10Quota, classifyM10Risk, digestM10RoutingInput, evaluateM10Candidate, rankM10Candidates, type M10QuotaObservation } from "../src/m10-routing.js";

const at = "2026-07-23T01:00:00.000Z";
const quota = (overrides: Partial<M10QuotaObservation> = {}): M10QuotaObservation => ({ observationId: "quota-one", workerId: "codex-cli", adapterId: "codex-cli-adapter", state: "available", confidence: "high", source: "provider-reported", observedAt: at, expiresAt: "2026-07-23T01:15:00.000Z", resetAt: null, remaining: 10, limitation: null, ...overrides });

describe("M10 deterministic routing policy", () => {
  it("classifies read-only, bounded write, high-risk, and structural refusals with exact policy reasons", () => {
    expect(classifyM10Risk({ action: "review", readOnly: true, repositoryMutation: false })).toMatchObject({ riskClass: "low", structurallyRefused: false, policyRules: ["M10-RISK-LOW-READ-ONLY"] });
    expect(classifyM10Risk({ action: "edit", readOnly: false, repositoryMutation: true })).toMatchObject({ riskClass: "medium", policyRules: ["M10-RISK-MEDIUM-BOUNDED-WRITE"] });
    expect(classifyM10Risk({ action: "apply", readOnly: false, repositoryMutation: true, applyOrPromotion: true })).toMatchObject({ riskClass: "high", policyRules: ["M10-RISK-HIGH-APPLY"] });
    expect(classifyM10Risk({ action: "deploy", readOnly: false, repositoryMutation: true, productionOrDeployment: true })).toMatchObject({ riskClass: "owner-only", structurallyRefused: true, policyRules: ["M10-RISK-OWNER-PRODUCTION"] });
  });

  it("keeps missing, unknown, stale, exhausted, and owner-attested quota semantics honest", () => {
    expect(classifyM10Quota(null, at)).toMatchObject({ state: "unknown", confidence: "unknown", fresh: false });
    expect(classifyM10Quota(quota({ state: "unknown", confidence: "unknown", source: "unknown", remaining: null }), at)).toMatchObject({ state: "unknown", fresh: true });
    expect(classifyM10Quota(quota({ expiresAt: at }), at)).toMatchObject({ state: "stale", fresh: false });
    expect(classifyM10Quota(quota({ state: "exhausted", remaining: 0 }), at)).toMatchObject({ state: "exhausted", fresh: true });
    expect(classifyM10Quota(quota({ source: "owner-attested", confidence: "low" }), at).warning).toContain("owner-attested");
  });

  it("fails closed for unknown mandatory capability and ranks eligible candidates deterministically", () => {
    const base = { mandatoryCapabilities: ["review"], readiness: "ready" as const, authentication: "authenticated" as const, sandboxAssurance: "elevated", workerEnabled: true, targetMatchesAttempt: true, quota: classifyM10Quota(quota(), at), costClass: "estimated-low" as const, reliability: "high" as const, ownerPreference: 10, manualRelayAllowed: true };
    const eligible = evaluateM10Candidate({ ...base, workerId: "codex-cli", adapterId: "codex-cli-adapter", connectorTier: "cli", availableCapabilities: { review: "satisfied" } });
    const unknown = evaluateM10Candidate({ ...base, workerId: "other", adapterId: "other", connectorTier: "cli", availableCapabilities: { review: "unknown" } });
    expect(eligible).toMatchObject({ eligible: true, costClass: "estimated-low" }); expect(unknown).toMatchObject({ eligible: false, rejectionReasons: ["review:unknown-fails-closed"] });
    expect(rankM10Candidates([unknown, eligible]).map((entry) => entry.workerId)).toEqual(["codex-cli", "other"]);
    expect(rankM10Candidates([eligible, unknown])).toEqual(rankM10Candidates([unknown, eligible]));
  });

  it("produces stable digests independent of object key insertion order", () => {
    expect(digestM10RoutingInput({ b: 2, a: 1 })).toBe(digestM10RoutingInput({ a: 1, b: 2 }));
    expect(digestM10RoutingInput({ a: 1 })).not.toBe(digestM10RoutingInput({ a: 2 }));
  });
});
