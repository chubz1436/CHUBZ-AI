# Phased Implementation Plan

> **STATUS: PROPOSED PLAN — AWAITING BANTAY REVIEW AND OWNER APPROVAL**
>
> Author: Claude Code / BUNSO (Fable 5), per accepted decision D-005.
> Date: 2026-07-10
> This plan authorizes nothing by itself. Each phase begins only after Bantay review of the prior phase's output and an explicit owner GO for that phase. Implementation is performed by Codex unless the owner assigns otherwise.

Worker roles throughout (per D-005): **Codex** implements; **BUNSO** reviews design conformance and acts as independent reviewer / backup implementer; **Bantay** reviews security, scope, and completeness; **Antigravity** validates operational feasibility on the real PC; **Opus inside Antigravity** codes only if specifically assigned; **Santos** optional backup on bounded tasks; **Kenneth / CHUBZ** approves every phase gate.

---

## Phase 0 — Design Acceptance and Local Prerequisites

**Objective:** convert this design package into owner-accepted decisions and verify the PC is ready — without writing application code.

**Included scope**

- Bantay review of the three design documents; BUNSO responds to findings; owner accepts/rejects/amends proposed decisions P-006 … P-018 (recorded in `docs/DECISIONS.md` by whoever the owner authorizes to edit it).
- Antigravity feasibility validation on the actual PC (read-only + trivially reversible checks only):
  - Confirm Node.js LTS, pnpm, and Git availability/installability (A-5).
  - **Validate U-1** (Codex CLI non-interactive invocation) and **U-2** (Claude Code CLI headless invocation) with harmless "hello" runs in a scratch directory.
  - Report exact working command lines into the worker manifests' draft `invocation` fields.
- Owner provides: Obsidian vault path (U-7), the pilot project choice, confirmation the pilot project is (or may become) a Git repository (A-2), Cloudflare account status (U-6 — needed only before Phase 2).
- Decision: authorize `git init` for this planning repo itself so all later phases have version control (currently not a repo; separately gated per mission restrictions).

**Excluded scope:** any application code, package manifests, dependency installation into the project, framework initialization, domain/tunnel configuration.

**Expected files/packages:** updates to `docs/DECISIONS.md` and worker profile invocation notes only (owner-authorized edits; not by BUNSO under the current mission).

**Assigned workers:** Bantay (review), BUNSO (findings response), Antigravity (validation), Owner (decisions).

**Acceptance criteria:** all P-decisions resolved to Accepted/Amended/Rejected; U-1/U-2 answered (even if the answer is "not workable — start manual-relay-only"); pilot project and vault path named.

**Tests:** none (no code).
**Risks:** design churn delaying start → time-box review to one round plus one revision.
**Rollback:** none needed — documents only.
**STOP POINT:** no Phase 1 work until owner GO on the resolved decision set.

---

## Phase 1 — Local-Only Vertical Slice (the MVP)

**Objective:** prove the entire loop — command → context → dispatch → capture → diff → approval → integration → Bridge Log → review package — on localhost, with one project, one CLI worker, and manual relay for everyone else.

**Included scope**

