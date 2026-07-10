# Security and Threat Model

> **STATUS: PROPOSED DESIGN — AWAITING BANTAY REVIEW AND OWNER APPROVAL**
>
> Author: Claude Code / BUNSO (Fable 5), per accepted decision D-005.
> Date: 2026-07-10
> Companion to [FINAL_ARCHITECTURE_DESIGN.md](FINAL_ARCHITECTURE_DESIGN.md). Design only — no configuration, deployment, or operational action is authorized by this document.

---

## 1. Assets to Protect

Ordered by consequence of compromise:

1. **The owner's PC itself** — arbitrary code execution on it is total compromise (it also reaches the home network, MikroTik gear, and other business systems).
2. **Owner authentication credentials** (passkeys, sessions, Cloudflare Access identity) — grant remote command authority.
3. **Bridge enrollment credential and grant-signing key** — forging either defeats the approval system.
4. **Project source code and files** on disk.
5. **Provider secrets** (worker CLI logins/API keys held by tools like Codex/Claude CLIs).
6. **Captured history** (prompts, responses, diffs, audit log) — sensitive business context; also integrity matters (audit must be tamper-evident).
7. **The `ichubz.com` domain/Cloudflare account** (Phase 2) — controls the front door.
8. **Availability** of the command center (lowest priority; it controls nothing life-critical and the MVP has no production authority to lose).

## 2. Trust Boundaries

```mermaid
flowchart LR
    B1[Internet / owner's browser] -->|TB-1: Cloudflare Access identity wall| B2[Cloudflare edge]
    B2 -->|TB-2: outbound tunnel to loopback| B3[Control Plane]
    B3 -->|TB-3: authenticated bridge WS + grants| B4[Local Bridge]
    B4 -->|TB-4: process + workspace boundary| B5[Worker process]
    B5 -->|TB-5: worktree scope| B6[Project files / rest of PC]
```

- **TB-1** Internet → Cloudflare Access: only the owner's authenticated identity passes (Phase 2). In Phase 1 this boundary is "loopback only" — nothing crosses it.
- **TB-2** Cloudflare → Control Plane: `cloudflared` originates outbound; Control Plane listens on `127.0.0.1` only and additionally validates its own session — Cloudflare Access is a wall, not the only wall.
- **TB-3** Control Plane → Bridge: mutual authentication (bridge enrollment credential + server identity pinning); every privileged instruction must carry a valid capability grant.
- **TB-4** Bridge → worker process: supervised child process; pinned cwd/env; timeout; tree-kill. *Not* a strong sandbox in MVP — see Residual Risks.
- **TB-5** Worker → filesystem: worker is told to operate in its worktree and its grant covers only that path; enforcement in MVP is supervision + post-hoc detection (capture diffs any out-of-scope writes it detects via configured watch paths), hardened later with a restricted OS account.

**The web app is untrusted display code.** It holds no secrets, signs nothing, and every command it sends is re-validated by the Control Plane.

## 3. Threat Actors

| Actor | Capability | Interest |
|---|---|---|
| Internet opportunist / scanner | Mass exploitation of exposed ports and login pages | Any foothold |
| Targeted remote attacker | Phishing the owner, credential stuffing, tunnel/domain account takeover | Control of the PC / business systems |
| Malicious or compromised worker output | Prompt-injected or hostile model output: harmful code, instructions embedded in context, attempts to widen scope | Escaping the workspace, exfiltrating secrets, poisoning approvals |
| Compromised dependency (supply chain) | Malicious npm package executing inside CP or Bridge | Same as above, with high privilege |
| Person with physical/local access to the PC | Full local control | Everything |
| The owner (error, not malice) | Fatigued approvals, mis-typed commands | Accidental damage |

## 4. Main Attack Paths and Mitigations

