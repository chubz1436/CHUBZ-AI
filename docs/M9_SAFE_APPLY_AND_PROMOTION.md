# M9 Safe Apply and Promotion

> **Status (2026-07-23): active implementation candidate, not accepted.** M1A–M8 are accepted on `main` at `10c080ce7a9a8441444b1f17ff1c904d58697a4a`. M9 is implemented only on `task/m9-safe-apply-cherry-pick` pending independent read-only review and owner acceptance. M10 and later remain excluded.

## Authority and eligible source

The Control Plane remains authoritative for ownership, immutable M7 package binding, eligibility, one-use prepare capability consumption, lifecycle state, owner confirmation, idempotency, evidence, incidents, and browser/WebSocket projection. The outbound-only Local Bridge remains the only Git/process execution boundary. M9 adds no inbound Bridge listener.

Only a finalized `captured` M7 package with verified package/manifest hashes, exact owner/project/task/attempt/operation/worker/adapter binding, system-observed provenance, stable Git refs, neutralized capture configuration, no execution-unknown marker, no manual-relay provenance, no redaction or limitation, and a complete safe changed-path manifest is eligible. The package must identify one exact commit whose direct parent is the reviewed baseline. Worker prose never establishes eligibility. Commit ranges and bounded patches are deliberately unsupported in this candidate and fail closed.

Repository paths are enrolled through the internal outbound-Bridge boundary. Browser APIs accept project identifiers, a strict `refs/heads/...` target ref, expected target HEAD, package ID, and a predeclared validation-plan ID; they never accept repository paths, arbitrary commands, patches, or shell text.

## Two phases

### Prepare

The owner first creates an immutable plan, then separately consumes a short-lived, one-use capability for isolated preparation. The Bridge rechecks emergency-stop state before every external Git/process boundary, verifies source and target repository identities, verifies the exact source commit and path set, checks the expected target ref, and inspects every target worktree.

Preparation refuses a target branch checked out in any owner worktree. Other dirty or untracked owner worktrees are observed by digest and must remain byte/status-identical; M9 never resets, cleans, stashes, checks out over, or writes into them. Work occurs in a detached per-operation worktree beneath the approved managed root. Source/target/apply roots must be canonical, disjoint, contained beneath the approved operational root, and free of symlinks, junctions, and reparse points.

Git runs with system/global configuration, hooks, external diff, prompting, and global attributes disabled. Repository-local hooks/filter/fsmonitor/custom diff or merge-driver configuration, filter attributes, symlinks, submodules, forbidden paths, unsafe refs, and repository overlap are rejected. The exact reviewed commit is fetched without updating `FETCH_HEAD`, then cherry-picked with signing disabled and a fixed system committer identity. No package artifact is executed.

Conflicts stop immediately. Conflicted paths and sanitized status evidence are recorded, the isolated cherry-pick is aborted, and the target ref and owner worktrees remain unchanged. There is no automatic or worker-provided resolution.

The Bridge runs only the predeclared validation plan with parameterized non-shell process spawning, timeouts, bounded/redacted output, parsed test counts where available, process-tree termination evidence, and unexpected-mutation detection. Failed, timed-out, cancelled, incomplete, or unknown validation cannot become ready. A ready result binds the old HEAD, prepared HEAD, changed paths, diff statistics, validation evidence digest, apply-worktree digest, package digest, and deterministic preview digest.

### Promote

Preparation never promotes automatically. The owner must separately confirm the exact promotion digest, which binds the operation, owner, target repository/ref, expected old HEAD, prepared new HEAD, validation/apply-worktree evidence, package digest, current version, and the requirement that emergency stop be inactive.

The Bridge rechecks all bindings and apply-worktree integrity immediately before promotion. `git update-ref <target-ref> <prepared-head> <expected-old-head>` supplies compare-and-swap semantics. A moved target becomes `stale`; uncertain outcomes become `promotion-unknown`; neither is retried automatically. M9 never force-updates, rewrites history, changes unrelated refs, pushes, deploys, deletes branches, or promotes multiple repositories.

## Restart, cancellation, evidence, and rollback limits

Every Bridge operation has an atomic per-operation journal. Exact completed replays return recorded evidence; conflicting replays are rejected; started-without-terminal-evidence operations cannot rerun. Control Plane restart reconciliation moves active preparation/cancellation to `apply-unknown` and active promotion to `promotion-unknown` without retry. The outbound Bridge must reconcile an uncertain ref result from its journal and actual refs before any future owner decision.

Cancellation is truthful: queued preparation can be confirmed cancelled before execution, while active cancellation remains requested or unknown until process-tree evidence proves termination. Emergency-stop release never resumes an M9 operation.

Immutable evidence records eligibility, approval/grant binding and consumption, preparation request/result, conflict/validation evidence, promotion confirmation/result, restart reconciliation, old/new refs, and rollback planning. M8 operational events and the Bridge Log receive bounded summaries only—not raw diffs, repository paths, worktree paths, or secrets.

Rollback is evidence and planning only. Records identify the original and promoted heads and whether a revert candidate exists. Any revert is a new owner-authorized, reviewed operation. M9 never resets history or automatically reverts.

## Protected APIs and UI

Authenticated same-origin APIs with strict Origin, CSRF, ownership, expected-version, idempotency, lifecycle, binding, and emergency-stop checks cover eligibility, plan creation, prepare request/status/evidence, promotion confirmation, safe cancellation, final evidence, and unresolved incidents. Internal Bridge claim/result methods are deliberately not browser routes.

The task drawer displays source package/verification, worker/adapter/commit, target repository identity/ref/expected HEAD, changed paths/statistics, conflicts, validation results, prepared HEAD, promotion refs, emergency state, rollback evidence, and limitations. Prepare and promote are distinct controls. Pending, stale, conflicted, unknown, or emergency-stopped states disable unsafe actions. Status is expressed with text as well as color and remains usable at narrow widths.

## Explicit exclusions and carryover

M9 does not add commit-range application, patch application, arbitrary commands, package script/binary execution, automatic conflict resolution, push, deployment, automatic rollback, force operations, routing/quota/fallback logic, production operations, new adapters, remote access, or any M10+ behavior.

The M8 LOW carryover remains open: when a real production Bridge daemon is assembled, its production command loop must wire the already-implemented emergency-stop gate and the M9 claim/result boundaries. This candidate does not claim that production runtime wiring exists.
