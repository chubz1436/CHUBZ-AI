# Active Tasks

> **STATUS: M1A COMPLETED ON TASK BRANCH `task/m1a-core-contracts` — BANTAY/CODEX REVIEW CURRENT. MERGE NOT APPROVED. M1B NOT AUTHORIZED.**

## Project lifecycle status

1. **Completed** — Architecture design (BUNSO using Fable 5), Bantay review (revisions R1–R7 applied), and owner architecture decisions (D-001 … D-021).
2. **Completed** — Phase 0A documentation and decision prerequisites.
3. **Completed — conditional pass** — Antigravity Phase 0B operational feasibility validation ([PHASE0B_OPERATIONAL_VALIDATION_REPORT.md](PHASE0B_OPERATIONAL_VALIDATION_REPORT.md)).
4. **Completed on task branch** — BUNSO/Fable 5 M1A Core Contracts implementation (`task/m1a-core-contracts`; **not merged to `main`**).
5. **Current** — M1A Bantay/Codex review, including the owner-directed final blocked-context and manifest hardening correction (D-021).
6. **Pending** — Owner merge approval for M1A.
7. **Pending and not authorized** — M1B Protocol Contracts (requires its own explicit owner GO), then M1C … M1E one at a time, each after owner approval of the previous review.

Earlier project bootstrap and worker onboarding (Codex, BUNSO, Antigravity) are complete and precede item 1.

## Current task detail — M1A review

Under review on branch `task/m1a-core-contracts`: `packages/shared` core contracts (task states, trusted blocked context, legal transitions with evidence corroboration and stage-aware reconciliation, twelve-command grammar, worker-manifest schema) plus exhaustive unit tests.

- Reviewers: Bantay (scope, architecture compliance, safety) and Codex (independent code review, per D-019 — BUNSO cannot review its own implementation).
- Outcome required: review findings resolved, then an explicit owner merge GO before `task/m1a-core-contracts` may merge into `main`.

Owner still to provide (needed before Phase 1 runtime work, not blocking M1A review): the Obsidian vault path (U-7) and the pilot project choice. Cloudflare account status (U-6) is needed only before Phase 2.

## Implementation-worker assignment (per D-019)

- **BUNSO using Fable 5** is temporarily the primary implementation worker while Fable 5 quota remains available.
- **Codex** is the backup and handoff implementation worker during this period, and remains the documented long-term primary implementation worker.
- **BUNSO and Codex must never edit the same files concurrently.** Exactly one implementation worker holds a given file or package at a time; handoff is explicit and owner-visible.
- Because BUNSO cannot independently review its own implementation, review of BUNSO-authored code falls to Bantay and Codex.

## Authorization boundary

M1A work exists only on the task branch; **merging it into `main` requires an explicit owner GO** that has not been given.

**M1B is pending and not authorized.** It requires M1A review completion, owner merge approval, and its own explicit owner GO before any M1B coding begins.

Nothing in this file authorizes runtime orchestration, worker connection, domain or tunnel configuration, server access, MikroTik access, deployment, restart, infrastructure changes, or production actions.
