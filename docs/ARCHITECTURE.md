# Architecture

> **STATUS: PLANNED — NOT YET IMPLEMENTED**

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

The proposed domain split is `ai`, `bridge`, `auth`, `files`, `docs`, and `status` under `ichubz.com`. No networking, DNS, hosting, authentication, or tunnel design has been implemented or configured.
