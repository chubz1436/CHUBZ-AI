# Decisions

> **STATUS: DECISIONS D-001 … D-032 ACCEPTED BY OWNER — M1A-M1C ACCEPTED ON `main`; M1D REDACTION LIBRARY ACTIVE AND UNACCEPTED ON `task/m1d-redaction-library` UNDER EXPLICIT OWNER GO; M1E AND LATER MILESTONES NOT STARTED OR AUTHORIZED**

This file is the decision log. An entry marked **ACCEPTED BY OWNER** records a decision Kenneth / CHUBZ has approved. Acceptance of a design decision does **not** by itself authorize implementation, deployment, infrastructure configuration, or production access; each implementation phase carries its own explicit owner GO.

**M1D activation (2026-07-20):** M1D Redaction Library received explicit owner GO and is active, unaccepted, on `task/m1d-redaction-library`; Codex is the current worker. M1A-M1C remain complete and accepted. M1D is restricted to pure shared redaction contracts/detectors/tests and excludes runtime integration, filesystem/network access, credentials, capture, Bridge, database, UI, and operations. Completion requires independent review and separate owner acceptance. M1E, M1F, M2, and later milestones remain unauthorized.

**Current milestone status (2026-07-20):** M1C remains accepted after independent security re-review PASS. M1D Redaction Library received explicit owner GO, is active and implemented locally on `task/m1d-redaction-library`, and remains unaccepted pending independent review and separate owner acceptance. Runtime key storage, persistent atomic grant consumption, WebAuthn ceremony, and Bridge execution remain deferred. M1E, M1F, M2, and all later milestones remain unauthorized pending separate explicit GO.

Decisions D-006 … D-018 correspond to proposals P-006 … P-018 in [FINAL_ARCHITECTURE_DESIGN.md](FINAL_ARCHITECTURE_DESIGN.md) §22, as revised following Bantay's required design revisions (2026-07-10). Where the design documents and this log ever disagree, this log governs the decision and the design documents govern the detail.

## D-001 — Local-first control plane

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** Prefer a local PC bridge and keep remotely accessible surfaces narrow and permissioned.
- **Reason:** Local ownership and explicit boundaries reduce uncontrolled access.

## D-002 — Chat-first and automation-first UX

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** Use conversational control plus discoverable slash commands and repeatable workflows.

## D-003 — Traceable, isolated worker tasks

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** Isolate assignments, capture responses and diffs automatically, detect conflicts, and produce Obsidian-compatible Bridge Log records.

## D-004 — Extensible workers

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** Design a future worker plug-in registry instead of hard-coding every worker integration.

## D-005 — Initial architecture design authority and review workflow

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** BUNSO using Fable 5 is the lead and final designer for the initial architecture package. Bantay is the architecture, safety, scope, and risk reviewer. Kenneth / CHUBZ gives final approval. Codex implements only after design review and owner approval. Antigravity validates operational practicality after a design exists.
- **Boundary:** This decision assigns design and review authority only; it does not authorize implementation, deployment, infrastructure configuration, or production access.

## D-006 — Recommended topology (was P-006)

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** Two local services on the owner's Windows PC — a Control Plane (state, orchestration, gates, serves the web app, binds to `127.0.0.1` only) and a separate outbound-only Local Bridge (worker execution, workspaces, Git, capture; no listening socket). The web app is served by the Control Plane. The control plane is not bundled into the web app and is not cloud-hosted.

## D-007 — Technology stack (was P-007)

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** TypeScript throughout a pnpm monorepo: React + Vite + Tailwind (PWA) frontend; Node.js LTS + Fastify control plane; Node.js + `execa` local bridge; SQLite (WAL) database and in-process queue; WebSocket real-time transport; Zod shared schemas; passkeys (WebAuthn) with Argon2 fallback; local content-hashed artifact storage; pino logging; Vitest + Playwright testing. Fallbacks are documented per choice in FINAL_ARCHITECTURE_DESIGN.md §17.

