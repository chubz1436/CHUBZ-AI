# Active Tasks

> **M8 STATUS (2026-07-23):** M1A-M7 are accepted on `main` at `6e1d206ce36b31a4909fcdae09a63b7e6ddd4136`. The owner authorized the bounded M8 Bridge Log, recovery/reconciliation, and global/project emergency-stop candidate on `task/m8-bridge-log-recovery-emergency-stop`. M8 is active and unaccepted pending independent read-only review and owner acceptance. M9 and later remain unauthorized. See [M8_RECOVERY_AND_EMERGENCY_CONTROLS.md](M8_RECOVERY_AND_EMERGENCY_CONTROLS.md).

> **CURRENT STATUS: M1A-M7 ACCEPTED; M8 RECOVERY AND EMERGENCY-CONTROL CANDIDATE ACTIVE, LOCAL-ONLY, AND UNACCEPTED.**

M8 adds a rebuildable non-authoritative Bridge Log projection, persistent evidence-backed incidents, restart reconciliation that preserves at-most-once execution, and owner-gated global/project emergency stops enforced before Bridge process spawn. It does not add M9 apply or owner-project mutation.

> **M6 ACCEPTANCE (2026-07-22):** The bounded local-only web chat and Kanban milestone independently passed, was owner-accepted, merged, and pushed on `main` at `00904342a685d20eb1f7b9566e9634aa49e9287f`.

> **M5 COMPLETION (2026-07-22):** The Codex CLI adapter and owner-attested manual relay independently passed, were owner-accepted, merged, and pushed on `main` at `3e926486f03223ee93591ca0822568217a26eb2b`.

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
13. **Completed and accepted** — M5 Codex CLI Adapter and Manual Relay, accepted on `main` at `3e926486f03223ee93591ca0822568217a26eb2b`.
14. **Completed and accepted** — M6 Web Chat and Kanban UI, accepted on `main` at `00904342a685d20eb1f7b9566e9634aa49e9287f`.
15. **Completed and accepted** — M7 authoritative evidence capture and immutable review packages, accepted on `main` at `6e1d206ce36b31a4909fcdae09a63b7e6ddd4136`.
16. **Active and unaccepted** — M8 Bridge Log projection, operational recovery/reconciliation, and global/project emergency stop on `task/m8-bridge-log-recovery-emergency-stop`; independent read-only review and separate owner acceptance remain required.

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

**M1A through M7 are complete and accepted.** M8 has explicit owner GO only for the bounded local-only recovery and emergency-control candidate on `task/m8-bridge-log-recovery-emergency-stop`; it remains unaccepted. Codex CLI is the first automated connector and manual relay remains the universal owner-attested fallback. M9 and later remain unauthorized.

Nothing in this file authorizes owner-project integration, domain or tunnel configuration, server access, MikroTik access, deployment, infrastructure change, production action, or M9+ work.

## M1D acceptance record

M1D Redaction Library received explicit owner GO, was independently reviewed PASS, and is complete and accepted. Accepted validation recorded 364 tests and successful typecheck. Its scope remains pure denylist classification, bounded pattern/entropy detection, safe redaction contracts, synthetic corpus tests, and public exports. Redaction is intentionally conservative and best-effort; future policy expansion may add unsupported secret patterns. Runtime context/capture integration remains deferred. M1E and M1F are accepted; M2 and later remain not started and unauthorized.

This acceptance record supersedes older M1D-pending wording elsewhere in this historical status document.