1. Monorepo scaffold: pnpm workspaces; packages `shared`, `control-plane`, `local-bridge`, `web-app`; TypeScript strict; Vitest; lockfile committed.
2. `packages/shared`: Zod schemas for task states/transitions, commands, WS protocol (client↔CP and CP↔bridge), worker manifest, capability grants, capture records, Bridge Log front matter; the shared secret-detector library; unit tests. **(First Codex task — see below.)**
3. `packages/control-plane`: Fastify on `127.0.0.1`; SQLite (WAL) with migrations; session auth (Argon2 password, Phase-1 local); WS hub with event cursors + idempotency keys; command parser; task orchestrator implementing the §10 state machine; queue (1/project, 2 global); approval engine issuing HMAC grants; worker registry loading manifests; context assembler with denylist + redaction; artifact store; Bridge Log projector; Bantay Review Package builder; audit hash chain.
4. `packages/local-bridge`: outbound WS client with enrollment + DPAPI storage; grant verifier + consumption journal; workspace manager (Git worktrees, branch `task/<id>`, merge integration); process supervisor (`execa`, timeouts, tree-kill, output caps); **Codex CLI adapter** (per validated U-1) and **manual-relay adapter**; capture pipeline with second-layer redaction; emergency stop levels 1–3.
5. `packages/web-app`: React + Vite + Tailwind PWA shell; command chat; project/worker selectors; approval cards; relay cards; side panel (Task, Files & Diff, Tests, History, Workers, Settings); emergency stop button; review-package download.
6. All twelve commands functional (`/compare` limited to 2 workers; high-risk categories refused per P-015).

**Excluded scope:** any remote access or tunnel, passkeys (Phase 2), additional CLI adapters, notifications, CPU/memory quotas, semantic-conflict heuristics, multi-project polish.

**Expected files/packages:** the four packages above; `.claude`/CI config as owner permits; no changes to production systems of any kind.

**Assigned workers:** Codex (implementation in bounded tasks), BUNSO (design-conformance code review per milestone), Antigravity (runs the slice on the real PC and reports friction), Bantay (security-relevant diff review: auth, grants, redaction, bridge), Owner (approval at each milestone).

**Suggested milestone order (each a bounded Codex task with its own review):** M1 shared schemas → M2 control-plane skeleton + DB + auth + WS → M3 bridge enrollment + supervisor + worktrees → M4 orchestrator + grants end-to-end with a fake "echo worker" → M5 Codex CLI adapter + manual relay → M6 web app chat + approval flow → M7 capture/diff/tests/review package → M8 Bridge Log projector + emergency stop + hardening pass.

**Acceptance criteria (all demonstrated live to the owner on the PC):**

- Owner dispatches a real task to Codex CLI via chat; watches status; reviews diff and tests in the panel; `/go` merges it; Bridge Log entry appears in the vault; review package downloads.
- Same flow via manual relay for a second worker (e.g., Bantay review task).
- `/stop` kills a running task cleanly; emergency stop level 2 revokes grants and pauses the queue; restart recovery reconciles correctly.
- Replayed/duplicated commands provably execute once (test + demo).
- A planted fake secret in output is redacted in DB, log, and review package.
- A worker write outside its worktree is flagged and blocks integration.
- `netstat` shows loopback-only listeners.

**Tests:** shared-schema unit tests; state-machine transition table tests (every legal/illegal transition); grant verifier tests (signature, expiry, replay, scope, action-hash mismatch); redaction corpus tests; orchestrator integration tests with the echo worker; Playwright E2E of the happy path and the `/stop` path.

**Risks:** Codex CLI behavior drift (mitigation: adapter isolated behind the interface; manual relay keeps system usable); Windows path/process quirks (mitigation: Antigravity validates early on the real PC); scope creep (mitigation: milestone gates, MVP boundary in the design doc).

**Rollback:** delete/park the packages; no external state exists. Each milestone is a Git branch merged only after review.

**STOP POINT:** Phase 1 demo accepted by owner; Bantay security review of M2/M3/M8 diffs complete. No remote exposure yet.

---

## Phase 2 — Secure Remote Control

**Objective:** the owner can operate the system from a phone away from home, through the §5.1 recommended path, with the §18 security-doc checklist fully satisfied.

**Included scope:** passkey (WebAuthn) login + password/TOTP fallback; remote session policy (2 h idle, re-auth for gate decisions); device management + revocation UI; Cloudflare Tunnel + Access setup **by the owner with step-by-step runbook** (the system itself still performs no DNS/tunnel changes); PWA install polish for the phone; the complete pre-remote checklist (SECURITY_AND_THREAT_MODEL.md §18) executed and evidenced.

