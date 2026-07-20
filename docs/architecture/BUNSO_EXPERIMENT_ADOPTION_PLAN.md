# BUNSO Experiment Adoption Plan

> **Status:** Historical experimental implementation evidence, recorded 2026-07-20. The original CHUBZ AI Command Center architecture remains authoritative. This plan authorizes no code transfer, cherry-pick, merge, server start, worker execution, or implementation milestone.

## Experiment identity and preservation

| Fact | Observed evidence |
| --- | --- |
| Repository | `B:\AI_Agent_folder\AI COMMAND CENTER BY FABLE 5\CHUBZ-AI-Command-Center-Fable5` |
| Branch | `improve/repository-backed-codex-vertical-slice` |
| Local branch HEAD | `a9c82c92a4610d2696fdc43a53d6ba05223c638a` |
| Remote-tracking branch | `origin/improve/repository-backed-codex-vertical-slice` at `7ae1ba48d2439b1132cc36b2ba8b379aee72e501` |
| Remote relationship | Local branch is one commit ahead of its retained remote-tracking branch (`0 behind, 1 ahead`). All six known commits are retained by that remote-tracking branch. |
| Working tree | Clean when inspected; preserved without modification. |
| Local UI and smoke repo | Historical experiment references only: `localhost:4680` and `B:\AI_Agent_folder\Fable5_Codex_Smoke`. Neither was started or executed during this review. |

The canonical repository and experiment have different root commits (`5f60f8472a0317aa1c338a265e8206aa19ce5b7b` and `9944f91e6be86219e6f2f1fbeda682ea3824f0c9` respectively), so no merge base exists. No retained local or remote ref other than the experimental branch itself contains its current HEAD. The remote-tracking branch proves that the known commits were pushed; it does not prove that the current local experimental HEAD was pushed or merged.

## Known commit inventory

| Short ID | Full ID | Found / retained branch evidence | Scope from Git metadata |
| --- | --- | --- | --- |
| `bcc5fa8` | `bcc5fa829fa32292711c5f643cdc9c3f9bc83c0b` | Found; contained by local and remote-tracking experiment branch | PATHEXT-aware `codex.cmd` resolution, spaced paths, stdin prompt delivery, readiness executable evidence |
| `a6d3095` | `a6d309567891939b138ad97b567c035d5dcf30f6` | Found; contained by local and remote-tracking experiment branch | Exit-zero success classification; non-zero refinement for auth/rate/quota |
| `afc5348` | `afc5348cea22302d7f0f7c8a34237e0d874394e9` | Found; contained by local and remote-tracking experiment branch | Git filter/hooks isolation, process-tree evidence, login-file credential default |
| `1b91562` | `1b915627ae716675ec668e11f1e167bf5a4bc57c` | Found; contained by local and remote-tracking experiment branch | Repository-capability routing and UI/API recommendation filtering |
| `3afe632` | `3afe632547c9a41993f009bc6064d28a1131ec55` | Found; contained by local and remote-tracking experiment branch | Filter/hook, detached-child cancellation, and credential/routing test coverage |
| `28c7d47` | `28c7d472d6496c20ee60b1a14bad968ebd3c2572` | Found; contained by local and remote-tracking experiment branch | Repository-backed architecture narrative, SQLite WAL, token boundary, and quarantine documentation |

`git show --stat` and changed-path inspection were performed for every listed commit. The experiment was neither merged, cherry-picked, reset, cleaned, pushed, nor otherwise modified by this batch.

## Proven historical workflow

The experiment provides historical evidence of a repository-backed Codex workflow: owner approval and an exact execution grant; immutable attempts; an isolated Git worktree; real Codex CLI execution; diff and artifact capture; independent repository validation; owner acceptance; and cleanup/recovery that avoids modifying the owner tree. It is implementation evidence, not proof that the canonical branch currently provides, compiles, or passes this workflow.

