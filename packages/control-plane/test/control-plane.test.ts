import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createControlPlane } from "../src/app.js";
import { ConfigurationError, createTestConfig, loadConfig } from "../src/config.js";
import { ControlPlaneDatabase, MigrationError } from "../src/database.js";

const roots: string[] = [];
const fixture = (overrides: Partial<ReturnType<typeof createTestConfig>> = {}) => { const root = mkdtempSync(join(tmpdir(), "chubz-control-plane-test-")); roots.push(root); return createControlPlane({ ...createTestConfig(root), logLevel: "fatal", ...overrides }); };
const origin = "http://127.0.0.1:4317";
afterEach(async () => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("strict configuration", () => {
  it("accepts explicit loopback and rejects external binding without leaking settings", () => {
    const root = mkdtempSync(join(tmpdir(), "chubz-config-test-")); roots.push(root);
    expect(loadConfig({ NODE_ENV: "test", CONTROL_PLANE_DATA_DIR: root, CONTROL_PLANE_SESSION_SECRET: "x".repeat(32) }).host).toBe("127.0.0.1");
    expect(() => loadConfig({ NODE_ENV: "test", CONTROL_PLANE_DATA_DIR: root, CONTROL_PLANE_SESSION_SECRET: "x".repeat(32), CONTROL_PLANE_HOST: "0.0.0.0" })).toThrow(ConfigurationError);
    expect(() => loadConfig({ NODE_ENV: "test", CONTROL_PLANE_DATA_DIR: root, CONTROL_PLANE_SESSION_SECRET: "short" })).toThrow("session secret");
  });
});

describe("database foundation", () => {
  it("uses WAL, foreign keys, deterministic migration history, and survives restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "chubz-control-plane-test-")); roots.push(root); const config = createTestConfig(root); const first = createControlPlane(config); const db = first.database.connection;
    expect((db.pragma("journal_mode", { simple: true }) as string).toLowerCase()).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect((db.prepare("SELECT count(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(10);
    await first.close();
    const second = createControlPlane(config);
    expect((second.database.connection.prepare("SELECT count(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(10);
    await second.close();
  });
});

describe("HTTP authentication and browser protections", () => {
  it("atomically admits one concurrent bootstrap and rejects direct second-administrator inserts", async () => {
    const control = fixture(); await control.app.ready();
    const request = (username: string) => control.app.inject({ method: "POST", url: "/v1/auth/bootstrap", headers: { origin, "content-type": "application/json" }, payload: { username, password: "correct-horse-battery-staple" } });
    const results = await Promise.all([request("owner-one"), request("owner-two")]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    expect((control.database.connection.prepare("SELECT count(*) AS n FROM administrators").get() as { n: number }).n).toBe(1);
    expect(() => control.database.connection.prepare("INSERT INTO administrators(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)").run("second-admin", "second-admin", "not-a-password", new Date().toISOString())).toThrow();
    await control.close();
  });
  it("bootstraps explicitly, rotates a revocable session, and enforces origin/CSRF", async () => {
    const control = fixture(); await control.app.ready();
    const bootstrap = await control.app.inject({ method: "POST", url: "/v1/auth/bootstrap", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password: "correct-horse-battery-staple" } });
    expect(bootstrap.statusCode).toBe(201);
    const badLogin = await control.app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin, "content-type": "application/json" }, payload: { username: "nobody", password: "wrong" } });
    expect(badLogin.statusCode).toBe(401); expect(badLogin.body).not.toContain("nobody");
    const login = await control.app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password: "correct-horse-battery-staple" } });
    expect(login.statusCode).toBe(200); const cookie = login.headers["set-cookie"]!; const csrf = (login.json() as { csrfToken: string }).csrfToken;
    const denied = await control.app.inject({ method: "POST", url: "/v1/auth/logout", headers: { origin, cookie } });
    expect(denied.statusCode).toBe(403);
    const logout = await control.app.inject({ method: "POST", url: "/v1/auth/logout", headers: { origin, cookie, "x-csrf-token": csrf } });
    expect(logout.statusCode).toBe(204);
    const session = await control.app.inject({ method: "GET", url: "/v1/session", headers: { cookie } });
    expect(session.statusCode).toBe(401);
    expect(login.headers["content-security-policy"]).toContain("default-src 'none'");
    await control.close();
  });
  it("rejects wrong origins, unsupported content type, and oversized requests", async () => {
    const control = fixture(); await control.app.ready();
    expect((await control.app.inject({ method: "POST", url: "/v1/auth/bootstrap", headers: { origin: "http://localhost:4317", "content-type": "application/json" }, payload: {} })).statusCode).toBe(403);
    expect((await control.app.inject({ method: "POST", url: "/v1/auth/bootstrap", headers: { origin, "content-type": "text/plain" }, payload: "x" })).statusCode).toBe(415);
    await control.close();
  });
});

