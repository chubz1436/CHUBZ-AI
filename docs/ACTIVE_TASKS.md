# Active Tasks

> **STATUS: M1A AND M1B MERGED INTO `main`. CURRENT WORK: CODEX DOCUMENTATION-ONLY BUNSO ARCHITECTURE ALIGNMENT. M1C NOT STARTED AND UNAUTHORIZED.**

## Project lifecycle status

1. **Completed** — Architecture design (BUNSO using Fable 5), Bantay review (revisions R1–R7 applied), and owner architecture decisions through D-032.
2. **Completed** — Phase 0A documentation and decision prerequisites.
3. **Completed — conditional pass** — Antigravity Phase 0B operational feasibility validation ([PHASE0B_OPERATIONAL_VALIDATION_REPORT.md](PHASE0B_OPERATIONAL_VALIDATION_REPORT.md)).
4. **Completed** — M1A Core Contracts: implemented, Bantay/Codex reviewed (D-021, D-022 hardening applied), owner-approved, and fast-forward merged into `main`.
5. **Completed** — M1B Protocol Contracts: merged into `main` through `2dc6a12`.
6. **Current** — Codex documentation-only BUNSO architecture preservation, owner-decision closure, and separate-experiment adoption planning on `task/bunso-architecture-alignment`; BUNSO's reviewed architecture is governing design input alongside accepted decisions.
7. **Pending and not authorized** — M1C Approval-Security Contracts, then M1D … M1F one at a time, each after owner approval of the previous review.

Earlier project bootstrap and worker onboarding (Codex, BUNSO, Antigravity) are complete and precede item 1.

## Current task detail — BUNSO architecture alignment

Codex is reconciling BUNSO architecture evidence with the accepted records. This is documentation-only: no runtime code, adapter implementation, M1C work, merge, push, deployment, or production action is authorized. The output is the official alignment record plus consistent architecture, security, milestone, decision, and worker-policy documentation.

Deferred owner inputs (not blockers, per D-022): the Obsidian vault path (U-7) remains configurable, and the pilot project remains uncreated and is needed only when a later runnable workflow requires it. Cloudflare account status (U-6) is needed only before Phase 2.

## Worker assignment and concurrency

- **Codex** is the current primary implementation worker.
- **BUNSO** remains the lead architecture designer and a governing architecture source; it is not the current implementation worker.
- **Bantay** reviews strategy, safety, scope, and prompts. **Antigravity** is secondary and capability-probed until approved.
- No workers may edit the same files concurrently. Handoff is explicit and owner-visible; no worker can override owner or repository policy.

## Authorization boundary

M1A Core Contracts and M1B Protocol Contracts are completed and merged into `main`.

**M1C is not started and unauthorized.** It requires its own explicit owner GO and the documented M1C prerequisites before any M1C coding begins. The next gate after this documentation batch is owner/Bantay review, not automatic implementation.

Nothing in this file authorizes runtime orchestration, worker connection, domain or tunnel configuration, server access, MikroTik access, deployment, restart, infrastructure changes, or production actions.
