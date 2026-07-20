# Active Tasks

> **STATUS: M1A-M1D ACCEPTED. M1E CAPTURE AND PROJECTION CONTRACTS IS ACTIVE ON `task/m1e-capture-projection-contracts` AFTER EXPLICIT OWNER GO; IT REMAINS UNACCEPTED. M1F, M2, AND LATER MILESTONES ARE NOT STARTED OR AUTHORIZED.**

## Project lifecycle status

1. **Completed** — Architecture design (BUNSO using Fable 5), Bantay review (revisions R1–R7 applied), and owner architecture decisions through D-032.
2. **Completed** — Phase 0A documentation and decision prerequisites.
3. **Completed — conditional pass** — Antigravity Phase 0B operational feasibility validation ([PHASE0B_OPERATIONAL_VALIDATION_REPORT.md](PHASE0B_OPERATIONAL_VALIDATION_REPORT.md)).
4. **Completed** — M1A Core Contracts: implemented, Bantay/Codex reviewed (D-021, D-022 hardening applied), owner-approved, and fast-forward merged into `main`.
5. **Completed** — M1B Protocol Contracts: merged into `main` through `2dc6a12`.
6. **Completed** — M1C Approval-Security Contracts: owner/Bantay accepted after independent security re-review PASS; implementation commits `769677dd7ee876a4ecbda08bb3674b6fa8a9a82a` and `cdffc0170facedb4c9791619a0adabc86e7f6f50` are accepted and merged into `main`.
7. **Completed and accepted** — M1D Redaction Library: owner/Bantay accepted after independent read-only review PASS. Accepted validation recorded 364 tests and successful typecheck. Redaction remains intentionally conservative and best-effort; future policy expansion may add unsupported secret patterns. Runtime context/capture integration remains deferred.
8. **Active and unaccepted** — M1E Capture and Projection Contracts is limited to pure shared contracts on `task/m1e-capture-projection-contracts`; it requires independent review and separate owner acceptance before merge.
9. **Pending and unauthorized** — M1F, M2 onward; each requires separate Bantay review and owner approval.

Earlier project bootstrap and worker onboarding (Codex, BUNSO, Antigravity) are complete and precede item 1.

## Current task — M1E Capture and Projection Contracts (active, unaccepted)

M1E received explicit owner GO and is active on `task/m1e-capture-projection-contracts`; Codex is the current implementation worker. Its scope is pure shared capture-record, provenance, artifact metadata, quota/retention metadata, Bridge Log front-matter, review-package manifest, deterministic digest, safe parser, and export contracts only. M1E parsers can validate the shape of an authoritative snapshot, but parser success is never authority: a future runtime store must independently load and vouch for the snapshot before any evaluator may rely on it. Runtime capture, authoritative snapshot loading, persistence, artifact storage, filesystem or Bridge Log writing, archives, adapters, database, UI, network, deployment, and production behavior are excluded. M1E remains unaccepted pending independent review and separate owner acceptance. M1F, M2, and later milestones remain not started and unauthorized.

## Current task detail — M1D Redaction Library (accepted)

M1D delivered pure shared redaction primitives only: denylist path classification, bounded secret-pattern and entropy candidate detection, safe redaction findings/results, synthetic corpus/adversarial tests, and intentional exports. Owner/Bantay accepted it after independent review PASS; validation recorded 364 tests and successful typecheck. Redaction remains intentionally conservative and best-effort, and future policy expansion may add unsupported secret patterns. Runtime context/capture integration remains deferred. M1E is now active and unaccepted after explicit owner GO; M1F and later milestones remain unauthorized.

Deferred owner inputs (not blockers, per D-022): the Obsidian vault path (U-7) remains configurable, and the pilot project remains uncreated and is needed only when a later runnable workflow requires it. Cloudflare account status (U-6) is needed only before Phase 2.

## Worker assignment and concurrency

- **Codex** is the current primary implementation worker.
- **BUNSO** remains the lead architecture designer and a governing architecture source; it is not the current implementation worker.
- **Bantay** reviews strategy, safety, scope, and prompts. **Antigravity** is secondary and capability-probed until approved.
- No workers may edit the same files concurrently. Handoff is explicit and owner-visible; no worker can override owner or repository policy.

## Authorization boundary

M1A Core Contracts and M1B Protocol Contracts are completed and merged into `main`.

**M1A through M1D are complete and accepted. M1D was accepted after independent review PASS. M1E is active and unaccepted after explicit owner GO.** M1F, M2, and all later milestones remain not started and unauthorized; each requires a separate explicit GO.

Nothing in this file authorizes runtime orchestration, worker connection, domain or tunnel configuration, server access, MikroTik access, deployment, restart, infrastructure changes, or production actions.

## M1D acceptance record

M1D Redaction Library received explicit owner GO, was independently reviewed PASS, and is complete and accepted. Accepted validation recorded 364 tests and successful typecheck. Its scope remains pure denylist classification, bounded pattern/entropy detection, safe redaction contracts, synthetic corpus tests, and public exports. Redaction is intentionally conservative and best-effort; future policy expansion may add unsupported secret patterns. Runtime context/capture integration remains deferred. M1E is active and unaccepted after explicit owner GO; M1F, M2, and later milestones remain not started and unauthorized pending separate explicit owner GO.

This acceptance record supersedes older M1D-pending wording elsewhere in this historical status document.
