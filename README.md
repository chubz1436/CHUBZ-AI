# CHUBZ AI Command Center

> **STATUS: M1A-M4 ACCEPTED; M5 CODEX CLI ADAPTER AND MANUAL RELAY ACTIVE, LOCAL-ONLY, AND UNACCEPTED**

CHUBZ AI Command Center is envisioned as a local-first, remotely accessible AI command ecosystem. It will give Kenneth / CHUBZ one chat-style interface for coordinating multiple specialized AI workers while retaining explicit ownership, isolation, traceability, and final approval.

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

- A web control panel for conversations, tasks, approvals, diffs, and worker status.
- A local PC bridge that mediates approved access to local tools and files.
- Automatic, task-scoped context loading and response/diff capture.
- Task isolation plus detection of overlapping or conflicting worker changes.
- Automatic Bridge Log records in Markdown suitable for Obsidian.
- A future plug-in registry for adding workers without coupling them to the core.

M1A through M4 are accepted. M4 was independently passed, owner-accepted, merged, and pushed on `main` at `2a6c678ca6b4cc107aacb3bd2f81910609c4ad8d`. The owner granted bounded M5 GO on July 22, 2026; its Codex CLI adapter and owner-attested manual-relay implementation is active, local-only, and unaccepted on `task/m5-codex-manual-relay`, starting from that exact M4 baseline. Codex CLI is the first automated connector and manual relay remains the universal owner-attested fallback. M6 and later remain unauthorized. Current architecture alignment and milestone status are maintained in [docs/ACTIVE_TASKS.md](docs/ACTIVE_TASKS.md) and [docs/PHASED_IMPLEMENTATION_PLAN.md](docs/PHASED_IMPLEMENTATION_PLAN.md).

## Planning-only domain map

- `ai.ichubz.com` (the only future Phase 2 hostname)

All other proposed subdomains are deferred. No DNS, hosting, tunnel, authentication, or deployment configuration has been performed.

## Start here

Read [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/SAFETY_AND_APPROVALS.md](docs/SAFETY_AND_APPROVALS.md), and the [BUNSO Experiment Adoption Plan](docs/architecture/BUNSO_EXPERIMENT_ADOPTION_PLAN.md). The required next activity after the local M5 implementation commit and validation is an independent read-only M5 adapter/security/reliability review.
