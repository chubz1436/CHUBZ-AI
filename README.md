# CHUBZ AI Command Center

> **STATUS: M1A-M6 ACCEPTED; M7 EVIDENCE CAPTURE AND REVIEW-PACKAGE CANDIDATE ACTIVE, LOCAL-ONLY, AND UNACCEPTED**

CHUBZ AI Command Center is a local-first AI command ecosystem. M6 provides the accepted local interaction surface; M7 adds authoritative managed-worktree Git/process evidence and immutable sanitized review packages without applying changes to owner projects. Remote access remains a later, separately gated phase.

The planned experience is both chat-first and automation-first: people can issue natural-language requests or slash commands, while repeatable workflows can load context, dispatch isolated tasks, capture responses and diffs, detect worker conflicts, and write Bridge Log records automatically.

## Planned workers

- Bantay / ChatGPT — architecture, safety, scope, prompt, and review assistance.
- Codex — primary implementation worker.
- Claude Code / BUNSO — lead architecture designer and governing architecture source; implementation or review only when explicitly assigned.
- Antigravity with Gemini 3.1 Pro High — operational investigation, validation, and specifically assigned coding.
- Santos using Hermes Agent — specialized agent and optional backup worker, invoked through the planned `/santos` command.
- Opus inside Antigravity — coding only when specifically assigned.

Santos is a separate worker and is not part of Antigravity, Claude Code / BUNSO, Codex, or Bantay. The primary planning-only command vocabulary is maintained in [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md#planned-primary-commands).

## Planned system

- A local web control panel for conversations, authoritative tasks, approvals, worker status, and M7 evidence/package inspection.
- A local PC bridge that mediates approved access to local tools and files.
- Automatic, task-scoped context loading and response/diff capture.
- Task isolation plus detection of overlapping or conflicting worker changes.
- Automatic Bridge Log records in Markdown suitable for Obsidian.
- A future plug-in registry for adding workers without coupling them to the core.

M1A through M6 are accepted on `main` at `00904342a685d20eb1f7b9566e9634aa49e9287f`. The owner granted bounded M7 GO on July 22, 2026. The local M7 candidate is implemented on `task/m7-capture-review-packages`; it remains unaccepted pending independent review and owner acceptance. M8 and later remain unauthorized.

## Planning-only domain map

- `ai.ichubz.com` (the only future Phase 2 hostname)

All other proposed subdomains are deferred. No DNS, hosting, tunnel, authentication, or deployment configuration has been performed.

## Start here

Read [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/M7_EVIDENCE_AND_REVIEW_PACKAGES.md](docs/M7_EVIDENCE_AND_REVIEW_PACKAGES.md), and [docs/SAFETY_AND_APPROVALS.md](docs/SAFETY_AND_APPROVALS.md). The required next activity after the local M7 candidate commit and validation is an independent read-only M7 review.
