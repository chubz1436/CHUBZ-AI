# M7 Evidence Capture and Review Packages

> **Status (2026-07-22):** M1A-M6 are accepted on `main` at `00904342a685d20eb1f7b9566e9634aa49e9287f`. M7 is implemented as an unaccepted candidate on `task/m7-capture-review-packages`. Independent read-only review and owner acceptance remain required. M8 and later are not authorized by this document.

## Authority and custody

The Control Plane owns the persistent `pending → capturing → captured | incomplete | failed | quarantined` lifecycle and binds every capture to one owner, project, task, immutable attempt, operation, worker, and adapter. Identity digests make duplicate requests idempotent. A retry creates a new capture operation only from an explicitly `failed` or `incomplete` capture and only while the authoritative attempt binding is unchanged.

The outbound-only Local Bridge is the observation authority for managed Git state and supervised processes. It accepts only an exact clone beneath the managed-clone root and an exact attempt worktree beneath the managed-worktree root. Owner working copies, root directories, path escapes, symlinks, junctions, reparse points, non-file changes, sensitive paths, repository identity changes, and Git ref drift fail closed or quarantine the result. Capture never applies, executes, cherry-picks, merges, or copies evidence into an owner project.

Four evidence classes stay distinct:

- `workerReportedClaim`: bounded, redacted worker text; never proof.
- `systemObserved`: Git and process evidence observed by the Local Bridge.
- `ownerAttestedManualEvidence`: explicitly weaker manual-relay provenance.
- `reviewerConclusion`: reserved for a human reviewer and never generated or rewritten by M7.

## Captured evidence

Git evidence records repository identity, managed worktree label, branch or detached state, HEAD, direct parent, baseline, merge base, commit subjects, ref stability, neutralized Git configuration, ordered changed paths, staged/unstaged/untracked state, before/after hashes, and raw/numstat digests. Text diffs disable external diff and text conversion. Untracked content and binary content are represented by metadata or explicit omission, not silently presented as complete text.

Validation evidence records the parameterized command, managed working-directory label, start/finish times, exit code and signal, stop reason, bounded sanitized stdout/stderr, truncation, parsed counts when recognized, process-tree termination evidence, tool versions, and artifact hashes. Exit/process evidence determines the outcome; text such as “tests passed” cannot convert a nonzero, timed-out, cancelled, or execution-unknown run into a pass. Unknown formats keep null counts.

## Bounds and redaction

The Local Bridge limits changed paths to 512, text diff to 512 KiB, each captured log to 128 KiB, Git command output to 4 MiB, and the finalized package to 2 MiB. Ordering and canonical JSON serialization are deterministic. Truncation, redaction, omission, unavailable merge bases, untracked-content omission, and ref drift appear in `limitations`, `redactions`, and `omissions` and affect package status.

The existing secret detector/redactor is applied to diff, log, command, working-directory label, tool-version, artifact-metadata, provenance, and worker-claim values. Sensitive structured keys and unsupported or oversized structures fail closed before Local Bridge package writing. Authentication material, capability grants, credentials, raw environments, unsafe filenames, sensitive paths, private keys, and secret-like values are rejected again at the Control Plane finalization boundary. No raw environment or grant serialization enters a package.

## Package format and immutability

Each package contains canonical `review-package.json` plus `manifest.json`. The package is bound to one exact capture and includes schema version, identities, Git evidence, changed-path manifest, bounded diff, validations, evidence categories, readiness/sandbox/terminal provenance, cancellation or execution-unknown evidence, manual provenance where applicable, limitations, redactions, omissions, and `applied: false` assurance.

The package digest is domain-separated SHA-256 over canonical package content. The manifest lists the filename, byte length, and SHA-256 of the package file and has its own domain-separated digest. Package identity changes when authoritative content changes. Finalization uses a private staging directory and atomic rename beneath the configured Control Plane or Bridge managed-data root. Finalized database rows have update/delete denial triggers; an existing package or capture marker with different content is a conflict and is never overwritten.

On restart, finalized packages remain immutable. `capturing` records become `incomplete` with an explicit restart reason; they never silently become complete. Staging content is never downloadable. Verification re-reads the exact bounded finalized file through its database binding and checks byte length and manifest digest before reporting success.

## Protected surfaces

Authenticated UI APIs support requesting and retrying an eligible capture, viewing capture status and sanitized summaries, listing package metadata, verifying hashes, and downloading only a finalized package by an opaque package ID. Browser mutations inherit authentication, exact Origin, CSRF, idempotency, task version, state, ownership, and attempt-binding checks. Download is not a filesystem browser and does not accept paths.

Authoritative capture/package changes publish task-stream events through the existing persisted WebSocket cursor. The M6 task drawer displays claim-versus-observation language, Git identities, changed-path/validation summaries, incomplete/redaction markers, manifest hashes, provenance, `applied: false`, and only a finalized-package download action. It offers no edit, reviewer-verdict, apply, patch, execution, merge, or cherry-pick control.

## Boundary after M7

M7 does not implement Bridge Log/Obsidian projection, a recovery console, emergency stop expansion, owner-project apply/integration, routing or quotas, deployment, alerts, remote access, or additional adapters. Those remain M8+ work and require separate owner authorization.