describe("migration hardening", () => {
  const downgradeToV1 = (database: ControlPlaneDatabase): void => {
    const db = database.connection;
    db.exec(`
      DROP TRIGGER m10_confirmation_immutable_delete;
      DROP TRIGGER m10_confirmation_immutable_update;
      DROP TRIGGER m10_recommendation_finalized_guard;
      DROP TRIGGER m10_quota_immutable_delete;
      DROP TRIGGER m10_quota_immutable_update;
      DROP TABLE m10_route_confirmations;
      DROP TABLE m10_fallback_plans;
      DROP TABLE m10_candidate_evaluations;
      DROP TABLE m10_recommendations;
      DROP TABLE m10_routing_incidents;
      DROP TABLE m10_routing_requests;
      DROP TABLE m10_reconciliation_runs;
      DROP TABLE m10_mutations;
      DROP TABLE m10_health_observations;
      DROP TABLE m10_quota_observations;
      DROP TABLE m10_routing_policies;
      DROP TRIGGER m9_finalized_promotion_evidence_guard;
      DROP TRIGGER m9_finalized_prepare_evidence_guard;
      DROP TRIGGER m9_apply_evidence_immutable_delete;
      DROP TRIGGER m9_apply_evidence_immutable_update;
      DROP TRIGGER m9_repository_binding_path_immutable;
      DROP TABLE m9_mutations;
      DROP TABLE m9_apply_evidence;
      DROP TABLE m9_capability_grants;
      DROP TABLE m9_apply_requests;
      DROP TABLE m9_repository_bindings;
      DROP TABLE m8_mutations;
      DROP TABLE m8_bridge_state;
      DROP TABLE m8_reconciliation_runs;
      DROP TABLE m8_stop_operations;
      DROP TABLE m8_emergency_state;
      DROP TABLE m8_emergency_stops;
      DROP TABLE m8_recovery_incidents;
      DROP TABLE m8_projection_state;
      DROP TABLE m8_operational_events;
      DROP TRIGGER administrators_singleton_insert;
      DROP TRIGGER m7_review_packages_immutable_update;
      DROP TRIGGER m7_review_packages_immutable_delete;
      DROP TRIGGER m6_manual_results_immutable_update;
      DROP TRIGGER m6_manual_results_immutable_delete;
      DROP TRIGGER task_attempts_immutable_update;
      DROP TRIGGER task_attempts_immutable_delete;
      DROP TABLE m7_review_packages;
      DROP TABLE m7_capture_requests;
      DROP TABLE m7_mutations;
      DROP TABLE m6_manual_results;
      DROP TABLE m6_mutations;
      DROP TABLE m5_worker_states;
      DROP TABLE m5_adapter_readiness;
      DROP TABLE m4_reconciliations;
      DROP TABLE m4_commands;
      DROP TABLE m4_results;
      DROP TABLE m4_dispatch_queue;
      DROP TABLE m4_grants;
      DROP TABLE m4_approvals;
      DROP TABLE m4_assignments;
      DROP TABLE m4_leases;
      DROP TABLE m4_write_scopes;
      DROP TABLE task_state_transitions;
      DROP TABLE task_attempts;
      DROP TABLE administrator_singleton_guard;
      ALTER TABLE tasks DROP COLUMN cancellation_requested_at;
      ALTER TABLE tasks DROP COLUMN current_operation_id;
      ALTER TABLE tasks DROP COLUMN created_at;
      ALTER TABLE tasks DROP COLUMN version;
      DELETE FROM schema_migrations WHERE version IN (2, 3, 4, 5, 6, 7, 8, 9, 10);
    `);
  };
  it("upgrades zero and one administrator databases but fails closed for multiple administrators", () => {
    for (const administrators of [0, 1]) {
      const root = mkdtempSync(join(tmpdir(), "chubz-control-plane-test-")); roots.push(root); const config = createTestConfig(root); const initial = new ControlPlaneDatabase(config); downgradeToV1(initial);
      if (administrators === 1) initial.connection.prepare("INSERT INTO administrators(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)").run("one-admin", "one-admin", "hash", new Date().toISOString());
      initial.close(); const upgraded = new ControlPlaneDatabase(config);
      expect((upgraded.connection.prepare("SELECT count(*) AS n FROM administrators").get() as { n: number }).n).toBe(administrators); upgraded.close();
    }
    const root = mkdtempSync(join(tmpdir(), "chubz-control-plane-test-")); roots.push(root); const config = createTestConfig(root); const initial = new ControlPlaneDatabase(config); downgradeToV1(initial);
    for (const username of ["owner-one", "owner-two"]) initial.connection.prepare("INSERT INTO administrators(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)").run(username, username, "hash", new Date().toISOString());
    initial.close(); expect(() => new ControlPlaneDatabase(config)).toThrow(MigrationError);
  });
  it("rejects checksum conflicts and unsupported future migration histories", () => {
    const root = mkdtempSync(join(tmpdir(), "chubz-control-plane-test-")); roots.push(root); const config = createTestConfig(root); const database = new ControlPlaneDatabase(config);
    database.connection.prepare("UPDATE schema_migrations SET checksum='bad' WHERE version=4").run(); database.close(); expect(() => new ControlPlaneDatabase(config)).toThrow(MigrationError);
    const repaired = new ControlPlaneDatabase({ ...config, databasePath: join(root, "future.sqlite") }); repaired.connection.prepare("UPDATE schema_migrations SET version=99 WHERE version=4").run(); repaired.close(); expect(() => new ControlPlaneDatabase({ ...config, databasePath: join(root, "future.sqlite") })).toThrow(MigrationError);
  });
});

