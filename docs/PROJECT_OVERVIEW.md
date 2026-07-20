# Project Overview

> **STATUS: PROJECT REFERENCE — M1A/M1B CONTRACTS MERGED; RUNTIME NOT YET IMPLEMENTED**

## Vision

CHUBZ AI Command Center is planned as the owner's single command surface for a group of AI workers. It should remain local-first, allow carefully controlled remote access, and keep Kenneth / CHUBZ as the final GO/NO-GO authority.

## Experience principles

- **Chat-first:** use one conversation-style interface to request, review, and approve work.
- **Automation-first:** turn safe, repeatable actions into visible workflows with explicit gates.
- **Traceable:** capture prompts, responses, decisions, diffs, approvals, and outcomes.
- **Isolated:** give each task a bounded workspace and identify worker overlap before changes combine.
- **Context-aware:** load only relevant, approved context automatically for each worker and task.

## Planned workers

The separate planned workers are Bantay / ChatGPT, Codex, Claude Code / BUNSO, Antigravity with Gemini 3.1 Pro High, Santos using Hermes Agent, and Opus inside Antigravity when specifically assigned. Santos is a specialized agent and optional backup worker with its own planned `/santos` invocation; it is not part of another worker.

## Planned primary commands

These commands are planning concepts only. No parser or command system has been implemented.

- `/codex` — send a task to Codex.
- `/claude` — send a task to Claude Code / BUNSO.
- `/antigravity` — send an operational or assigned coding task to Antigravity.
- `/santos` — invoke the separate Santos / Hermes worker profile.
- `/bantay` — request architecture, safety, scope, prompt, or review assistance.
- `/compare` — compare selected worker outputs.
- `/go` — approve only the currently displayed bounded action.
- `/stop` — stop or cancel the current task.
- `/status` — show worker and task status.
- `/files` — show captured task files.
- `/diff` — show the current task diff.
- `/review` — request review of a completed result.

A general `/go` does not authorize deployment, production changes, database writes, MikroTik actions, credential access, DNS changes, or server restarts. Each requires specific confirmation for the exact action.

The planned outputs include an automatic Bridge Log: Obsidian-compatible Markdown records that document task history without requiring manual transcription.
