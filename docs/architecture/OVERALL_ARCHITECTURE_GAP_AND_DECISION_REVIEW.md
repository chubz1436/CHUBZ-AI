# Overall Architecture — Gap and Decision Review

> **STATUS: REVIEWED HISTORICAL / DESIGN-INPUT DOCUMENT — NOT INDEPENDENTLY AUTHORITATIVE. AUTHORIZES NOTHING.**
>
> When wording conflicts, [DECISIONS.md](../DECISIONS.md), [FINAL_ARCHITECTURE_DESIGN.md](../FINAL_ARCHITECTURE_DESIGN.md), [SECURITY_AND_THREAT_MODEL.md](../SECURITY_AND_THREAT_MODEL.md), and [PHASED_IMPLEMENTATION_PLAN.md](../PHASED_IMPLEMENTATION_PLAN.md) govern. Proposal dispositions are recorded in [BUNSO_ARCHITECTURE_ALIGNMENT.md](BUNSO_ARCHITECTURE_ALIGNMENT.md).
>
> Author: Claude Code / BUNSO (Fable 5), per D-005. Date: 2026-07-12.
> Evidence baseline: `main` @ `bb8928b65a028716977e83ed7f8bdc15fa9812f6` (clean working tree); `task/m1b-protocol-contracts` @ `078d24d1f163351ed7c0f3446149ae903a07622f` (6 commits ahead of main).
> Companion to [CHUBZ_AI_COMMAND_CENTER_OVERALL_ARCHITECTURE_DRAFT.md](CHUBZ_AI_COMMAND_CENTER_OVERALL_ARCHITECTURE_DRAFT.md).

---

## 1. Stale wording found (repository evidence vs document text)

These are factual staleness findings, verified against git state on 2026-07-12. **No document was edited** — the 2-file limit for this design task is spent on the two architecture documents. A bounded doc-alignment task should fix these; recommended assignee: Codex, docs-only, after owner GO.

| ID | Location | Stale text | Reality (evidence) |
|---|---|---|---|
| S-1 | [DECISIONS.md](../DECISIONS.md) header | "M1A COMPLETED ON TASK BRANCH, IN REVIEW; MERGE PENDING" | M1A is merged into `main` (`bb8928b` "Mark M1A completed after merge"; ACTIVE_TASKS.md items 6–7 agree) |
| S-2 | [PHASED_IMPLEMENTATION_PLAN.md](../PHASED_IMPLEMENTATION_PLAN.md), "First Implementation Tasks" section | "The next pending task is 'BUNSO/Fable 5 M1A Core Contracts' … not authorized to begin: Antigravity's Phase 0B … has not yet been executed" | Phase 0B is complete (conditional pass) and M1A is merged — this paragraph contradicts the same document's own Phase 0 header. This is the known "stale wording in PHASED_IMPLEMENTATION_PLAN.md" issue |
| S-3 | [PHASED_IMPLEMENTATION_PLAN.md](../PHASED_IMPLEMENTATION_PLAN.md) Phase 0 header + STOP POINT + phase-gate table; [ACTIVE_TASKS.md](../ACTIVE_TASKS.md) items 8 and "Authorization boundary" | "M1B Protocol Contracts remains pending and unauthorized" | `task/m1b-protocol-contracts` carries six commits of M1B implementation under correction/review (owner evidently issued the M1B GO after these documents were written). The docs must record that GO and the branch's review status |
| S-4 | [ARCHITECTURE.md](../ARCHITECTURE.md) "Planning-only endpoints" | "The proposed domain split is `ai`, `bridge`, `auth`, `files`, `docs`, and `status`" | D-008 accepted `ai.ichubz.com` only and **deferred all others**. ARCHITECTURE.md predates the accepted design and now contradicts it |
| S-5 | [ARCHITECTURE.md](../ARCHITECTURE.md), [PROJECT_OVERVIEW.md](../PROJECT_OVERVIEW.md), [SAFETY_AND_APPROVALS.md](../SAFETY_AND_APPROVALS.md), [WORKER_ROLES.md](../WORKER_ROLES.md) headers | "STATUS: PLANNED — NOT YET IMPLEMENTED" | Partially stale: M1A contracts are implemented and merged; M1B is in progress. Headers should say the design is accepted and contract implementation has begun |
| S-6 | [DECISIONS.md](../DECISIONS.md) D-020 Clarification 3 | `confirmed-not-executed` "→ CONTEXT_PREPARING with a new immutable attempt" (single target) | D-021 refined this to stage-aware targets (dispatch → AWAITING_DISPATCH; execution → CONTEXT_PREPARING; integration → APPROVED). D-021 explicitly does not rewrite D-020's text, so this is by-design historical layering — but any doc-alignment pass should add a pointer so a reader of D-020 alone is not misled |