## D-008 — Remote access approach and subdomain plan (was P-008)

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** Remote access via Cloudflare Tunnel plus Cloudflare Access, exposing only `ai.ichubz.com`. All other candidate subdomains (`api`, `bridge`, `auth`, `files`, `docs`, `status`) are deferred. Tailscale remains the documented fallback.
- **Boundary:** No DNS, tunnel, certificate, or hosting configuration is authorized by this decision. Remote access is enabled only after the Phase 2 prerequisites in SECURITY_AND_THREAT_MODEL.md §18 are evidenced and the owner records a separate explicit GO.

## D-009 — Workspace isolation and owner working-copy safety (was P-009)

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** Projects enroll as a **managed clone** (the original project directory is read, never silently initialized or modified). Task attempts run in Git worktrees created from the managed clone. Approved results are finalized as a task commit plus an exported patch **inside the managed repository only** — the owner's normal working copy and checked-out branch are never automatically mutated. Applying an approved patch to the owner's real project is a separate, explicitly displayed bounded action (milestone M9). Non-Git projects enroll by snapshot import.

## D-010 — Source of truth for operational state (was P-010)

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** SQLite is the operational source of truth. The Obsidian Bridge Log is a regenerable, human-readable Markdown projection and is never read back as authoritative state.

## D-011 — Authoritative worker-role definition (was P-011)

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** Once implemented, worker registry manifests are the authoritative definition of worker identity, capabilities, restrictions, and permissions. Prose summaries in [WORKER_ROLES.md](WORKER_ROLES.md), the README, and the worker profiles become human-readable projections of the manifests. Until the registry exists, WORKER_ROLES.md remains the authoritative prose source.

## D-012 — Manual relay as a first-class, owner-attested connector (was P-012)

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** Manual relay is a first-class connector and the universal fallback for every worker. Manual results are recorded as **"owner-attested manual relay"**, carry the same post-import workflow (task states, redaction, approval records, review packages, Bridge Log) but explicitly weaker guarantees (no execution supervision, cryptographic identity, command capture, file provenance, cancellation, or filesystem enforcement). Default manual capability is review/design/text-output only; file changes require explicit reviewed artifact import. Manual workers must never be displayed as automatically controlled or cryptographically authenticated. Connector tier is always shown honestly.

## D-013 — First automated connector target (was P-013)

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** Codex CLI is the first automated (`cli-headless`) connector target, contingent on Antigravity's Phase 0 validation of unknown U-1. No connector is presently confirmed; if validation fails, the worker remains on manual relay.

## D-014 — Approval enforcement and grant model (was P-014)

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** Consequential actions are authorized by short-lived, single-use, task-bound, action-hash-bound capability grants verified by the Bridge.
  - **Phase 1 (local-only):** HMAC-signed grants provide integrity and anti-replay protection **only**. Because the Control Plane holds the signing key, they are explicitly **not** proof of owner presence and must never be described as such (residual risk R-8, accepted solely because Phase 1 is loopback-only).
  - **Before Phase 2 remote access:** a Bridge-verifiable owner-presence approval proof is required — Bridge-issued nonce, challenge binding the action hash, task, attempt, scope, and expiry, approved by a passkey/WebAuthn assertion that the Bridge verifies independently against the owner's registered public key. The Control Plane must not possess a private key capable of forging owner approval. A separate approval-signer service remains a documented fallback with stated costs.

## D-015 — High-risk actions refused in the MVP (was P-015)

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** Deployment, production actions, database operations, MikroTik/router actions, DNS and tunnel changes, server restarts, credential access, and destructive Git operations are **refused outright** in the MVP — no executable code path exists for them. They are not merely gated. Each requires its own future design, gate type, and typed confirmation distinct from `/go`. A general `/go` approves exactly one currently displayed bounded action and can never authorize these categories.

## D-016 — MVP concurrency limits (was P-016)

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** At most one running task per project and two system-wide, with a per-project integration lock and FIFO queue. Limits are configuration and may be raised only in Phase 4 with the conflict detector active.