| # | Path | Mitigations |
|---|---|---|
| AP-1 | Internet → exposed port on PC | **Eliminated structurally**: no inbound listener; loopback binding; outbound-only tunnel and bridge |
| AP-2 | Internet → stolen owner session → remote commands | Cloudflare Access + in-app passkey (two independent walls), short sessions, device revocation, every consequential action still requires a fresh in-app approval, full audit |
| AP-3 | Worker output injects instructions ("also run this command / approve this") | Workers never talk to the gate: approval cards render only Control-Plane-derived facts (diff stats, file lists), never worker-authored action text; grants are owner-initiated only; worker text is displayed as inert content |
| AP-4 | Worker writes outside its workspace | cwd/env pinning, workspace-scoped grant, changed-path capture compared against scope (out-of-scope writes flag the task and block integration), later: restricted worker OS account |
| AP-5 | Malicious code merged after weak review | Diff always shown before `/go`; tests surfaced; risk flags (files touched outside declared intent, new network/exec calls flagged by heuristic lint in Phase 4); Bantay Review Package for second opinion; owner remains the gate |
| AP-6 | Secret leakage into prompts/logs/review packages | Context denylist + dual-layer redaction + redaction events (§11); provider secrets never enter the data path at all |
| AP-7 | Forged approvals / replayed grants | HMAC-signed, single-use, ≤10-min, action-hash-bound grants; bridge-side consumption journal; clock-skew tolerance ±2 min (§8) |
| AP-8 | Supply-chain compromise of a dependency | Lockfile-pinned versions, minimal dependency set, `pnpm audit` in CI, no postinstall scripts where avoidable, dependency review as an explicit implementation-phase checklist item |
| AP-9 | Cloudflare account takeover | Owner account hardening prerequisite (MFA on Cloudflare) before Phase 2 go-live; in-app auth remains a second wall even if the edge falls |
| AP-10 | Duplicate/replayed remote commands after reconnect | Idempotency keys end-to-end + bridge journal — replay returns the original result |

## 5. Web-to-Local-Bridge Risks (the critical chain)

The chain Browser → Control Plane → Bridge → process execution is the reason this system needs a threat model. Controls in sequence:

1. Browser input is data, never code: strict schema validation (Zod) on every message; commands are an enum, not free-form shell.
2. Control Plane authorizes: session validity, project scope, task state legality, gate policy — before anything reaches the Bridge.
3. The Bridge trusts no instruction on connection identity alone: privileged operations (dispatch, integrate, delete workspace, kill) each require a matching grant. A fully compromised Control Plane can therefore still only do what fresh grants would allow — and grants require the signing key.
4. Worker invocations are parameterized: adapters build argument arrays (`execa` without shell), never string-concatenated shell commands; owner text is passed as prompt content, not as command-line-interpreted material.
5. Everything is journaled on both sides for post-incident reconstruction.

## 6. Authentication Model

| Layer | Phase 1 (local only) | Phase 2 (remote) |
|---|---|---|
| Network reachability | Loopback only | Cloudflare Access (email OTP or IdP; owner-only policy) in front of the tunnel |
| Application login | Owner password (Argon2id) on `http://localhost` | **Passkey (WebAuthn)** primary; password+TOTP fallback |
| Session | HttpOnly, Secure, SameSite=Strict cookie; idle timeout 24 h local | Idle timeout 2 h remote; absolute lifetime 14 days; re-auth (passkey tap) required for gate decisions on remote sessions |
| WebSocket auth | Session cookie validated at upgrade + per-connection nonce token; server closes on session revocation | Same |
| Device management | Device record per registered browser; owner can list and revoke; revocation kills sessions and WS immediately | Same, plus new-device registration requires an existing authenticated session or physical access to the PC |
| Future staff roles | Data model has `role`; MVP hardcodes owner-only. Role checks are written at every gate from day one so adding roles later is additive, not a rewrite | `DEFERRED` |

All authentication events (success, failure, revocation, new device) are audit events. Raw provider secrets are never sent to or stored in the browser.

## 7. Bridge Identity