Historical experiment results recorded in commit messages are **not rerun results**: `70/70`, `71/71`, and `113/113` are historical experiment evidence only. In particular, `71/71` is recorded by `a6d3095` and `113/113` by `3afe632`/`28c7d47`; neither result was rerun here.

## Traceability and adoption matrix

| Experimental capability | Disposition | Destination milestone / rationale |
| --- | --- | --- |
| Windows `codex.cmd` and PATHEXT resolution | Reimplement against current contracts | M1F defines adapter readiness/run evidence; M3/M5 implement the Bridge and Codex adapter. |
| Paths containing spaces | Reimplement against current contracts | M3/M5 adapter and supervisor tests on Windows. |
| Prompt delivery through stdin | Selectively port after contract review | M1F execution specification, then M5; preserve parameterized invocation and avoid task text in argv. |
| Exit-code classification | Reimplement against current contracts | M1F structured adapter-result taxonomy, then M3/M5 runtime behavior. |
| Readiness, version, and authentication evidence | Already covered by canonical architecture | D-024 and M1F define the required readiness contract; implement in M3/M5. |
| `login_file` and explicit API-key credential modes | Selectively port after contract review | M1F/M3/M5, subject to D-024 and the canonical secret-storage boundary; never persist or expose provider secrets. |
| Immutable retry attempts | Already covered by canonical architecture | M1A/D-022 define immutable attempt identity; reimplement store behavior in M2/M4. |
| Process-tree cancellation | Reimplement against current contracts | M3 supervisor, then M4/M8 recovery tests; retain the experiment's limitation below. |
| Git clean/smudge-filter neutralization | Reimplement against current contracts | M3 managed-clone/worktree Git service and adversarial Git tests. |
| Randomized no-hooks path | Reimplement against current contracts | M3 Git service and process-isolation tests. |
| Repository capability routing | Defer to a named milestone | M1F exposes capabilities; M10 matures routing, quota, and fallback. MVP remains owner-confirmed under D-029. |
| Unsupported-worker UI states | Selectively port after contract review | M1F readiness states, M5 adapter registry, and M6 surfaces. |
| Isolated worktrees | Already covered by canonical architecture | D-009 and D-025; runtime implementation belongs in M3. |
| Operation evidence and checkpoints | Reimplement against current contracts | M1E record contracts, M3 operation journal, and M4 reconciliation. |
| Diffs and artifacts | Reimplement against current contracts | M1E capture contracts and M7 capture/review implementation. |
| Independent repository validation | Selectively port after contract review | M3 managed-clone evidence plus M7 review-package validation; never modify the owner working copy. |
| Owner acceptance | Already covered by canonical architecture | D-014 approval model; M1C contracts and M4/M9 implementation gates. |
| Cleanup and recovery | Reimplement against current contracts | M3 workspace lifecycle and M8 recovery/cleanup hardening. |

## Known limitations to retain during review

- The experiment used a single repository-wide lease; canonical work must preserve the scoped lease model planned for M1F rather than importing this limitation.
- Write scope was advisory; canonical work must retain managed worktrees, restricted roots, and later enforcement.
- Legacy adapters were quarantined; their existence is not evidence that they are supported in the canonical system.
- The validator ran with owner OS privileges; this does not satisfy the restricted-worker prerequisite for remote execution.
- Windows `taskkill /T` cannot prove termination of every completely detached descendant; cancellation remains an evidence and recovery concern.
- The proven repository path was Codex-only at that stage; other workers remain capability-probed/manual as directed by D-024.
- Historical tests are not proof that the current canonical branch passes them.

## Adoption boundary

Compatible behavior and code are to be preserved as evidence, not imported wholesale. The Control Plane / Local Bridge architecture, accepted decisions, and M1C–M1F gates remain controlling. Blind cherry-picking or replacement is prohibited. Any later integration requires a dedicated technical review, a mapped contract review, and an owner-approved implementation batch.