## 2. Contradictions between current documents

| ID | Contradiction | Proposed resolution |
|---|---|---|
| C-1 | **Chat-first vs Kanban/dashboard.** D-002 and FINAL_ARCHITECTURE_DESIGN §18 mandate "one chat column + side panel, **no dashboard grid**" and guard against "Mission-Control drift". The owner's current direction requires a Hermes-style Kanban queue, an executive dashboard, and eleven screens | Draft §11 resolves this as: chat remains the sole command/approval origin; Kanban/dashboard are added **inspection surfaces** over the same store, and any action from them emits the same typed command + approval card. This is an evolution of D-002, not a silent replacement → **owner decision OD-1** |
| C-2 | **Owner-selects-worker vs automatic routing.** The accepted command model dispatches via explicit worker commands (`/codex` …); the new direction requires automatic routing by type/role/availability/quota | Draft §5 resolves this as recommendation-first routing (owner confirms), with auto-dispatch only as a future per-category owner policy → **OD-2** |
| C-3 | **Notification timing.** Accepted plan defers notifications to Phase 4; the new direction lists a notification system as a required component | Kept at Phase 4 (M11) — an outbound-only hook; the architecture reserves the event tap now so no redesign is needed → **OD-3** confirms the timing |
| C-4 | **WORKER_ROLES.md long-term table vs D-019 temporary assignment.** Both documents state the layering correctly, but the roadmap's "recommended worker" depends on whether Fable 5 quota is exhausted | Roadmap assumes reversion to Codex per D-019's own terms. The owner should record the reversion explicitly when it happens → **OD-4** |

## 3. Missing architecture decisions (now supplied as PROPOSED in the draft)

| ID | Gap | Where addressed |
|---|---|---|
| G-1 | No routing/fallback/quota subsystem existed in the accepted design | Draft §5, §2.2 (Routing & Fallback Engine, Quota & Availability Monitor), M10 |
| G-2 | No explicit lease/write-scope model — the accepted design had queue/locks but no ownership entity, TTL, or stale-recovery path | Draft §6, §9 (Assignment, WriteScope, Lease), M1F contracts |
| G-3 | No typed evidence taxonomy — evidence kinds existed in transition contracts (M1A) but no unified class ranking or Evidence entity | Draft §4, §9 (Evidence entity), M1F |
| G-4 | No session-bootstrap / snapshot mechanism — the staleness found in §1 is the symptom | Draft §8.3 (`_SNAPSHOT.md` projection with evidence header) |
| G-5 | No Repository Evidence Collector as a named component (git facts were implicit in the capture pipeline) | Draft §2.2, M3 |
| G-6 | No handoff record/bundle definition despite D-019 requiring explicit owner-visible handoff | Draft §5.6, §9 (Handoff entity) |
| G-7 | No blocked-reason codes for routing/lease outcomes | `no-eligible-worker`, `stale-lease` proposed (M1F; extends the M1A reason-code enum — a **contract change requiring owner GO**, flagged deliberately) |
| G-8 | No isolation architecture for future ISP/MikroTik expansion beyond "refused" | Draft §12.6 (Operations Gateway, separate service and gates) |
| G-9 | Browser-controlled connector provenance requirement (D-022 §6) had no design placeholder | Draft §4.2 row; the connector stays DEFERRED and may not ship without an automated-provenance design |

