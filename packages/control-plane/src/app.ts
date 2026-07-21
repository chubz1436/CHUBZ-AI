import { createHash, randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { parseClientToControlPlaneMessage, type ControlPlaneToClientMessage, canonicalizeClientMutationForDigest, classifyDelivery, scopeKey } from "@chubz/shared";
import { detectRedactions, redactText } from "@chubz/shared";
import type { AuthService, Principal } from "./auth.js";
import { AuthService as AuthServiceClass } from "./auth.js";
import type { ControlPlaneConfig } from "./config.js";
import { ControlPlaneDatabase } from "./database.js";

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
const errorMessage = (code: string): string => ({ INVALID_REQUEST: "The request is invalid.", UNAUTHORIZED: "Authentication is required.", FORBIDDEN: "The request is not permitted.", RATE_LIMITED: "Too many attempts. Try again later.", IDEMPOTENCY_CONFLICT: "The request conflicts with a prior delivery.", UNAVAILABLE: "The service is not ready." }[code] ?? "The request could not be processed.");
const publicError = (reply: FastifyReply, status: number, code: string, requestId: string) => reply.code(status).send({ error: { code, message: errorMessage(code), requestId } });
const isOriginAllowed = (request: FastifyRequest, config: ControlPlaneConfig): boolean => request.headers.origin === config.allowedOrigin;
const reqId = (request: FastifyRequest): string => typeof request.id === "string" ? request.id.slice(0, 128) : messageId();
type LoginBucket = { count: number; resetAt: number };

export function createControlPlane(config: ControlPlaneConfig): ControlPlane {
  const database = new ControlPlaneDatabase(config);
  const auth = new AuthServiceClass(database, config);
  const loginBuckets = new Map<string, LoginBucket>();
  const app = Fastify({ logger: { level: config.logLevel }, bodyLimit: config.requestBodyLimit, genReqId: () => messageId() });
  void app.register(cookie);
  void app.register(websocket, { options: { maxPayload: config.websocketMessageLimit } });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff").header("X-Frame-Options", "DENY").header("Referrer-Policy", "no-referrer").header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'").header("Cache-Control", "no-store");
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
    try { await auth.bootstrap(request.body?.username as string, request.body?.password as string, reqId(request)); return reply.code(201).send({ status: "created" }); } catch { return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); }
  });
  app.post<{ Body: { username?: unknown; password?: unknown } }>("/v1/auth/login", async (request, reply) => {
    if (!isOriginAllowed(request, config)) return publicError(reply, 403, "FORBIDDEN", reqId(request));
    const bucketKey = `${request.ip}|${typeof request.body?.username === "string" ? request.body.username.slice(0, 64) : "?"}`; const previous = loginBuckets.get(bucketKey); const current = previous?.resetAt && previous.resetAt > Date.now() ? previous : { count: 0, resetAt: Date.now() + 60_000 };
    if (current.count >= 5) return publicError(reply, 429, "RATE_LIMITED", reqId(request));
    try { const result = await auth.login(request.body?.username as string, request.body?.password as string, reqId(request)); loginBuckets.delete(bucketKey); reply.setCookie(config.cookieName, result.cookie, { httpOnly: true, sameSite: "strict", secure: config.secureCookie, path: "/", maxAge: Math.floor(config.sessionTtlMs / 1000) }); return { csrfToken: result.principal.csrfToken }; } catch { current.count += 1; loginBuckets.set(bucketKey, current); return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); }
  });
  app.post("/v1/auth/logout", async (request, reply) => { auth.revoke(request.cookies[config.cookieName], reqId(request)); reply.clearCookie(config.cookieName, { path: "/" }); return reply.code(204).send(); });
  app.get("/v1/session", async (request, reply) => { const principal = auth.authenticate(request.cookies[config.cookieName]); if (!principal) return publicError(reply, 401, "UNAUTHORIZED", reqId(request)); return { username: principal.username }; });
  // WebSocket routes are registered after the plugin has installed its route hook.
  // This preserves the plugin's upgrade handler instead of treating this as HTTP.
  app.after(() => {
  app.get("/v1/ws", { websocket: true }, (socket, request) => {
    if (!isOriginAllowed(request, config)) { socket.close(1008, "origin denied"); return; }
    const principal = auth.authenticate(request.cookies[config.cookieName]);
    if (!principal) { socket.close(1008, "authentication required"); return; }
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
          const row = database.connection.prepare("SELECT payload_digest, first_message_id, response_ref, recorded_at FROM idempotency_records WHERE scope_key=? AND idempotency_key=?").get(scopeValue, message.idempotencyKey) as { payload_digest: string; first_message_id: string; response_ref: string | null; recorded_at: string } | undefined;
          const classification = classifyDelivery({ idempotencyKey: message.idempotencyKey, scope, payloadDigest: bodyDigest }, row === undefined ? undefined : { idempotencyKey: message.idempotencyKey, scope, payloadDigest: row.payload_digest, firstMessageId: row.first_message_id, responseRef: row.response_ref ?? undefined, recordedAt: row.recorded_at });
          if (classification === "conflict") return protocolError("IDEMPOTENCY_CONFLICT");
          if (classification === "new") database.connection.prepare("INSERT INTO idempotency_records(scope_key,idempotency_key,payload_digest,first_message_id,response_ref,recorded_at) VALUES(?,?,?,?,?,?)").run(scopeValue, message.idempotencyKey, bodyDigest, message.messageId, message.messageId, now());
          return send({ protocolVersion: "1.0", messageId: messageId(), messageKind: "request.accepted", sentAt: now(), payload: { acceptedMessageId: message.messageId, replayClassification: classification === "duplicate-same-request" ? classification : "new", resultRef: message.messageId } });
        }
        if (message.messageKind === "stream.resume") {
          const cursor = message.payload.cursor; const stream = database.connection.prepare("SELECT head_sequence, oldest_retained_sequence FROM event_streams WHERE stream_id=?").get(cursor.streamId) as { head_sequence: number; oldest_retained_sequence: number } | undefined;
          if (!stream || cursor.lastConsumedSequence + 1 < stream.oldest_retained_sequence || cursor.lastConsumedSequence > stream.head_sequence) return protocolError("CURSOR_UNAVAILABLE");
          const events = database.connection.prepare("SELECT payload_json FROM events WHERE stream_id=? AND sequence>? ORDER BY sequence ASC LIMIT 64").all(cursor.streamId, cursor.lastConsumedSequence) as Array<{ payload_json: string }>;
          for (const event of events) send(JSON.parse(event.payload_json)); return;
        }
        return send({ protocolVersion: "1.0", messageId: messageId(), messageKind: "request.accepted", sentAt: now(), payload: { acceptedMessageId: message.messageId } });
      } catch { protocolError("VALIDATION_ERROR"); }
    });
    socket.on("close", () => { closed = true; }); socket.on("error", () => { closed = true; });
  });
  });
  const emitEvent = (streamId: string, message: ControlPlaneToClientMessage): void => {
    const db = database.connection; db.transaction(() => { const stream = db.prepare("SELECT head_sequence FROM event_streams WHERE stream_id=?").get(streamId) as { head_sequence: number } | undefined; const sequence = (stream?.head_sequence ?? 0) + 1; if (!stream) db.prepare("INSERT INTO event_streams(stream_id,head_sequence,oldest_retained_sequence) VALUES(?,?,?)").run(streamId, sequence, 1); else db.prepare("UPDATE event_streams SET head_sequence=? WHERE stream_id=?").run(sequence, streamId); db.prepare("INSERT INTO events(stream_id,sequence,event_id,payload_json,occurred_at) VALUES(?,?,?,?,?)").run(streamId, sequence, message.messageId, JSON.stringify(message), now()); })();
  };
  return Object.freeze({ app, database, auth, emitEvent, close: async () => { await app.close(); database.close(); } });
}
