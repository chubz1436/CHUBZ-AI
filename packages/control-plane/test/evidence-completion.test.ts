import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createControlPlane, type ControlPlane } from "../src/app.js";
import { createTestConfig, type ControlPlaneConfig } from "../src/config.js";
import { ControlPlaneDatabase, MigrationError } from "../src/database.js";

const origin = "http://127.0.0.1:4317";
const password = "correct-horse-battery-staple";
const roots: string[] = [];
const controls = new Set<ControlPlane>();
const sockets = new Set<WebSocket>();

const isolatedConfig = (): ControlPlaneConfig => {
  const root = mkdtempSync(join(tmpdir(), "chubz-control-plane-evidence-test-"));
  roots.push(root);
  return { ...createTestConfig(root), logLevel: "fatal" };
};

const createTrackedControl = (config: ControlPlaneConfig): ControlPlane => {
  const control = createControlPlane(config);
  controls.add(control);
  return control;
};

const closeControl = async (control: ControlPlane): Promise<void> => {
  if (!controls.delete(control)) return;
  await control.close();
};

const bootstrapAndLogin = async (control: ControlPlane): Promise<{ cookie: string; csrf: string }> => {
  await control.app.ready();
  expect((await control.app.inject({ method: "POST", url: "/v1/auth/bootstrap", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password } })).statusCode).toBe(201);
  const login = await control.app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password } });
  expect(login.statusCode).toBe(200);
  return { cookie: String(login.headers["set-cookie"]), csrf: (login.json() as { csrfToken: string }).csrfToken };
};

const openSocket = async (address: string, cookie: string): Promise<WebSocket> => {
  const socket = new WebSocket(`${address}/v1/ws`, { headers: { origin, cookie } });
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return socket;
};

const closeSocket = async (socket: WebSocket): Promise<void> => {
  if (!sockets.has(socket)) return;
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.close();
  await closed;
};

const collectUntilPong = (socket: WebSocket, request: unknown): Promise<Array<Record<string, unknown>>> => new Promise((resolve, reject) => {
  const received: Array<Record<string, unknown>> = [];
  const marker = Buffer.from(`marker-${Math.random()}`);
  const cleanup = () => { socket.off("message", onMessage); socket.off("pong", onPong); socket.off("error", onError); };
  const onMessage = (data: WebSocket.RawData) => received.push(JSON.parse(data.toString()) as Record<string, unknown>);
  const onPong = (data: Buffer) => { if (!data.equals(marker)) return; cleanup(); resolve(received); };
  const onError = (error: Error) => { cleanup(); reject(error); };
  socket.on("message", onMessage); socket.on("pong", onPong); socket.on("error", onError);
  socket.send(JSON.stringify(request), (error) => {
    if (error) return onError(error);
    socket.ping(marker, undefined, (pingError) => { if (pingError) onError(pingError); });
  });
});

const chatMessage = (messageId: string, idempotencyKey: string, text = "Draft a plan") => ({
  protocolVersion: "1.0",
  messageId,
  messageKind: "chat.submit",
  sentAt: new Date().toISOString(),
  projectId: "demo",
  idempotencyKey,
  payload: { input: { kind: "natural-language", text }, projectId: "demo" },
});

const resumeMessage = (messageId: string, streamId: string, lastConsumedSequence: unknown) => ({
  protocolVersion: "1.0",
  messageId,
  messageKind: "stream.resume",
  sentAt: new Date().toISOString(),
  payload: { cursor: { streamId, lastConsumedSequence } },
});

const taskEvent = (streamId: string, sequence: number) => ({
  protocolVersion: "1.0" as const,
  messageId: `event-message-${sequence}`,
  messageKind: "task.event" as const,
  sentAt: new Date().toISOString(),
  payload: { streamId, sequence, eventId: `event-${sequence}`, taskId: "task-one", occurredAt: new Date().toISOString(), eventKind: "updated" },
});

const errorCode = (message: Record<string, unknown>): string | undefined => ((message.payload as { error?: { code?: string } }).error?.code);
const eventSequence = (message: Record<string, unknown>): number => ((message.payload as { sequence: number }).sequence);

