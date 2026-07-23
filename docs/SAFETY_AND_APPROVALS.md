# Safety and Approvals

> **M9 candidate gate:** apply planning, isolated preparation, and target promotion are distinct. Preparation consumes a short-lived one-use grant bound to one verified M7 package and expected target HEAD. Promotion requires a later owner confirmation bound to the prepared HEAD, validation evidence, package digest, target identity/ref, current version, and inactive emergency-stop state. No approval authorizes push, deployment, conflict resolution, retry of an unknown operation, or rollback. See [M9_SAFE_APPLY_AND_PROMOTION.md](M9_SAFE_APPLY_AND_PROMOTION.md).

> **Historical M3 boundary (now accepted):** M3 authorized only outbound enrollment/connection, protected storage, journaling, process supervision, and managed clone/worktree foundations. Later accepted milestones added bounded orchestration, UI, evidence, and recovery while preserving the no-inbound-listener, no-remote-access, and no-deployment boundaries.

> **STATUS: POLICY REFERENCE — M1A-M8 ACCEPTED; M9 SAFE APPLY CANDIDATE ACTIVE AND UNACCEPTED; M10+ UNAUTHORIZED.**

The command center is planned around least privilege, visible intent, task isolation, and owner-controlled escalation.

## Planned gates

| Gate | Examples | Required handling |
| --- | --- | --- |
| Read | Inspect files, logs, status, or approved context | Stay within declared scope; record sources and access |
| Write | Edit files, generate artifacts, change configuration | Show plan and bounded target; capture diffs; obtain the applicable approval |
| Deploy / operate | Publish, restart, migrate, change DNS, contact servers, or affect production | Explicit owner GO required immediately before action |

Credentials, secret material, destructive operations, external communications, and permission expansion require separate explicit authorization. A prior approval for analysis or implementation does not imply deploy approval.

The planned `/go` command approves only the currently displayed bounded action. A general `/go` must not automatically authorize deployment, production changes, database writes, MikroTik actions, credential access, DNS changes, or server restarts; each requires specific confirmation for the exact action.

M1C freezes only the contract boundary for that exact action: a strict versioned action record, deterministic SHA-256 digest, short-lived single-use grant bound to task/attempt/operation/action digest, and a future transport-neutral owner-presence proof binding. A Phase-2 proof binds the action, Bridge challenge identity, challenge/nonce digest, and intended verifier; the future Bridge WebAuthn verifier must independently derive the stored nonce digest from actual `clientDataJSON.challenge`, never trust client-supplied evidence or text as authority. M1C implements no approval runtime, key storage, consumption database, Bridge execution, WebAuthn ceremony, UI, remote access, or production operation. A duplicate grant delivery may be correlated to a prior outcome but never authorizes duplicate execution; persistent atomic consumption and reconciliation remain later runtime work.

The planned control panel will make pending gates visible in chat and through slash commands. Automatic context loading must obey worker and task permissions. Automatic response/diff capture and Bridge Log records must support review without leaking unrelated or secret data. M1E snapshot-shaped contract values are structural inputs only: a future trusted runtime store must independently load, scope, and establish their authority. Parsing a value never grants authority, and the current pure shared package performs no snapshot loading, persistence, capture, storage, or enforcement.

Kenneth / CHUBZ remains the final GO/NO-GO approver.