## D-017 — Task state machine (was P-017)

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** The twelve-state task machine and transition-authority table in FINAL_ARCHITECTURE_DESIGN.md §10 is adopted. `BLOCKED` carries machine-readable reason codes (`queue-lock`, `conflict`, `missing-context`, `policy`, `abandoned`, `execution-unknown`) rather than expanding the visible state model. Privileged operations follow an at-most-once design: journal-before-execution, grant consumption before privileged execution, and owner-reviewed reconciliation of ambiguous outcomes — never blind retry.

## D-018 — Package layout (was P-018)

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** Add `packages/control-plane` as the fourth workspace package alongside `shared`, `local-bridge`, and `web-app`, with the responsibilities and prohibited responsibilities defined in FINAL_ARCHITECTURE_DESIGN.md §13.

## D-019 — Temporary implementation-worker assignment

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** While Fable 5 quota remains available, **BUNSO using Fable 5 is temporarily the primary implementation worker** for the initial coding phases. **Codex is the backup and handoff implementation worker** during this period. Codex remains the documented long-term primary implementation worker; this assignment is temporary and reverts to Codex when the owner ends it or Fable 5 quota is exhausted.
- **Concurrency boundary:** BUNSO and Codex must **never edit the same files concurrently.** Exactly one implementation worker holds a given file or package at a time; handoff is explicit and owner-visible.
- **Boundary:** This decision reassigns implementation-worker identity only. It does not authorize coding to begin. Each implementation phase and bounded subtask still requires its own explicit owner GO, and Bantay review plus Antigravity Phase 0 validation precede any coding.
- **Note:** D-005 remains in force. BUNSO's design authority is unchanged; this decision adds a temporary implementation role on top of it. When BUNSO implements, independent review of that work falls to Bantay and Codex, since BUNSO cannot be its own independent reviewer.
- **Current-status clarification:** The temporary implementation assignment has ended for the current batch. D-027 records Codex as the current primary implementation worker; this historical decision remains preserved rather than rewritten.

## D-020 — Task-state count and cancellation clarification

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Clarification 1 — state count:** The accepted task-state model contains **fourteen** visible states. The word "twelve" in D-017 and in the original FINAL_ARCHITECTURE_DESIGN.md §10 prose was a counting defect. The authoritative state list is the fourteen states shown in the accepted §10 state diagram and implemented in `TASK_STATES` (`packages/shared`). D-017's historical text is not rewritten; this decision supersedes its count.
- **Clarification 2 — cancellation semantics:** States where worker dispatch or integration may be in flight — `AWAITING_DISPATCH`, `RUNNING`, `APPROVED` — cancel through `CANCELLING → CANCELLED`, completed only on the Bridge's kill/termination confirmation. Passive states with no process requiring termination — `DRAFT`, `CONTEXT_PREPARING`, `RESULT_CAPTURED`, `AWAITING_APPROVAL`, `REVISION_REQUESTED`, and ordinary `BLOCKED` — may be cancelled directly to `CANCELLED` by the owner only. Terminal states remain terminal.
- **Clarification 3 — execution-unknown:** `BLOCKED(execution-unknown)` is excluded from ordinary unblocking and from ordinary cancellation until reconciliation is recorded. Its only exits are the owner-reviewed reconciliation outcomes `confirmed-completed` (→ COMPLETED), `confirmed-failed` (→ FAILED), and `confirmed-not-executed` (→ CONTEXT_PREPARING with a new immutable attempt), each requiring recorded owner-reconciliation evidence. No automated actor may resolve execution-unknown.
- **Boundary:** This decision clarifies the M1A contract only; it does not authorize additional implementation scope.

