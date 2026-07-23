# Architecture

> **M9 candidate note (2026-07-23):** M1A-M8 are accepted on `main` at `10c080ce7a9a8441444b1f17ff1c904d58697a4a`. The Control Plane verifies and persists exact M7 eligibility and owner gates; the outbound-only Bridge alone performs isolated exact-commit preparation, validation, and compare-and-swap ref promotion. Owner working copies are never execution workspaces, conflicts fail closed, and push/deployment remain unavailable. See [M9_SAFE_APPLY_AND_PROMOTION.md](M9_SAFE_APPLY_AND_PROMOTION.md).

> **M8 candidate note (2026-07-23):** Control Plane SQLite state and the independent Local Bridge operation journal remain authoritative. Bridge Log Markdown is a bounded, sanitized, rebuildable projection only. Persistent recovery incidents describe operational uncertainty without creating execution authority. Global/project emergency stops are authoritative Control Plane state and are rechecked by the outbound-only Bridge immediately before process spawn. Release never auto-resumes or retries blocked work. See [M8_RECOVERY_AND_EMERGENCY_CONTROLS.md](M8_RECOVERY_AND_EMERGENCY_CONTROLS.md).

> **Historical M7 boundary (now accepted):** M7 established the runtime-evidence and immutable review-package authority split described below. M8 and the current unaccepted M9 candidate extend that accepted foundation without changing it.

## M7 authority split

The Control Plane persists capture identity, eligibility, lifecycle, failure/limitation metadata, package bindings, idempotency, restart reconciliation, ownership checks, and browser/WebSocket projections. The outbound-only Local Bridge observes Git and supervised process state only inside managed clones and exact per-attempt worktrees, constructs bounded sanitized canonical packages beneath managed-data roots, and never uses or mutates owner working copies. Finalized packages are immutable and independently hash-verifiable. Worker claims, system observations, owner-attested manual evidence, and reviewer conclusions remain separate categories. See [M7_EVIDENCE_AND_REVIEW_PACKAGES.md](M7_EVIDENCE_AND_REVIEW_PACKAGES.md).

At the M7 boundary, Bridge Log/Obsidian projection, recovery controls, project apply/integration, routing, deployment, and remote access were excluded. M8 later added the accepted Bridge Log, recovery, and emergency-stop controls; only the bounded M9 exact-commit apply candidate described above is now active. Routing, deployment, and remote access remain excluded.

> **STATUS: ARCHITECTURE REFERENCE — M1A-M8 ACCEPTED; M9 SAFE APPLY CANDIDATE ACTIVE AND UNACCEPTED**

## Planned components

1. **Web control panel** — chat, worker selection, task state, approvals, captured responses, and diffs.
2. **Local PC bridge** — a narrowly permissioned broker between the control panel and approved local workers, tools, and files.
3. **Task orchestrator** — automatic context loading, isolated dispatch, result collection, and approval routing.
4. **Capture and audit layer** — automatic response and diff capture plus Bridge Log entries in Obsidian-compatible Markdown.
5. **Conflict detector** — warns when workers touch overlapping scope, files, decisions, or assumptions.
6. **Worker plug-in registry** — a future manifest-driven way to add worker capabilities and permission profiles.

## Planned interaction flow

The owner starts in chat or invokes a slash command. The system creates an isolated task, loads approved task context, assigns one or more workers, captures outputs and diffs, flags conflicts, and pauses at the required approval gate. Approved outcomes are recorded in the Bridge Log.

## Planning-only endpoints

The accepted future Phase 2 hostname is `ai.ichubz.com`; `bridge`, `auth`, `files`, `docs`, and `status` remain deferred under D-008. No networking, DNS, hosting, authentication, or tunnel design has been implemented or configured.
