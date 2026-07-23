# M8 Bridge Log, Recovery, and Emergency Controls

**Status:** implementation candidate active and unaccepted. M7 is the accepted baseline on `main` at `6e1d206ce36b31a4909fcdae09a63b7e6ddd4136`. M8 requires independent read-only review and separate owner acceptance. Nothing here authorizes M9 or later work.

## Authority model

Control Plane SQLite records remain authoritative for task, attempt, grant, stop, incident, reconciliation, and event state. The M3 Local Bridge operation journal remains authoritative for external execution history. M7 captures and immutable review packages retain their established evidence boundaries.

The Bridge Log is a bounded Markdown projection for human visibility only. It is not a command queue, database, approval source, capability source, recovery authority, or execution trigger. Editing or deleting it cannot change Control Plane state. Verification detects cursor gaps, digest disagreement, deletion, corruption, and manual edits; rebuild replaces the file only from authoritative operational events.

## Projection storage and hygiene

The projection is stored at `bridge-log/bridge-log.md` beneath the configured managed Control Plane data directory. Non-test data must remain below `B:\AI_Agent_folder`. The implementation uses canonical containment checks, a fixed safe filename, link/junction rejection, bounded entries and bytes, deterministic cursor ordering, same-directory staging, atomic rename, and startup cleanup of incomplete staging. No owner repository is a valid projection target.

Projected entries contain a schema version, monotonic cursor, event ID and digest, timestamp, safe bindings, source, actor category, state change, and sanitized summary. Capability signatures, grant JSON, tokens, credentials, raw environment values, arbitrary files, and unbounded worker output are excluded.

## Recovery incidents and restart reconciliation

Recovery incidents are stable, persistent, deduplicated records with bindings, sanitized evidence, severity, detection times, allowed owner actions, explicitly blocked automatic actions, resolution state, and provenance. Acknowledgement never changes a task outcome. Closure is refused while authoritative evidence still shows the condition.

On restart, M8 reconciles claimed-before-start dispatch, running work without a terminal result, uncertain cancellation, interrupted M7 capture, projection integrity, and active emergency stops. Running work whose dispatch start was authoritative but whose completion is absent is recorded as `execution-unknown` and moved through the existing task transition policy to `BLOCKED`; it is never automatically rerun. Interrupted capture remains incomplete. Repeated reconciliation does not create duplicate incidents or rerun work.

## Emergency-stop semantics

Global and project-scoped stops are owner-gated, persisted, versioned, idempotent, audited, and visible in the dashboard. Activation immediately blocks approval-to-execution, dispatch claims, Bridge capture requests that require execution, command issuance, and external process spawn in scope. Queued grants are revoked and queued dispatch entries are left `emergency-blocked`; release does not restore them.

For running work, activation persists a cancellation request and moves eligible tasks to normal `CANCELLING` state. Cancellation is shown as requested, failed, confirmed, or uncertain; it is never represented as successful without process-tree evidence. A disconnected Bridge remains fail-closed. Release requires the current scope version and an explicit owner confirmation, and does not resume or retry any operation.

The Bridge performs defense-in-depth checks at command acceptance and immediately before process spawn. The final pre-spawn check uses `BEGIN IMMEDIATE` against the authoritative SQLite database, serializing it with stop activation: a spawn that holds the lock begins before activation can commit; after activation is authoritative, every later spawn observes the stop and is refused. The Bridge remains outbound-only and gains no listener.

## Protected surface

Authenticated same-origin APIs expose safe operational status, projection verify/rebuild, incident acknowledgement/closure, and emergency activation/release. Existing Origin, CSRF, sole-administrator authentication, ownership binding, expected-version, idempotency, and sanitized-error controls apply to every mutation. Monotonic WebSocket events announce projection, incident, reconciliation, cancellation, blocked-dispatch, and stop changes through the existing resumable UI stream.

The M6 dashboard adds a keyboard-usable, narrow-screen Operations surface with prominent global/project stop state, reason and owner identity, cancellation uncertainty, projection cursor and status, reconciliation summary, incidents, safe acknowledgement/rebuild controls, and sanitized Bridge Log summaries. It provides no file editor, database editor, journal editor, terminal, force-success action, or execution-unknown retry.

## Explicit exclusions

M8 adds no apply, patch, cherry-pick, merge, push, deployment, routing engine, quota scheduler, recommendation engine, remote access, inbound Bridge listener, production operation, owner-project mutation, journal rewrite, grant resurrection, forced completion, or automatic retry. Those remain M9+ or otherwise separately gated.
