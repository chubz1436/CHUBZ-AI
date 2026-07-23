# M11 Operations, Packaging, and Release Readiness

## Status and authority

M1A-M10 are accepted on `main` at `5bb492c5a107591d5c56da03b2b9919b3d0dfebc`. M11 is an active, local-only implementation candidate on `task/m11-operations-packaging-release`. It is not accepted, installed, deployed, remotely exposed, or production-ready. Its release label is deliberately `local MVP candidate`.

M11 adds operational visibility and a package suitable for a later owner-authorized installation. It does not add execution authority. The Control Plane remains authoritative; M4 approval and one-use grants, journal-before-execution, M5 adapter isolation, M8 emergency stop, M9 prepare/promotion separation, and M10 route confirmation remain mandatory. The Local Bridge initiates one authenticated loopback WebSocket session and exposes no listener.

## Runtime components

- `control-plane.mjs` serves the authenticated web application and protected API on an explicit loopback address. It owns the authoritative SQLite database, migrations, alerts, health/readiness, and browser events.
- `local-bridge.mjs` composes the outbound connector, durable operation journal, grant verifier, isolated Codex adapter, safe-apply executor, and mandatory SQLite emergency-stop gate. The same gate is supplied to the final process supervisor.
- Static web assets are served from the verified package.
- Managed data, operational logs, support bundles, and candidate packages are contained beneath the configured managed-data root.
- `runtime-cli.mjs` and `Invoke-CHUBZRuntime.ps1` expose the bounded operator commands. No command creates a service, scheduled task, registry entry, firewall rule, tunnel, or permanent installation.

## Configuration

The runtime reads one version-1 JSON document conforming to `config/runtime-config.schema.json`; `config/runtime-config.example.json` is safe to copy and edit. Unknown fields are rejected. Configuration covers loopback endpoints, a secret reference, managed paths, bounded sizes/counts, retention intervals, project registrations, heartbeat interval, storage warning threshold, and local display labels.

The ordinary JSON file contains only `environment:NAME`, never the secret value. The referenced environment value must exist only in the launching process and must be at least 32 characters. It is not placed in child argv, logs, dashboard output, release files, diagnostics, or support bundles.

Startup refuses non-loopback endpoints, mismatched origins/ports, a Bridge identity other than `local-bridge`, relative or unapproved managed roots, unsafe filenames, duplicated path names, unsupported versions, unknown fields, excessive bounds, duplicate project IDs, and existing symlink/junction/reparse components. Packaged persistent paths on Windows must remain under `B:\AI_Agent_folder`.

Configuration migration is explicit: only version 1 is supported by this candidate. A different version fails validation; it is never silently rewritten.

## Operator commands

From a verified extracted release directory, use:

```powershell
.\scripts\Invoke-CHUBZRuntime.ps1 -Command validate-config -ConfigPath B:\approved\runtime-config.json
.\scripts\Invoke-CHUBZRuntime.ps1 -Command migrate -ConfigPath B:\approved\runtime-config.json
.\scripts\Invoke-CHUBZRuntime.ps1 -Command start -ConfigPath B:\approved\runtime-config.json
.\scripts\Invoke-CHUBZRuntime.ps1 -Command wait-ready -ConfigPath B:\approved\runtime-config.json
.\scripts\Invoke-CHUBZRuntime.ps1 -Command health -ConfigPath B:\approved\runtime-config.json
.\scripts\Invoke-CHUBZRuntime.ps1 -Command inspect-runtime -ConfigPath B:\approved\runtime-config.json
.\scripts\Invoke-CHUBZRuntime.ps1 -Command inspect-emergency-stop -ConfigPath B:\approved\runtime-config.json
.\scripts\Invoke-CHUBZRuntime.ps1 -Command diagnostics -ConfigPath B:\approved\runtime-config.json
.\scripts\Invoke-CHUBZRuntime.ps1 -Command stop -ConfigPath B:\approved\runtime-config.json
```

`verify-package` and `current-version` inspect the package itself and do not need a runtime configuration. `upgrade-plan` requires a verified package artifact ID. `retention-preview` records a dry-run only. `clear-stale-pids` removes a PID record only after the exact PID is observed absent; it refuses running or mismatched identities and never terminates a process.

Startup checks that no PID record is running, stale, or mismatched and that the Control Plane port is free. Each record binds component, PID, executable path, command digest, process start time, configuration digest, and record time. A partial known start is rolled back only through verified identities. Shutdown re-inspects identities and terminates Local Bridge then Control Plane process trees only when the record still matches. Stale PID reuse and unrelated processes are refused.

`/healthz` identifies the application/build and local-candidate status. `/readyz` reports database, migration, configuration, authentication, WebSocket, and mandatory Bridge-gate checks. Readiness never claims that an adapter, external provider, quota, or deployment is healthy.

## Operations dashboard and alerts

The authenticated dashboard labels every metric `authoritative`, `observed`, `estimated`, `owner-attested`, `unknown`, or `stale`. It summarizes Control Plane and Bridge health, migrations, event stream, tasks/attempts, adapter drift, sandbox assurance, quota confidence, emergency stop, recovery, projection, review packages, apply/promotion, routing, storage, and component/build identity.

Alerts are bounded SQLite records with deterministic identities, owner/project scope, severity, source, first/last seen, evidence references, sanitized text, safe operator action, version, and active/acknowledged/resolved state. Refreshes do not version-bump an unchanged condition. Acknowledgement records awareness and cannot resolve a condition. Resolution occurs only after reconciliation no longer observes the authoritative condition. Restart reconciliation recreates or updates the same identity and never starts work.

