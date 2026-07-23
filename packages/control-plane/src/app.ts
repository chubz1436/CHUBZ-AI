import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { parseClientToControlPlaneMessage, type ControlPlaneToClientMessage, canonicalizeClientMutationForDigest, classifyDelivery, scopeKey } from "@chubz/shared";
import { detectRedactions, redactText } from "@chubz/shared";
import type WebSocket from "ws";
import type { AuthService, Principal } from "./auth.js";
import { AuthService as AuthServiceClass, BootstrapConflictError } from "./auth.js";
import type { ControlPlaneConfig } from "./config.js";
import { ControlPlaneDatabase } from "./database.js";
import { Phase1GrantKey } from "./grant-engine.js";
import { M6UiService, mapM6Error } from "./m6-ui.js";
import { M7ReviewService } from "./m7-review.js";
import { M8OperationsService } from "./m8-operations.js";
import { M9ApplyService } from "./m9-apply.js";
import { M10RoutingService } from "./m10-routing.js";
import { validateM11Configuration } from "./m11-config.js";
import { M11ArtifactService } from "./m11-artifacts.js";
import { M11OperationsService } from "./m11-operations.js";
import { M4Orchestrator } from "./orchestrator.js";

export type ControlPlane = Readonly<{ app: FastifyInstance; database: ControlPlaneDatabase; auth: AuthService; review: M7ReviewService; operations: M8OperationsService; apply: M9ApplyService; routing: M10RoutingService; operational: M11OperationsService; artifacts: M11ArtifactService; close: () => Promise<void>; emitEvent: (streamId: string, message: ControlPlaneToClientMessage) => void }>;
const json = "application/json";
const messageId = () => randomUUID();
const now = () => new Date().toISOString();
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const safeDetail = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const findings = detectRedactions(value);
  if (!findings.ok) return "[redacted]";
  const result = redactText(value, findings.value);
  return result.ok ? result.value.text.slice(0, 512) : "[redacted]";
};
const errorMessage = (code: string): string => ({ INVALID_REQUEST: "The request is invalid.", INVALID_INPUT: "The request is invalid.", LIMIT_EXCEEDED: "The request exceeds a safe bound.", UNAUTHORIZED: "Authentication is required.", FORBIDDEN: "The request is not permitted.", NOT_FOUND: "The requested record was not found.", CONFLICT: "The authoritative state changed or the request conflicts with an earlier action.", STALE_STATE: "The task changed. Refresh before trying again.", STOP_POINT: "The action is unavailable at the current safety boundary.", ILLEGAL_TRANSITION: "The requested state transition is unavailable.", RATE_LIMITED: "Too many attempts. Try again later.", IDEMPOTENCY_CONFLICT: "The request conflicts with a prior delivery.", UNAVAILABLE: "The required authoritative service is unavailable." }[code] ?? "The request could not be processed.");
const publicError = (reply: FastifyReply, status: number, code: string, requestId: string) => reply.code(status).send({ error: { code, message: errorMessage(code), requestId } });
const isOriginAllowed = (request: FastifyRequest, config: ControlPlaneConfig): boolean => request.headers.origin === config.allowedOrigin;
const reqId = (request: FastifyRequest): string => typeof request.id === "string" ? request.id.slice(0, 128) : messageId();
type LoginBucket = { count: number; expiresAt: number; generation: number };
type LoginBucketExpiry = Readonly<{ key: string; expiresAt: number; generation: number }>;