- Enrollment: on first setup, the owner (locally, physically at the PC) runs a bridge enroll step; the Control Plane issues a one-time enrollment code, exchanged for a long-lived **bridge credential** (random 256-bit token or keypair).
- Storage: bridge credential and the Control Plane's grant-signing key are stored via **Windows DPAPI** (user-scoped encryption), never in plaintext config or the repo.
- Connection: bridge authenticates every WS connection with its credential; Control Plane pins the expected bridge id; a second bridge cannot enroll without a new owner-initiated enrollment.
- Rotation: credentials rotatable from Settings; rotation revokes the old immediately.

## 8. Authorization and Capability Grants

The enforcement primitive for every consequential action:

```
grant = {
  grantId, approvalDecisionId, taskId, attemptId,
  gate: read | write-workspace | integrate | dispose | ...,
  actionHash: SHA-256 of the canonical bounded-action description
              (exactly what was displayed on the approval card),
  scope: { projectId, workspacePath | branch | artifact ids },
  issuedAt, expiresAt (≤ 10 min), singleUse: true
}
signature = HMAC-SHA-256(controlPlaneSigningKey, canonical(grant))
```

Bridge verification (all must pass): signature; expiry (±2 min skew tolerance); grant not in consumed journal (then atomically journaled as consumed); requested operation's own canonical hash equals `actionHash`; scope containment (paths inside the named workspace).

Properties: **task-bound, action-bound, time-bound, single-use, dual-verified.** A generic `/go` cannot leak authority because the grant encodes the exact displayed action — approving "merge task/42" cannot be replayed as "delete workspace" or reused tomorrow.

Routine automatic operations (creating a worktree for an owner-dispatched task, capturing output) use system-issued grants tied to the dispatch itself, so even "automatic" bridge work follows the same verified format.

## 9. Approval Enforcement per Gate

| Gate / category | MVP enforcement |
|---|---|
| Read (context loading, status) | Allowed within declared project context sources only; denylist paths excluded; all loads recorded |
| Write (workspace) | Auto-granted per dispatch, **scoped to the task worktree only** |
| Test/build execution | Runs inside the worktree under the dispatch grant, subject to timeout and output caps; commands recorded |
| Integrate (merge to project) | Requires explicit `/go` on a displayed card → integration grant |
| Deploy / operate | **REFUSED in MVP** (P-015): not routed to a gate; the command errors with "not implemented" |
| Production actions, database ops, MikroTik/router, DNS/tunnel changes, server restart, credential access | **REFUSED in MVP**, same mechanism. Future design must give each its own gate type, its own approval card wording, and a typed confirmation phrase distinct from `/go` |
| Destructive Git (force-push, history rewrite, branch deletion outside task branches) | **REFUSED** — adapters and the bridge's Git layer have no code path for them |
| Emergency stop | Never gated; always allowed; cannot be disabled remotely |

A general `/go` therefore *cannot* silently authorize deployment, production writes, database writes, MikroTik actions, DNS changes, credential access, server restarts, or unrelated future actions — those actions have no executable path in the MVP at all, and post-MVP each gets a distinct grant type that `/go` does not issue.

## 10. Secret Storage

- System secrets (bridge credential, signing key, session keys): Windows DPAPI, user scope, on the PC only.
- Provider secrets (worker CLI logins, API keys): remain wherever the worker tool stores them; **the command center never reads, stores, transports, or proxies them.** Adapters invoke tools that are already authenticated on the PC.
- Nothing secret in: the browser, SQLite, artifacts, Bridge Log, review packages, or the repo. `.env` files are prohibited by mission restriction and unnecessary in this design (config file + DPAPI blobs instead).
- Backups of the data directory are documented as containing captured project content (sensitive) but no credentials.

## 11. Secret Redaction

Two independent passes — Control Plane (outbound context) and Bridge (captured output) — both **before persistence**, sharing one detector library in `packages/shared`:

