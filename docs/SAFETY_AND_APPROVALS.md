# Safety and Approvals

> **STATUS: POLICY REFERENCE — M1A/M1B CONTRACTS MERGED; M1C APPROVAL-SECURITY CONTRACTS ACTIVE AND PENDING REVIEW; RUNTIME NOT YET IMPLEMENTED**

The command center is planned around least privilege, visible intent, task isolation, and owner-controlled escalation.

## Planned gates

| Gate | Examples | Required handling |
| --- | --- | --- |
| Read | Inspect files, logs, status, or approved context | Stay within declared scope; record sources and access |
| Write | Edit files, generate artifacts, change configuration | Show plan and bounded target; capture diffs; obtain the applicable approval |
| Deploy / operate | Publish, restart, migrate, change DNS, contact servers, or affect production | Explicit owner GO required immediately before action |

Credentials, secret material, destructive operations, external communications, and permission expansion require separate explicit authorization. A prior approval for analysis or implementation does not imply deploy approval.

The planned `/go` command approves only the currently displayed bounded action. A general `/go` must not automatically authorize deployment, production changes, database writes, MikroTik actions, credential access, DNS changes, or server restarts; each requires specific confirmation for the exact action.

M1C freezes only the contract boundary for that exact action: a strict versioned action record, deterministic SHA-256 digest, short-lived single-use grant bound to task/attempt/operation/action digest, and a future transport-neutral owner-presence proof binding. It implements no approval runtime, key storage, consumption database, Bridge execution, WebAuthn ceremony, UI, remote access, or production operation. A duplicate grant delivery may be correlated to a prior outcome but never authorizes duplicate execution; persistent atomic consumption and reconciliation remain later runtime work.

The planned control panel will make pending gates visible in chat and through slash commands. Automatic context loading must obey worker and task permissions. Automatic response/diff capture and Bridge Log records must support review without leaking unrelated or secret data.

Kenneth / CHUBZ remains the final GO/NO-GO approver.
