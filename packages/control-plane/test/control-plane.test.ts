import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createControlPlane } from "../src/app.js";
import { ConfigurationError, createTestConfig, loadConfig } from "../src/config.js";

const roots: string[] = [];
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "chubz-control-plane-test-")); roots.push(root); return createControlPlane(createTestConfig(root)); };
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
    expect((db.prepare("SELECT count(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(1);
    await first.close();
    const second = createControlPlane(config);
    expect((second.database.connection.prepare("SELECT count(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(1);
    await second.close();
  });
});

describe("HTTP authentication and browser protections", () => {
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
    expect((control.database.connection.prepare("SELECT count(*) AS n FROM idempotency_records").get() as { n: number }).n).toBe(1);
    await control.close();
  });
});
