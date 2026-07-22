# CHUBZ AI Command Center

> **STATUS: M1A-M5 ACCEPTED; M6 WEB CHAT AND KANBAN CANDIDATE ACTIVE, LOCAL-ONLY, AND UNACCEPTED**

CHUBZ AI Command Center is a local-first AI command ecosystem. M6 gives Kenneth / CHUBZ one local chat-style interface for coordinating bounded worker tasks while retaining explicit ownership, isolation, traceability, and final approval. Remote access remains a later, separately gated phase.

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

- A local web control panel for M6 conversations, authoritative tasks, approvals, and worker status. Diff and review-package capture remain M7 work.
- A local PC bridge that mediates approved access to local tools and files.
- Automatic, task-scoped context loading and response/diff capture.
- Task isolation plus detection of overlapping or conflicting worker changes.
- Automatic Bridge Log records in Markdown suitable for Obsidian.
- A future plug-in registry for adding workers without coupling them to the core.

M1A through M5 are accepted on `main` at `3e926486f03223ee93591ca0822568217a26eb2b`. The owner granted bounded M6 GO on July 22, 2026. The local M6 candidate is implemented on `task/m6-web-chat-kanban-ui`; it remains unaccepted pending independent review and owner acceptance. M7 and later remain unauthorized.

## Planning-only domain map

- `ai.ichubz.com` (the only future Phase 2 hostname)

All other proposed subdomains are deferred. No DNS, hosting, tunnel, authentication, or deployment configuration has been performed.

## Start here

Read [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/SAFETY_AND_APPROVALS.md](docs/SAFETY_AND_APPROVALS.md), and the [BUNSO Experiment Adoption Plan](docs/architecture/BUNSO_EXPERIMENT_ADOPTION_PLAN.md). The required next activity after the local M6 candidate commit and validation is an independent read-only M6 review.
