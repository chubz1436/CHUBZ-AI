# Worker Roles

> **STATUS: PLANNED — NOT YET IMPLEMENTED**
>
> **Temporary assignment in force (D-019):** BUNSO using Fable 5 is the temporary primary implementation worker while Fable 5 quota remains available. Codex is the backup and handoff implementation worker during this period and remains the documented long-term primary implementer. **BUNSO and Codex must never edit the same files concurrently.** Because BUNSO cannot independently review its own implementation, review of BUNSO-authored code falls to Bantay and Codex. The table below describes the long-term steady state.
>
> Once the worker registry exists, manifests become the authoritative worker-role definition and this file becomes a projection of them (D-011).

| Worker | Planned responsibility | Boundary |
| --- | --- | --- |
| Kenneth / CHUBZ | Project owner, priority setter, and final GO/NO-GO approver | Final authority when workers disagree |
| Claude Code / BUNSO using Fable 5 | Lead and final designer for the initial architecture package; proposes the complete architecture, technology stack, interfaces, security model, task model, approval model, and phased implementation roadmap | Must address Codex, BUNSO, and Antigravity onboarding findings; cannot begin implementation, deployment, infrastructure configuration, or production access without separate owner approval; afterward remains a separate backup implementer and independent reviewer when assigned |
| Bantay / ChatGPT | Architecture, safety, risk, and scope-control reviewer; prompt architect | Reviews BUNSO's design and reports findings and recommended corrections to the owner; does not create a competing design unless the owner requests one; is not an implementation worker |
| Codex | Primary implementation worker after BUNSO completes the design, Bantay reviews it, and Kenneth / CHUBZ approves it | Implements only approved, bounded phases and must not substitute an unapproved competing architecture |
| Antigravity using Gemini 3.1 Pro High | Operational, local-runtime, repository-inspection, and validation worker | Read-only by default; validates practicality on the owner's Windows PC after an approved design exists |
| Opus inside Antigravity | Coding worker only when specifically assigned | Separate from Claude Code / BUNSO; has no default coding or design authority |
| Santos using Hermes Agent | Separate specialized agent and optional backup worker; planned invocation: `/santos` | Invoked only through an assigned task and approved scope; not combined with another worker |

These identities remain separate: Claude Code / BUNSO is not Opus inside Antigravity; Antigravity is not Claude Code; Santos is not combined with another worker; and Bantay is not an implementation worker. Future workers are planned to register through a plug-in registry that declares identity, capabilities, context needs, and permissions. Task isolation and conflict detection should prevent silent overlap between workers.