## D-021 — Trusted blocked context and stage-aware recovery

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Requirements:**
  1. `BLOCKED` must preserve trusted information about the state and operation that entered it (source state, blocked operation, reason, attempt identity, operation identity, and journal reference where applicable).
  2. A caller must not be able to substitute or omit the stored blocked reason, source state, operation, attempt identity, or journal identity.
  3. Recovery from `BLOCKED` must return only to a target valid for the original blocked stage.
  4. `execution-unknown` may be used only when an operation was recorded as started but its final result is uncertain (a trusted journal/start reference is mandatory).
  5. A reconciliation outcome means the outcome of the **original operation** — not automatically the outcome of the entire task.
  6. `confirmed-completed` must advance only to the legitimate success state of the original operation (dispatch → RUNNING; execution → RESULT_CAPTURED; integration → COMPLETED).
  7. A retry must use a new immutable attempt or operation identity where required; a Boolean assertion alone is insufficient.
  8. Ordinary BLOCKED recovery and execution-unknown reconciliation are separate paths.
  9. This clarification changes only the M1A contract and does not authorize runtime orchestration.
- **Note:** D-020's historical text is not rewritten; this decision refines its reconciliation model to be stage-aware.

## D-022 — Trusted task snapshot and reconciliation evidence

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Requirements:**
  1. Transition authorization must receive the existing task state and BLOCKED context through a **separate trusted-current-snapshot input**, distinct from the transition request.
  2. A transition request must not be allowed to supply or replace the current BLOCKED reason, source state, operation, attempt ID, operation ID, or journal reference.
  3. The future state store is responsible for loading the trusted snapshot; M1A defines and validates its contract without implementing persistence.
  4. Every new-attempt transition requires both the trusted current attempt ID and a distinct proposed next attempt ID.
  5. Reconciliation to FAILED requires stage-specific trusted Bridge result or failure evidence in addition to owner reconciliation.
  6. Automated connectors, including browser-controlled connectors, require automated provenance. Owner-attested provenance is reserved for manual relay/import workflows.
  7. Pilot-project and Obsidian-path choices are not blockers for M1A.
  8. This decision clarifies the M1A contract only and does not authorize M1B or runtime orchestration.
- **Note:** D-021's historical text is not rewritten; this decision hardens how its trusted blocked context is delivered and evidenced.

## D-023 — M1B protocol-contract scope and transport semantics

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-11
- **Requirements:**
  1. M1B defines pure, versioned protocol contracts only.
  2. It covers Client ↔ Control Plane and Control Plane ↔ Local Bridge envelopes.
  3. Mutating messages require idempotency identity and payload fingerprinting contracts.
  4. Duplicate delivery must be distinguishable from conflicting key reuse.
  5. Event streams use ordered cursors and support safe resume semantics.
  6. Protocol contracts must reject unknown fields, unknown message kinds, and unsupported versions by default.
  7. Bridge messages must use typed high-level operations, never raw shell command strings.
  8. M1B does not implement WebSocket servers, persistence, queues, authentication, grants, process execution, or network I/O.
  9. M1C and later phases require separate owner authorization. M1C is complete and accepted under the bounded owner/Bantay decision recorded above; later phases remain unauthorized.

## D-024 — Adapter integration strategy and readiness

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-20
- **Decision:** The normal integration path is SDK/CLI-first, never GUI automation. Every adapter has a preferred path and a stable fallback, with owner-attested manual relay retained as the universal fallback under D-012. `codex exec` is the initial Codex automated path; deeper app-server, Python SDK, or equivalent paths remain feature-flagged until capability-proven. Claude backend integration is planned around the Agent SDK with API-key authentication, not an assumed `claude.ai` subscription session. Antigravity is a secondary capability-probed adapter, not a required primary dependency.
- **Readiness:** Before automated use, an adapter must report installed version, supported capabilities, authentication state, sandbox support, noninteractive execution, cancellation, resume, structured output, and quota/rate-limit confidence when available. Its state is explicit (for example: unprobed, probing, ready, degraded, manual-only, blocked, frozen), never a simple online/offline Boolean.
- **Boundary:** This decision selects architecture and contracts only. It does not assert that any unproven integration works or authorize an adapter implementation.