**Excluded scope:** new worker adapters; any additional subdomain; notification service; role-based access.

**Expected files/packages:** auth additions in `control-plane` and `web-app`; `docs/RUNBOOK_REMOTE_ACCESS.md` (new, owner-executed steps); no system-performed infrastructure changes.

**Assigned workers:** Codex (auth + session code), Bantay (security review — blocking), Antigravity (validates tunnel behavior and phone UX with the owner), BUNSO (independent review of the auth diff), Owner (performs Cloudflare steps; final GO to enable — recorded as its own decision, not a `/go`).

**Acceptance criteria:** all ten §18 checklist items pass with evidence; owner completes a full task cycle from a phone on mobile data; revoking the phone device kills its session live; disabling the tunnel from Cloudflare dashboard verifiedly severs remote access while local use continues.

**Tests:** WebAuthn ceremony tests; session expiry/re-auth tests; Playwright remote-flow E2E against the tunnel; negative tests (no Access identity → blocked before app; revoked device → blocked at app).

**Risks:** Cloudflare Access misconfiguration exposing the app (mitigation: checklist item 2 verified by Bantay + a second person test from an unauthorized identity); passkey friction on the owner's phone (mitigation: TOTP fallback).

**Rollback:** disable the tunnel (single Cloudflare action) → system reverts to Phase-1 local-only posture instantly.

**STOP POINT:** remote access enabled only after the checklist evidence is reviewed by Bantay and the owner records explicit GO.

---

## Phase 3 — Additional Worker Adapters

**Objective:** move workers up the connector ladder from manual relay toward automation, one at a time, without destabilizing the slice.

**Included scope:** Claude Code CLI adapter (per validated U-2); Antigravity and Santos remain manual-relay unless U-3/U-4 produce a real mechanism (re-validated here); optional `http-api` connector type implementation if the owner decides U-5 (API-based review worker); `/compare` widened to 3 workers; worker health checks per manifest; connector-tier honesty surfaced in UI (already designed) verified against reality.

**Excluded scope:** browser-controlled connectors (remain `DEFERRED`); concurrency increases; business-system integrations.

**Expected files/packages:** adapter modules in `local-bridge`; manifest updates; no core protocol changes (protocol stability is itself an acceptance criterion).

**Assigned workers:** Codex (adapters), BUNSO (adapter interface conformance review; may implement one adapter as backup worker if owner assigns), Antigravity (validates each adapter on the PC), Bantay (review), Owner (gates).

**Acceptance criteria:** each new adapter passes the same E2E suite as the Codex adapter with only manifest/adapter changes; a deliberately hung worker is timed out, killed, and reported correctly; `/compare` across three workers produces a usable side-by-side with overlap warnings.

**Tests:** adapter contract test suite (shared, run against every adapter including manual relay); timeout/cancel tests per adapter.

**Risks:** each external CLI changes its flags over time (mitigation: adapters are thin, manifests carry invocation config, manual relay is the permanent fallback).

**Rollback:** disable a worker's manifest → it drops back to manual relay; no core impact.

**STOP POINT:** owner decides which workers are "automated enough"; no obligation to automate all.

---

## Phase 4 — Advanced Automation and Conflict Handling

**Objective:** raise concurrency safely and deepen automation without weakening gates.

**Included scope:** concurrency raise (e.g., 2/project, 4 global) with the file-overlap Conflict Detector actively blocking colliding integrations; per-file ownership hints; assumption-trailer capture surfaced in review packages and `/compare`; heuristic risk lint on diffs (new exec/network calls, touched sensitive paths) as **flags only**; notification hook (e.g., push/email "approval waiting") as an outbound-only integration; process hardening — dedicated low-privilege Windows account for worker processes with NTFS ACLs, and/or Job Object CPU/memory caps (addresses residual risk R-1); NSSM/service-based auto-start; backup/restore automation for the data directory.

