# BUNSO Architecture Alignment

> **Status:** Official reconciliation record, 2026-07-20. This record is documentation-only and authorizes no implementation, merge, deployment, or production action.

## Evidence reviewed

- `main` at `2dc6a12948c4fe695a0c2f07c47917cdd7167bdc`, which descends from the recorded baseline of the same commit.
- Architecture-revision commit `75931a9` and the succeeding M1A/M1B decision, contract, and status history through `2dc6a12`.
- The accepted design, security model, implementation plan, decision register, worker-role record, Phase 0B report, and M1A/M1B history.
- BUNSO's preserved, untracked design evidence: `CHUBZ_AI_COMMAND_CENTER_OVERALL_ARCHITECTURE_DRAFT.md` and `OVERALL_ARCHITECTURE_GAP_AND_DECISION_REVIEW.md` (both dated 2026-07-12). They are not modified by this batch; this record is their official disposition.

## Disposition matrix

Each material proposal has one disposition. Existing decisions remain controlling where referenced.

| BUNSO proposal | Disposition | Governing record / destination |
| --- | --- | --- |
| Local Control Plane plus outbound-only Bridge | Accepted and active | D-006 |
| SQLite in WAL mode, operation journal, reconciliation; no Temporal for MVP | Accepted and active | D-010, D-017, D-026 |
| Managed clone, worktrees, no shared mutable worker directory | Accepted and active | D-003, D-009, D-016, D-019, D-025 |
| Manual relay as durable, honestly labelled fallback | Accepted and active | D-012, D-024 |
| SDK/CLI-first adapters; GUI/browser automation is not the normal path | Accepted and active | D-024; any browser-controlled connector remains deferred |
| Codex `codex exec` as initial automated path; deeper integrations feature-flagged until capability-proven | Accepted and active | D-013, D-024; M1F/M3 readiness proof |
| Claude Agent SDK/API-key path and Antigravity capability probe | Deferred to a named milestone | Phase 3 adapter milestones; M1F defines the common readiness contract |
| Typed task, attempt, operation, adapter-run, lifecycle-event, approval, cancellation, retry, failure, completion, and artifact records | Deferred to a named milestone | M1C, M1E, and M1F; M1A/M1B already govern their completed contract portions |
| Explicit adapter readiness states and startup probes | Deferred to a named milestone | M1F contracts, implemented in M3/Phase 3 |
| OpenTelemetry-compatible trace identity | Accepted and active | D-025; schema and emitter work are deferred to M1F/M2/M3 |
| Quota confidence, circuit breakers, authentication-expiry handling, and adapter/runtime freeze controls | Accepted and active | D-025; implementation is deferred to M1F, M3, and Phase 3 |
| Pinned, verified, canary-upgraded, rollback-capable worker runtimes | Accepted and active | D-025; implementation is deferred to M3/Phase 3 |
| Resilience/adversarial cases: duplicate dispatch, crash, stale lease, expired grant, malformed output, cancellation, resume, rate limit, partial artifacts, duplicate events, and journal reconciliation | Accepted and active | D-026; contract tests in M1F and runtime tests in M2/M3/Phase 3 |
| M1F coordination contracts: assignment, write scope, lease, handoff, quota snapshot, evidence taxonomy, and the two proposed blocked reasons | Deferred to a named milestone | M1F, after M1E and before M2; each M1 subtask still requires its own explicit GO (D-026, D-030) |
| Multi-surface UI: chat, Kanban, task queue/detail, worker/quota status, recovery, logs, and dashboard | Accepted and active | D-028; all action paths use the same typed command, approval, and policy engine |
| Recommendation-first routing and guarded future auto-dispatch | Accepted and active | D-029; MVP dispatch remains owner-confirmed |
| M10 routing/quota/fallback and M11 dashboards/notifications/packaging | Deferred to named roadmap milestones | D-030; M10/M11 are beyond the first implementation phase and notifications remain M11 / Phase 4 |
| Codex reversion to current primary implementation worker | Accepted and active | D-031 |
| Hermes-style UX/workflow references | Superseded | D-032 preserves the custom Control Plane / Local Bridge architecture as governing; Hermes does not replace it |
| Operations Gateway for business/production control | Superseded | D-015 refuses these capabilities in the MVP. A future separately designed, separately authorized gateway may replace that exclusion only after an owner decision. |
| Historical claims that M1B was current or unmerged | Superseded | Current `main` contains the completed M1B work through `2dc6a12`; this status is reflected in the active plan and task record. |

## Resolved owner decisions

| Former item | Resolution | Decision |
| --- | --- | --- |
| A-1 | Multi-surface UI accepted with one command/approval path. | D-028 |
| A-2 | Recommendation-first routing accepted; auto-dispatch is explicit, revocable, per-category, and never the default for operate-class work. | D-029 |
| A-3 | M10/M11 accepted beyond the first implementation phase; notifications remain M11 / Phase 4. | D-030 |
| A-4 | Codex confirmed as the current primary implementation worker. | D-031 |

## Remaining owner decision required

| Item | Decision and choices | Why owner-only |
| --- | --- | --- |
| Staging profile | Whether to approve a staging profile for the Command Center itself when runtime work reaches that point. | It creates an operational environment and must be separately designed. |

## Unresolved evidence gaps

- The 2026-07-12 drafts describe M1B as unmerged; current Git history proves that status is obsolete. The drafts remain preserved as evidence, not normative status.
- Current installed worker versions, authentication state, sandbox behavior, cancellation, resume, structured output, and quota visibility were not re-probed by this documentation batch. M1F readiness contracts make those facts explicit before automated use.
- Claude's subscription authentication must not be assumed usable by a backend adapter; the planned SDK route requires API-key authentication and a capability proof.
- Antigravity remains a secondary, capability-probed adapter until its proof of concept passes.

## Policy precedence

Chubz is the final approver. Bantay reviews strategy, safety, scope, and prompts. Codex is the current primary implementation worker. BUNSO remains the lead architecture-design source; Antigravity is secondary and capability-probed. The custom Control Plane / Local Bridge architecture remains governing; Hermes-style systems are UX and workflow references only. Workers cannot override owner or repository policy, infer production authorization, or turn an informal draft into a governing contract.

When records conflict, use this order: newer explicit owner decision; accepted decision record; merged approved contract; accepted architecture/security/plan detail; preserved draft; worker output. An implementation that changes architecture-governing behavior must update its applicable architecture documentation and decision record in the same batch; small internal edits do not require unrelated documentation churn.
