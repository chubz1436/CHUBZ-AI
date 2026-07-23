# M10 Routing, Quota, and Safe Fallback

## Status

M1A-M9 are accepted on `main` at `df62ae84164ba8abffbaf9447d85f55de2332222`. M10 is implemented as a local candidate on `task/m10-routing-quota-fallback` and is **active but unaccepted** pending independent read-only review and separate owner acceptance. M11 and later remain excluded.

## Authority boundary

The Control Plane is authoritative. M10 recommendations are evidence-bound advice, not capability grants and not dispatch commands. A recommendation cannot start a worker, consume a grant, create a queue entry, bypass an M4 approval, bypass a lease or write scope, weaken adapter readiness, bypass an emergency stop, skip journaling or reconciliation, apply an M7 package, or cross an M9 apply gate.

The flow is deliberately split:

1. Project authoritative routing input without storing the full task prompt.
2. Classify risk with deterministic server rules.
3. Evaluate every registered accepted candidate against mandatory capabilities.
4. Persist a ranked immutable recommendation and safe fallback plan.
5. Record an exact owner route confirmation.
6. Continue through the existing, separate dispatch approval and single-use grant flow.

There is no automatic dispatch. High-risk work never receives an automatic path. Structurally refused work remains refused regardless of adapter capability, readiness, or quota.

## Routing input and digest

The M10 input projection binds owner, project, task, immutable attempt, operation, task version and state, action digest, requested action identifier, assignment digest, write-scope identity and permissions, deterministic risk result, policy version/digest, emergency-stop digest, readiness snapshot identities/digests, quota-observation digest, and bounded metadata flags. Full instructions and sensitive prompt text are excluded from routing input, events, Bridge Log entries, and recommendation records.

`digestM10RoutingInput` canonicalizes that projection under a versioned hash domain. Confirmation reprojects current state and fails closed if the digest, task version, route identity, readiness, quota freshness, or emergency-stop state is no longer valid.

## Deterministic risk classification

- `low`: bounded read-only work with no repository mutation.
- `medium`: bounded repository mutation.
- `high`: apply/promotion, restart, irreversible work, unknown scope, or insufficient authoritative evidence.
- `owner-only`: credential, production/deployment, database administration, router/DNS/billing/external-system control, destructive Git, history rewrite, or remote access.

Each classification persists exact reasons and policy-rule identifiers. `owner-only` is structurally refused. Client-supplied risk and worker marketing text are not authoritative.

## Capability and readiness matching

Candidate evaluation is fail-closed per mandatory capability. An unknown mandatory capability is rejected. Worker enable/freeze state, immutable attempt target, adapter readiness, authentication, sandbox assurance, connector tier, quota state, reliability observations, owner policy, and estimated cost class are evaluated separately and displayed.

Only the accepted Codex CLI adapter and permanent manual relay are considered. No Claude, Antigravity, Santos, OpenRouter, or other adapter was added. The Windows Codex fallback remains honestly labeled `degraded-bounded-local` when that is the recorded evidence. Manual relay remains weaker, owner-attested, non-automated, and without automated cancellation or resume.

## Quota, rate limits, cost, and health

Quota observations are immutable persistent records with worker, adapter, state, confidence, source, observation time, expiry, reset time, remaining amount when safely known, and a bounded limitation. States are `available`, `constrained`, `exhausted`, `unknown`, `stale`, and `unavailable`; confidence is `high`, `medium`, `low`, or `unknown`.

- Missing telemetry is `unknown`, never unlimited.
- Expired observations are `stale` and cannot confirm a route.
- Owner-entered data stays `owner-attested` and cannot claim high confidence.
- Raw provider responses and credentials are not stored or returned.
- No provider UI is scraped and no new network probe is made.
- Cost classes are explicitly `estimated-*`; cost never authorizes work.

Health observations accept bounded authoritative outcomes, reject worker self-claims as health authority, expire, and retain at most 64 records per worker/adapter. They inform reliability without permanently disabling a worker after one failure.