afterEach(async () => {
  for (const socket of [...sockets]) socket.terminate();
  sockets.clear();
  for (const control of [...controls]) await closeControl(control).catch(() => undefined);
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("M2 idempotency evidence completion", () => {
  it("classifies concurrent duplicate, conflict, and restart deliveries authoritatively", async () => {
    const config = isolatedConfig();
    const first = createTrackedControl(config);
    const { cookie } = await bootstrapAndLogin(first);
    const second = createTrackedControl(config); await second.app.ready();
    const firstAddress = await first.app.listen({ host: "127.0.0.1", port: 0 });
    const secondAddress = await second.app.listen({ host: "127.0.0.1", port: 0 });
    const firstSocket = await openSocket(firstAddress, cookie);
    const secondSocket = await openSocket(secondAddress, cookie);

    const [firstResponse, secondResponse] = await Promise.all([
      collectUntilPong(firstSocket, chatMessage("concurrent-one", "shared-key")),
      collectUntilPong(secondSocket, chatMessage("concurrent-two", "shared-key")),
    ]);
    expect(firstResponse).toHaveLength(1); expect(secondResponse).toHaveLength(1);
    expect(firstResponse[0]!.messageKind).toBe("request.accepted"); expect(secondResponse[0]!.messageKind).toBe("request.accepted");
    const record = first.database.connection.prepare("SELECT first_message_id, response_ref FROM idempotency_records WHERE idempotency_key=?").get("shared-key") as { first_message_id: string; response_ref: string };
    expect((firstResponse[0]!.payload as { resultRef: string }).resultRef).toBe(record.response_ref);
    expect((secondResponse[0]!.payload as { resultRef: string }).resultRef).toBe(record.response_ref);
    expect((first.database.connection.prepare("SELECT count(*) AS n FROM idempotency_records WHERE idempotency_key=?").get("shared-key") as { n: number }).n).toBe(1);

    const conflict = await collectUntilPong(firstSocket, chatMessage("conflicting-message", "shared-key", "Different payload"));
    expect(conflict).toHaveLength(1); expect(conflict[0]!.messageKind).toBe("protocol.error"); expect(errorCode(conflict[0]!)).toBe("IDEMPOTENCY_CONFLICT");

    await closeSocket(firstSocket); await closeSocket(secondSocket); await closeControl(first); await closeControl(second);
    const restarted = createTrackedControl(config); await restarted.app.ready();
    const restartedAddress = await restarted.app.listen({ host: "127.0.0.1", port: 0 }); const restartedSocket = await openSocket(restartedAddress, cookie);
    const duplicateAfterRestart = await collectUntilPong(restartedSocket, chatMessage("restart-duplicate", "shared-key"));
    expect((duplicateAfterRestart[0]!.payload as { replayClassification: string; resultRef: string }).replayClassification).toBe("duplicate-same-request");
    expect((duplicateAfterRestart[0]!.payload as { resultRef: string }).resultRef).toBe(record.response_ref);
    const conflictAfterRestart = await collectUntilPong(restartedSocket, chatMessage("restart-conflict", "shared-key", "Still different"));
    expect(errorCode(conflictAfterRestart[0]!)).toBe("IDEMPOTENCY_CONFLICT");
    await closeSocket(restartedSocket); await closeControl(restarted);
  });

  it("does not cache a failed idempotency transaction as a successful result", async () => {
    const config = isolatedConfig(); const control = createTrackedControl(config); const { cookie } = await bootstrapAndLogin(control);
    const address = await control.app.listen({ host: "127.0.0.1", port: 0 }); const socket = await openSocket(address, cookie);
    control.database.connection.exec("CREATE TRIGGER fail_idempotency_insert BEFORE INSERT ON idempotency_records BEGIN SELECT RAISE(ABORT, 'injected test failure'); END");
    const failed = await collectUntilPong(socket, chatMessage("failed-message", "retryable-key"));
    expect(failed).toHaveLength(1); expect(failed[0]!.messageKind).toBe("protocol.error");
    expect((control.database.connection.prepare("SELECT count(*) AS n FROM idempotency_records WHERE idempotency_key=?").get("retryable-key") as { n: number }).n).toBe(0);
    control.database.connection.exec("DROP TRIGGER fail_idempotency_insert");
    const retry = await collectUntilPong(socket, chatMessage("successful-retry", "retryable-key"));
    expect(retry).toHaveLength(1); expect(retry[0]!.messageKind).toBe("request.accepted");
    expect((retry[0]!.payload as { replayClassification: string }).replayClassification).toBe("new");
    expect((control.database.connection.prepare("SELECT count(*) AS n FROM idempotency_records WHERE idempotency_key=?").get("retryable-key") as { n: number }).n).toBe(1);
    await closeSocket(socket); await closeControl(control);
  });
});

describe("M2 CSRF evidence completion", () => {
  it("isolates CSRF tokens across rotated sessions and sanitizes stale-token failures", async () => {
    const control = createTrackedControl(isolatedConfig()); const first = await bootstrapAndLogin(control);
    const secondLogin = await control.app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password } });
    const second = { cookie: String(secondLogin.headers["set-cookie"]), csrf: (secondLogin.json() as { csrfToken: string }).csrfToken };
    const crossed = await control.app.inject({ method: "POST", url: "/v1/auth/logout", headers: { origin, cookie: second.cookie, "x-csrf-token": first.csrf } });
    expect(crossed.statusCode).toBe(403); expect(crossed.body).not.toContain(first.csrf); expect(crossed.body).not.toContain(second.cookie); expect(crossed.body).not.toContain("owner");
    const revoked = await control.app.inject({ method: "POST", url: "/v1/auth/logout", headers: { origin, cookie: first.cookie, "x-csrf-token": second.csrf } });
    expect(revoked.statusCode).toBe(403); expect(revoked.body).not.toContain(second.csrf); expect(revoked.body).not.toContain(first.cookie);
    expect((await control.app.inject({ method: "POST", url: "/v1/auth/logout", headers: { origin, cookie: second.cookie, "x-csrf-token": second.csrf } })).statusCode).toBe(204);
    expect((await control.app.inject({ method: "POST", url: "/v1/auth/logout", headers: { origin, cookie: second.cookie, "x-csrf-token": second.csrf } })).statusCode).toBe(403);
    await closeControl(control);
  });
});

