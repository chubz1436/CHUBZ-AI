import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const MAX_CREDENTIAL_BYTES = 16_384;

export interface CredentialProtector {
  readonly id: string;
  protect(plaintext: Uint8Array): Promise<Uint8Array>;
  unprotect(ciphertext: Uint8Array): Promise<Uint8Array>;
}

type CredentialEnvelope = Readonly<{
  version: 1;
  protector: string;
  protectedValue: string;
  createdAt: string;
}>;

export type EnrollmentMaterial = Readonly<{
  enrollmentId: string;
  endpoint: string;
  bearerToken: string;
}>;

export function validateLocalOutboundEndpoint(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("invalid Bridge endpoint"); }
  if (!(["ws:", "wss:"] as string[]).includes(url.protocol)) throw new Error("Bridge endpoint must use WebSocket");
  if (!(url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1")) {
    throw new Error("M3 Bridge endpoints must be loopback-only");
  }
  if (url.username || url.password || url.hash) throw new Error("Bridge endpoint must not contain credentials or fragments");
  return url.toString();
}

export class ProtectedCredentialStore {
  public constructor(private readonly path: string, private readonly protector: CredentialProtector) {}

  public async save(material: EnrollmentMaterial): Promise<void> {
    const encoded = Buffer.from(JSON.stringify(material), "utf8");
    if (encoded.byteLength > MAX_CREDENTIAL_BYTES) throw new Error("enrollment material exceeds storage bound");
    const protectedValue = await this.protector.protect(encoded);
    const envelope: CredentialEnvelope = Object.freeze({ version: 1, protector: this.protector.id, protectedValue: Buffer.from(protectedValue).toString("base64"), createdAt: new Date().toISOString() });
    const serialized = `${JSON.stringify(envelope)}\n`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.path);
  }

  public async load(): Promise<EnrollmentMaterial | null> {
    let serialized: string;
    try { serialized = await readFile(this.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (Buffer.byteLength(serialized) > MAX_CREDENTIAL_BYTES * 4) throw new Error("credential envelope exceeds storage bound");
    const envelope = JSON.parse(serialized) as Partial<CredentialEnvelope>;
    if (envelope.version !== 1 || envelope.protector !== this.protector.id || typeof envelope.protectedValue !== "string") throw new Error("unsupported credential envelope");
    const plaintext = await this.protector.unprotect(Buffer.from(envelope.protectedValue, "base64"));
    if (plaintext.byteLength > MAX_CREDENTIAL_BYTES) throw new Error("decrypted credential exceeds storage bound");
    const value = JSON.parse(Buffer.from(plaintext).toString("utf8")) as Partial<EnrollmentMaterial>;
    if (typeof value.enrollmentId !== "string" || typeof value.endpoint !== "string" || typeof value.bearerToken !== "string" || value.bearerToken.length < 16) throw new Error("malformed enrollment material");
    return Object.freeze({ enrollmentId: value.enrollmentId, endpoint: validateLocalOutboundEndpoint(value.endpoint), bearerToken: value.bearerToken });
  }

  public async clear(): Promise<void> { await rm(this.path, { force: true }); }
}

/** Windows CurrentUser DPAPI. Secret bytes travel on stdin, never in argv. */
export class WindowsDpapiProtector implements CredentialProtector {
  public readonly id = "windows-dpapi-current-user-v1";

  private async invoke(mode: "Protect" | "Unprotect", value: Uint8Array): Promise<Uint8Array> {
    if (process.platform !== "win32") throw new Error("Windows DPAPI is unavailable on this platform");
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $inputText=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($inputText); $scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser; $output=[System.Security.Cryptography.ProtectedData]::${mode}($bytes,$null,$scope); [Console]::Out.Write([Convert]::ToBase64String($output))`;
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { input: Buffer.from(value).toString("base64"), encoding: "utf8", windowsHide: true, maxBuffer: MAX_CREDENTIAL_BYTES * 4, timeout: 10_000 });
    if (result.error || result.status !== 0) throw new Error("Windows protected-storage operation failed");
    return Buffer.from(result.stdout.trim(), "base64");
  }

  public protect(plaintext: Uint8Array): Promise<Uint8Array> { return this.invoke("Protect", plaintext); }
  public unprotect(ciphertext: Uint8Array): Promise<Uint8Array> { return this.invoke("Unprotect", ciphertext); }
}

export class EnrollmentManager {
  public constructor(private readonly store: ProtectedCredentialStore) {}

  public async enroll(endpoint: string, bearerToken: string): Promise<Readonly<{ enrollmentId: string; endpoint: string }>> {
    const normalized = validateLocalOutboundEndpoint(endpoint);
    if (bearerToken.length < 16 || bearerToken.length > 8_192) throw new Error("invalid enrollment token length");
    const enrollmentId = randomUUID();
    await this.store.save(Object.freeze({ enrollmentId, endpoint: normalized, bearerToken }));
    return Object.freeze({ enrollmentId, endpoint: normalized });
  }

  public async status(): Promise<Readonly<{ enrolled: boolean; enrollmentId: string | null; endpoint: string | null }>> {
    const material = await this.store.load();
    return material === null ? Object.freeze({ enrolled: false, enrollmentId: null, endpoint: null }) : Object.freeze({ enrolled: true, enrollmentId: material.enrollmentId, endpoint: material.endpoint });
  }
  public revoke(): Promise<void> { return this.store.clear(); }
}