describe("bounded authentication state", () => {
  it("caps rotating login buckets and evicts expired buckets", async () => {
    const control = fixture({ loginBucketMaximum: 3, loginAttemptWindowMs: 10_000 }); await control.app.ready();
    const login = (username: string) => control.app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin, "content-type": "application/json" }, payload: { username, password: "wrong" } });
    expect((await login("person-one")).statusCode).toBe(401); expect((await login("person-two")).statusCode).toBe(401); expect((await login("person-three")).statusCode).toBe(401); expect((await login("person-four")).statusCode).toBe(429);
    await control.close();
    const expiring = fixture({ loginBucketMaximum: 3, loginAttemptWindowMs: 20 }); await expiring.app.ready();
    const shortLogin = (username: string) => expiring.app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin, "content-type": "application/json" }, payload: { username, password: "wrong" } });
    expect((await shortLogin("expired-person")).statusCode).toBe(401); await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await shortLogin("new-person")).statusCode).toBe(401); await expiring.close();
  });
  it("prunes old audit records and enforces the retained-record maximum", async () => {
    const control = fixture({ authEventRetentionMs: 1_000, authEventMaximum: 3 }); await control.app.ready(); const db = control.database.connection;
    for (let index = 0; index < 5; index += 1) db.prepare("INSERT INTO auth_events(event_kind, occurred_at, request_id) VALUES (?, ?, ?)").run("old", new Date(Date.now() - 10_000).toISOString(), `old-${index}`);
    for (let index = 0; index < 5; index += 1) await control.app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin, "content-type": "application/json" }, payload: { username: `unknown-${index}`, password: "wrong" } });
    expect((db.prepare("SELECT count(*) AS n FROM auth_events").get() as { n: number }).n).toBe(3);
    expect((db.prepare("SELECT count(*) AS n FROM auth_events WHERE event_kind='old'").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT count(*) AS n FROM auth_events WHERE event_kind='login-failed'").get() as { n: number }).n).toBe(3); await control.close();
  });
});

describe("keyed session and CSRF storage", () => {
  it("stores only HMAC token digests and changing the secret invalidates sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "chubz-control-plane-test-")); roots.push(root); const config = { ...createTestConfig(root), logLevel: "fatal" as const }; const control = createControlPlane(config); await control.app.ready();
    await control.app.inject({ method: "POST", url: "/v1/auth/bootstrap", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password: "correct-horse-battery-staple" } });
    const login = await control.app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password: "correct-horse-battery-staple" } }); const cookie = String(login.headers["set-cookie"]!); const raw = /chubz_session=([^;]+)/.exec(cookie)![1]!; const csrf = (login.json() as { csrfToken: string }).csrfToken;
    const row = control.database.connection.prepare("SELECT id_hash, csrf_hash FROM sessions").get() as { id_hash: string; csrf_hash: string };
    const digest = (value: string) => createHmac("sha256", config.sessionSecret).update(value).digest("hex");
    expect(row.id_hash).toBe(digest(raw)); expect(row.csrf_hash).toBe(digest(csrf)); expect(`${row.id_hash}${row.csrf_hash}`).not.toContain(raw); expect(`${row.id_hash}${row.csrf_hash}`).not.toContain(csrf);
    await control.close(); const rotated = createControlPlane({ ...config, sessionSecret: "y".repeat(64) }); await rotated.app.ready(); expect((await rotated.app.inject({ method: "GET", url: "/v1/session", headers: { cookie } })).statusCode).toBe(401); await rotated.close();
  });
  it("enforces absolute and idle expiry and rejects stale CSRF values", async () => {
    const control = fixture({ sessionTtlMs: 25, sessionIdleMs: 1_000 }); await control.app.ready();
    await control.app.inject({ method: "POST", url: "/v1/auth/bootstrap", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password: "correct-horse-battery-staple" } });
    const login = await control.app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password: "correct-horse-battery-staple" } }); const cookie = String(login.headers["set-cookie"]!); const csrf = (login.json() as { csrfToken: string }).csrfToken;
    expect((await control.app.inject({ method: "POST", url: "/v1/auth/logout", headers: { origin, cookie, "x-csrf-token": "stale-token" } })).statusCode).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 35)); expect((await control.app.inject({ method: "GET", url: "/v1/session", headers: { cookie } })).statusCode).toBe(401); await control.close();
    const idle = fixture({ sessionTtlMs: 1_000, sessionIdleMs: 25 }); await idle.app.ready();
    await idle.app.inject({ method: "POST", url: "/v1/auth/bootstrap", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password: "correct-horse-battery-staple" } }); const idleLogin = await idle.app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password: "correct-horse-battery-staple" } });
    await new Promise((resolve) => setTimeout(resolve, 35)); expect((await idle.app.inject({ method: "GET", url: "/v1/session", headers: { cookie: String(idleLogin.headers["set-cookie"]!) } })).statusCode).toBe(401); await idle.close();
  });
});

