# Decisions

> **STATUS: DECISIONS D-001 … D-020 ACCEPTED BY OWNER — M1A IMPLEMENTATION IN REVIEW**

This file is the decision log. An entry marked **ACCEPTED BY OWNER** records a decision Kenneth / CHUBZ has approved. Acceptance of a design decision does **not** by itself authorize implementation, deployment, infrastructure configuration, or production access; each implementation phase carries its own explicit owner GO.

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

## D-020 — Task-state count and cancellation clarification

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Clarification 1 — state count:** The accepted task-state model contains **fourteen** visible states. The word "twelve" in D-017 and in the original FINAL_ARCHITECTURE_DESIGN.md §10 prose was a counting defect. The authoritative state list is the fourteen states shown in the accepted §10 state diagram and implemented in `TASK_STATES` (`packages/shared`). D-017's historical text is not rewritten; this decision supersedes its count.
- **Clarification 2 — cancellation semantics:** States where worker dispatch or integration may be in flight — `AWAITING_DISPATCH`, `RUNNING`, `APPROVED` — cancel through `CANCELLING → CANCELLED`, completed only on the Bridge's kill/termination confirmation. Passive states with no process requiring termination — `DRAFT`, `CONTEXT_PREPARING`, `RESULT_CAPTURED`, `AWAITING_APPROVAL`, `REVISION_REQUESTED`, and ordinary `BLOCKED` — may be cancelled directly to `CANCELLED` by the owner only. Terminal states remain terminal.
- **Clarification 3 — execution-unknown:** `BLOCKED(execution-unknown)` is excluded from ordinary unblocking and from ordinary cancellation until reconciliation is recorded. Its only exits are the owner-reviewed reconciliation outcomes `confirmed-completed` (→ COMPLETED), `confirmed-failed` (→ FAILED), and `confirmed-not-executed` (→ CONTEXT_PREPARING with a new immutable attempt), each requiring recorded owner-reconciliation evidence. No automated actor may resolve execution-unknown.
- **Boundary:** This decision clarifies the M1A contract only; it does not authorize additional implementation scope.
