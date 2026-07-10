# Decisions

> **STATUS: PLANNED — NOT YET IMPLEMENTED**

This file is the initial decision log. Entries describe planning intent, not completed functionality.

## D-001 — Local-first control plane

- **Status:** Proposed
- **Decision:** Prefer a local PC bridge and keep remotely accessible surfaces narrow and permissioned.
- **Reason:** Local ownership and explicit boundaries reduce uncontrolled access.

## D-002 — Chat-first and automation-first UX

- **Status:** Proposed
- **Decision:** Use conversational control plus discoverable slash commands and repeatable workflows.

## D-003 — Traceable, isolated worker tasks

- **Status:** Proposed
- **Decision:** Isolate assignments, capture responses and diffs automatically, detect conflicts, and produce Obsidian-compatible Bridge Log records.

## D-004 — Extensible workers

- **Status:** Proposed
- **Decision:** Design a future worker plug-in registry instead of hard-coding every worker integration.

## D-005 — Initial architecture design authority and review workflow

- **Status:** ACCEPTED BY OWNER
- **Decision date:** 2026-07-10
- **Decision:** BUNSO using Fable 5 is the lead and final designer for the initial architecture package. Bantay is the architecture, safety, scope, and risk reviewer. Kenneth / CHUBZ gives final approval. Codex implements only after design review and owner approval. Antigravity validates operational practicality after a design exists.
- **Boundary:** This decision assigns design and review authority only; it does not authorize implementation, deployment, infrastructure configuration, or production access.
