# CHUBZ AI Command Center

> **STATUS: PLANNED — NOT YET IMPLEMENTED**

CHUBZ AI Command Center is envisioned as a local-first, remotely accessible AI command ecosystem. It will give Kenneth / CHUBZ one chat-style interface for coordinating multiple specialized AI workers while retaining explicit ownership, isolation, traceability, and final approval.

The planned experience is both chat-first and automation-first: people can issue natural-language requests or slash commands, while repeatable workflows can load context, dispatch isolated tasks, capture responses and diffs, detect worker conflicts, and write Bridge Log records automatically.

## Planned workers

- Bantay / ChatGPT — architecture, safety, scope, prompt, and review assistance.
- Codex — primary implementation worker.
- Claude Code / BUNSO — separate backup implementation worker and independent reviewer.
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

No application functionality exists yet. This repository currently contains planning documentation and placeholders only.

## Planning-only domain map

- `ai.ichubz.com`
- `bridge.ichubz.com`
- `auth.ichubz.com`
- `files.ichubz.com`
- `docs.ichubz.com`
- `status.ichubz.com`

These names are references only; no DNS, hosting, tunnel, authentication, or deployment configuration has been performed.

## Start here

Read [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/SAFETY_AND_APPROVALS.md](docs/SAFETY_AND_APPROVALS.md). The recommended next activity is read-only onboarding of every planned worker.
