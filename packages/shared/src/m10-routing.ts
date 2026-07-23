import { createHash } from "node:crypto";

export const M10_ROUTING_VERSION = "m10.routing/v1" as const;
export type M10RiskClass = "low" | "medium" | "high" | "owner-only";
export type M10QuotaState = "available" | "constrained" | "exhausted" | "unknown" | "stale" | "unavailable";
export type M10Confidence = "high" | "medium" | "low" | "unknown";
export type M10CostClass = "estimated-low" | "estimated-medium" | "estimated-high" | "estimated-unknown";

export type M10RiskInput = Readonly<{
  action: string;
  readOnly: boolean;
  repositoryMutation: boolean;
  applyOrPromotion?: boolean;
  credentials?: boolean;
  productionOrDeployment?: boolean;
  databaseAdministration?: boolean;
  externalSystems?: boolean;
  destructiveGit?: boolean;
  historyRewrite?: boolean;
  serviceRestart?: boolean;
  remoteAccess?: boolean;
  irreversible?: boolean;
  unknownScope?: boolean;
  insufficientEvidence?: boolean;
}>;

export type M10RiskResult = Readonly<{ riskClass: M10RiskClass; reasons: readonly string[]; policyRules: readonly string[]; structurallyRefused: boolean }>;

const OWNER_ONLY: ReadonlyArray<readonly [keyof M10RiskInput, string, string]> = [
  ["credentials", "credential access or repair is owner-only", "M10-RISK-OWNER-CREDENTIALS"],
  ["productionOrDeployment", "production or deployment control is outside M10", "M10-RISK-OWNER-PRODUCTION"],
  ["databaseAdministration", "database administration is outside M10", "M10-RISK-OWNER-DATABASE"],
  ["externalSystems", "router, DNS, billing, or external-system control is outside M10", "M10-RISK-OWNER-EXTERNAL"],
  ["destructiveGit", "destructive Git is structurally refused", "M10-RISK-OWNER-DESTRUCTIVE-GIT"],
  ["historyRewrite", "history rewrite is structurally refused", "M10-RISK-OWNER-HISTORY"],
  ["remoteAccess", "remote access is outside M10", "M10-RISK-OWNER-REMOTE"],
];

export function classifyM10Risk(input: M10RiskInput): M10RiskResult {
  const ownerOnly = OWNER_ONLY.filter(([field]) => input[field] === true);
  if (ownerOnly.length > 0) return Object.freeze({ riskClass: "owner-only", reasons: ownerOnly.map(([, reason]) => reason), policyRules: ownerOnly.map(([, , rule]) => rule), structurallyRefused: true });
  const highCandidates: Array<readonly [boolean, string, string]> = [
    [input.applyOrPromotion === true, "apply or promotion changes an authoritative repository ref", "M10-RISK-HIGH-APPLY"],
    [input.serviceRestart === true, "service restart can interrupt active work", "M10-RISK-HIGH-RESTART"],
    [input.irreversible === true, "the operation is irreversible or hard to reverse", "M10-RISK-HIGH-IRREVERSIBLE"],
    [input.unknownScope === true, "the requested scope is unknown", "M10-RISK-HIGH-UNKNOWN-SCOPE"],
    [input.insufficientEvidence === true, "authoritative evidence is insufficient", "M10-RISK-HIGH-EVIDENCE"],
  ];
  const high = highCandidates.filter(([matched]) => matched);
  if (high.length > 0) return Object.freeze({ riskClass: "high", reasons: high.map(([, reason]) => reason), policyRules: high.map(([, , rule]) => rule), structurallyRefused: false });
  if (input.repositoryMutation || !input.readOnly) return Object.freeze({ riskClass: "medium", reasons: ["bounded repository write is requested"], policyRules: ["M10-RISK-MEDIUM-BOUNDED-WRITE"], structurallyRefused: false });
  return Object.freeze({ riskClass: "low", reasons: ["bounded read-only work with no repository mutation"], policyRules: ["M10-RISK-LOW-READ-ONLY"], structurallyRefused: false });
}

export type M10QuotaObservation = Readonly<{
  observationId: string;
  workerId: string;
  adapterId: string;
  state: Exclude<M10QuotaState, "stale">;
  confidence: M10Confidence;
  source: "provider-reported" | "adapter-observed" | "inferred" | "owner-attested" | "unknown";
  observedAt: string;
  expiresAt: string | null;
  resetAt: string | null;
  remaining: number | null;
  limitation: string | null;
}>;

export function classifyM10Quota(observation: M10QuotaObservation | null, now: string): Readonly<{ state: M10QuotaState; confidence: M10Confidence; fresh: boolean; warning: string | null }> {
  if (observation === null) return Object.freeze({ state: "unknown", confidence: "unknown", fresh: false, warning: "No authoritative quota observation is available; unknown is not unlimited." });
  if (!Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(observation.observedAt))) return Object.freeze({ state: "unknown", confidence: "unknown", fresh: false, warning: "Quota timestamps are invalid." });
  if (observation.expiresAt === null || !Number.isFinite(Date.parse(observation.expiresAt)) || Date.parse(now) >= Date.parse(observation.expiresAt)) return Object.freeze({ state: "stale", confidence: observation.confidence, fresh: false, warning: "The quota observation is stale and cannot establish current availability." });
  if (observation.source === "unknown" || observation.state === "unknown") return Object.freeze({ state: "unknown", confidence: "unknown", fresh: true, warning: "Quota is explicitly unknown; lack of telemetry is not availability." });
  return Object.freeze({ state: observation.state, confidence: observation.confidence, fresh: true, warning: observation.source === "owner-attested" ? "Quota is owner-attested, not provider-validated." : observation.limitation });
}

