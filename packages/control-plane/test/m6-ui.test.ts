import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createControlPlane } from "../src/app.js";
import { createTestConfig } from "../src/config.js";

const origin = "http://127.0.0.1:4317";
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "chubz-m6-ui-test-")); roots.push(root); return createControlPlane(createTestConfig(root)); };
const authenticate = async (control: ReturnType<typeof fixture>) => {
  await control.app.ready();
  await control.app.inject({ method: "POST", url: "/v1/auth/bootstrap", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password: "correct-horse-battery-staple" } });
  const login = await control.app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin, "content-type": "application/json" }, payload: { username: "owner", password: "correct-horse-battery-staple" } });
  return { cookie: String(login.headers["set-cookie"]), csrf: (login.json() as { csrfToken: string }).csrfToken };
};
const headers = (auth: Awaited<ReturnType<typeof authenticate>>) => ({ origin, cookie: auth.cookie, "x-csrf-token": auth.csrf, "content-type": "application/json" });
const manualRequest = (key = "task-create:manual-one", instructions = "Review the bounded change") => ({ idempotencyKey: key, projectId: "project-manual", instructions, workerId: "manual-relay", timeoutSec: 900 });

function seedReadyCodex(control: ReturnType<typeof fixture>): void {
  const hash = "1".repeat(64); const at = new Date().toISOString(); const evidenceId = `evidence.codex.sha256.${hash}`;
  const readiness = {
    coordinationVersion: "1.0", readinessId: `readiness.codex.sha256.${hash}`, workerId: "codex-cli", adapterId: "codex-cli-adapter", connectorTier: "cli", providerId: "openai", runtimeId: "codex-cli-runtime", installedVersion: "1.2.3",
    executableId: "codex-native", executableHash: `sha256:${"2".repeat(64)}`, authenticationState: "authenticated", sandboxCapability: "validated", noninteractiveCapability: "validated", structuredOutputCapability: "validated", cancellationCapability: "validated", resumeCapability: "validated", healthStatus: "healthy", quotaVisibility: "unknown", freezeState: "enabled", capabilityProbeAt: at, readinessState: "ready",
    capabilities: [{ capability: "code-write", assurance: "validated", evidenceRef: evidenceId }, { capability: "review", assurance: "validated", evidenceRef: evidenceId }], evidenceRefs: [evidenceId],
  };
  const evidence = { evidenceId, compatibility: "passed", drift: false, windowsSandbox: { configuredImplementation: "elevated", selectedImplementation: "elevated", elevatedProbeResult: "passed", elevatedFailureClassification: null, fallbackSelected: false, fallbackCanaryResult: "not-required", assurance: "elevated" } };
  control.database.connection.prepare("INSERT INTO m5_adapter_readiness(readiness_id,worker_id,adapter_id,readiness_state,freeze_state,readiness_json,evidence_json,recorded_at) VALUES(?,?,?,?,?,?,?,?)").run(readiness.readinessId, readiness.workerId, readiness.adapterId, readiness.readinessState, readiness.freezeState, JSON.stringify(readiness), JSON.stringify(evidence), at);
}

