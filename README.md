# CHUBZ AI Command Center

> M10 implementation candidate active (2026-07-23): M1A-M9 are accepted on `main` at `df62ae84164ba8abffbaf9447d85f55de2332222`. The current branch adds deterministic recommendation-first routing, quota confidence, exact owner route confirmation, and plan-only fallback. Recommendations never dispatch or grant capability. M10 is not accepted until independent read-only review and owner acceptance; M11+ remains excluded. See [docs/M10_ROUTING_QUOTA_AND_FALLBACK.md](docs/M10_ROUTING_QUOTA_AND_FALLBACK.md).

> **STATUS: M1A-M9 ACCEPTED; M10 ROUTING CANDIDATE ACTIVE, LOCAL-ONLY, AND UNACCEPTED**

CHUBZ AI Command Center is a local-first AI command ecosystem. M1A–M9 provide the accepted task, grant, Bridge, UI, evidence, recovery, emergency-stop, and exact reviewed-commit apply baseline. The M10 candidate adds owner-visible routing recommendations without automatic dispatch or fallback; remote access remains later and separately gated.

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

M1A through M9 are accepted on `main` at `df62ae84164ba8abffbaf9447d85f55de2332222`. The owner granted bounded M10 GO on July 23, 2026. The local M10 candidate is implemented on `task/m10-routing-quota-fallback`; it remains unaccepted pending independent review and owner acceptance. M11 and later remain excluded.

## Planning-only domain map

- `ai.ichubz.com` (the only future Phase 2 hostname)

All other proposed subdomains are deferred. No DNS, hosting, tunnel, authentication, or deployment configuration has been performed.

## Start here

Read [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/M10_ROUTING_QUOTA_AND_FALLBACK.md](docs/M10_ROUTING_QUOTA_AND_FALLBACK.md), and [docs/SAFETY_AND_APPROVALS.md](docs/SAFETY_AND_APPROVALS.md). The required next activity after the local M10 candidate commit and validation is an independent read-only M10 review.