export type M10CandidateInput = Readonly<{
  workerId: string;
  adapterId: string;
  connectorTier: "cli" | "manual-relay";
  mandatoryCapabilities: readonly string[];
  availableCapabilities: Readonly<Record<string, "satisfied" | "unavailable" | "unknown">>;
  readiness: "ready" | "degraded" | "manual-only" | "blocked" | "unknown";
  authentication: "authenticated" | "not-required" | "expired" | "missing" | "unknown";
  sandboxAssurance: string;
  workerEnabled: boolean;
  targetMatchesAttempt: boolean;
  quota: ReturnType<typeof classifyM10Quota>;
  costClass: M10CostClass;
  reliability: "high" | "medium" | "low" | "unknown";
  ownerPreference: number;
  manualRelayAllowed: boolean;
  preferLowerCost?: boolean;
}>;

export type M10CandidateEvaluation = Readonly<{
  workerId: string;
  adapterId: string;
  connectorTier: "cli" | "manual-relay";
  eligible: boolean;
  capabilityMatch: Readonly<Record<string, boolean>>;
  rejectionReasons: readonly string[];
  limitations: readonly string[];
  score: number;
  scoreComponents: Readonly<Record<string, number>>;
  quota: M10CandidateInput["quota"];
  readiness: M10CandidateInput["readiness"];
  sandboxAssurance: string;
  costClass: M10CostClass;
}>;

const COST_SCORE: Readonly<Record<M10CostClass, number>> = { "estimated-low": 30, "estimated-medium": 20, "estimated-high": 10, "estimated-unknown": 0 };
const CONFIDENCE_SCORE: Readonly<Record<M10Confidence, number>> = { high: 20, medium: 12, low: 5, unknown: 0 };
const RELIABILITY_SCORE: Readonly<Record<M10CandidateInput["reliability"], number>> = { high: 20, medium: 12, low: 5, unknown: 0 };

export function evaluateM10Candidate(input: M10CandidateInput): M10CandidateEvaluation {
  const rejections: string[] = [];
  const limitations: string[] = [];
  const capabilityMatch = Object.fromEntries(input.mandatoryCapabilities.map((capability) => [capability, input.availableCapabilities[capability] === "satisfied"]));
  for (const capability of input.mandatoryCapabilities) {
    const status = input.availableCapabilities[capability] ?? "unknown";
    if (status !== "satisfied") rejections.push(`${capability}:${status === "unknown" ? "unknown-fails-closed" : "unavailable"}`);
  }
  if (!input.workerEnabled) rejections.push("worker-disabled-or-frozen");
  if (!input.targetMatchesAttempt) rejections.push("immutable-attempt-target-mismatch");
  if (input.connectorTier === "cli" && !["ready", "degraded"].includes(input.readiness)) rejections.push("adapter-not-ready");
  if (input.connectorTier === "cli" && !["authenticated", "not-required"].includes(input.authentication)) rejections.push("authentication-not-current");
  if (["exhausted", "unavailable"].includes(input.quota.state)) rejections.push(`quota-${input.quota.state}`);
  if (input.connectorTier === "manual-relay") {
    if (!input.manualRelayAllowed) rejections.push("manual-relay-disallowed-by-owner-policy");
    limitations.push("weaker owner-attested provenance", "not automated execution", "no automated cancellation or resume");
  }
  if (input.readiness === "degraded") limitations.push(`degraded readiness: ${input.sandboxAssurance}`);
  if (["unknown", "stale"].includes(input.quota.state)) limitations.push(input.quota.warning ?? "quota availability is not established");
  const safety = rejections.length === 0 ? 1_000 : 0;
  const readiness = input.readiness === "ready" ? 100 : input.readiness === "degraded" ? 55 : input.readiness === "manual-only" ? 35 : 0;
  const ownerPolicy = Math.max(0, Math.min(20, input.ownerPreference));
  const cost = input.preferLowerCost === false ? 0 : COST_SCORE[input.costClass];
  const quotaConfidence = CONFIDENCE_SCORE[input.quota.confidence];
  const reliability = RELIABILITY_SCORE[input.reliability];
  const fallbackRisk = input.connectorTier === "manual-relay" ? 0 : 10;
  const scoreComponents = Object.freeze({ safety, readiness, ownerPolicy, cost, quotaConfidence, reliability, fallbackRisk });
  return Object.freeze({ workerId: input.workerId, adapterId: input.adapterId, connectorTier: input.connectorTier, eligible: rejections.length === 0, capabilityMatch: Object.freeze(capabilityMatch), rejectionReasons: Object.freeze(rejections), limitations: Object.freeze(limitations), score: Object.values(scoreComponents).reduce((sum, value) => sum + value, 0), scoreComponents, quota: input.quota, readiness: input.readiness, sandboxAssurance: input.sandboxAssurance, costClass: input.costClass });
}

export function rankM10Candidates(values: readonly M10CandidateEvaluation[]): readonly M10CandidateEvaluation[] {
  return Object.freeze([...values].sort((left, right) => Number(right.eligible) - Number(left.eligible) || right.score - left.score || left.workerId.localeCompare(right.workerId) || left.adapterId.localeCompare(right.adapterId)));
}

const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
export const digestM10RoutingInput = (value: unknown): `sha256:${string}` => `sha256:${createHash("sha256").update(`chubz.m10.routing-input/v1\n${canonical(value)}`, "utf8").digest("hex")}`;
export const digestM10Recommendation = (value: unknown): `sha256:${string}` => `sha256:${createHash("sha256").update(`chubz.m10.recommendation/v1\n${canonical(value)}`, "utf8").digest("hex")}`;
