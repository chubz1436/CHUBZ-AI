# Active Tasks

> **M6 STATUS (2026-07-22):** M1A-M5 are accepted on `main` at `3e926486f03223ee93591ca0822568217a26eb2b`. The owner authorized the bounded, local-only M6 web chat and Kanban milestone on `task/m6-web-chat-kanban-ui`. M6 remains unaccepted pending independent read-only review and owner acceptance. M7 and later remain unauthorized.

> **M5 COMPLETION (2026-07-22):** The Codex CLI adapter and owner-attested manual relay independently passed, were owner-accepted, merged, and pushed on `main` at `3e926486f03223ee93591ca0822568217a26eb2b`.

> **STATUS: M1A-M5 ACCEPTED; M6 WEB CHAT AND KANBAN CANDIDATE ACTIVE, LOCAL-ONLY, AND UNACCEPTED.**

## Project lifecycle status

1. **Completed** — Architecture design (BUNSO using Fable 5), Bantay review (revisions R1–R7 applied), and owner architecture decisions through D-032.
2. **Completed** — Phase 0A documentation and decision prerequisites.
3. **Completed — conditional pass** — Antigravity Phase 0B operational feasibility validation ([PHASE0B_OPERATIONAL_VALIDATION_REPORT.md](PHASE0B_OPERATIONAL_VALIDATION_REPORT.md)).
4. **Completed** — M1A Core Contracts: implemented, Bantay/Codex reviewed (D-021, D-022 hardening applied), owner-approved, and fast-forward merged into `main`.
5. **Completed** — M1B Protocol Contracts: merged into `main` through `2dc6a12`.
6. **Completed** — M1C Approval-Security Contracts: owner/Bantay accepted after independent security re-review PASS; implementation commits `769677dd7ee876a4ecbda08bb3674b6fa8a9a82a` and `cdffc0170facedb4c9791619a0adabc86e7f6f50` are accepted and merged into `main`.
7. **Completed and accepted** — M1D Redaction Library: owner/Bantay accepted after independent read-only review PASS. Accepted validation recorded 364 tests and successful typecheck. Redaction remains intentionally conservative and best-effort; future policy expansion may add unsupported secret patterns. Runtime context/capture integration remains deferred.
8. **Completed and accepted** — M1E Capture and Projection Contracts passed final independent read-only review. Accepted validation recorded 376 tests and successful typecheck; the work remains pure shared-library contracts only.
9. **Completed and accepted** — M1F Adapter & Coordination Contracts passed comprehensive independent Claude Sonnet 4.6 review PASS. Accepted validation recorded 395 passing tests and successful typecheck. It remains pure shared schemas, parsers, evaluators, canonicalization/hash helpers, and synthetic tests only; runtime behavior remains deferred.
10. **Completed and accepted** — M2 Control Plane Foundation, accepted on `main` through `13993fc583507509437d2f6121c70eddd3198bfd`.
11. **Completed and accepted** — M3 Local Bridge Foundation independently passed, was owner-accepted, merged, and pushed on `main` at `4474b8a7d3f37c8c53319d88bfc22ad7e352109e`.
12. **Completed and accepted** — M4 Orchestrator and Capability Grants independently passed, was owner-accepted, merged, and pushed on `main` at `2a6c678ca6b4cc107aacb3bd2f81910609c4ad8d`.
13. **Active and unaccepted** — M5 Codex CLI Adapter and Manual Relay on `task/m5-codex-manual-relay`, starting exactly from `2a6c678ca6b4cc107aacb3bd2f81910609c4ad8d`; independent read-only adapter/security/reliability review and separate owner acceptance remain required.

Earlier project bootstrap and worker onboarding (Codex, BUNSO, Antigravity) are complete and precede item 1.

## M1E acceptance record

M1E Capture and Projection Contracts passed final independent read-only review and were accepted by Owner/Bantay. Accepted validation recorded 376 tests and successful typecheck. Its scope remains pure shared capture-record, provenance, artifact metadata, quota/retention metadata, Bridge Log front-matter, review-package manifest, deterministic digest, safe parser, and export contracts only. M1E parsers validate only the shape of an authoritative snapshot: future runtime custody must independently load, scope, and establish authority. Runtime capture, authoritative snapshot loading, persistence, artifact storage, filesystem or Bridge Log writing, archives, adapters, database, UI, network, deployment, and production behavior remain deferred. M1F is accepted; M2 and later remain not started and unauthorized.

## M1F acceptance record

M1F Adapter & Coordination Contracts are accepted after comprehensive independent Claude Sonnet 4.6 review PASS. Accepted validation recorded 395 passing tests and successful typecheck. Recommendations, assignments, dispatch, execution, and completion remain distinct; authoritative snapshots remain a future runtime boundary. Adapter execution, routing, runtime leases and quotas, event streams, journal persistence, telemetry, Bridge, database, filesystem, UI, and network behavior remain deferred. M1A-M1F are complete and accepted; M2 and later remain not started and unauthorized, and M2 requires a separate explicit owner GO.

**Deferred LOW hardening:** re-evaluate `readOnlyPaths` wildcard overlap with `generatedArtifactRoot` before runtime write-scope enforcement. It is non-blocking because `readOnlyPaths` grants no write authority. This note does not authorize M2 or runtime implementation.

## Prior task detail — M1D Redaction Library (accepted)

M1D delivered pure shared redaction primitives only: denylist path classification, bounded secret-pattern and entropy candidate detection, safe redaction findings/results, synthetic corpus/adversarial tests, and intentional exports. Owner/Bantay accepted it after independent review PASS; validation recorded 364 tests and successful typecheck. Redaction remains intentionally conservative and best-effort, and future policy expansion may add unsupported secret patterns. Runtime context/capture integration remains deferred. M1E and M1F are accepted; M2 and later remain unauthorized.

Deferred owner inputs (not blockers, per D-022): the Obsidian vault path (U-7) remains configurable, and the pilot project remains uncreated and is needed only when a later runnable workflow requires it. Cloudflare account status (U-6) is needed only before Phase 2.

## Worker assignment and concurrency

- **Codex** is the current primary implementation worker.
- **BUNSO** remains the lead architecture designer and a governing architecture source; it is not the current implementation worker.
- **Bantay** reviews strategy, safety, scope, and prompts. **Antigravity** is secondary and capability-probed until approved.
- No workers may edit the same files concurrently. Handoff is explicit and owner-visible; no worker can override owner or repository policy.

## Authorization boundary

M1A Core Contracts and M1B Protocol Contracts are completed and merged into `main`.

**M1A through M4 are complete and accepted.** M5 has explicit owner GO only for the bounded local-only Codex CLI adapter and owner-attested manual-relay implementation on `task/m5-codex-manual-relay`; it remains unaccepted. Codex CLI is the first automated connector and manual relay remains the universal owner-attested fallback. M6 and later remain unauthorized.

Nothing in this file authorizes owner-project integration, domain or tunnel configuration, server access, MikroTik access, deployment, restart, infrastructure change, production action, or M6+ work.

## M1D acceptance record

M1D Redaction Library received explicit owner GO, was independently reviewed PASS, and is complete and accepted. Accepted validation recorded 364 tests and successful typecheck. Its scope remains pure denylist classification, bounded pattern/entropy detection, safe redaction contracts, synthetic corpus tests, and public exports. Redaction is intentionally conservative and best-effort; future policy expansion may add unsupported secret patterns. Runtime context/capture integration remains deferred. M1E and M1F are accepted; M2 and later remain not started and unauthorized.

This acceptance record supersedes older M1D-pending wording elsewhere in this historical status document.
