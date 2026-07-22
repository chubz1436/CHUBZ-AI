import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  CapabilityGrantSchema,
  parseCapabilityGrant,
  type CapabilityGrant,
  type GrantAuthenticationVerifier,
} from "@chubz/shared";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = Object.freeze({ now: () => new Date() });

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
};

const authenticationPayload = (grant: CapabilityGrant): string => canonicalize({
  domain: "chubz.m1c.capability-grant-auth/v1",
  grantVersion: grant.grantVersion,
  grantId: grant.grantId,
  taskId: grant.taskId,
  attemptId: grant.attemptId,
  operationId: grant.operationId,
  actionDigest: grant.actionDigest,
  issuedAt: grant.issuedAt,
  notBefore: grant.notBefore,
  expiresAt: grant.expiresAt,
  singleUse: grant.singleUse,
  issuer: grant.issuer,
  approval: grant.approval,
  intendedVerifier: grant.intendedVerifier,
  authentication: { algorithm: grant.authentication.algorithm, keyId: grant.authentication.keyId },
});

export type ApprovalBinding = Readonly<{
  ownerId: string; taskId: string; attemptId: string; operationId: string;
  actionDigest: string; scopeHash: string; workerId: string; adapterId: string;
}>;

/** The signed approvalId is the accepted grant field that commits the wider authoritative approval context. */
export function deriveApprovalId(binding: ApprovalBinding): string {
  const values = Object.values(binding);
  if (values.some((value) => typeof value !== "string" || value.length < 1 || value.length > 512)) throw new Error("invalid approval binding");
  return `approval-${createHash("sha256").update(`chubz.m4.approval-binding/v1\n${canonicalize(binding)}`, "utf8").digest("hex")}`;
}

export type GrantIssueRequest = Readonly<{
  grantId: string;
  taskId: string;
  attemptId: string;
  operationId: string;
  actionDigest: `sha256:${string}`;
  issuerId: string;
  approvalId: string;
  intendedVerifier: string;
  lifetimeMs: number;
}>;

/**
 * Phase-1 runtime HMAC boundary. Secret bytes are supplied by protected runtime
 * configuration, copied privately, and are never serialised or included in errors.
 */
export class Phase1GrantKey {
  readonly #secret: Buffer;
  public readonly keyId: string;

  public constructor(keyId: string, secret: Uint8Array) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(keyId) || secret.byteLength < 32) {
      throw new Error("invalid grant signing configuration");
    }
    this.keyId = keyId;
    this.#secret = Buffer.from(secret);
  }

  public issue(request: GrantIssueRequest, clock: Clock = systemClock): CapabilityGrant {
    if (!Number.isSafeInteger(request.lifetimeMs) || request.lifetimeMs < 1 || request.lifetimeMs > 600_000) {
      throw new Error("invalid grant lifetime");
    }
    const issuedAt = clock.now();
    if (!Number.isFinite(issuedAt.getTime())) throw new Error("invalid trusted clock");
    const unsigned = CapabilityGrantSchema.parse({
      grantVersion: "1.0",
      grantId: request.grantId,
      taskId: request.taskId,
      attemptId: request.attemptId,
      operationId: request.operationId,
      actionDigest: request.actionDigest,
      issuedAt: issuedAt.toISOString(),
      notBefore: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + request.lifetimeMs).toISOString(),
      singleUse: true,
      issuer: { kind: "control-plane", issuerId: request.issuerId },
      approval: { approvalId: request.approvalId, mode: "phase1-local" },
      intendedVerifier: request.intendedVerifier,
      authentication: { algorithm: "hmac-sha256", keyId: this.keyId, signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    const signature = createHmac("sha256", this.#secret).update(authenticationPayload(unsigned), "utf8").digest("base64url");
    return CapabilityGrantSchema.parse({ ...unsigned, authentication: { ...unsigned.authentication, signature } });
  }

  public verifier(): GrantAuthenticationVerifier {
    return Object.freeze({
      verify: (input: Parameters<GrantAuthenticationVerifier["verify"]>[0]): boolean => {
        try {
          if (input.algorithm !== "hmac-sha256" || input.keyId !== this.keyId || input.signature.byteLength !== 32) return false;
          const expected = createHmac("sha256", this.#secret).update(input.payload, "utf8").digest();
          return timingSafeEqual(expected, Buffer.from(input.signature));
        } catch {
          return false;
        }
      },
    });
  }

  public destroy(): void {
    this.#secret.fill(0);
  }

  public validates(grant: unknown): boolean {
    return parseCapabilityGrant(grant).ok;
  }
}