## D-025 — Isolation, observability, quota, and runtime integrity

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-20
- **Decision:** Worker execution uses layered isolation: per-attempt Git worktree, vendor sandbox where available, restricted filesystem roots, default-deny network where practical with explicit per-task grants, and no shared mutable working directory or implicit production access. OpenTelemetry-compatible trace context links task, attempt, operation, adapter run, worker process, approval, artifact, and recovery/failure event.
- **Operational controls:** Quota data carries a confidence/source level; rate limits use circuit breakers; authentication expiry is surfaced; adapters and runtimes have freeze switches. Worker runtimes are version-pinned and hash-verified where practical, upgraded through staged canaries, capability-probed after upgrade, and rollback-capable after regression.
- **Boundary:** D-009, D-012, D-016, and D-019 remain controlling for managed workspaces, manual relay, concurrency, and worker handoff.

## D-026 — M1F coordination and resilience contracts

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-20
- **Decision:** M1F, **Adapter & Coordination Contracts**, is a bounded contract milestone after M1E and before M2. It defines versioned schemas for assignment, write scope, lease, handoff, quota snapshot/confidence, evidence taxonomy, adapter readiness/run, lifecycle event, operation-journal reconciliation, and the proposed `no-eligible-worker` and `stale-lease` blocked reasons. It does not implement a bridge, routing engine, or worker adapter.
- **Required test design:** The contract and later runtime suites cover duplicate dispatch/event, bridge or worker crash, stale lease, expired approval grant, malformed structured output, authentication expiry, cancellation during execution, resume after interruption, rate limit, partial artifact, and journal reconciliation.
- **Persistence:** MVP retains SQLite in WAL mode, the operation journal, and reconciliation/recovery logic. Temporal or another durable workflow engine is evaluated only when demonstrated scale or operational complexity justifies it.
- **Boundary:** M1F requires its own explicit owner GO and does not authorize M1C, M2, or runtime work.

## D-027 — Worker authority, policy precedence, and same-action documentation

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-20
- **Decision:** Chubz is final approver; Bantay reviews strategy, safety, scope, and prompts; Codex is the current primary implementation worker; BUNSO remains an architecture source; and Antigravity remains secondary until capability-proven. Workers cannot override owner or repository policy, infer production authorization, or treat a draft as a governing contract.
- **Precedence:** Newer explicit owner decisions override older conflicting planning notes; accepted decisions override informal drafts; merged approved contracts override unapproved proposals. Architecture-governing implementation changes update their applicable documentation and decision record in the same implementation batch, without requiring unrelated documentation churn.

## D-028 — Multi-surface Command Center UI

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-20
- **Decision:** Chat remains the primary command and approval surface. Kanban, task queue, task detail, worker status, quota status, recovery center, logs, and dashboard views are accepted inspection and workflow surfaces.
- **Invariant:** Any action initiated outside chat emits the same typed command and passes through the same approval and policy engine. No dashboard or other surface may introduce a separate or weaker command path.

## D-029 — Recommendation-first worker routing

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-20
- **Decision:** Routing ranks workers by task type, assigned role, capability, availability, quota confidence, load, and the lowest-cost capable worker. MVP dispatch remains owner-confirmed.
- **Boundary:** Future auto-dispatch requires an explicit, revocable, per-category owner policy. It is never the default for production, destructive, infrastructure, credential, database, MikroTik, deployment, restart, or other operate-class work.

## D-030 — Roadmap sequencing for coordination, routing, and surfaces

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-20
- **Decision:** M1F follows M1E and completes before M2. M10 and M11 are accepted roadmap milestones beyond the first implementation phase: M10 matures routing, quota, and fallback; M11 adds expanded dashboards, notifications, and later packaging.
- **Boundary:** Notifications remain deferred to M11 / Phase 4. This decision does not authorize M1F, M10, M11, or any other implementation.

## D-031 — Current primary implementation worker

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-20
- **Decision:** Codex is the current primary implementation worker. BUNSO remains the lead architecture designer and governing architecture source; any implementation or review assignment remains explicit and bounded.

## D-032 — Governing CHUBZ architecture and reference systems

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-20
- **Decision:** The original custom CHUBZ AI Command Center architecture remains governing: the Control Plane and outbound-only Local Bridge are the core architecture. Hermes-style systems are UX and workflow references only; they do not replace the governing architecture.
