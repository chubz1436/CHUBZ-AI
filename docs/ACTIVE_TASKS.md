# Active Tasks

> **STATUS: M1A-M1E ACCEPTED. M1F ADAPTER & COORDINATION CONTRACTS HAS EXPLICIT OWNER GO, IS ACTIVE AND UNACCEPTED ON `task/m1f-adapter-coordination-contracts`; M2 AND LATER REMAIN NOT STARTED OR UNAUTHORIZED.**

## Project lifecycle status

1. **Completed** — Architecture design (BUNSO using Fable 5), Bantay review (revisions R1–R7 applied), and owner architecture decisions through D-032.
2. **Completed** — Phase 0A documentation and decision prerequisites.
3. **Completed — conditional pass** — Antigravity Phase 0B operational feasibility validation ([PHASE0B_OPERATIONAL_VALIDATION_REPORT.md](PHASE0B_OPERATIONAL_VALIDATION_REPORT.md)).
4. **Completed** — M1A Core Contracts: implemented, Bantay/Codex reviewed (D-021, D-022 hardening applied), owner-approved, and fast-forward merged into `main`.
5. **Completed** — M1B Protocol Contracts: merged into `main` through `2dc6a12`.
6. **Completed** — M1C Approval-Security Contracts: owner/Bantay accepted after independent security re-review PASS; implementation commits `769677dd7ee876a4ecbda08bb3674b6fa8a9a82a` and `cdffc0170facedb4c9791619a0adabc86e7f6f50` are accepted and merged into `main`.
7. **Completed and accepted** — M1D Redaction Library: owner/Bantay accepted after independent read-only review PASS. Accepted validation recorded 364 tests and successful typecheck. Redaction remains intentionally conservative and best-effort; future policy expansion may add unsupported secret patterns. Runtime context/capture integration remains deferred.
8. **Completed and accepted** — M1E Capture and Projection Contracts passed final independent read-only review. Accepted validation recorded 376 tests and successful typecheck; the work remains pure shared-library contracts only.
9. **Active and unaccepted** — M1F Adapter & Coordination Contracts, on `task/m1f-adapter-coordination-contracts`, with Codex as current implementation worker. Scope is pure shared schemas, safe parsers, evaluators, canonicalization/hash helpers, and synthetic tests; execution, routing, queues, persistence, filesystem/worktrees, network, UI, deployment, and production behavior are excluded. Independent review and separate owner acceptance are required.
10. **Pending and unauthorized** — M2 onward; each requires separate Bantay review and owner approval.

Earlier project bootstrap and worker onboarding (Codex, BUNSO, Antigravity) are complete and precede item 1.

## M1E acceptance record

M1E Capture and Projection Contracts passed final independent read-only review and were accepted by Owner/Bantay. Accepted validation recorded 376 tests and successful typecheck. Its scope remains pure shared capture-record, provenance, artifact metadata, quota/retention metadata, Bridge Log front-matter, review-package manifest, deterministic digest, safe parser, and export contracts only. M1E parsers validate only the shape of an authoritative snapshot: future runtime custody must independently load, scope, and establish authority. Runtime capture, authoritative snapshot loading, persistence, artifact storage, filesystem or Bridge Log writing, archives, adapters, database, UI, network, deployment, and production behavior remain deferred. M1F is now active and unaccepted under its separate owner GO; M2 and later remain not started and unauthorized.

## Current task detail — M1F Adapter & Coordination Contracts (active, unaccepted)

M1F received explicit owner GO. Codex is implementing only shared contracts and synthetic regression tests on `task/m1f-adapter-coordination-contracts`. Recommendations remain distinct from assignments, assignments from dispatch, and dispatch from execution; authoritative runtime snapshots remain a future boundary. M1F does not authorize or contain runtime adapter execution, worker selection, bridges, queues, persistence, SQLite, process control, filesystem/worktree enforcement, quota polling, authentication, UI, deployment, or production work. M1A-M1E remain complete and accepted; M2 and later remain not started and unauthorized. M1F requires independent review and separate owner acceptance before any merge.

## Prior task detail — M1D Redaction Library (accepted)

M1D delivered pure shared redaction primitives only: denylist path classification, bounded secret-pattern and entropy candidate detection, safe redaction findings/results, synthetic corpus/adversarial tests, and intentional exports. Owner/Bantay accepted it after independent review PASS; validation recorded 364 tests and successful typecheck. Redaction remains intentionally conservative and best-effort, and future policy expansion may add unsupported secret patterns. Runtime context/capture integration remains deferred. M1E is accepted; M1F is active and unaccepted under its separate owner GO, while M2 and later remain unauthorized.

Deferred owner inputs (not blockers, per D-022): the Obsidian vault path (U-7) remains configurable, and the pilot project remains uncreated and is needed only when a later runnable workflow requires it. Cloudflare account status (U-6) is needed only before Phase 2.

## Worker assignment and concurrency

- **Codex** is the current primary implementation worker.
- **BUNSO** remains the lead architecture designer and a governing architecture source; it is not the current implementation worker.
- **Bantay** reviews strategy, safety, scope, and prompts. **Antigravity** is secondary and capability-probed until approved.
- No workers may edit the same files concurrently. Handoff is explicit and owner-visible; no worker can override owner or repository policy.

## Authorization boundary

M1A Core Contracts and M1B Protocol Contracts are completed and merged into `main`.

**M1A through M1E are complete and accepted. M1F has explicit owner GO and is active but unaccepted on `task/m1f-adapter-coordination-contracts`; its scope is contracts and tests only.** M2 and all later milestones remain not started and unauthorized. M1F requires independent review and separate owner acceptance before merge.

Nothing in this file authorizes runtime orchestration, worker connection, domain or tunnel configuration, server access, MikroTik access, deployment, restart, infrastructure changes, or production actions.

## M1D acceptance record

M1D Redaction Library received explicit owner GO, was independently reviewed PASS, and is complete and accepted. Accepted validation recorded 364 tests and successful typecheck. Its scope remains pure denylist classification, bounded pattern/entropy detection, safe redaction contracts, synthetic corpus tests, and public exports. Redaction is intentionally conservative and best-effort; future policy expansion may add unsupported secret patterns. Runtime context/capture integration remains deferred. M1E is complete and accepted; M1F is active and unaccepted under its separate owner GO, while M2 and later remain not started and unauthorized.

This acceptance record supersedes older M1D-pending wording elsewhere in this historical status document.