## Deterministic scoring

Candidate order is: mandatory safety/capability checks, readiness, bounded owner preference, estimated lower-cost suitability, quota confidence, recent bounded reliability, lower fallback risk, then stable worker/adapter identity. Every candidate persists eligibility, capability match, rejection reasons, limitations, score, and score components. Natural-language rationale only summarizes the deterministic result.

## Confirmation and dispatch

Owner confirmation binds owner, task, attempt, operation, project, selected worker and adapter, recommendation version, input digest, risk class, capability scope, quota digest, expected task version, emergency-stop digest, and a deterministic confirmation digest. Confirmations are immutable and idempotent.

Confirmation creates neither grant nor dispatch. The existing `/approve-dispatch` flow requires a current M10 confirmation and still performs the accepted M4 action/scope/worker binding, approval, single-use grant, readiness, lease, queue, concurrency, journal, and emergency-stop checks.

That new confirmation gate applies to automated Codex dispatch. The already-accepted manual-relay creation flow remains an explicit, immediate owner-attested fallback and is not represented as automated dispatch; M10 does not silently change its M1-M9 lifecycle.

## Safe fallback

Fallback is a persisted plan only. Options may describe a new immutable attempt for another eligible accepted adapter, weaker manual relay, waiting for quota reset, or owner intervention. Confirmation of a fallback plan creates no attempt and dispatches nothing; the next required action is the normal new-attempt lifecycle.

No fallback is available while execution is unknown, the original operation may still be running, cancellation is unconfirmed, or the task is running/cancelling. There is no reused grant, silent route change, retry loop, post-restart fallback, or automatic resume after emergency-stop release. High-risk fallback remains owner-controlled and never automatic.

## Persistence, API, events, and restart

Migration 10 adds owner/project policies, quota and health observations, routing requests, candidate evaluations, recommendations, confirmations, fallback plans, incidents, idempotency records, and reconciliation runs. Finalized recommendations, confirmations, and quota observations are immutable. Exact replay returns the recorded result; conflicting key reuse fails.

Restart reconciliation marks recommendations stale when task version/state no longer matches or execution is unknown. It preserves valid records, never creates another recommendation/confirmation/attempt/dispatch, and never activates fallback.

Protected same-origin APIs expose routing input/snapshot, recommendation generation/refresh, candidate evaluations, quota/health observations, confirmation, rejection, fallback inspection/confirmation, and bounded project policy changes. Existing authentication, strict Origin, CSRF, request bounds, owner scoping, expected version, idempotency, and public-error sanitization apply.

M10 emits monotonic WebSocket task events and sanitized M8 operational events. Bridge Log summaries contain identifiers and state only; prompts, credentials, tokens, and raw provider responses remain excluded.

## Dashboard

Task detail shows risk, reasons, policy rules, candidate eligibility, rejection reasons, readiness, sandbox assurance, quota state/confidence/freshness, estimated cost, score components, limitations, confirmation state, and fallback truth. Recommendation, route confirmation, and dispatch approval are distinct controls. Stale recommendations cannot be confirmed; emergency stop disables generation/confirmation; execution-unknown exposes no retry/fallback control. The adapters page shows quota source, freshness, reset, remaining value, and warning text without color-only status.

## Carryovers and exclusions

These accepted carryovers remain unresolved: M7 download verify-then-read hardening; M8 production-Bridge emergency-gate assembly; prior live-browser review of the M8 Operations UI; M9 physical OS crash during exact `update-ref`; M9 true two-process promotion race; M9 full outbound-Bridge integration; and M9 exact single reviewed-commit cherry-pick only.

M10 adds no new adapter, autonomous worker swarm, default auto-dispatch, auto-fallback execution, provider UI automation, billing integration, external-system mutation, production deployment, push, automatic apply/promotion, rollback execution, inbound Bridge listener, notification system, packaging, remote access, or M11 functionality.