export function createControlPlane(config: ControlPlaneConfig): ControlPlane {
  const database = new ControlPlaneDatabase(config);
  const auth = new AuthServiceClass(database, config);
  const operations = new M8OperationsService(database, config);
  const grantSecret = createHash("sha256").update(`chubz.m6.runtime-grant/v1\n${config.sessionSecret}`, "utf8").digest();
  const gate = (projectId: string): void => operations.assertExecutionAllowed(projectId);
  const orchestrator = new M4Orchestrator(database, new Phase1GrantKey("control-plane-runtime", grantSecret), undefined, gate);
  operations.reconcileTaskLifecycle(orchestrator);
  const review = new M7ReviewService(database, config, gate);
  operations.reconcileAfterRestart();
  operations.project();
  const apply = new M9ApplyService(database, config, review, operations, gate);
  const routing = new M10RoutingService(database, operations);
  const operational = new M11OperationsService(database, config);
  const artifacts = new M11ArtifactService(database, config, operational);
  const ui = new M6UiService(database, orchestrator, (principal, taskId) => review.snapshotForTask(principal, taskId), gate, (principal, taskId) => routing.isConfirmedForDispatch(principal, taskId), (principal, taskId) => routing.assertConfirmedForDispatch(principal, taskId));
  const loginBuckets = new Map<string, LoginBucket>();
  const loginBucketExpiries: LoginBucketExpiry[] = [];
  let loginBucketGeneration = 0;
  const pruneLoginBuckets = (at: number): void => {
    while (loginBucketExpiries.length > 0 && loginBucketExpiries[0]!.expiresAt <= at) {
      const expired = loginBucketExpiries.shift()!;
      const current = loginBuckets.get(expired.key);
      if (current?.generation === expired.generation && current.expiresAt <= at) loginBuckets.delete(expired.key);
    }
  };
  const app = Fastify({ logger: { level: config.logLevel }, bodyLimit: config.requestBodyLimit, genReqId: () => messageId() });
  const browserSockets = new Set<WebSocket>();
  const bridgeSockets = new Set<WebSocket>();
  void app.register(cookie);
  void app.register(websocket, { options: { maxPayload: config.websocketMessageLimit } });
  const webRoot = process.env["CHUBZ_PACKAGED_WEB_ROOT"] ? resolve(process.env["CHUBZ_PACKAGED_WEB_ROOT"]) : resolve(dirname(fileURLToPath(import.meta.url)), "../../web-app/dist");
  if (existsSync(webRoot)) void app.register(fastifyStatic, { root: webRoot, prefix: "/", decorateReply: false, wildcard: false });
  app.addHook("onRequest", async (request, reply) => {
    const isWebAsset = request.url === "/" || request.url.startsWith("/assets/");
    const csp = isWebAsset ? "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" : "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
    reply.header("X-Content-Type-Options", "nosniff").header("X-Frame-Options", "DENY").header("Referrer-Policy", "no-referrer").header("Content-Security-Policy", csp).header("Cache-Control", "no-store");
    if (request.method !== "GET" && request.method !== "HEAD" && request.url !== "/v1/auth/login" && request.url !== "/v1/auth/bootstrap") {
      if (!isOriginAllowed(request, config)) return publicError(reply, 403, "FORBIDDEN", reqId(request));
      const principal = auth.authenticate(request.cookies[config.cookieName]);
      if (!principal || !auth.verifyCsrf(principal, request.headers["x-csrf-token"])) return publicError(reply, 403, "FORBIDDEN", reqId(request));
    }
  });
  app.addHook("preValidation", async (request, reply) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && request.url !== "/v1/auth/logout") {
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith(json)) return publicError(reply, 415, "INVALID_REQUEST", reqId(request));
    }
  });
  app.setErrorHandler((error, request, reply) => { app.log.warn({ event: "request-error", requestId: reqId(request), detail: safeDetail(error instanceof Error ? error.message : undefined) }); return publicError(reply, 400, "INVALID_REQUEST", reqId(request)); });
  app.get("/healthz", async () => ({ status: "ok", applicationVersion: process.env["CHUBZ_BUILD_VERSION"] ?? "0.11.0-mvp.1", buildCommit: process.env["CHUBZ_BUILD_COMMIT"] ?? "working-tree", releaseStatus: "local MVP candidate", localOnly: true }));
  app.get("/readyz", async (_request, reply) => {
    if (!database.isReady()) return publicError(reply, 503, "UNAVAILABLE", "readiness");
    return { status: "ready", checks: { database: "ok", migrations: "ok", configuration: "ok", authentication: "ok", websocket: "ok", bridgeGate: "required" }, schemaVersion: ControlPlaneDatabase.latestSchemaVersion, releaseStatus: "local MVP candidate" };
  });
  app.post<{ Body: { username?: unknown; password?: unknown } }>("/v1/auth/bootstrap", async (request, reply) => {
    if (!isOriginAllowed(request, config)) return publicError(reply, 403, "FORBIDDEN", reqId(request));
    try { await auth.bootstrap(request.body?.username as string, request.body?.password as string, reqId(request)); return reply.code(201).send({ status: "created" }); } catch (error) { return error instanceof BootstrapConflictError ? publicError(reply, 409, "CONFLICT", reqId(request)) : publicError(reply, 401, "UNAUTHORIZED", reqId(request)); }
  });
  app.post<{ Body: { username?: unknown; password?: unknown } }>("/v1/auth/login", async (request, reply) => {
    if (!isOriginAllowed(request, config)) return publicError(reply, 403, "FORBIDDEN", reqId(request));
    const bucketKey = `${request.ip}|${typeof request.body?.username === "string" ? request.body.username.slice(0, 64) : "?"}`; const at = Date.now(); pruneLoginBuckets(at);
    let current = loginBuckets.get(bucketKey);
    if (current === undefined || current.expiresAt <= at) {
      if (loginBuckets.size >= config.loginBucketMaximum) return publicError(reply, 429, "RATE_LIMITED", reqId(request));
      current = { count: 0, expiresAt: at + config.loginAttemptWindowMs, generation: ++loginBucketGeneration };
      loginBuckets.set(bucketKey, current); loginBucketExpiries.push({ key: bucketKey, expiresAt: current.expiresAt, generation: current.generation });
    }
    if (current.count >= 5) return publicError(reply, 429, "RATE_LIMITED", reqId(request));
    current.count += 1;
    try { const result = await auth.login(request.body?.username as string, request.body?.password as string, reqId(request)); current.count = 0; reply.setCookie(config.cookieName, result.cookie, { httpOnly: true, sameSite: "strict", secure: config.secureCookie, path: "/", maxAge: Math.floor(config.sessionTtlMs / 1000) }); return { csrfToken: result.principal.csrfToken }; } catch { return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); }
  });
  app.post("/v1/auth/logout", async (request, reply) => { auth.revoke(request.cookies[config.cookieName], reqId(request)); reply.clearCookie(config.cookieName, { path: "/" }); return reply.code(204).send(); });
  app.get("/v1/session", async (request, reply) => { const principal = auth.authenticate(request.cookies[config.cookieName]); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); return { username: principal.username, role: "sole-administrator", csrfToken: principal.csrfToken }; });

  const principalFor = (request: FastifyRequest): Principal | undefined => auth.authenticate(request.cookies[config.cookieName]);
  const m6Failure = (error: unknown, request: FastifyRequest, reply: FastifyReply) => { const mapped = mapM6Error(error); app.log.warn({ event: "m6-request-rejected", requestId: reqId(request), code: mapped.code }); return publicError(reply, mapped.status, mapped.code, reqId(request)); };
  const publishTaskEvent = (taskId: string, eventKind: string): void => {
    const streamId = "ui-tasks";
    const stream = database.connection.prepare("SELECT head_sequence FROM event_streams WHERE stream_id=?").get(streamId) as { head_sequence: number } | undefined;
    const sequence = (stream?.head_sequence ?? 0) + 1;
    const at = now(); const eventId = `event-${randomUUID()}`;
    const message: ControlPlaneToClientMessage = { protocolVersion: "1.0", messageId: messageId(), messageKind: "task.event", sentAt: at, taskId, payload: { streamId, sequence, eventId, taskId, occurredAt: at, eventKind } };
    emitEvent(streamId, message);
  };
  review.setTransitionPublisher(publishTaskEvent);
  operations.setPublisher(publishTaskEvent);
  apply.setPublisher(publishTaskEvent);
  routing.setPublisher(publishTaskEvent);
  operational.reconcile();
  operational.setPublisher((eventKind) => publishTaskEvent("m11-operations", eventKind));
  artifacts.setPublisher((eventKind) => publishTaskEvent("m11-operations", eventKind));
  app.get("/v1/ui/snapshot", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    return { ...ui.snapshot(principal), operations: operations.status(), applies: apply.snapshot(principal), applyIncidents: apply.incidents(principal), routing: routing.snapshot(principal), operational: operational.operationalSummary(principal), runtimeArtifacts: artifacts.metadata(principal), csrfToken: principal.csrfToken };
  });
  app.get("/v1/ui/operations/summary", async (request, reply) => { const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); try { return operational.operationalSummary(principal); } catch (error) { return m6Failure(error, request, reply); } });
  app.get<{ Querystring: { state?: string } }>("/v1/ui/alerts", async (request, reply) => { const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); try { operational.refreshAlerts(principal); return { alerts: operational.listAlerts(principal, request.query.state) }; } catch (error) { return m6Failure(error, request, reply); } });
  app.get<{ Params: { alertId: string } }>("/v1/ui/alerts/:alertId", async (request, reply) => { const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); try { return operational.alert(principal, request.params.alertId); } catch (error) { return m6Failure(error, request, reply); } });
  app.post<{ Params: { alertId: string }; Body: Record<string, unknown> }>("/v1/ui/alerts/:alertId/acknowledge", async (request, reply) => { const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); try { return operational.acknowledge(principal, request.params.alertId, request.body); } catch (error) { return m6Failure(error, request, reply); } });
  app.get("/v1/ui/runtime-packages", async (request, reply) => { const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); return { artifacts: artifacts.metadata(principal) }; });
  app.post<{ Body: Record<string, unknown> }>("/v1/ui/runtime-packages/verify", async (request, reply) => { const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); try { return artifacts.verifyPackage(principal, request.body); } catch (error) { return m6Failure(error, request, reply); } });
  app.post<{ Body: Record<string, unknown> }>("/v1/ui/configuration/validate", async (request, reply) => { const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); return validateM11Configuration(request.body["configuration"]); });
  app.post<{ Body: Record<string, unknown> }>("/v1/ui/diagnostics", async (request, reply) => { const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); try { return reply.code(201).send(artifacts.generate(principal, request.body, "diagnostics")); } catch (error) { return m6Failure(error, request, reply); } });
  app.post<{ Body: Record<string, unknown> }>("/v1/ui/support-bundles", async (request, reply) => { const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); try { return reply.code(201).send(artifacts.generate(principal, request.body, "support-bundle")); } catch (error) { return m6Failure(error, request, reply); } });
  app.post<{ Params: { artifactId: string }; Body: Record<string, unknown> }>("/v1/ui/support-bundles/:artifactId/verify", async (request, reply) => { const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); try { return artifacts.verifySupport(principal, request.params.artifactId, request.body); } catch (error) { return m6Failure(error, request, reply); } });
  app.get<{ Params: { artifactId: string } }>("/v1/support-bundles/:artifactId", async (request, reply) => { const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); try { const value = artifacts.retrieve(principal, request.params.artifactId); return reply.header("Content-Type", "application/json; charset=utf-8").header("Content-Disposition", `attachment; filename="${String(value.metadata["fileName"])}"`).header("Digest", String(value.metadata["sha256"])).send(value.content); } catch (error) { return m6Failure(error, request, reply); } });
  app.post<{ Body: Record<string, unknown> }>("/v1/ui/upgrade-plan", async (request, reply) => { const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); try { return artifacts.upgradePlan(principal, request.body); } catch (error) { return m6Failure(error, request, reply); } });
  app.post<{ Body: Record<string, unknown> }>("/v1/ui/retention/preview", async (request, reply) => { const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); try { return artifacts.retentionPreview(principal, request.body); } catch (error) { return m6Failure(error, request, reply); } });
  app.post<{ Body: Record<string, unknown> }>("/v1/ui/retention/apply", async (request, reply) => { const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); try { return artifacts.applyRetention(principal, request.body); } catch (error) { return m6Failure(error, request, reply); } });
  app.get("/v1/ui/health", async (request, reply) => { const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); const summary = operational.operationalSummary(principal); return { health: (summary["metrics"] as Record<string, unknown>)["controlPlane"], readiness: database.isReady() ? "ready" : "unavailable", release: (summary["metrics"] as Record<string, unknown>)["version"] }; });
  app.get<{ Params: { taskId: string } }>("/v1/ui/tasks/:taskId/routing", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return { inputs: routing.inputs(principal, request.params.taskId), ...routing.snapshot(principal, request.params.taskId) }; } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/routing/recommendations", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return reply.code(201).send(routing.generate(principal, request.params.taskId, request.body)); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string; recommendationId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/routing/recommendations/:recommendationId/confirm", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return routing.confirm(principal, request.params.taskId, request.params.recommendationId, request.body); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string; recommendationId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/routing/recommendations/:recommendationId/reject", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return routing.reject(principal, request.params.taskId, request.params.recommendationId, request.body); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/routing/refresh", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return reply.code(201).send(routing.generate(principal, request.params.taskId, request.body)); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.get<{ Params: { taskId: string } }>("/v1/ui/tasks/:taskId/routing/fallback", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return routing.fallback(principal, request.params.taskId); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string; fallbackId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/routing/fallback/:fallbackId/confirm", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return routing.confirmFallback(principal, request.params.taskId, request.params.fallbackId, request.body); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.get("/v1/ui/routing/observations", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); return routing.snapshot(principal);
  });
  app.put<{ Params: { projectId: string }; Body: Record<string, unknown> }>("/v1/ui/projects/:projectId/routing-policy", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return routing.updatePolicy(principal, request.params.projectId, request.body); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Body: Record<string, unknown> }>("/v1/ui/tasks", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = ui.createTask(principal, request.body); publishTaskEvent(String(result["taskId"]), "task.created"); operations.project(); return reply.code(201).send(result); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/approve-dispatch", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = ui.approveDispatch(principal, request.params.taskId, request.body); publishTaskEvent(request.params.taskId, "dispatch.approved"); operations.project(); return result; } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/cancel", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = ui.cancel(principal, request.params.taskId, request.body); publishTaskEvent(request.params.taskId, "cancellation.requested"); operations.project(); return result; } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/decision", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = ui.decideResult(principal, request.params.taskId, request.body); publishTaskEvent(request.params.taskId, "result.decided"); operations.project(); return result; } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/manual-text", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = ui.manualText(principal, request.params.taskId, request.body); publishTaskEvent(request.params.taskId, "manual-relay.result-recorded"); operations.project(); return result; } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/manual-artifacts", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return ui.artifactUnavailable(request.body); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/captures", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = review.requestCapture(principal, request.params.taskId, request.body); return reply.code(202).send(result); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.get<{ Params: { taskId: string } }>("/v1/ui/tasks/:taskId/captures", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return { captures: review.snapshotForTask(principal, request.params.taskId) }; } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string; captureId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/captures/:captureId/retry", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = review.retryCapture(principal, request.params.taskId, request.params.captureId, request.body); return reply.code(202).send(result); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.get<{ Params: { taskId: string } }>("/v1/ui/tasks/:taskId/review-packages", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return { packages: review.listPackages(principal, request.params.taskId) }; } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string; packageId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/review-packages/:packageId/verify", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return review.verifyPackage(principal, request.params.taskId, request.params.packageId); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.get<{ Params: { packageId: string } }>("/v1/review-packages/:packageId", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = review.download(principal, request.params.packageId); return reply.header("Content-Type", "application/json; charset=utf-8").header("Content-Disposition", `attachment; filename="${result.fileName}"`).header("Digest", result.digest).send(result.content); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Body: Record<string, unknown> }>("/v1/ui/apply/eligibility", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return apply.eligibility(principal, request.body); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Body: Record<string, unknown> }>("/v1/ui/apply-plans", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = apply.createPlan(principal, request.body); return reply.code(201).send(result); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.get<{ Params: { applyId: string } }>("/v1/ui/apply/:applyId", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const record = apply.snapshot(principal).find((item) => item["applyId"] === request.params.applyId); return record ?? publicError(reply, 404, "NOT_FOUND", reqId(request)); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.get<{ Params: { applyId: string } }>("/v1/ui/apply/:applyId/evidence", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const record = apply.snapshot(principal).find((item) => item["applyId"] === request.params.applyId); return record ? { apply: record } : publicError(reply, 404, "NOT_FOUND", reqId(request)); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { applyId: string }; Body: Record<string, unknown> }>("/v1/ui/apply/:applyId/prepare", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return reply.code(202).send(apply.requestPrepare(principal, request.params.applyId, request.body)); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { applyId: string }; Body: Record<string, unknown> }>("/v1/ui/apply/:applyId/promote", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return reply.code(202).send(apply.confirmPromotion(principal, request.params.applyId, request.body)); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { applyId: string }; Body: Record<string, unknown> }>("/v1/ui/apply/:applyId/cancel", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return apply.cancel(principal, request.params.applyId, request.body); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.get("/v1/ui/apply-incidents", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    return { incidents: apply.incidents(principal) };
  });
  app.post<{ Body: Record<string, unknown> }>("/v1/ui/adapters/codex/refresh", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return ui.artifactUnavailable(request.body); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.get("/v1/ui/operations", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    return operations.status();
  });
  app.post<{ Body: Record<string, unknown> }>("/v1/ui/bridge-log/verify", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = operations.verifyProtected(principal, request.body); publishTaskEvent("m8-operations", "projection.verified"); return result; } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Body: Record<string, unknown> }>("/v1/ui/bridge-log/rebuild", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = operations.rebuild(principal, request.body); publishTaskEvent("m8-operations", "projection.rebuilt"); return result; } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { incidentId: string }; Body: Record<string, unknown> }>("/v1/ui/recovery-incidents/:incidentId/acknowledge", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = operations.acknowledgeIncident(principal, request.params.incidentId, request.body); publishTaskEvent("m8-operations", "recovery-incident.acknowledged"); return result; } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { incidentId: string }; Body: Record<string, unknown> }>("/v1/ui/recovery-incidents/:incidentId/close", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = operations.closeIncident(principal, request.params.incidentId, request.body); publishTaskEvent("m8-operations", "recovery-incident.closed"); return result; } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Body: Record<string, unknown> }>("/v1/ui/emergency-stops", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try {
      const result = operations.activateStop(principal, request.body); const cancellations = result["cancellations"] as Array<{ taskId: string; operationId: string; state: string }>;
      for (const cancellation of cancellations.filter((item) => item.state === "requested")) {
        try { const task = orchestrator.getTask(cancellation.taskId); if (task.state === "RUNNING") orchestrator.cancel(cancellation.taskId); }
        catch { database.connection.prepare("UPDATE m8_stop_operations SET cancellation_state='failed',updated_at=?,evidence_json=? WHERE stop_id=? AND operation_id=?").run(now(), JSON.stringify({ requestPersisted: true, taskTransition: "failed", terminationConfirmed: false }), result["stopId"], cancellation.operationId); }
      }
      publishTaskEvent("m8-operations", "emergency-stop.activated"); operations.project(); return reply.code(201).send(result);
    } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { stopId: string }; Body: Record<string, unknown> }>("/v1/ui/emergency-stops/:stopId/release", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = operations.releaseStop(principal, request.params.stopId, request.body); publishTaskEvent("m8-operations", "emergency-stop.released"); return result; } catch (error) { return m6Failure(error, request, reply); }
  });
  // WebSocket routes are registered after the plugin has installed its route hook.
  // This preserves the plugin's upgrade handler instead of treating this as HTTP.
  app.after(() => {
  app.get("/v1/ws", { websocket: true }, (socket, request) => {
    if (!isOriginAllowed(request, config)) { socket.close(1008, "origin denied"); return; }
    const principal = auth.authenticate(request.cookies[config.cookieName]);
    if (!principal) { socket.close(1008, "authentication required"); return; }
    browserSockets.add(socket);
    let queued = 0; let closed = false;
    const send = (value: unknown) => { if (closed || queued >= 64) { socket.close(1013, "backpressure"); return; } queued += 1; socket.send(JSON.stringify(value), () => { queued -= 1; }); };
    const protocolError = (code: string) => send({ protocolVersion: "1.0", messageId: messageId(), messageKind: "protocol.error", sentAt: now(), payload: { error: { code, summary: code === "IDEMPOTENCY_CONFLICT" ? "Idempotency key conflicts with a prior request." : "The message was rejected." } } });
    socket.on("message", (raw: Buffer | string) => {
      try {
        const content = raw.toString(); if (Buffer.byteLength(content) > config.websocketMessageLimit) return protocolError("MESSAGE_TOO_LARGE");
        const parsed = parseClientToControlPlaneMessage(JSON.parse(content)); if (!parsed.ok) return protocolError(parsed.error.code);
        const message = parsed.message;
        if ("idempotencyKey" in message) {
          const scope = { direction: "client-to-control-plane" as const, messageKind: message.messageKind, contextId: message.projectId ?? message.taskId };
          const bodyDigest = digest(canonicalizeClientMutationForDigest(message)); const scopeValue = scopeKey(scope);
          type StoredDelivery = { payload_digest: string; first_message_id: string; response_ref: string | null; recorded_at: string };
          const find = (): StoredDelivery | undefined => database.connection.prepare("SELECT payload_digest, first_message_id, response_ref, recorded_at FROM idempotency_records WHERE scope_key=? AND idempotency_key=?").get(scopeValue, message.idempotencyKey) as StoredDelivery | undefined;
          const classify = (row: StoredDelivery | undefined) => classifyDelivery({ idempotencyKey: message.idempotencyKey, scope, payloadDigest: bodyDigest }, row === undefined ? undefined : { idempotencyKey: message.idempotencyKey, scope, payloadDigest: row.payload_digest, firstMessageId: row.first_message_id, responseRef: row.response_ref ?? undefined, recordedAt: row.recorded_at });
          let row: StoredDelivery | undefined; let classification: ReturnType<typeof classify>;
          try {
            ({ row, classification } = database.connection.transaction(() => {
              const existing = find(); const result = classify(existing);
              if (result !== "new") return { row: existing, classification: result };
              database.connection.prepare("INSERT INTO idempotency_records(scope_key,idempotency_key,payload_digest,first_message_id,response_ref,recorded_at) VALUES(?,?,?,?,?,?)").run(scopeValue, message.idempotencyKey, bodyDigest, message.messageId, message.messageId, now());
              return { row: find(), classification: result };
            })());
          } catch {
            row = find();
            if (row === undefined) throw new Error("idempotency storage unavailable");
            classification = classify(row);
          }
          if (classification === "conflict") return protocolError("IDEMPOTENCY_CONFLICT");
          const originalId = row?.first_message_id ?? message.messageId; const resultRef = row?.response_ref ?? originalId;
          return send({ protocolVersion: "1.0", messageId: messageId(), messageKind: "request.accepted", sentAt: now(), payload: { acceptedMessageId: originalId, replayClassification: classification === "duplicate-same-request" ? classification : "new", resultRef } });
        }
        if (message.messageKind === "stream.resume") {
          const cursor = message.payload.cursor; const stream = database.connection.prepare("SELECT head_sequence, oldest_retained_sequence FROM event_streams WHERE stream_id=?").get(cursor.streamId) as { head_sequence: number; oldest_retained_sequence: number } | undefined;
          if (!stream && cursor.lastConsumedSequence === 0) return;
          if (!stream || cursor.lastConsumedSequence + 1 < stream.oldest_retained_sequence || cursor.lastConsumedSequence > stream.head_sequence) return protocolError("CURSOR_UNAVAILABLE");
          const events = database.connection.prepare("SELECT payload_json FROM events WHERE stream_id=? AND sequence>? ORDER BY sequence ASC LIMIT 64").all(cursor.streamId, cursor.lastConsumedSequence) as Array<{ payload_json: string }>;
          for (const event of events) send(JSON.parse(event.payload_json)); return;
        }
        return send({ protocolVersion: "1.0", messageId: messageId(), messageKind: "request.accepted", sentAt: now(), payload: { acceptedMessageId: message.messageId } });
      } catch { protocolError("VALIDATION_ERROR"); }
    });
    socket.on("close", () => { closed = true; browserSockets.delete(socket); }); socket.on("error", () => { closed = true; browserSockets.delete(socket); });
  });
  app.get("/v1/bridge/ws", { websocket: true }, (socket, request) => {
    const authorization = request.headers.authorization; const supplied = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const expected = createHmac("sha256", config.sessionSecret).update("chubz.m11.bridge-session/v1\nlocal-bridge").digest("base64url"); const left = Buffer.from(supplied); const right = Buffer.from(expected);
    if (left.byteLength !== right.byteLength || !timingSafeEqual(left, right)) { socket.close(1008, "bridge authentication required"); return; }
    bridgeSockets.add(socket);
    const connectedAt = now(); database.connection.prepare("UPDATE m8_bridge_state SET connection_state='connected',last_seen_at=?,updated_at=?,version=version+1 WHERE bridge_id='local-bridge'").run(connectedAt, connectedAt); publishTaskEvent("m11-operations", "bridge.connection-changed"); operational.refreshAlerts();
    let closed = false;
    socket.on("message", (raw: Buffer | string) => {
      if (closed || Buffer.byteLength(raw) > 4_096) { socket.close(1009, "bridge heartbeat exceeds bound"); return; }
      try { const value = JSON.parse(raw.toString()) as Record<string, unknown>; if (value["kind"] !== "bridge.heartbeat" || value["enrollmentIdentity"] !== "local-bridge" || typeof value["sentAt"] !== "string" || !Number.isFinite(Date.parse(value["sentAt"])) || typeof value["runtimeVersion"] !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u.test(value["runtimeVersion"])) throw new Error("invalid heartbeat"); const at = now(); database.connection.transaction(() => { database.connection.prepare("UPDATE m8_bridge_state SET connection_state='connected',last_seen_at=?,updated_at=?,version=version+1 WHERE bridge_id='local-bridge'").run(at, at); database.connection.prepare("INSERT INTO m11_component_versions(component_id,runtime_version,observed_at) VALUES('local-bridge',?,?) ON CONFLICT(component_id) DO UPDATE SET runtime_version=excluded.runtime_version,observed_at=excluded.observed_at").run(value["runtimeVersion"], at); })(); socket.send(JSON.stringify({ kind: "bridge.heartbeat-accepted", receivedAt: at, emergencyStopGateRequired: true })); }
      catch { socket.close(1008, "invalid bridge heartbeat"); }
    });
    const disconnected = (): void => { if (closed) return; closed = true; bridgeSockets.delete(socket); if (!database.connection.open) return; const at = now(); database.connection.prepare("UPDATE m8_bridge_state SET connection_state='disconnected',updated_at=?,version=version+1 WHERE bridge_id='local-bridge'").run(at); publishTaskEvent("m11-operations", "bridge.connection-changed"); operational.refreshAlerts(); };
    socket.on("close", disconnected); socket.on("error", disconnected);
  });
  });
  const emitEvent = (streamId: string, message: ControlPlaneToClientMessage): void => {
    const db = database.connection; db.transaction(() => { const stream = db.prepare("SELECT head_sequence FROM event_streams WHERE stream_id=?").get(streamId) as { head_sequence: number } | undefined; const sequence = (stream?.head_sequence ?? 0) + 1; if (!stream) db.prepare("INSERT INTO event_streams(stream_id,head_sequence,oldest_retained_sequence) VALUES(?,?,?)").run(streamId, sequence, 1); else db.prepare("UPDATE event_streams SET head_sequence=? WHERE stream_id=?").run(sequence, streamId); db.prepare("INSERT INTO events(stream_id,sequence,event_id,payload_json,occurred_at) VALUES(?,?,?,?,?)").run(streamId, sequence, message.messageId, JSON.stringify(message), now()); })();
    const serialized = JSON.stringify(message);
    for (const socket of browserSockets) if (socket.readyState === socket.OPEN && socket.bufferedAmount < config.websocketMessageLimit * 4) socket.send(serialized, () => undefined);
  };
  publishTaskEvent("m11-operations", "runtime.reconciliation-completed");
  return Object.freeze({ app, database, auth, review, operations, apply, routing, operational, artifacts, emitEvent, close: async () => { for (const socket of bridgeSockets) socket.close(); for (const socket of browserSockets) socket.close(); await app.close(); database.close(); } });
}
