# CHUBZ AI Command Center

> M9 implementation candidate active (2026-07-23): M1A-M8 are accepted on `main` at `10c080ce7a9a8441444b1f17ff1c904d58697a4a`. The current branch adds verified exact-commit eligibility, isolated prepare/validation, and separately owner-confirmed compare-and-swap promotion. M9 is not accepted until independent read-only review and owner acceptance; M10+ remains excluded.

> **STATUS: M1A-M8 ACCEPTED; M9 SAFE APPLY CANDIDATE ACTIVE, LOCAL-ONLY, AND UNACCEPTED**

CHUBZ AI Command Center is a local-first AI command ecosystem. M1A–M8 provide the accepted task, grant, Bridge, UI, evidence, recovery, and emergency-stop baseline. The M9 candidate adds one exact verified-commit path with isolated preparation and separately confirmed atomic promotion; remote access remains a later, separately gated phase.

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

M1A through M8 are accepted on `main` at `10c080ce7a9a8441444b1f17ff1c904d58697a4a`. The owner granted bounded M9 GO on July 23, 2026. The local M9 candidate is implemented on `task/m9-safe-apply-cherry-pick`; it remains unaccepted pending independent review and owner acceptance. M10 and later remain excluded.

## Planning-only domain map

- `ai.ichubz.com` (the only future Phase 2 hostname)

All other proposed subdomains are deferred. No DNS, hosting, tunnel, authentication, or deployment configuration has been performed.

## Start here

Read [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/M9_SAFE_APPLY_AND_PROMOTION.md](docs/M9_SAFE_APPLY_AND_PROMOTION.md), and [docs/SAFETY_AND_APPROVALS.md](docs/SAFETY_AND_APPROVALS.md). The required next activity after the local M9 candidate commit and validation is an independent read-only M9 review.
