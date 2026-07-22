# Control Plane (M2 foundation)

This package is the local-only M2 runtime foundation. It binds only to an explicit loopback address, persists limited control-plane records in SQLite WAL mode, and exposes authentication, protected HTTP, WebSocket protocol, liveness, and readiness boundaries.

Required startup configuration is deliberately narrow: `CONTROL_PLANE_DATA_DIR` and `CONTROL_PLANE_SESSION_SECRET` (at least 32 characters; never generated or logged). Optional values include the database path, explicit loopback host, port, allowed loopback origin, session limits, request limits, and log level. External and wildcard hosts, non-loopback origins, weak/missing session secrets, and non-isolated test data directories are rejected.

The sole administrator is created through an explicit bootstrap endpoint before any account exists, with both a final transaction check and a SQLite singleton trigger. Passwords are Argon2id hashes; sessions are opaque, HMAC-SHA-256 digested at rest using `CONTROL_PLANE_SESSION_SECRET`, HttpOnly/SameSite=Strict cookies, rotated on login, and revocable. Changing that secret deliberately invalidates existing local sessions. A CSRF token is returned only after login and is mandatory for authenticated mutations.

Failed-login buckets expire after 60 seconds and are capped at 1,024 entries by default (`CONTROL_PLANE_LOGIN_ATTEMPT_WINDOW_MS`, `CONTROL_PLANE_LOGIN_BUCKET_MAXIMUM`). Authentication audit records are retained for 30 days and capped at 10,000 rows (`CONTROL_PLANE_AUTH_EVENT_RETENTION_MS`, `CONTROL_PLANE_AUTH_EVENT_MAXIMUM`); both bounds are enforced transactionally.

M6 adds a same-origin local web surface and protected `/v1/ui/*` projection/mutation routes over the accepted M2-M5 state, orchestration, grant, readiness, and manual-relay foundations. Browser responses deliberately omit grant authentication, credential, environment, and raw readiness-evidence material. WebSocket task events are persisted in the `ui-tasks` stream for cursor-based resume; snapshots remain the recovery authority.

The Control Plane still does not expose a remote surface or add an inbound Bridge listener. Bridge-dependent artifact transport and readiness probes fail closed when no authoritative outbound Bridge connection is available.
