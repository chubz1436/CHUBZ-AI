# Active Tasks

> **STATUS: M1A MERGED INTO `main`. M1B PROTOCOL CONTRACTS CURRENT ON `task/m1b-protocol-contracts` (OWNER GO GRANTED 2026-07-11). M1C PENDING AND UNAUTHORIZED.**

## Project lifecycle status

1. **Completed** — Architecture design (BUNSO using Fable 5), Bantay review (revisions R1–R7 applied), and owner architecture decisions (D-001 … D-023).
2. **Completed** — Phase 0A documentation and decision prerequisites.
3. **Completed — conditional pass** — Antigravity Phase 0B operational feasibility validation ([PHASE0B_OPERATIONAL_VALIDATION_REPORT.md](PHASE0B_OPERATIONAL_VALIDATION_REPORT.md)).
4. **Completed** — M1A Core Contracts: implemented, Bantay/Codex reviewed (D-021, D-022 hardening applied), owner-approved, and fast-forward merged into `main`.
5. **Current** — **BUNSO/Fable 5 M1B Protocol Contracts** on branch `task/m1b-protocol-contracts` (owner GO granted 2026-07-11; scope per D-023).
6. **Pending** — M1B Bantay/Codex review, then owner merge approval.
7. **Pending and not authorized** — M1C Approval-Security Contracts, then M1D … M1E one at a time, each after owner approval of the previous review.

Earlier project bootstrap and worker onboarding (Codex, BUNSO, Antigravity) are complete and precede item 1.

## Current task detail — M1B Protocol Contracts

Under implementation on `task/m1b-protocol-contracts` (never merged before review and an explicit owner merge GO): pure versioned protocol contracts in `packages/shared/src/protocol/` — common envelopes, Client ↔ Control Plane and Control Plane ↔ Bridge message kinds, idempotency/replay classification, event cursors with stream resume, and standard protocol errors, plus exhaustive unit tests. No WebSocket, persistence, queue, authentication, grant, process-execution, or network code (D-023).

Deferred owner inputs (not blockers, per D-022): the Obsidian vault path (U-7) remains configurable, and the pilot project remains uncreated and is needed only when a later runnable workflow requires it. Cloudflare account status (U-6) is needed only before Phase 2.

## Implementation-worker assignment (per D-019)

- **BUNSO using Fable 5** is temporarily the primary implementation worker while Fable 5 quota remains available.
- **Codex** is the backup and handoff implementation worker during this period, and remains the documented long-term primary implementation worker.
- **BUNSO and Codex must never edit the same files concurrently.** Exactly one implementation worker holds a given file or package at a time; handoff is explicit and owner-visible.
- Because BUNSO cannot independently review its own implementation, review of BUNSO-authored code falls to Bantay and Codex.

## Authorization boundary

M1A Core Contracts is completed, owner-approved, and merged into `main`.

**M1B is authorized and current** (owner GO 2026-07-11, scope bounded by D-023) on `task/m1b-protocol-contracts` only; merging M1B into `main` requires Bantay/Codex review and a separate explicit owner merge GO.

**M1C is pending and not authorized.** It requires its own explicit owner GO before any M1C coding begins.

Nothing in this file authorizes runtime orchestration, worker connection, domain or tunnel configuration, server access, MikroTik access, deployment, restart, infrastructure changes, or production actions.