describe("authenticated WebSocket foundation", () => {
  it("rejects unauthenticated access and persists idempotent protocol deliveries", async () => {
    const control = fixture(); await control.app.ready();
    await control.app.inject({ method: "POST", url: "/v1/auth/bootstrap", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password: "correct-horse-battery-staple" } });
    const login = await control.app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password: "correct-horse-battery-staple" } }); const cookie = login.headers["set-cookie"]!;
    const address = await control.app.listen({ host: "127.0.0.1", port: 0 });
    const unauthenticated = await new Promise<number>((resolve) => { const ws = new WebSocket(`${address}/v1/ws`, { headers: { origin } }); ws.once("close", (code) => resolve(code)); });
    expect(unauthenticated).toBe(1008);
    const responses = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const ws = new WebSocket(`${address}/v1/ws`, { headers: { origin, cookie } }); const received: Array<Record<string, unknown>> = [];
      ws.once("open", () => { const message = { protocolVersion: "1.0", messageId: "message-1", messageKind: "chat.submit", sentAt: new Date().toISOString(), projectId: "demo", idempotencyKey: "idem-key-1", payload: { input: { kind: "natural-language", text: "Draft a plan" }, projectId: "demo" } }; ws.send(JSON.stringify(message)); ws.send(JSON.stringify({ ...message, messageId: "message-2", sentAt: new Date().toISOString() })); });
      ws.on("message", (data) => { received.push(JSON.parse(data.toString()) as Record<string, unknown>); if (received.length === 2) { ws.close(); resolve(received); } }); ws.once("error", reject);
    });
    expect(responses.map((item) => (item.payload as { replayClassification?: string }).replayClassification)).toEqual(["new", "duplicate-same-request"]);
    expect(responses.map((item) => (item.payload as { acceptedMessageId?: string; resultRef?: string }).acceptedMessageId)).toEqual(["message-1", "message-1"]);
    expect(responses.map((item) => (item.payload as { acceptedMessageId?: string; resultRef?: string }).resultRef)).toEqual(["message-1", "message-1"]);
    expect((control.database.connection.prepare("SELECT count(*) AS n FROM idempotency_records").get() as { n: number }).n).toBe(1);
    await control.close();
  });
  it("replays persisted events after the accepted cursor and rejects future cursors", async () => {
    const control = fixture(); await control.app.ready();
    await control.app.inject({ method: "POST", url: "/v1/auth/bootstrap", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password: "correct-horse-battery-staple" } });
    const login = await control.app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password: "correct-horse-battery-staple" } }); const cookie = String(login.headers["set-cookie"]!);
    control.emitEvent("stream-one", { protocolVersion: "1.0", messageId: "event-message-one", messageKind: "task.event", sentAt: new Date().toISOString(), payload: { streamId: "stream-one", sequence: 1, eventId: "event-one", taskId: "task-one", occurredAt: new Date().toISOString(), eventKind: "updated" } });
    const address = await control.app.listen({ host: "127.0.0.1", port: 0 });
    const resume = (lastConsumedSequence: number) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`${address}/v1/ws`, { headers: { origin, cookie } }); ws.once("open", () => ws.send(JSON.stringify({ protocolVersion: "1.0", messageId: `resume-${lastConsumedSequence}`, messageKind: "stream.resume", sentAt: new Date().toISOString(), payload: { cursor: { streamId: "stream-one", lastConsumedSequence } } })));
      ws.once("message", (data) => { const message = JSON.parse(data.toString()) as Record<string, unknown>; ws.close(); resolve(message); }); ws.once("error", reject);
    });
    expect((await resume(0)).messageKind).toBe("task.event"); expect((await resume(2)).messageKind).toBe("protocol.error"); await control.close();
  });
});
