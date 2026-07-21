# Control Plane (M2 foundation)

This package is the local-only M2 runtime foundation. It binds only to an explicit loopback address, persists limited control-plane records in SQLite WAL mode, and exposes authentication, protected HTTP, WebSocket protocol, liveness, and readiness boundaries.

Required startup configuration is deliberately narrow: `CONTROL_PLANE_DATA_DIR` and `CONTROL_PLANE_SESSION_SECRET` (at least 32 characters; never generated or logged). Optional values include the database path, explicit loopback host, port, allowed loopback origin, session limits, request limits, and log level. External and wildcard hosts, non-loopback origins, weak/missing session secrets, and non-isolated test data directories are rejected.

The sole administrator is created through an explicit bootstrap endpoint before any account exists. Passwords are Argon2id hashes; sessions are opaque, hashed at rest, HttpOnly/SameSite=Strict cookies, rotated on login, and revocable. A CSRF token is returned only after login and is mandatory for authenticated mutations.

M2 stores protocol idempotency results and append-only ordered events, but does not dispatch work, execute an operation, establish task authority from caller input, connect a Bridge/adapter, serve a web UI, or expose a remote surface.
