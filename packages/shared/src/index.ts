/**
 * @chubz/shared — pure contract library for the CHUBZ AI Command Center.
 *
 * M1A: task states, legal transitions, the twelve-command grammar, and
 * the worker-manifest schema. M1B: versioned protocol contracts for
 * Client ↔ Control Plane and Control Plane ↔ Bridge, idempotency,
 * event cursors, and protocol errors. Deterministic, side-effect free,
 * no I/O of any kind. M1C adds approval-security contracts: bounded
 * approval actions, action hashing, capability grants, and Phase 2
 * proof bindings. Runtime authorization, storage, and transport remain
 * outside this package.
 */
export * from "./task-states.js";
export * from "./task-transitions.js";
export * from "./commands.js";
export * from "./worker-manifest.js";
export * from "./protocol/index.js";
export * from "./approval-security.js";
