# Active Tasks

> **STATUS: M1A AND M1B MERGED INTO `main`. CURRENT WORK: CODEX M1C APPROVAL-SECURITY CONTRACTS ON `task/m1c-approval-security-contracts`, AUTHORIZED BY EXPLICIT OWNER GO AND PENDING BANTAY/OWNER REVIEW.**

## Project lifecycle status

1. **Completed** — Architecture design (BUNSO using Fable 5), Bantay review (revisions R1–R7 applied), and owner architecture decisions through D-032.
2. **Completed** — Phase 0A documentation and decision prerequisites.
3. **Completed — conditional pass** — Antigravity Phase 0B operational feasibility validation ([PHASE0B_OPERATIONAL_VALIDATION_REPORT.md](PHASE0B_OPERATIONAL_VALIDATION_REPORT.md)).
4. **Completed** — M1A Core Contracts: implemented, Bantay/Codex reviewed (D-021, D-022 hardening applied), owner-approved, and fast-forward merged into `main`.
5. **Completed** — M1B Protocol Contracts: merged into `main` through `2dc6a12`.
6. **Current** — Codex M1C Approval-Security Contracts on `task/m1c-approval-security-contracts`; the owner issued an explicit GO. M1C remains active and unaccepted pending Bantay/owner review.
7. **Pending and not authorized** — M1D, M1E, M1F, and M2 onward; each requires separate Bantay review and owner approval.

Earlier project bootstrap and worker onboarding (Codex, BUNSO, Antigravity) are complete and precede item 1.

## Current task detail — M1C Approval-Security Contracts

Codex is implementing pure shared approval-security contracts: strict versioned approval actions, canonical SHA-256 action digests, HMAC-authenticated Phase-1 capability grants, expiry/replay classification, and transport-neutral future WebAuthn proof binding. M1A and M1B remain complete and frozen. M1C excludes the Approval Engine runtime, persistence, HTTP/WebSocket transport, Bridge execution, worker adapters/routing, UI cards, WebAuthn ceremony, Cloudflare/remote access, and production operations.

Deferred owner inputs (not blockers, per D-022): the Obsidian vault path (U-7) remains configurable, and the pilot project remains uncreated and is needed only when a later runnable workflow requires it. Cloudflare account status (U-6) is needed only before Phase 2.

## Worker assignment and concurrency

- **Codex** is the current primary implementation worker.
- **BUNSO** remains the lead architecture designer and a governing architecture source; it is not the current implementation worker.
- **Bantay** reviews strategy, safety, scope, and prompts. **Antigravity** is secondary and capability-probed until approved.
- No workers may edit the same files concurrently. Handoff is explicit and owner-visible; no worker can override owner or repository policy.

## Authorization boundary

M1A Core Contracts and M1B Protocol Contracts are completed and merged into `main`.

**M1C is active on `task/m1c-approval-security-contracts` under an explicit owner GO, but is not complete or accepted.** Completion and every following milestone remain subject to separate Bantay review and owner approval. M1D, M1E, M1F, and M2 remain not started.

Nothing in this file authorizes runtime orchestration, worker connection, domain or tunnel configuration, server access, MikroTik access, deployment, restart, infrastructure changes, or production actions.
