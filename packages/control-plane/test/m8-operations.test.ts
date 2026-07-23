import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createControlPlane } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ControlPlaneDatabase } from "../src/database.js";
import { M8OperationsService } from "../src/m8-operations.js";

const origin = "http://127.0.0.1:4317"; const roots: string[] = [];
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "chubz-m8-test-")); roots.push(root); const config = { ...createTestConfig(root), logLevel: "fatal" as const }; return { root, config, control: createControlPlane(config) }; };
afterEach(async () => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const authenticate = async (control: ReturnType<typeof createControlPlane>) => { await control.app.inject({ method: "POST", url: "/v1/auth/bootstrap", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password: "correct-horse-battery-staple" } }); const login = await control.app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password: "correct-horse-battery-staple" } }); return { cookie: String(login.headers["set-cookie"]), csrf: (login.json() as { csrfToken: string }).csrfToken }; };
const headers = (auth: { cookie: string; csrf: string }) => ({ origin, cookie: auth.cookie, "x-csrf-token": auth.csrf, "content-type": "application/json" });
const createManual = async (control: ReturnType<typeof createControlPlane>, auth: { cookie: string; csrf: string }, projectId = "project-one") => { const response = await control.app.inject({ method: "POST", url: "/v1/ui/tasks", headers: headers(auth), payload: { idempotencyKey: `task-create:${projectId}`, projectId, instructions: "bounded recovery test", workerId: "manual-relay", timeoutSec: 30 } }); expect(response.statusCode).toBe(201); return response.json() as { taskId: string; operationId: string; version: number }; };

describe("M8 Bridge Log projection", () => {
  it("projects deterministically, suppresses duplicates, detects tampering, sanitizes content, and rebuilds only from authoritative events", async () => {
    const { root, control } = fixture(); const auth = await authenticate(control); const task = await createManual(control, auth);
    const before = (control.database.connection.prepare("SELECT COUNT(*) AS n FROM m8_operational_events").get() as { n: number }).n;
    const event = { eventId: "manual-safe-event", eventKind: "operator-note", projectId: "project-one", taskId: task.taskId, source: "m8_recovery_incidents", actorCategory: "owner", summary: "<script>alert(1)</script> password=top-secret", occurredAt: "2026-07-23T00:00:00.000Z" };
    control.operations.record(event); control.operations.record(event); control.operations.project();
    expect((control.database.connection.prepare("SELECT COUNT(*) AS n FROM m8_operational_events").get() as { n: number }).n).toBe(before + 1);
    expect(() => control.operations.record({ ...event, summary: "conflicting payload" })).toThrow("conflicts");
    const projectionPath = join(root, "bridge-log", "bridge-log.md"); const projected = readFileSync(projectionPath, "utf8"); expect(projected).toContain("Non-authoritative"); expect(projected).not.toMatch(/<script>|top-secret|password=/u);
    const taskState = control.database.connection.prepare("SELECT state,version FROM tasks WHERE task_id=?").get(task.taskId);
    writeFileSync(projectionPath, `${projected}\nmanual edit\n`); expect(control.operations.verify()).toMatchObject({ projection: { status: "tampered" } }); expect(control.database.connection.prepare("SELECT state,version FROM tasks WHERE task_id=?").get(task.taskId)).toEqual(taskState);
    const status = control.operations.status() as { projection: { version: number } }; const rebuilt = await control.app.inject({ method: "POST", url: "/v1/ui/bridge-log/rebuild", headers: headers(auth), payload: { idempotencyKey: "projection-rebuild-one", expectedVersion: status.projection.version } }); expect(rebuilt.statusCode).toBe(200); expect(readFileSync(projectionPath, "utf8")).not.toContain("manual edit");
    await control.close();
  });

  it("detects authoritative cursor gaps and rejects junction-backed projection roots", async () => {
    const { control } = fixture(); control.operations.record({ eventId: "gap-event-one", eventKind: "test-event", source: "m8_operational_events", actorCategory: "system-recovery", summary: "first", occurredAt: new Date().toISOString() }); control.operations.project();
    const row = control.database.connection.prepare("SELECT sequence FROM m8_operational_events WHERE event_id='gap-event-one'").get() as { sequence: number }; control.database.connection.prepare("DELETE FROM m8_operational_events WHERE sequence=?").run(row.sequence);
    expect(control.operations.verify()).toMatchObject({ projection: { status: "gap" } }); await control.close();
    const root = mkdtempSync(join(tmpdir(), "chubz-m8-link-test-")); roots.push(root); const target = join(root, "target"); mkdirSync(target); const data = join(root, "test-data"); mkdirSync(data); symlinkSync(target, join(data, "bridge-log"), process.platform === "win32" ? "junction" : "dir");
    const config = { ...createTestConfig(data), logLevel: "fatal" as const }; const database = new ControlPlaneDatabase(config); try { expect(() => new M8OperationsService(database, config)).toThrow(/path is not trusted/u); } finally { database.close(); }
  });
});

