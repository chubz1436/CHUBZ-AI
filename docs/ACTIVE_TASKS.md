# Active Tasks

> **STATUS: M1A CORE CONTRACTS COMPLETED AND MERGED INTO `main`. NO PHASE 1 TASK IS CURRENTLY AUTHORIZED BEYOND MERGED M1A. M1B PENDING AND UNAUTHORIZED.**

## Project lifecycle status

1. **Completed** — Architecture design (BUNSO using Fable 5), Bantay review (revisions R1–R7 applied), and owner architecture decisions (D-001 … D-022).
2. **Completed** — Phase 0A documentation and decision prerequisites.
3. **Completed — conditional pass** — Antigravity Phase 0B operational feasibility validation ([PHASE0B_OPERATIONAL_VALIDATION_REPORT.md](PHASE0B_OPERATIONAL_VALIDATION_REPORT.md)).
4. **Completed** — BUNSO/Fable 5 M1A Core Contracts implementation.
5. **Completed** — Bantay review and Codex independent verification of M1A, including the owner-directed hardening corrections (D-021 and D-022).
6. **Completed** — Owner merge approval for M1A.
7. **Completed** — Fast-forward merge of M1A Core Contracts into `main`.
8. **Pending and not authorized** — M1B Protocol Contracts (requires its own explicit owner GO), then M1C … M1E one at a time, each after owner approval of the previous review.

Earlier project bootstrap and worker onboarding (Codex, BUNSO, Antigravity) are complete and precede item 1.

## Current task detail — none authorized

M1A Core Contracts (`packages/shared`: task states, trusted blocked context, legal transitions with evidence corroboration and stage-aware reconciliation, twelve-command grammar, worker-manifest schema, plus exhaustive unit tests) is **completed, independently verified, and merged into `main`**.

**No Phase 1 task is currently authorized beyond merged M1A.** The next step, M1B Protocol Contracts, is pending and requires its own explicit owner GO.

Deferred owner inputs (not blockers, per D-022): the Obsidian vault path (U-7) remains configurable, and the pilot project remains uncreated and is needed only when a later runnable workflow requires it. Cloudflare account status (U-6) is needed only before Phase 2.

## Implementation-worker assignment (per D-019)

- **BUNSO using Fable 5** is temporarily the primary implementation worker while Fable 5 quota remains available.
- **Codex** is the backup and handoff implementation worker during this period, and remains the documented long-term primary implementation worker.
- **BUNSO and Codex must never edit the same files concurrently.** Exactly one implementation worker holds a given file or package at a time; handoff is explicit and owner-visible.
- Because BUNSO cannot independently review its own implementation, review of BUNSO-authored code falls to Bantay and Codex.

## Authorization boundary

M1A Core Contracts is completed, owner-approved, and merged into `main`.

**M1B is pending and not authorized.** It requires its own explicit owner GO before any M1B coding begins. No Phase 1 task is currently authorized beyond merged M1A.

Nothing in this file authorizes runtime orchestration, worker connection, domain or tunnel configuration, server access, MikroTik access, deployment, restart, infrastructure changes, or production actions.