1. **Denylist exclusion** (strongest): `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, wallet/keystore patterns, and owner-configurable additions are never readable as context sources and are dropped from capture with a redaction event.
2. **Pattern detectors:** known key formats (cloud provider key IDs/prefixes, generic `api[_-]?key\s*[:=]`, bearer/JWT structure, PEM blocks, connection-string URIs with embedded passwords, password-like assignments).
3. **Entropy heuristic:** long high-entropy tokens in captured output flagged and masked (`•••redacted-<detector>•••`).
4. Every hit → `SecretRedactionEvent` (detector, location class, count — never the value). Review packages display total redaction counts as a risk flag.
5. Honest limitation: redaction is best-effort defense in depth, not a guarantee; the primary control is keeping secret-bearing files out of scope (layer 1) and provider secrets out of the data path entirely (§10).

## 12. Process Isolation

- Each worker attempt: separate child process, cwd pinned to its worktree, private TEMP, minimal environment (no inherited secrets beyond what the worker tool itself requires), manifest timeout, output-size caps, process-tree termination on cancel/timeout/shutdown.
- Bridge runs as the owner's user in MVP — **stated honestly: this is supervision, not a sandbox** (see Residual Risks R-1). Phase 4 hardening option: dedicated low-privilege Windows account for worker processes with NTFS ACLs limiting it to worktree paths, and/or Windows Job Objects for CPU/memory caps.
- Bridge and Control Plane are separate OS processes; compromise of the CP process does not directly grant file/process execution rights (must still present valid grants over TB-3).

## 13. Filesystem Boundaries

- Declared roots only: each Project declares its root path; the Bridge refuses operations outside `projectRoot`, `worktrees/`, and the artifact/data directory (canonical-path prefix checks; symlink/junction resolution before checks; UNC and drive-relative path forms normalized).
- Task writes belong in the task worktree; detected out-of-scope changes flag the attempt and block integration.
- The repo's own docs and the Obsidian vault are written only by the projector, only within configured paths.
- The denylist (§11) applies to reads even inside project roots.

## 14. Network Boundaries

- Control Plane: listens on `127.0.0.1:<port>` only, in every phase. Remote reachability exists solely through the outbound `cloudflared` process (Phase 2, after prerequisites in §18).
- Bridge: zero listening sockets; outbound connections limited to the Control Plane loopback endpoint (and, for future `http-api` connectors, explicitly allowlisted provider hosts per manifest).
- Workers: a worker process may make its own provider connections (that is how CLI agents work); this is accepted and recorded — the manifest documents each worker's expected network behavior, and this is a known residual risk (R-2), not a hidden one.
- No LAN exposure in any phase unless the owner separately decides it (would be a new decision, not a default).

## 15. Audit Requirements

- Append-only `AUDIT_EVENT` table, hash-chained (each event stores the previous event's hash) → tampering is detectable by chain verification.
- Audited: every command (with idempotency key), every state transition, every approval request/decision/expiry, every grant issue/consume/deny, auth events, device changes, bridge connect/disconnect/enroll/rotate, redaction events, emergency stops, out-of-scope write flags, config changes.
- Clock: single-host timestamps (UTC, monotonic sequence ids) — no distributed clock problem in MVP.
- Retention: never auto-deleted in MVP; export supported.
- The audit chain is included (summarized) in review packages so external review can see the full action history.

## 16. Emergency Stop

Three escalating levels, all owner-initiated, none gated, all audited:

1. **`/stop`** — cancel the current task: kill its process tree, mark partial capture, release its locks.
2. **Emergency Stop (red button / `/stop all`)** — kill *all* worker process trees, revoke every outstanding grant, pause the dispatch queue (new dispatches refuse until owner resumes), keep the UI and capture alive for inspection.
3. **Hard stop (local only)** — a bridge-side console command / desktop shortcut that terminates the Bridge supervisor itself (and optionally the Control Plane and `cloudflared`), independent of the web stack — usable even if the web app or Control Plane is misbehaving. Because the Bridge holds no inbound sockets, stopping these processes returns the PC to a fully disconnected state.

Recovery from stop: on Bridge restart, the journal reconciles — orphaned processes are killed, half-captured attempts marked `partial`, queue stays paused until the owner resumes.

## 17. Incident Recovery

1. Contain: emergency stop level 2 or 3; if remote compromise suspected, disable the Cloudflare tunnel/Access from the Cloudflare dashboard (kills all remote reachability without touching the PC).
2. Revoke: all devices/sessions from Settings (or directly in SQLite if the UI is untrusted); rotate bridge credential and signing key.
3. Reconstruct: verify audit hash chain; review Command/Audit events and bridge journal around the incident window; diff project repos against last-known-good commits (Git history is itself a recovery asset).
4. Restore: project files from Git; system state from data-directory backup if needed.
5. Record: incident note linked from the Bridge Log; corrective decisions go to the decision log.

## 18. Security Controls Required BEFORE Remote Access Is Enabled (Phase 2 gate)

Remote access must not be turned on until every item is verified:

1. Passkey login implemented, tested from the owner's actual phone, with password+TOTP fallback and device revocation working.
2. Cloudflare Access policy restricting `ai.ichubz.com` to the owner's identity; Cloudflare account itself protected with MFA.
3. Control Plane still bound to loopback only; verified no other listening ports were introduced (netstat check documented as an acceptance test).
4. Capability grants + bridge journal verified end-to-end, including replay and expiry tests.
5. Session hardening: Secure/HttpOnly/SameSite cookies, idle/absolute timeouts, re-auth for gate decisions on remote sessions.
6. Secret redaction active on both layers with tests; denylist verified against the real project root.
7. Emergency stop levels 1–3 tested, including recovery.
8. Audit chain verification tool passing.
9. Backup of data directory + restore drill performed once.
10. Bantay security review of the Phase 2 implementation diff; owner GO recorded for enabling the tunnel (this is a deploy/operate-class decision and gets its own explicit approval, not a `/go`).

## 19. Residual Risks (accepted honestly, ranked)

| # | Residual risk | Why it remains | Mitigation posture |
|---|---|---|---|
| R-1 | **Worker processes run with the owner's user privileges in MVP** — a truly malicious worker/toolchain could act outside supervision before detection | Windows lacks a cheap namespace sandbox; restricted-account ACL setup deferred to keep MVP achievable | Trusted worker tools only; diffs reviewed before integration; Phase 4 hardening planned; owner informed this is the largest accepted risk |
| R-2 | Worker tools make their own internet connections and hold their own provider credentials | That is how CLI agents function | Manifest documents expected behavior; provider secrets never transit the command center |
| R-3 | Redaction is best-effort; a novel secret format could slip into a capture | Pattern/entropy detection cannot be complete | Denylist-first design; redaction events reviewed; review packages human-checked before external sharing |
| R-4 | Cloudflare (Phase 2) can technically observe tunneled traffic | TLS terminates at their edge | No credentials in the data path; acceptable for command/diff traffic; Tailscale fallback documented if the owner's posture changes |
| R-5 | Physical access to the PC defeats everything | Out of scope for application architecture | Owner's existing physical/OS security; DPAPI at least binds secrets to the Windows account |
| R-6 | Owner approval fatigue → rubber-stamped `/go` | Human factor | Cards kept short/specific, risk flags prominent, high-risk categories refused outright rather than relying on attention |
| R-7 | Supply-chain compromise of npm dependencies | Ecosystem reality | Minimal deps, lockfiles, audit in CI, update discipline in the implementation plan |

---

*Companion documents: [FINAL_ARCHITECTURE_DESIGN.md](FINAL_ARCHITECTURE_DESIGN.md), [PHASED_IMPLEMENTATION_PLAN.md](PHASED_IMPLEMENTATION_PLAN.md).*