## 4. Risks that could force redesign

| Risk | Why it matters | Containment in the draft |
|---|---|---|
| R-1: Kanban surfaces grow their own command path | Would fork approval semantics and break the single-`/go` invariant | §11 rule: non-chat surfaces emit the same typed commands; enforce in review of M6 |
| R-2: Routing graduated to auto-dispatch too early | Undermines owner-gated dispatch; quota pressure will tempt this | Auto-dispatch requires per-category owner policy records (OD-2); never default |
| R-3: Blocked-reason enum churn | M1A froze the enum; M1F adds two codes; further ad-hoc additions would destabilize the contract | Treat the enum as frozen-after-M1F; additions require a decision entry |
| R-4: Lease glob-overlap semantics | Ambiguous glob intersection could allow overlapping write scopes | M1F must define the intersection rule conservatively (ambiguous ⇒ overlap) with contract tests |
| R-5: Quota states for manual workers are owner-declared and can go stale | Routing on stale quota misroutes | Snapshots carry source + timestamp; UI shows age; stale snapshots decay to `unknown` |
| R-6: Operations Gateway scope creep into the core | Business integrations inside the core would couple production risk to the task engine | §12.6 hard boundary: separate service, separate credentials, own gate designs, typed API only |

## 5. Contracts that must be frozen before implementation proceeds

1. **Frozen (merged, main):** task states, legal transitions + evidence corroboration, trusted blocked context, stage-aware reconciliation, command grammar, worker manifest (M1A).
2. **Freezing (M1B, on branch):** protocol envelopes, idempotency digests, event cursors, Bridge report bindings — frozen at M1B merge after the R2 export-boundary patch.
3. **Must freeze before M2:** M1C grant/action-hash canonicalization; M1E capture/provenance records; **M1F coordination contracts** (assignment/write-scope/lease/handoff/quota/evidence taxonomy — new, needs OD-5 approval of M1F itself).
4. **Must freeze before M10:** routing policy schema and quota-snapshot semantics.

## 6. Decisions requiring Kenneth's approval (owner-decision section)

Nothing below is decided by the draft; each is presented with a recommendation only.

| ID | Decision needed | Recommendation |
|---|---|---|
| **OD-1** | Adopt the multi-surface UI (Kanban, executive dashboard, recovery center, quota dashboard) as an evolution of D-002, with chat remaining the sole command/approval origin | Accept as drafted (§11); record as a new decision superseding the "no dashboard grid" wording of the accepted §18 |
| **OD-2** | Adopt recommendation-first routing + quota-aware fallback (M10); auto-dispatch only by future per-category policy | Accept as drafted (§5) |
| **OD-3** | Confirm notification system stays Phase 4 (M11) despite being on the required-component list | Accept — the event hook reserved now makes later addition additive |
| **OD-4** | Record the D-019 reversion (Codex primary implementer) if this Fable 5 session ends the quota period | Record at next session start |
| **OD-5** | Authorize M1F "Coordination contracts" as a new bounded subtask (extends the M1A blocked-reason enum by `no-eligible-worker`, `stale-lease`; adds the §9 new-entity schemas) | Approve after M1B–M1E complete, one at a time as usual |
| **OD-6** | Accept the two new milestones M10 (routing/quota) and M11 (dashboards/notifications/packaging) into the phased plan | Accept; sequence after M8/M9 as drafted |
| **OD-7** | Approve the staging profile concept (second data directory + port on the same PC) for pre-release testing of the Command Center itself | Accept at M8 timeframe; zero production surface |
| **OD-8** | Authorize the docs-only alignment task fixing S-1…S-6 (stale wording), assigned to Codex with Bantay spot-check | Approve soon — stale status lines are exactly the failure mode the evidence model exists to prevent |

---

*End of gap review. This document and the overall draft are the complete output of the 2026-07-12 design session; no code, configuration, or unrelated documentation was modified.*