describe("M2 migration rollback evidence completion", () => {
  it("rolls back a failing migration and never records its version marker", () => {
    const config = isolatedConfig(); const initial = new ControlPlaneDatabase(config); const db = initial.connection;
    db.exec("DROP TRIGGER administrators_singleton_insert; DROP TRIGGER m6_manual_results_immutable_update; DROP TRIGGER m6_manual_results_immutable_delete; DROP TABLE administrator_singleton_guard; DROP TABLE m6_manual_results; DROP TABLE m6_mutations; DROP TABLE m5_worker_states; DROP TABLE m5_adapter_readiness; DELETE FROM schema_migrations WHERE version IN (2, 3, 4, 5, 6)");
    for (const username of ["owner-one", "owner-two"]) db.prepare("INSERT INTO administrators(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)").run(username, username, "hash", new Date().toISOString());
    initial.close();
    expect(() => new ControlPlaneDatabase(config)).toThrow(MigrationError);
    const inspection = new Database(config.databasePath);
    expect(inspection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='administrator_singleton_guard'").get()).toBeUndefined();
    expect(inspection.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='administrators_singleton_insert'").get()).toBeUndefined();
    expect((inspection.prepare("SELECT group_concat(version) AS versions FROM schema_migrations").get() as { versions: string }).versions).toBe("1");
    expect((inspection.prepare("SELECT count(*) AS n FROM administrators").get() as { n: number }).n).toBe(2); inspection.close();
    expect(() => new ControlPlaneDatabase(config)).toThrow(MigrationError);
  });
});

describe("M2 cursor and event evidence completion", () => {
  it("rejects malformed and future cursors and bounds replay strictly after the cursor", async () => {
    const control = createTrackedControl(isolatedConfig()); const { cookie } = await bootstrapAndLogin(control); const streamId = "bounded-stream";
    for (let sequence = 1; sequence <= 70; sequence += 1) control.emitEvent(streamId, taskEvent(streamId, sequence));
    const address = await control.app.listen({ host: "127.0.0.1", port: 0 }); const socket = await openSocket(address, cookie);
    const malformed = await collectUntilPong(socket, resumeMessage("malformed-cursor", streamId, "bad"));
    expect(malformed).toHaveLength(1); expect(errorCode(malformed[0]!)).toBe("VALIDATION_ERROR");
    const negative = await collectUntilPong(socket, resumeMessage("negative-cursor", streamId, -1));
    expect(negative).toHaveLength(1); expect(errorCode(negative[0]!)).toBe("VALIDATION_ERROR");
    const future = await collectUntilPong(socket, resumeMessage("future-cursor", streamId, 71));
    expect(future).toHaveLength(1); expect(errorCode(future[0]!)).toBe("CURSOR_UNAVAILABLE");
    const replay = await collectUntilPong(socket, resumeMessage("bounded-cursor", streamId, 5));
    expect(replay).toHaveLength(64); expect(replay.map(eventSequence)).toEqual(Array.from({ length: 64 }, (_, index) => index + 6));
    expect((control.database.connection.prepare("SELECT count(*) AS n FROM events WHERE stream_id=?").get(streamId) as { n: number }).n).toBe(70);
    await closeSocket(socket); await closeControl(control);
  });

  it("persists ordered event replay across a full service restart", async () => {
    const config = isolatedConfig(); const first = createTrackedControl(config); const { cookie } = await bootstrapAndLogin(first); const streamId = "restart-stream";
    for (let sequence = 1; sequence <= 3; sequence += 1) first.emitEvent(streamId, taskEvent(streamId, sequence));
    await closeControl(first);
    const restarted = createTrackedControl(config); await restarted.app.ready();
    expect((restarted.database.connection.prepare("SELECT count(*) AS n FROM events WHERE stream_id=?").get(streamId) as { n: number }).n).toBe(3);
    const address = await restarted.app.listen({ host: "127.0.0.1", port: 0 }); const socket = await openSocket(address, cookie);
    const replay = await collectUntilPong(socket, resumeMessage("restart-resume", streamId, 1));
    expect(replay.map(eventSequence)).toEqual([2, 3]);
    expect(replay.map((message) => message.messageId)).toEqual(["event-message-2", "event-message-3"]);
    await closeSocket(socket); await closeControl(restarted);
  });

  it("keeps replay state isolated between WebSocket connections", async () => {
    const control = createTrackedControl(isolatedConfig()); const { cookie } = await bootstrapAndLogin(control); const streamId = "isolated-stream";
    for (let sequence = 1; sequence <= 3; sequence += 1) control.emitEvent(streamId, taskEvent(streamId, sequence));
    const address = await control.app.listen({ host: "127.0.0.1", port: 0 }); const first = await openSocket(address, cookie); const second = await openSocket(address, cookie);
    const firstReplay = await collectUntilPong(first, resumeMessage("first-resume", streamId, 1)); expect(firstReplay.map(eventSequence)).toEqual([2, 3]);
    await closeSocket(first);
    const secondReplay = await collectUntilPong(second, resumeMessage("second-resume", streamId, 0)); expect(secondReplay.map(eventSequence)).toEqual([1, 2, 3]);
    const secondFollowup = await collectUntilPong(second, resumeMessage("second-followup", streamId, 2)); expect(secondFollowup.map(eventSequence)).toEqual([3]);
    expect((control.database.connection.prepare("SELECT head_sequence FROM event_streams WHERE stream_id=?").get(streamId) as { head_sequence: number }).head_sequence).toBe(3);
    await closeSocket(second); await closeControl(control);
  });
});

describe("M2 graceful shutdown evidence completion", () => {
  it("closes listeners, WebSockets, and SQLite while preserving committed records", async () => {
    const config = isolatedConfig(); const control = createTrackedControl(config); const { cookie } = await bootstrapAndLogin(control); const streamId = "shutdown-stream";
    control.emitEvent(streamId, taskEvent(streamId, 1));
    const address = await control.app.listen({ host: "127.0.0.1", port: 0 }); const socket = await openSocket(address, cookie);
    const socketClosed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    await closeControl(control); expect(await socketClosed).toBe(1005); expect(control.database.connection.open).toBe(false);
    await expect(fetch(`${address}/healthz`)).rejects.toThrow();
    const restarted = createTrackedControl(config); expect((restarted.database.connection.prepare("SELECT count(*) AS n FROM events WHERE stream_id=?").get(streamId) as { n: number }).n).toBe(1); await closeControl(restarted);
  });
});
