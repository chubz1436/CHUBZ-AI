# Active Tasks

> **STATUS: DESIGN ACCEPTED — PHASE 0B OPERATIONAL VALIDATION IS CURRENT AND NOT YET EXECUTED. NO IMPLEMENTATION AUTHORIZED.**
>
> **Phase 0 is NOT complete.** Phase 0A (documentation and decision prerequisites) is completed. Phase 0B (operational feasibility validation) has not been executed. Phase 0 is complete only after Phase 0B passes and Kenneth / CHUBZ reviews the validation report.

No implementation task is active. No application code exists. No Phase 0B validation has been performed.

## Project lifecycle status

1. **Completed** — Architecture design (BUNSO using Fable 5).
2. **Completed** — Bantay architecture review (required revisions R1–R7, all applied).
3. **Completed** — Owner architecture decisions (D-001 … D-019 accepted 2026-07-10).
4. **Completed** — Phase 0A documentation and decision prerequisites.
5. **Current / Not yet executed** — **Antigravity Phase 0B operational feasibility validation.**
6. **Pending** — Owner review of the Phase 0B validation report.
7. **Pending** — Owner GO for Phase 1.
8. **Pending and not authorized** — **BUNSO/Fable 5 M1A Core Contracts**, followed by M1B … M1E one at a time, each after owner approval of the previous review.

Earlier project bootstrap and worker onboarding (Codex, BUNSO, Antigravity) are complete and precede item 1.

## Current task detail — Antigravity Phase 0B operational feasibility validation

**Not yet executed.** Read-only and trivially reversible checks only, per [PHASED_IMPLEMENTATION_PLAN.md](PHASED_IMPLEMENTATION_PLAN.md) Phase 0B:

- Assess the Windows environment on the owner's actual PC.
- Confirm Node.js LTS, pnpm, and Git availability or installability.
- Verify filesystem permissions for the intended data, managed-clone, and worktree directories.
- **Validate U-1** — the Codex CLI non-interactive invocation — with a harmless run in a scratch directory.
- **Validate U-2** — the Claude Code CLI headless invocation — likewise.
- Verify process-management assumptions: spawn, timeout, and reliable process-tree termination.
- Assess connector feasibility per worker and report the exact working command lines for the worker manifests' draft `invocation` fields.
- Report any Windows-specific friction affecting process supervision or Git worktrees.

Antigravity produces a validation report; the owner reviews it before any Phase 1 GO.

Owner still to provide: the Obsidian vault path (U-7), the pilot project choice, and confirmation that the pilot project is or may become a Git repository. Cloudflare account status (U-6) is needed only before Phase 2.

## Implementation-worker assignment (per D-019)

- **BUNSO using Fable 5** is temporarily the primary implementation worker while Fable 5 quota remains available.
- **Codex** is the backup and handoff implementation worker during this period, and remains the documented long-term primary implementation worker.
- **BUNSO and Codex must never edit the same files concurrently.** Exactly one implementation worker holds a given file or package at a time; handoff is explicit and owner-visible.
- Because BUNSO cannot independently review its own implementation, review of BUNSO-authored code falls to Bantay and Codex.

## Authorization boundary

Item #5 authorizes Antigravity's read-only Phase 0B validation only — and that validation has not yet been executed.

Item #8 (M1A Core Contracts) is **pending and not authorized.** It requires Phase 0B to pass, owner review of the validation report, and a separate explicit owner GO for Phase 1 before any coding begins.

Nothing in this file authorizes application coding, framework initialization, dependency installation, AI worker connection, domain or tunnel configuration, server access, MikroTik access, deployment, restart, infrastructure changes, or production actions.
