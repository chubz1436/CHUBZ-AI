# Active Tasks

> **STATUS: M1A-M1C ACCEPTED ON `main`. M1D REDACTION LIBRARY IS ACTIVE AND UNACCEPTED ON `task/m1d-redaction-library` UNDER EXPLICIT OWNER GO. M1E, M1F, M2, AND LATER MILESTONES ARE NOT STARTED OR AUTHORIZED.**

## Project lifecycle status

1. **Completed** — Architecture design (BUNSO using Fable 5), Bantay review (revisions R1–R7 applied), and owner architecture decisions through D-032.
2. **Completed** — Phase 0A documentation and decision prerequisites.
3. **Completed — conditional pass** — Antigravity Phase 0B operational feasibility validation ([PHASE0B_OPERATIONAL_VALIDATION_REPORT.md](PHASE0B_OPERATIONAL_VALIDATION_REPORT.md)).
4. **Completed** — M1A Core Contracts: implemented, Bantay/Codex reviewed (D-021, D-022 hardening applied), owner-approved, and fast-forward merged into `main`.
5. **Completed** — M1B Protocol Contracts: merged into `main` through `2dc6a12`.
6. **Completed** — M1C Approval-Security Contracts: owner/Bantay accepted after independent security re-review PASS; implementation commits `769677dd7ee876a4ecbda08bb3674b6fa8a9a82a` and `cdffc0170facedb4c9791619a0adabc86e7f6f50` are accepted and merged into `main`.
7. **Pending and not authorized** — M1D, M1E, M1F, and M2 onward; each requires separate Bantay review and owner approval.

Earlier project bootstrap and worker onboarding (Codex, BUNSO, Antigravity) are complete and precede item 1.

## Current task detail — M1C Approval-Security Contracts

M1C delivered pure shared approval-security contracts: strict versioned approval actions, canonical SHA-256 action digests, HMAC-authenticated Phase-1 capability grants, expiry/replay classification, and transport-neutral future WebAuthn proof binding. Independent security re-review returned PASS; the accepted review recorded 329 tests and typecheck passing. M1C excludes the Approval Engine runtime, key storage, persistent atomic grant consumption, HTTP/WebSocket transport, Bridge execution, worker adapters/routing, UI cards, WebAuthn ceremony, Cloudflare/remote access, and production operations; those deferred responsibilities remain assigned to later milestones.

Deferred owner inputs (not blockers, per D-022): the Obsidian vault path (U-7) remains configurable, and the pilot project remains uncreated and is needed only when a later runnable workflow requires it. Cloudflare account status (U-6) is needed only before Phase 2.

## Worker assignment and concurrency

- **Codex** is the current primary implementation worker.
- **BUNSO** remains the lead architecture designer and a governing architecture source; it is not the current implementation worker.
- **Bantay** reviews strategy, safety, scope, and prompts. **Antigravity** is secondary and capability-probed until approved.
- No workers may edit the same files concurrently. Handoff is explicit and owner-visible; no worker can override owner or repository policy.

## Authorization boundary

M1A Core Contracts and M1B Protocol Contracts are completed and merged into `main`.

**M1C is complete and accepted on `main` after explicit owner/Bantay approval and independent security re-review PASS.** M1D, M1E, M1F, M2, and all later milestones remain not started and unauthorized; the next milestone requires a separate explicit GO.

Nothing in this file authorizes runtime orchestration, worker connection, domain or tunnel configuration, server access, MikroTik access, deployment, restart, infrastructure changes, or production actions.

## M1D activation record

M1D Redaction Library received explicit owner GO and is active on `task/m1d-redaction-library`; Codex is the current worker. M1A-M1C remain complete and accepted. M1D scope is pure denylist classification, bounded pattern/entropy detection, safe redaction contracts, synthetic corpus tests, and public exports. It excludes runtime context assembly, capture, Bridge, logs, artifacts, UI, database, filesystem/network access, credentials, deployment, and operations. M1D is unaccepted: independent review and separate owner acceptance are required. M1E, M1F, M2, and later milestones remain not started and unauthorized.

This activation record supersedes older M1D-pending wording elsewhere in this historical status document.