describe("M6 authenticated UI API", () => {
  it("restores a CSRF-bearing session and fails closed without authentication or CSRF", async () => {
    const control = fixture(); await control.app.ready();
    expect((await control.app.inject({ method: "GET", url: "/v1/ui/snapshot" })).statusCode).toBe(401);
    const auth = await authenticate(control);
    const session = await control.app.inject({ method: "GET", url: "/v1/session", headers: { cookie: auth.cookie } });
    expect(session.statusCode).toBe(200); expect(session.json()).toMatchObject({ username: "owner", role: "sole-administrator", csrfToken: auth.csrf });
    const denied = await control.app.inject({ method: "POST", url: "/v1/ui/tasks", headers: { origin, cookie: auth.cookie, "content-type": "application/json" }, payload: manualRequest() });
    expect(denied.statusCode).toBe(403); expect(denied.body).not.toContain("correct-horse"); await control.close();
  });

  it("creates and reloads an immutable manual task, redacts sensitive text, and enforces aggregate idempotency", async () => {
    const control = fixture(); const auth = await authenticate(control); const secret = "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const first = await control.app.inject({ method: "POST", url: "/v1/ui/tasks", headers: headers(auth), payload: manualRequest("task-create:redacted-one", `Review api_key=${secret}`) });
    expect(first.statusCode).toBe(201); const created = first.json() as { taskId: string; attemptId: string; state: string; version: number }; expect(created).toMatchObject({ state: "RUNNING", version: 3 });
    const replay = await control.app.inject({ method: "POST", url: "/v1/ui/tasks", headers: headers(auth), payload: manualRequest("task-create:redacted-one", `Review api_key=${secret}`) });
    expect(replay.statusCode).toBe(201); expect(replay.json()).toEqual(first.json());
    const conflict = await control.app.inject({ method: "POST", url: "/v1/ui/tasks", headers: headers(auth), payload: manualRequest("task-create:redacted-one", "different request") });
    expect(conflict.statusCode).toBe(409);
    control.database.connection.prepare("INSERT INTO m4_results(result_ref,task_id,attempt_id,operation_id,result_digest,result_json,status,recorded_at) VALUES(?,?,?,?,?,?,?,?)").run("result-hostile-one", created.taskId, created.attemptId, "operation-hostile-one", `sha256:${"2".repeat(64)}`, JSON.stringify({ output: `api_key=${secret}`, accessToken: secret, nested: { rawEnvironment: { HOME: "not-for-browser" }, safeValue: "retained" } }), "completed", new Date().toISOString());
    const snapshot = await control.app.inject({ method: "GET", url: "/v1/ui/snapshot", headers: { cookie: auth.cookie } }); const body = snapshot.body;
    expect(snapshot.statusCode).toBe(200); expect(body).not.toContain(secret); expect(body).not.toContain("not-for-browser"); expect(body).not.toContain("accessToken"); expect(body).not.toContain("rawEnvironment"); expect(body).toContain("retained"); expect(body).toContain("[REDACTED:"); expect(body).toContain("weaker-manual"); expect(body).not.toContain("password_hash"); expect(body).not.toContain("grant_json"); await control.close();
  });

  it("records only an authenticated owner-attested manual claim and rejects stale or unsupported artifact actions", async () => {
    const control = fixture(); const auth = await authenticate(control);
    const created = (await control.app.inject({ method: "POST", url: "/v1/ui/tasks", headers: headers(auth), payload: manualRequest("task-create:relay-flow") })).json() as { taskId: string; version: number };
    const stale = await control.app.inject({ method: "POST", url: `/v1/ui/tasks/${created.taskId}/manual-text`, headers: headers(auth), payload: { idempotencyKey: "manual-text:stale-one", expectedVersion: created.version - 1, responseType: "review", text: "done", attested: true } });
    expect(stale.statusCode).toBe(409);
    const unattested = await control.app.inject({ method: "POST", url: `/v1/ui/tasks/${created.taskId}/manual-text`, headers: headers(auth), payload: { idempotencyKey: "manual-text:unattested", expectedVersion: created.version, responseType: "review", text: "done", attested: false } });
    expect(unattested.statusCode).toBe(400);
    const secret = "ZXCVBNMASDFGHJKLQWERTYUIOP1234567890";
    const recorded = await control.app.inject({ method: "POST", url: `/v1/ui/tasks/${created.taskId}/manual-text`, headers: headers(auth), payload: { idempotencyKey: "manual-text:record-one", expectedVersion: created.version, responseType: "review", text: `worker says token=${secret}`, attested: true } });
    expect(recorded.statusCode).toBe(200); expect(recorded.json()).toMatchObject({ state: "AWAITING_APPROVAL", version: created.version + 2 });
    const recordedVersion = (recorded.json() as { version: number }).version;
    const decision = await control.app.inject({ method: "POST", url: `/v1/ui/tasks/${created.taskId}/decision`, headers: headers(auth), payload: { idempotencyKey: "decision:manual-one", expectedVersion: recordedVersion, decision: "approve" } });
    expect(decision.statusCode).toBe(200); expect(decision.json()).toMatchObject({ state: "APPROVED", decision: "approve", version: recordedVersion + 1 });
    const snapshot = await control.app.inject({ method: "GET", url: "/v1/ui/snapshot", headers: { cookie: auth.cookie } }); expect(snapshot.body).not.toContain(secret); expect(snapshot.body).toContain("owner-attested manual relay"); expect(snapshot.body).toContain('"workerClaim":true');
    const artifact = await control.app.inject({ method: "POST", url: `/v1/ui/tasks/${created.taskId}/manual-artifacts`, headers: headers(auth), payload: { idempotencyKey: "artifact:unavailable-one", sourcePath: "C:\\unsafe.exe" } });
    expect(artifact.statusCode).toBe(503); expect(artifact.body).not.toContain("C:\\unsafe.exe"); await control.close();
  });

  it("uses protected server transitions for Codex approval and cancellation without serializing grant authentication", async () => {
    const control = fixture(); const auth = await authenticate(control); seedReadyCodex(control);
    const request = { idempotencyKey: "task-create:codex-one", projectId: "project-codex", instructions: "Update the bounded README section", workerId: "codex-cli", scopeMode: "workspace-write", allowedPaths: ["README.md"], timeoutSec: 600 };
    const create = await control.app.inject({ method: "POST", url: "/v1/ui/tasks", headers: headers(auth), payload: request }); expect(create.statusCode).toBe(201); const task = create.json() as { taskId: string; version: number; state: string }; expect(task.state).toBe("AWAITING_DISPATCH");
    const recommendation = (await control.app.inject({ method: "POST", url: `/v1/ui/tasks/${task.taskId}/routing/recommendations`, headers: headers(auth), payload: { idempotencyKey: "routing:codex-one", expectedVersion: task.version } })).json() as Record<string, unknown>; const selected = recommendation["selected"] as Record<string, unknown>;
    const route = await control.app.inject({ method: "POST", url: `/v1/ui/tasks/${task.taskId}/routing/recommendations/${String(recommendation["recommendationId"])}/confirm`, headers: headers(auth), payload: { idempotencyKey: "routing-confirm:codex-one", expectedVersion: task.version, recommendationVersion: recommendation["recommendationVersion"], inputDigest: recommendation["inputDigest"], selectedWorkerId: selected["workerId"], selectedAdapterId: selected["adapterId"] } }); expect(route.statusCode).toBe(200);
    const approve = await control.app.inject({ method: "POST", url: `/v1/ui/tasks/${task.taskId}/approve-dispatch`, headers: headers(auth), payload: { idempotencyKey: "approve:codex-one", expectedVersion: task.version } });
    expect(approve.statusCode).toBe(200); expect(approve.json()).toMatchObject({ grant: { status: "issued", singleUse: true } }); expect(approve.body).not.toContain("signature"); expect(approve.body).not.toContain("authentication");
    const double = await control.app.inject({ method: "POST", url: `/v1/ui/tasks/${task.taskId}/approve-dispatch`, headers: headers(auth), payload: { idempotencyKey: "approve:codex-two", expectedVersion: task.version } }); expect(double.statusCode).toBe(409);
    const cancel = await control.app.inject({ method: "POST", url: `/v1/ui/tasks/${task.taskId}/cancel`, headers: headers(auth), payload: { idempotencyKey: "cancel:codex-one", expectedVersion: task.version } }); expect(cancel.statusCode).toBe(200); expect(cancel.json()).toMatchObject({ state: "CANCELLING", cancellationConfirmed: false });
    const snapshot = await control.app.inject({ method: "GET", url: "/v1/ui/snapshot", headers: { cookie: auth.cookie } }); expect(snapshot.body).not.toContain("grantVersion"); expect(snapshot.body).not.toContain("signature"); await control.close();
  });

  it("labels execution-unknown and never exposes retry authority", async () => {
    const control = fixture(); const auth = await authenticate(control);
    const created = (await control.app.inject({ method: "POST", url: "/v1/ui/tasks", headers: headers(auth), payload: manualRequest("task-create:unknown-one") })).json() as { taskId: string; attemptId: string };
    const operation = control.database.connection.prepare("SELECT current_operation_id FROM tasks WHERE task_id=?").get(created.taskId) as { current_operation_id: string };
    control.database.connection.prepare("UPDATE tasks SET state='BLOCKED',blocked_context_json=?,version=version+1,updated_at=? WHERE task_id=?").run(JSON.stringify({ blockedFrom: "RUNNING", blockedOperation: "worker-execution", blockedReason: "execution-unknown", attemptId: created.attemptId, operationId: operation.current_operation_id, journalRef: "journal-unknown" }), new Date().toISOString(), created.taskId);
    const snapshot = (await control.app.inject({ method: "GET", url: "/v1/ui/snapshot", headers: { cookie: auth.cookie } })).json() as { tasks: Array<{ executionUnknown: boolean; actions: { canRetry: boolean } }> };
    expect(snapshot.tasks[0]).toMatchObject({ executionUnknown: true, actions: { canRetry: false } }); await control.close();
  });

  it("broadcasts authoritative task events and resumes from the persisted UI cursor", async () => {
    const control = fixture(); const auth = await authenticate(control); const address = await control.app.listen({ host: "127.0.0.1", port: 0 });
    const event = new Promise<Record<string, unknown>>((resolve, reject) => { const socket = new WebSocket(`${address.replace("http", "ws")}/v1/ws`, { headers: { origin, cookie: auth.cookie } }); const timer = setTimeout(() => reject(new Error("event timeout")), 5_000); socket.on("message", (data) => { const value = JSON.parse(data.toString()) as Record<string, unknown>; if (value["messageKind"] === "task.event") { clearTimeout(timer); socket.close(); resolve(value); } }); socket.on("error", reject); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const created = await control.app.inject({ method: "POST", url: "/v1/ui/tasks", headers: headers(auth), payload: manualRequest("task-create:websocket-one") }); expect(created.statusCode).toBe(201);
    const message = await event; expect(message["messageKind"]).toBe("task.event"); expect((message["payload"] as Record<string, unknown>)["sequence"]).toBe(1);
    const snapshot = (await control.app.inject({ method: "GET", url: "/v1/ui/snapshot", headers: { cookie: auth.cookie } })).json() as { cursor: { streamId: string; lastConsumedSequence: number } }; expect(snapshot.cursor).toEqual({ streamId: "ui-tasks", lastConsumedSequence: 1, oldestRetainedSequence: 1 }); await control.close();
  });
});
