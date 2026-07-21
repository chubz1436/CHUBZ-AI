import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeConnectionManager, EnrollmentManager, ProtectedCredentialStore, validateLocalOutboundEndpoint, type CredentialProtector, type OutboundConnection, type OutboundConnector } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

class TestProtector implements CredentialProtector {
  public readonly id = "test-aes-gcm";
  private readonly key = randomBytes(32);
  public async protect(value: Uint8Array): Promise<Uint8Array> { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]); }
  public async unprotect(value: Uint8Array): Promise<Uint8Array> { const bytes = Buffer.from(value); const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(bytes.length - 16)); return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]); }
}

class RecordingConnector implements OutboundConnector {
  public readonly attempts: Array<{ endpoint: string; authorization: string }> = [];
  public listenCalls = 0;
  public async connect(endpoint: string, authorization: string): Promise<OutboundConnection> { this.attempts.push({ endpoint, authorization }); return Object.freeze({ close: () => undefined, send: () => undefined }); }
}

describe("enrollment and protected storage", () => {
  it("persists only protected enrollment material and supports lifecycle revocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "chubz-enrollment-")); roots.push(root);
    const path = join(root, "credential.json");
    const store = new ProtectedCredentialStore(path, new TestProtector());
    const manager = new EnrollmentManager(store);
    const token = "synthetic-secret-token-that-must-not-be-plaintext";
    const enrolled = await manager.enroll("ws://127.0.0.1:4317/bridge", token);
    expect(enrolled.endpoint).toBe("ws://127.0.0.1:4317/bridge");
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain("bearerToken");
    expect(await manager.status()).toMatchObject({ enrolled: true, enrollmentId: enrolled.enrollmentId, endpoint: enrolled.endpoint });
    await manager.revoke();
    expect(await manager.status()).toEqual({ enrolled: false, enrollmentId: null, endpoint: null });
  });

  it("rejects non-loopback, credential-bearing, and non-WebSocket endpoints", () => {
    for (const endpoint of ["https://127.0.0.1/x", "ws://example.test/x", "ws://localhost/x", "ws://user:pass@127.0.0.1/x", "ws://127.0.0.1/x#fragment"]) expect(() => validateLocalOutboundEndpoint(endpoint)).toThrow();
  });
});

describe("outbound-only connection foundation", () => {
  it("only asks the injected client connector to initiate an outbound connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "chubz-connection-")); roots.push(root);
    const store = new ProtectedCredentialStore(join(root, "credential.json"), new TestProtector());
    await new EnrollmentManager(store).enroll("ws://127.0.0.1:4317/bridge", "synthetic-token-long-enough");
    const connector = new RecordingConnector();
    await new BridgeConnectionManager(store, connector).connect();
    expect(connector.attempts).toHaveLength(1);
    expect(connector.attempts[0]?.endpoint).toBe("ws://127.0.0.1:4317/bridge");
    expect(connector.attempts[0]?.authorization).toBe("Bearer synthetic-token-long-enough");
    expect(connector.listenCalls).toBe(0);
  });
});
