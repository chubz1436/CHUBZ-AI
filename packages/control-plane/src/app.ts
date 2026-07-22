import { createHash, randomUUID } from "node:crypto";
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
import { M4Orchestrator } from "./orchestrator.js";

export type ControlPlane = Readonly<{ app: FastifyInstance; database: ControlPlaneDatabase; auth: AuthService; close: () => Promise<void>; emitEvent: (streamId: string, message: ControlPlaneToClientMessage) => void }>;
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
  const grantSecret = createHash("sha256").update(`chubz.m6.runtime-grant/v1\n${config.sessionSecret}`, "utf8").digest();
  const orchestrator = new M4Orchestrator(database, new Phase1GrantKey("control-plane-runtime", grantSecret));
  const ui = new M6UiService(database, orchestrator);
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
  void app.register(cookie);
  void app.register(websocket, { options: { maxPayload: config.websocketMessageLimit } });
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../web-app/dist");
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
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    if (!database.isReady()) return publicError(reply, 503, "UNAVAILABLE", "readiness");
    return { status: "ready", checks: { database: "ok", migrations: "ok", configuration: "ok", authentication: "ok", websocket: "ok" } };
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
  app.get("/v1/ui/snapshot", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    return { ...ui.snapshot(principal), csrfToken: principal.csrfToken };
  });
  app.post<{ Body: Record<string, unknown> }>("/v1/ui/tasks", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = ui.createTask(principal, request.body); publishTaskEvent(String(result["taskId"]), "task.created"); return reply.code(201).send(result); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/approve-dispatch", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = ui.approveDispatch(principal, request.params.taskId, request.body); publishTaskEvent(request.params.taskId, "dispatch.approved"); return result; } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/cancel", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = ui.cancel(principal, request.params.taskId, request.body); publishTaskEvent(request.params.taskId, "cancellation.requested"); return result; } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/decision", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = ui.decideResult(principal, request.params.taskId, request.body); publishTaskEvent(request.params.taskId, "result.decided"); return result; } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/manual-text", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { const result = ui.manualText(principal, request.params.taskId, request.body); publishTaskEvent(request.params.taskId, "manual-relay.result-recorded"); return result; } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Params: { taskId: string }; Body: Record<string, unknown> }>("/v1/ui/tasks/:taskId/manual-artifacts", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return ui.artifactUnavailable(request.body); } catch (error) { return m6Failure(error, request, reply); }
  });
  app.post<{ Body: Record<string, unknown> }>("/v1/ui/adapters/codex/refresh", async (request, reply) => {
    const principal = principalFor(request); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request));
    try { return ui.artifactUnavailable(request.body); } catch (error) { return m6Failure(error, request, reply); }
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
  });
  const emitEvent = (streamId: string, message: ControlPlaneToClientMessage): void => {
    const db = database.connection; db.transaction(() => { const stream = db.prepare("SELECT head_sequence FROM event_streams WHERE stream_id=?").get(streamId) as { head_sequence: number } | undefined; const sequence = (stream?.head_sequence ?? 0) + 1; if (!stream) db.prepare("INSERT INTO event_streams(stream_id,head_sequence,oldest_retained_sequence) VALUES(?,?,?)").run(streamId, sequence, 1); else db.prepare("UPDATE event_streams SET head_sequence=? WHERE stream_id=?").run(sequence, streamId); db.prepare("INSERT INTO events(stream_id,sequence,event_id,payload_json,occurred_at) VALUES(?,?,?,?,?)").run(streamId, sequence, message.messageId, JSON.stringify(message), now()); })();
    const serialized = JSON.stringify(message);
    for (const socket of browserSockets) if (socket.readyState === socket.OPEN && socket.bufferedAmount < config.websocketMessageLimit * 4) socket.send(serialized, () => undefined);
  };
  return Object.freeze({ app, database, auth, emitEvent, close: async () => { await app.close(); database.close(); } });
}
