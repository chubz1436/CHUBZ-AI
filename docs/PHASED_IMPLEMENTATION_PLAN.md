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
- Version control for this planning repository: **already complete** — the owner authorized initialization on 2026-07-10; the repository exists on branch `main` with remote `github.com/chubz1436/CHUBZ-AI`.

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
2. `packages/shared`: Zod schemas for task states/transitions, commands, WS protocol (client↔CP and CP↔bridge), worker manifest, capability grants, capture records, Bridge Log front matter; the shared secret-detector library; unit tests. **(Split into the first Codex subtasks M1A–M1E — see below; Codex receives exactly one at a time.)**
3. `packages/control-plane`: Fastify on `127.0.0.1`; SQLite (WAL) with migrations; session auth (Argon2 password, Phase-1 local); WS hub with event cursors + idempotency keys; command parser; task orchestrator implementing the §10 state machine (including `BLOCKED` reason codes such as `execution-unknown`); queue (1/project, 2 global); approval engine issuing HMAC grants (Phase 1 integrity/anti-replay control — not owner-presence proof; security doc §8.1); worker registry loading manifests; context assembler with denylist + redaction; artifact store with quota/retention rules; Bridge Log projector; Bantay Review Package builder; audit hash chain; CSP + sanitized output rendering + CSRF/WS-Origin controls from the start (security doc §14.1).
4. `packages/local-bridge`: outbound WS client with enrollment + DPAPI storage; grant verifier + **operation journal (journal-before-execution, grant consumption before privileged execution, at-most-once semantics with `execution-unknown` reconciliation)**; workspace manager (**managed project clone**, Git worktrees on branch `task/<id>`, approved-commit + patch finalization — **no writes to the owner's original working copy**); process supervisor (`execa`, timeouts, tree-kill, output caps); **Codex CLI adapter** (per validated U-1) and **manual-relay adapter** (owner-attested, text-output default, explicit artifact import); capture pipeline with second-layer redaction and worker-provenance recording (connector type, executable path, version, hash when available); emergency stop levels 1–3.
5. `packages/web-app`: React + Vite + Tailwind PWA shell; command chat; project/worker selectors; approval cards; relay cards; side panel (Task, Files & Diff, Tests, History, Workers, Settings); emergency stop button; review-package download.
6. All twelve commands functional (`/compare` limited to 2 workers; high-risk categories refused per P-015).

**Excluded scope:** any remote access or tunnel, passkeys (Phase 2), additional CLI adapters, notifications, CPU/memory quotas, semantic-conflict heuristics, multi-project polish.

**Expected files/packages:** the four packages above; `.claude`/CI config as owner permits; no changes to production systems of any kind.

**Assigned workers:** Codex (implementation in bounded tasks), BUNSO (design-conformance code review per milestone), Antigravity (runs the slice on the real PC and reports friction), Bantay (security-relevant diff review: auth, grants, redaction, bridge), Owner (approval at each milestone).

**Suggested milestone order (each a bounded Codex task with its own review; Codex receives exactly one at a time, each dispatched only after owner approval of the previous):** M1A–M1E shared contracts (split defined below) → M2 control-plane skeleton + DB + auth + WS → M3 bridge enrollment + operation journal + supervisor + managed clone/worktrees → M4 orchestrator + grants end-to-end with a fake "echo worker" → M5 Codex CLI adapter + manual relay (owner-attested import flow) → M6 web app chat + approval flow (CSP and sanitized rendering from the start) → M7 capture/diff/tests/review package → M8 Bridge Log projector + emergency stop + hardening pass → **M9 (separately gated): the explicit apply-to-project action** — apply/cherry-pick/export of an approved patch into the owner's real project as its own displayed bounded action with its own approval card; may be deferred to Phase 3 at the owner's choice, with manual patch application as the interim.

**Acceptance criteria (all demonstrated live to the owner on the PC):**

- Owner dispatches a real task to Codex CLI via chat; watches status; reviews diff and tests in the panel; `/go` finalizes the approved task commit and patch in the **managed** repository; a `git status`/checksum check proves the owner's own working copy was untouched; Bridge Log entry appears in the vault; review package downloads.
- Same post-import workflow via manual relay for a second worker (e.g., a Bantay review task), recorded as **owner-attested**, text-output default, with explicit artifact import demonstrated for a file-producing case.
- `/stop` kills a running task cleanly; emergency stop level 2 revokes grants and pauses the queue; restart recovery reconciles correctly.
- At-most-once semantics demonstrated: replayed/duplicated commands are refused with the original result returned; killing the Bridge mid-finalization yields `BLOCKED(execution-unknown)` and an owner-reviewed reconciliation flow that never blindly retries (test + demo).
- A planted fake secret in output is redacted in DB, log, and review package.
- A worker write outside its worktree is flagged and blocks integration.
- `netstat` shows loopback-only listeners.

**Tests:** shared-schema unit tests; state-machine transition table tests (every legal/illegal transition, including `BLOCKED` reason codes); grant verifier tests (signature, expiry, replay, scope, action-hash mismatch); operation-journal tests (`prepared`/`started`/`completed`/`failed`/`execution-unknown` transitions and crash-recovery reconciliation, including Git-state reconciliation); redaction corpus tests; orchestrator integration tests with the echo worker; Playwright E2E of the happy path and the `/stop` path.

**Risks:** Codex CLI behavior drift (mitigation: adapter isolated behind the interface; manual relay keeps system usable); Windows path/process quirks (mitigation: Antigravity validates early on the real PC); scope creep (mitigation: milestone gates, MVP boundary in the design doc).

**Rollback:** delete/park the packages; no external state exists. Each milestone is a Git branch merged only after review.

**STOP POINT:** Phase 1 demo accepted by owner; Bantay security review of M2/M3/M8 diffs complete. No remote exposure yet.

---

## Phase 2 — Secure Remote Control

**Objective:** the owner can operate the system from a phone away from home, through the §5.1 recommended path, with the §18 security-doc checklist fully satisfied.

**Included scope:** passkey (WebAuthn) login + password/TOTP fallback; **Bridge-verifiable owner-presence approval proof** (bridge nonce + WebAuthn assertion independently verified by the Bridge — security doc §8.2) replacing HMAC-only authorization for consequential approvals; **worker privilege containment, moved up from Phase 4 as a hard prerequisite** — dedicated low-privilege Windows worker account or equivalent enforceable ACL boundary, NTFS permissions limiting worker access to managed workspaces, Job Object (or equivalent) process-tree containment, and a demonstrated escape-attempt test (if the CLI worker cannot function under the restricted account, remote worker execution remains disabled pending an explicit recorded owner risk acceptance); browser delivery controls verified (CSP, output sanitization, CSRF, WebSocket Origin checks, Cloudflare Access JWT validation at the Control Plane, service-worker cache rules — security doc §14.1); remote session policy (2 h idle, re-auth for gate decisions); device management + revocation UI; Cloudflare Tunnel + Access setup **by the owner with step-by-step runbook** (the system itself still performs no DNS/tunnel changes); PWA install polish for the phone; the complete pre-remote checklist (security doc §18, items 1–13) executed and evidenced.

**Excluded scope:** new worker adapters; any additional subdomain; notification service; role-based access.

**Expected files/packages:** auth additions in `control-plane` and `web-app`; `docs/RUNBOOK_REMOTE_ACCESS.md` (new, owner-executed steps); no system-performed infrastructure changes.

**Assigned workers:** Codex (auth, approval-proof, and session code), Bantay (security review — blocking), Antigravity (validates tunnel behavior, phone UX, and the restricted worker-account setup on the real PC — this is finicky Windows work), BUNSO (independent review of the auth and approval-proof diffs), Owner (performs Cloudflare steps; final GO to enable — recorded as its own decision, not a `/go`).

**Acceptance criteria:** every §18 checklist item (1–13) passes with evidence — including the approval-proof item (the Control Plane alone demonstrably cannot mint an accepted approval), the privilege-containment escape-attempt test, and the browser-controls item; owner completes a full task cycle from a phone on mobile data; revoking the phone device kills its session live; disabling the tunnel from the Cloudflare dashboard verifiedly severs remote access while local use continues.

**Tests:** WebAuthn ceremony tests (login and approval-proof: wrong nonce, wrong action hash, wrong origin, replayed assertion all rejected by the Bridge); session expiry/re-auth tests; escape-attempt test for the restricted worker account; Playwright remote-flow E2E against the tunnel; negative tests (no Access identity → blocked before app; revoked device → blocked at app).

**Risks:** Cloudflare Access misconfiguration exposing the app (mitigation: checklist item 2 verified by Bantay + a second person test from an unauthorized identity); passkey friction on the owner's phone (mitigation: TOTP fallback); Windows ACL complexity breaking the CLI worker under the restricted account (mitigation: Antigravity validates early; if unresolvable, remote worker execution stays disabled pending an explicit owner risk-acceptance decision).

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

**Included scope:** concurrency raise (e.g., 2/project, 4 global) with the file-overlap Conflict Detector actively blocking colliding finalizations; per-file ownership hints; assumption-trailer capture surfaced in review packages and `/compare`; heuristic risk lint on diffs (new exec/network calls, touched sensitive paths) as **flags only**; notification hook (e.g., push/email "approval waiting") as an outbound-only integration; **further hardening beyond the Phase 2 baseline** (per-worker tuning of the restricted account, CPU/memory quota tuning via Job Objects); NSSM/service-based auto-start; backup/restore automation for the data directory using the SQLite backup mechanism (never file-copying the live WAL database), plus artifact-quota and owner-controlled retention enforcement.

**Excluded scope:** semantic-conflict *resolution* (permanent non-goal); business-system control.

**Assigned workers:** Codex (implementation), Antigravity (operational validation on the real PC), Bantay (review), BUNSO (design updates if reality diverges), Owner (gates).

**Acceptance criteria:** two concurrent tasks in one project with overlapping files → second finalization blocked with a clear card; hardening tuning verified without regressing adapter function; backup/restore drill passes with a SQLite-backup-API snapshot; notifications arrive without opening any inbound port.

**Tests:** concurrency/lock integration tests; backup/restore integrity test; load test at the new concurrency limit.

**Risks:** concurrency exposing latent race conditions in the orchestrator (mitigation: conflict detector blocks colliding finalizations; concurrency is config-revertible instantly).

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

## Recommended First Codex Tasks — Bounded Split `PROPOSED — NOT EXECUTED`

The former single `packages/shared` task is split into five bounded subtasks. **Codex receives exactly one subtask at a time, each dispatched only after owner approval of the previous one's review.** All are pure library code — no network, no filesystem side effects, no framework.

- **M1A — Core contracts:** task states and the legal-transition table (FINAL_ARCHITECTURE_DESIGN.md §10, including `BLOCKED` reason codes), the twelve-command grammar, and the worker manifest schema (§8.3). **Unit tests only** — every legal transition accepted, every illegal transition rejected.
- **M1B — Protocol contracts:** client↔Control-Plane and Control-Plane↔Bridge message envelopes, idempotency keys, event cursors. **Unit tests only.**
- **M1C — Approval-security contracts:** capability-grant schemas; canonical action representation and its stable hash serialization; expiry and replay model; explicit Phase 1 HMAC-limitation documentation in the schema source (security doc §8.1); and the Phase 2 passkey-backed approval-proof contracts — challenge structure binding nonce, action hash, task, attempt, scope, and expiry (§8.2). **Security tests only** — canonicalization stability, replay/expiry rejection, challenge-binding tests.
- **M1D — Redaction library:** context denylist, pattern detectors, entropy detector, test corpus. **No filesystem or network I/O.**
- **M1E — Capture and projection contracts:** capture records including worker-provenance fields (connector type, executable path, version, hash; owner-attested marker for manual relay), artifact metadata with quota/retention fields, Bridge Log front matter, and the review-package manifest + hash format. **Unit tests only.**

Why M1A first: it is the smallest fully bounded start, zero-risk (no I/O), forces the central state-machine ambiguities to surface immediately while the design is fresh, and everything else depends on it. Each subtask is ideally sized review material for Bantay and BUNSO before riskier bridge code begins.

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
