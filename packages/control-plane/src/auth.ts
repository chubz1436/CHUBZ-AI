import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import type { ControlPlaneConfig } from "./config.js";
import type { ControlPlaneDatabase } from "./database.js";

const token = (): string => randomBytes(32).toString("base64url");
const genericFailure = new Error("Authentication failed.");
export class BootstrapConflictError extends Error { constructor() { super("Bootstrap unavailable."); this.name = "BootstrapConflictError"; } }
export type Principal = Readonly<{ administratorId: string; username: string; sessionId: string; csrfToken: string }>;

export class AuthService {
  private readonly dummyHashPromise = argon2.hash("not-a-real-password", { type: argon2.argon2id });
  constructor(private readonly database: ControlPlaneDatabase, private readonly config: ControlPlaneConfig) {}
  private digest(value: string): string { return createHmac("sha256", this.config.sessionSecret).update(value).digest("hex"); }
  private csrfFor(sessionId: string): string { return createHmac("sha256", this.config.sessionSecret).update(`chubz.csrf/v1\n${sessionId}`).digest("base64url"); }
  hasAdministrator(): boolean { return (this.database.connection.prepare("SELECT 1 FROM administrators LIMIT 1").get() as unknown) !== undefined; }
  async bootstrap(username: string, password: string, requestId: string): Promise<void> {
    if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username) || password.length < 12 || password.length > 256) throw genericFailure;
    if (this.hasAdministrator()) throw new BootstrapConflictError();
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    const id = randomUUID(); const now = new Date().toISOString();
    try {
      this.database.connection.transaction(() => {
        if (this.hasAdministrator()) throw new BootstrapConflictError();
        this.database.connection.prepare("INSERT INTO administrators(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)").run(id, username, passwordHash, now);
        this.record("bootstrap", id, requestId);
      })();
    } catch (error) { if (error instanceof BootstrapConflictError) throw error; throw new BootstrapConflictError(); }
  }
  async login(username: string, password: string, requestId: string): Promise<{ cookie: string; principal: Principal }> {
    const validInput = /^[a-zA-Z0-9_.-]{3,64}$/.test(username) && password.length >= 1 && password.length <= 256;
    const row = validInput ? this.database.connection.prepare("SELECT id, username, password_hash, disabled_at FROM administrators WHERE username = ?").get(username) as { id: string; username: string; password_hash: string; disabled_at: string | null } | undefined : undefined;
    const verified = await argon2.verify(row?.password_hash ?? await this.dummyHashPromise, password).catch(() => false);
    if (!validInput || row === undefined || row.disabled_at !== null || !verified) { this.record("login-failed", undefined, requestId); throw genericFailure; }
    const raw = token(); const now = Date.now(); const idHash = this.digest(raw); const csrf = this.csrfFor(idHash); const expires = new Date(now + this.config.sessionTtlMs).toISOString(); const idle = new Date(now + this.config.sessionIdleMs).toISOString();
    this.database.connection.transaction(() => {
      this.database.connection.prepare("DELETE FROM sessions WHERE administrator_id = ? AND revoked_at IS NULL").run(row.id);
      this.database.connection.prepare("INSERT INTO sessions(id_hash, administrator_id, csrf_hash, created_at, expires_at, idle_expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(idHash, row.id, this.digest(csrf), new Date(now).toISOString(), expires, idle, new Date(now).toISOString());
      this.record("login-succeeded", row.id, requestId);
    })();
    return { cookie: raw, principal: Object.freeze({ administratorId: row.id, username: row.username, sessionId: idHash, csrfToken: csrf }) };
  }
  authenticate(rawCookie: unknown): Principal | undefined {
    if (typeof rawCookie !== "string" || rawCookie.length > 256) return undefined;
    const row = this.database.connection.prepare("SELECT s.id_hash, s.csrf_hash, s.expires_at, s.idle_expires_at, s.revoked_at, a.id, a.username, a.disabled_at FROM sessions s JOIN administrators a ON a.id=s.administrator_id WHERE s.id_hash=?").get(this.digest(rawCookie)) as { id_hash: string; csrf_hash: string; expires_at: string; idle_expires_at: string; revoked_at: string | null; id: string; username: string; disabled_at: string | null } | undefined;
    if (!row || row.revoked_at !== null || row.disabled_at !== null || Date.parse(row.expires_at) <= Date.now() || Date.parse(row.idle_expires_at) <= Date.now()) return undefined;
    const csrf = this.csrfFor(row.id_hash);
    // Binding CSRF to the authenticated session lets a refreshed same-origin UI
    // recover safely and upgrades sessions created before deterministic CSRF.
    this.database.connection.prepare("UPDATE sessions SET csrf_hash=?,last_seen_at=?,idle_expires_at=? WHERE id_hash=?").run(this.digest(csrf), new Date().toISOString(), new Date(Date.now() + this.config.sessionIdleMs).toISOString(), row.id_hash);
    return Object.freeze({ administratorId: row.id, username: row.username, sessionId: row.id_hash, csrfToken: csrf });
  }
  verifyCsrf(principal: Principal, provided: unknown): boolean {
    if (typeof provided !== "string" || provided.length > 256) return false;
    const row = this.database.connection.prepare("SELECT csrf_hash FROM sessions WHERE id_hash=? AND revoked_at IS NULL").get(principal.sessionId) as { csrf_hash: string } | undefined;
    if (!row) return false;
    const left = Buffer.from(row.csrf_hash); const right = Buffer.from(this.digest(provided));
    return left.length === right.length && timingSafeEqual(left, right);
  }
  revoke(rawCookie: unknown, requestId: string): void { if (typeof rawCookie === "string") { const digest = this.digest(rawCookie); const session = this.database.connection.prepare("SELECT administrator_id FROM sessions WHERE id_hash=?").get(digest) as { administrator_id: string } | undefined; this.database.connection.prepare("UPDATE sessions SET revoked_at=? WHERE id_hash=?").run(new Date().toISOString(), digest); this.record("logout", session?.administrator_id, requestId); } }
  private record(kind: string, administratorId: string | undefined, requestId: string): void {
    this.database.connection.transaction(() => {
      this.database.connection.prepare("INSERT INTO auth_events(event_kind, administrator_id, occurred_at, request_id) VALUES (?, ?, ?, ?)").run(kind, administratorId ?? null, new Date().toISOString(), requestId);
      this.database.connection.prepare("DELETE FROM auth_events WHERE occurred_at < ?").run(new Date(Date.now() - this.config.authEventRetentionMs).toISOString());
      this.database.connection.prepare("DELETE FROM auth_events WHERE id <= COALESCE((SELECT id FROM auth_events ORDER BY id DESC LIMIT 1 OFFSET ?), 0)").run(this.config.authEventMaximum);
    })();
  }
}