**Excluded scope:** semantic-conflict *resolution* (permanent non-goal); business-system control.

**Assigned workers:** Codex (implementation), Antigravity (validates the restricted-account setup on the real PC — this is finicky Windows work), Bantay (review, especially the hardening), BUNSO (design updates if reality diverges), Owner (gates).

**Acceptance criteria:** two concurrent tasks in one project with overlapping files → second integration blocked with a clear card; worker under the restricted account cannot write outside its worktree (verified by a deliberate escape attempt test); notifications arrive without opening any inbound port.

**Tests:** concurrency/lock integration tests; ACL escape-attempt test; load test at the new concurrency limit.

**Risks:** Windows ACL complexity breaking legitimate worker behavior (mitigation: per-worker opt-in to the restricted account; supervised mode remains available).

**Rollback:** concurrency limits are config; hardening is per-worker opt-in; every feature independently revertible.

**STOP POINT:** owner review of whether added automation actually reduced their workload (the UX requirement is the metric).

---

## Phase 5 — Future Ecosystem Integrations `DEFERRED`

**Objective (directional only):** carefully considered extension toward the owner's wider systems — each item is its own future design + review + decision cycle, **not** authorized by this plan.

**Candidate scope (each requires its own gate design first):** read-only status surfaces for business systems; new gate types with typed confirmation phrases for operate-class actions (per SECURITY_AND_THREAT_MODEL.md §9); additional owner-approved subdomains (`files`, `status`) if genuinely needed; possible multi-user roles; possible hybrid topology (Control Plane on a home server).

**Explicitly still excluded until individually designed and approved:** MikroTik/router control, ISP billing, PisoWiFi, payroll, solar, EV, CCTV, DNS automation, server restarts, database writes, credential management.

**Assigned workers:** future assignment; BUNSO expected to design each extension's architecture; Bantay to review; owner to gate.

**Acceptance criteria / tests / rollback:** defined per future design.

**STOP POINT:** built into the structure — nothing here begins without a new owner-approved design.

---

## Recommended First Codex Implementation Task `PROPOSED — NOT EXECUTED`

> **Task:** Implement `packages/shared` v1: Zod schemas + inferred TypeScript types for (a) task states and the legal-transition table from FINAL_ARCHITECTURE_DESIGN.md §10, (b) the twelve-command grammar, (c) client↔control-plane and control-plane↔bridge WebSocket message envelopes with idempotency keys and event cursors, (d) the worker manifest (§8.3), (e) capability grants and their canonical-hash serialization (SECURITY_AND_THREAT_MODEL.md §8), (f) capture-record and Bridge-Log front-matter shapes, plus (g) the shared secret-detector library with its test corpus. Pure library code — no network, no filesystem side effects, no framework. Deliverable: package + exhaustive unit tests (every legal transition accepted, every illegal transition rejected; grant canonicalization stable; detector corpus passing).

Why this first: it is fully bounded, zero-risk (no I/O), forces every ambiguity in the contracts to surface immediately while the design is fresh, and everything else in Phase 1 depends on it. It is also ideal review material for Bantay and BUNSO before riskier bridge code begins.

---

## Phase-Gate Summary

| Phase | Gate to enter | Gate to exit |
|---|---|---|
| 0 | Owner GO on this package post-Bantay review | Decisions resolved; U-1/U-2 answered |
| 1 | Owner GO + accepted decisions | Live demo + acceptance list + security reviews |
| 2 | Owner GO | §18 checklist evidenced; explicit remote-enable decision |
| 3 | Owner GO | Adapter contract suite green per adapter |
| 4 | Owner GO | Concurrency + hardening acceptance tests |
| 5 | New design cycle per item | Per item |

*Companion documents: [FINAL_ARCHITECTURE_DESIGN.md](FINAL_ARCHITECTURE_DESIGN.md), [SECURITY_AND_THREAT_MODEL.md](SECURITY_AND_THREAT_MODEL.md).*