describe("M8 owner emergency stop and recovery", () => {
  it("enforces auth, Origin, CSRF, ownership, idempotency, stale release, scoped blocking, honest cancellation, and no auto-resume", async () => {
    const { control } = fixture(); const auth = await authenticate(control); const task = await createManual(control, auth, "project-one");
    const payload = { scopeType: "project", projectId: "project-one", reason: "<b>owner safety stop</b>", expectedVersion: 0, idempotencyKey: "emergency-project-one" };
    expect((await control.app.inject({ method: "POST", url: "/v1/ui/emergency-stops", headers: { origin, "content-type": "application/json" }, payload })).statusCode).toBe(403);
    expect((await control.app.inject({ method: "POST", url: "/v1/ui/emergency-stops", headers: { ...headers(auth), origin: "http://evil.invalid" }, payload })).statusCode).toBe(403);
    const activated = await control.app.inject({ method: "POST", url: "/v1/ui/emergency-stops", headers: headers(auth), payload }); expect(activated.statusCode).toBe(201); const stop = activated.json() as { stopId: string; version: number; cancellations: Array<{ confirmed: boolean }> }; expect(stop.cancellations[0]?.confirmed).toBe(false);
    const duplicate = await control.app.inject({ method: "POST", url: "/v1/ui/emergency-stops", headers: headers(auth), payload }); expect(duplicate.json()).toEqual(activated.json());
    expect((await control.app.inject({ method: "POST", url: "/v1/ui/emergency-stops", headers: headers(auth), payload: { ...payload, reason: "conflict" } })).statusCode).toBe(409);
    expect(() => control.operations.assertExecutionAllowed("project-one")).toThrow("emergency stop"); expect(() => control.operations.assertExecutionAllowed("project-two")).not.toThrow();
    expect((await control.app.inject({ method: "POST", url: `/v1/ui/emergency-stops/${stop.stopId}/release`, headers: headers(auth), payload: { expectedVersion: 0, idempotencyKey: "emergency-release-stale" } })).statusCode).toBe(409);
    const released = await control.app.inject({ method: "POST", url: `/v1/ui/emergency-stops/${stop.stopId}/release`, headers: headers(auth), payload: { expectedVersion: 1, idempotencyKey: "emergency-release-valid" } }); expect(released.statusCode).toBe(200); expect(released.json()).toMatchObject({ autoResumed: false }); expect((control.database.connection.prepare("SELECT state FROM tasks WHERE task_id=?").get(task.taskId) as { state: string }).state).toBe("CANCELLING");
    await control.close();
  });

  it("persists global stop and deduplicated execution-unknown recovery across repeated restarts", async () => {
    const value = fixture(); const auth = await authenticate(value.control); const task = await createManual(value.control, auth, "project-restart"); await value.control.close();
    const restarted = createControlPlane(value.config); expect((restarted.database.connection.prepare("SELECT state,blocked_context_json FROM tasks WHERE task_id=?").get(task.taskId) as { state: string; blocked_context_json: string }).state).toBe("BLOCKED");
    expect((restarted.operations.status() as { incidents: Array<{ condition: string }> }).incidents.some((incident) => incident.condition === "operation-started-completion-unknown")).toBe(true); const count = (restarted.database.connection.prepare("SELECT COUNT(*) AS n FROM m8_recovery_incidents").get() as { n: number }).n; await restarted.close();
    const again = createControlPlane(value.config); expect((again.database.connection.prepare("SELECT COUNT(*) AS n FROM m8_recovery_incidents").get() as { n: number }).n).toBe(count); const authAgain = await authenticate(again).catch(() => auth);
    const activated = await again.app.inject({ method: "POST", url: "/v1/ui/emergency-stops", headers: headers(authAgain), payload: { scopeType: "global", reason: "restart persistence", expectedVersion: 0, idempotencyKey: "emergency-global-one" } }); expect(activated.statusCode).toBe(201); await again.close();
    const final = createControlPlane(value.config); expect((final.operations.status() as { emergency: { active: boolean } }).emergency.active).toBe(true); expect(() => final.operations.assertExecutionAllowed("any-project")).toThrow("emergency stop"); await final.close();
  });
});
