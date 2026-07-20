# Shared Package

> **STATUS: M1A/M1B COMPLETE; M1C APPROVAL-SECURITY CONTRACTS ACTIVE ON `task/m1c-approval-security-contracts`, PENDING BANTAY/OWNER REVIEW**

`@chubz/shared` is a pure TypeScript contract package. It contains M1A task-state, transition, command, and worker-manifest contracts; M1B protocol/idempotency contracts; and the M1C approval-action, action-hash, capability-grant, replay-classification, and Phase-2 proof-binding contracts.

M1C exports only strict parsers, schemas, canonicalization/digest helpers, and pure verification/classification helpers. It does not implement an Approval Engine, persistence, HTTP/WebSocket transport, Bridge execution, WebAuthn ceremony, or secret/key storage. Runtime grant consumption must be atomic and happen before privileged execution; duplicate delivery may replay an existing outcome but never authorizes a second execution.
