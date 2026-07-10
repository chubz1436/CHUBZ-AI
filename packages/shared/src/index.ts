/**
 * @chubz/shared — pure contract library for the CHUBZ AI Command Center.
 *
 * M1A scope only: task states, legal transitions, the twelve-command
 * grammar, and the worker-manifest schema. Deterministic, side-effect
 * free, no I/O of any kind.
 */
export * from "./task-states.js";
export * from "./task-transitions.js";
export * from "./commands.js";
export * from "./worker-manifest.js";