Covered conditions include Bridge disconnect/version mismatch, adapter readiness/drift/authentication, degraded sandbox, unknown/stale/constrained quota, execution-unknown, uncertain cancellation, active emergency stop, unresolved recovery, projection gap/tampering/failure, incomplete/quarantined capture, stale routing, unknown apply/promotion, migration mismatch, and storage pressure. M11 sends no email, SMS, Slack, or push notification.

Protected APIs include operational summary, alert list/detail/acknowledgement, runtime package metadata/verification, safe configuration validation, diagnostics/support generation/retrieval/verification, upgrade plan, retention preview/apply, and authenticated health details. Mutations use the existing strict Origin, session, CSRF, owner scope, bounded input, idempotency, and expected-version rules. M11 events reuse the existing persisted `task.event` sequence/cursor/snapshot channel.

## Release package

Run the source-tree builder only for a local candidate:

```powershell
node .\scripts\build-m11-release.mjs --output B:\AI_Agent_folder\CHUBZ-AI-Command-Center-M11-<commit>
```

The builder requires a clean Git tree unless the explicit test-only `--allow-dirty` switch is supplied. It refuses an existing output, creates a uniquely named staging directory directly below `B:\AI_Agent_folder`, builds the web app and three Node entries, copies only required native runtime dependency closures, writes release metadata, scans forbidden paths, creates `SHA256SUMS.json`, verifies every file, then atomically renames the staging directory. Failure removes only the verified staging child. It never overwrites an existing package.

Package layout:

```text
app/       bundled runtime entries and required native production dependencies
web/       compiled static assets
config/    strict schema and secret-free example
scripts/   bounded PowerShell operator wrapper
docs/      this operator/security guide
release/   authoritative release manifest
package.json
SHA256SUMS.json
```

The manifest records application/component versions, Git commit, build timestamp, database/config/package/operations schema versions, Windows and runtime requirements, milestone status, safety exclusions, and known limitations. The hash manifest records sorted safe relative filenames, byte counts, and SHA-256 values. Walkers reject traversal names, links, unsupported entries, excessive files/bytes, credentials/auth state, databases, logs, caches, `.git`, and runtime data.

## Diagnostics, support, logs, and retention

Diagnostics and support bundles are bounded canonical JSON files created with exclusive immutable permissions and an authoritative SHA-256 record. Retrieval verifies size and hash before reading. Verification records `verified` or `tampered`. Contents are limited to build/health/configuration metadata, migration version, adapter readiness, stops/incidents/alerts, projection status, recent bounded authoritative event summaries, bounded sanitized operational log records, package-integrity metadata, limitations, and platform capabilities.

They intentionally omit credentials, tokens, cookies, auth files, grants/signatures, task prompts/bodies, worker stdout/stderr/raw output, environment variables, databases, owner source files, and arbitrary filesystem data. No generic path or download API exists.

Operational logs are canonical JSON lines with timestamp, component, severity, event identity, safe task/operation references, sanitized details, per-line bounds, size rotation, bounded retained files, and restart-safe append behavior. Newline/control characters are normalized and sensitive keys/values are redacted. Full worker streams remain in their existing bounded evidence channel and are not duplicated.

Retention is two-step. An authenticated owner records an idempotent, versioned, 15-minute preview containing only exact old support/diagnostic artifact IDs and whitelisted log filenames. Applying that preview rechecks owner, expiry, version, candidate type, canonical containment, and regular-file/no-link status; it uses individual unlink operations, never broad recursion. Support file metadata and hashes remain in SQLite with `retained-metadata`; all authoritative M7-M10 records, alerts, owner projects, repositories, and arbitrary files are preserved. Packaging staging cleanup is limited to the builder's exact unique staging directory.

## Upgrade preparation and rollback limits

An upgrade plan is available only for a candidate package that passed its SHA-256 manifest verification. It reports current/candidate identity, required configuration version and revalidation, forward-only database migration preview, verified stopped-runtime backup requirement, expected file/database changes, restart requirement, rollback limitations, and post-upgrade checks. It performs no backup, file replacement, migration, shutdown, restart, upgrade, downgrade, restore, rollback, install, push, or deployment.

Rollback remains a future owner-authorized operation requiring a verified backup and compatibility evidence. Automatic database downgrade and destructive state reset are unsupported.

## Security boundaries and known carryovers

- All listeners bind only explicit loopback. Remote access and public exposure are unavailable.
- The Bridge has no inbound listener. Its authenticated connection is outbound to the loopback Control Plane.
- Emergency stop is mandatory in the packaged runtime at Bridge admission and immediately before shell-free child spawn. This directly addresses the prior M8 packaged-runtime wiring carryover; it does not relax approval, grants, journaling, routing, apply, or promotion gates.
- Package and support artifacts are content-bounded, link-rejecting, path-contained, immutable where appropriate, and tamper-detectable.
- Commands pass an argv array with `shell: false`; the secret remains outside argv. The PowerShell wrapper passes resolved literal paths as array elements.
- No terminal, arbitrary file browser, database editor, push, deploy, remote control, automatic fallback, automatic retry, automatic install, or automatic upgrade control is present.

Still open: prior live-browser coverage gaps; M7 download verify-then-read hardening beyond its accepted boundary; a physical crash during the exact M9 `update-ref`; a true two-process promotion race; live provider/quota integration; and exact single-commit M9 cherry-pick. M11 does not claim these resolved.

## Required next step

Independent read-only M11 review, followed by separate owner acceptance if the review passes. Installation, merge, push, deployment, remote access, and any later milestone require their own authority.
