import { createHash } from "node:crypto";
import { mkdir, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, parse as parsePath, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import {
  detectRedactions,
  parseAdapterRun,
  parseAssignment,
  redactText,
  type AdapterRun,
  type Assignment,
} from "@chubz/shared";

export const MANUAL_RELAY_LIMITS = Object.freeze({
  maxTextBytes: 64 * 1024,
  maxFiles: 16,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalArtifactBytes: 16 * 1024 * 1024,
  maxPurposeBytes: 1_000,
} as const);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".json", ".csv", ".tsv", ".patch", ".diff", ".png", ".jpg", ".jpeg", ".webp", ".pdf"]);
const sha256 = (bytes: string | Uint8Array): `sha256:${string}` => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
};
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const canonicalPath = (value: string): string => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
const contained = (root: string, candidate: string): boolean => {
  const rel = relative(canonicalPath(root), canonicalPath(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
async function rejectLinkComponents(path: string): Promise<void> {
  const absolute = resolve(path); const parsed = parsePath(absolute); const parts = absolute.slice(parsed.root.length).split(sep).filter(Boolean); let cursor = parsed.root;
  for (const part of parts) { cursor = resolve(cursor, part); const info = await lstat(cursor); if (info.isSymbolicLink()) throw new ManualRelayError("ARTIFACT_REJECTED", "artifact source traverses a link or junction"); }
}
const sanitize = (text: string): string => {
  const findings = detectRedactions(text);
  if (!findings.ok) throw new ManualRelayError("MALFORMED_IMPORT", "manual response could not be redacted");
  const redacted = redactText(text, findings.value);
  if (!redacted.ok) throw new ManualRelayError("MALFORMED_IMPORT", "manual response could not be redacted");
  return redacted.value.text;
};

export type ManualRelayErrorCode = "MALFORMED_IMPORT" | "OVERSIZED_IMPORT" | "BINDING_MISMATCH" | "ATTESTATION_REQUIRED" | "IDEMPOTENCY_CONFLICT" | "ARTIFACT_REJECTED";
export class ManualRelayError extends Error {
  public constructor(public readonly code: ManualRelayErrorCode, message: string) { super(message); this.name = "ManualRelayError"; }
}

export type OwnerAttestation = Readonly<{
  attestationId: string;
  ownerId: string;
  authenticated: true;
  attestedAt: string;
  selectedImportMode: "text" | "artifact";
}>;
export type ActiveManualContext = Readonly<{
  taskId: string;
  attemptId: string;
  operationId: string;
  state: "RUNNING";
  immutableAttempt: true;
}>;
export type ManualTextResponse = Readonly<{ version: "1.0"; kind: "manual.text"; responseType: "text" | "review" | "design"; text: string }>;
export type ManualTextImportRequest = Readonly<{
  idempotencyKey: string;
  active: ActiveManualContext;
  assignment: Assignment;
  workerIdentityLabel: string;
  expectedResponseType: ManualTextResponse["responseType"];
  response: unknown;
  attestation: OwnerAttestation;
  readinessSnapshotRef: string;
}>;
export type ManualTextImportResult = Readonly<{
  resultId: string;
  taskId: string;
  attemptId: string;
  operationId: string;
  workerIdentityLabel: string;
  responseType: ManualTextResponse["responseType"];
  payloadFingerprint: `sha256:${string}`;
  provenance: "owner-attested manual relay";
  assurance: "weaker-manual";
  text: string;
  run: AdapterRun;
  replayed: boolean;
}>;

export type ManualArtifactDeclaration = Readonly<{
  sourcePath: string;
  relativePath: string;
  declaredPurpose: string;
  declaredSha256: `sha256:${string}`;
}>;
export type ManualArtifactImportRequest = Readonly<{
  idempotencyKey: string;
  importId: string;
  active: ActiveManualContext;
  assignment: Assignment;
  workerIdentityLabel: string;
  files: readonly ManualArtifactDeclaration[];
  attestation: OwnerAttestation;
  readinessSnapshotRef: string;
}>;
export type QuarantinedArtifactRef = Readonly<{ artifactId: string; relativePath: string; contentHash: `sha256:${string}`; bytes: number; declaredPurpose: string; state: "quarantined" }>;
export type ManualArtifactImportResult = Readonly<{
  resultId: string;
  taskId: string;
  attemptId: string;
  operationId: string;
  payloadFingerprint: `sha256:${string}`;
  provenance: "owner-attested manual relay";
  assurance: "weaker-manual";
  artifacts: readonly QuarantinedArtifactRef[];
  appliedToProject: false;
  appliedToWorktree: false;
  run: AdapterRun;
  replayed: boolean;
}>;

function validateBase(input: Readonly<{ idempotencyKey: string; active: ActiveManualContext; assignment: Assignment; workerIdentityLabel: string; attestation: OwnerAttestation; readinessSnapshotRef: string }>, mode: "text" | "artifact"): Extract<Assignment, { kind: "owner-confirmed" | "dispatched" }> {
  for (const value of [input.idempotencyKey, input.active.taskId, input.active.attemptId, input.active.operationId, input.workerIdentityLabel, input.attestation.attestationId, input.attestation.ownerId, input.readinessSnapshotRef]) if (!SAFE_ID.test(value) || value.includes("..")) throw new ManualRelayError("MALFORMED_IMPORT", "manual relay identity is invalid");
  if (input.active.state !== "RUNNING" || input.active.immutableAttempt !== true) throw new ManualRelayError("BINDING_MISMATCH", "an active immutable attempt is required");
  if (input.attestation.authenticated !== true || input.attestation.selectedImportMode !== mode || !Number.isFinite(Date.parse(input.attestation.attestedAt))) throw new ManualRelayError("ATTESTATION_REQUIRED", "authenticated owner attestation for the selected import mode is required");
  const parsed = parseAssignment(input.assignment);
  if (!parsed.ok || (parsed.value.kind !== "owner-confirmed" && parsed.value.kind !== "dispatched")) throw new ManualRelayError("BINDING_MISMATCH", "manual relay assignment is invalid");
  const assignment = parsed.value;
  if (assignment.taskId !== input.active.taskId || assignment.attemptId !== input.active.attemptId || assignment.operationId !== input.active.operationId || assignment.workerId !== input.workerIdentityLabel || assignment.adapterId !== "manual-relay" || assignment.permittedConnectorTier !== "manual-relay" || assignment.writeScopeRef !== null || assignment.leaseRequired || assignment.readinessSnapshotRef !== input.readinessSnapshotRef || Date.parse(input.attestation.attestedAt) >= Date.parse(assignment.expiresAt)) throw new ManualRelayError("BINDING_MISMATCH", "manual relay bindings do not match the active attempt");
  return assignment;
}

function manualRun(input: Readonly<{ active: ActiveManualContext; assignment: Assignment; workerIdentityLabel: string; readinessSnapshotRef: string; attestation: OwnerAttestation; resultId: string; capability: string }>): AdapterRun {
  const candidate = {
    coordinationVersion: "1.0", adapterRunId: `run-${input.resultId}`, taskId: input.active.taskId, attemptId: input.active.attemptId, operationId: input.active.operationId,
    workerId: input.workerIdentityLabel, adapterId: "manual-relay", connectorTier: "manual-relay", readinessSnapshotRef: input.readinessSnapshotRef,
    invocationMode: "manual-relay", requestedCapability: input.capability, startedAt: input.attestation.attestedAt, endedAt: input.attestation.attestedAt,
    structuredOutputState: "received", cancellationState: "not-requested", resumedFromRunId: null, quotaSnapshotRef: null, lifecycleState: "completed",
    captureRefs: [`capture-${input.resultId}`], evidenceRefs: [input.attestation.attestationId], blockedReason: null, runtimeProvenanceRefs: [input.attestation.attestationId], cancellationEvidenceRefs: [],
  };
  const parsed = parseAdapterRun(candidate);
  if (!parsed.ok) throw new ManualRelayError("MALFORMED_IMPORT", `manual relay run violated M1F (${parsed.code})`);
  return parsed.value;
}

export class ManualRelayConnector {
  private readonly database: Database.Database;
  private readonly quarantineRoot: string;
  public constructor(databasePath: string, quarantineRoot: string) {
    this.database = new Database(databasePath);
    this.quarantineRoot = resolve(quarantineRoot);
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS manual_imports (
        idempotency_key TEXT PRIMARY KEY,
        request_digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        import_kind TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
    `);
  }
  public close(): void { this.database.close(); }

  private replay<T extends { replayed: boolean }>(idempotencyKey: string, requestDigest: string): T | null {
    const row = this.database.prepare("SELECT request_digest,result_json FROM manual_imports WHERE idempotency_key=?").get(idempotencyKey) as { request_digest: string; result_json: string } | undefined;
    if (!row) return null;
    if (row.request_digest !== requestDigest) throw new ManualRelayError("IDEMPOTENCY_CONFLICT", "manual import identity conflicts with a prior payload");
    return Object.freeze({ ...(JSON.parse(row.result_json) as T), replayed: true });
  }
  private persist(idempotencyKey: string, requestDigest: string, kind: "text" | "artifact", result: unknown): void {
    this.database.prepare("INSERT INTO manual_imports(idempotency_key,request_digest,result_json,import_kind,recorded_at) VALUES(?,?,?,?,?)").run(idempotencyKey, requestDigest, JSON.stringify(result), kind, new Date().toISOString());
  }

  public importText(input: ManualTextImportRequest): ManualTextImportResult {
    validateBase(input, "text");
    if (!object(input.response) || !exactKeys(input.response, ["version", "kind", "responseType", "text"]) || input.response.version !== "1.0" || input.response.kind !== "manual.text" || input.response.responseType !== input.expectedResponseType || typeof input.response.text !== "string") throw new ManualRelayError("MALFORMED_IMPORT", "manual text response does not match the expected schema");
    if (Buffer.byteLength(input.response.text) > MANUAL_RELAY_LIMITS.maxTextBytes) throw new ManualRelayError("OVERSIZED_IMPORT", "manual text response exceeds its bound");
    const payloadFingerprint = sha256(canonical({ active: input.active, assignmentId: input.assignment.assignmentId, workerIdentityLabel: input.workerIdentityLabel, responseType: input.expectedResponseType, response: input.response, attestationId: input.attestation.attestationId }));
    const replay = this.replay<ManualTextImportResult>(input.idempotencyKey, payloadFingerprint);
    if (replay) return replay;
    const resultId = `manual-result-${payloadFingerprint.slice("sha256:".length, "sha256:".length + 48)}`;
    const result: ManualTextImportResult = Object.freeze({
      resultId, taskId: input.active.taskId, attemptId: input.active.attemptId, operationId: input.active.operationId, workerIdentityLabel: input.workerIdentityLabel,
      responseType: input.expectedResponseType, payloadFingerprint, provenance: "owner-attested manual relay", assurance: "weaker-manual", text: sanitize(input.response.text),
      run: manualRun({ ...input, resultId, capability: input.expectedResponseType }), replayed: false,
    });
    this.persist(input.idempotencyKey, payloadFingerprint, "text", result);
    return result;
  }

  public async importArtifacts(input: ManualArtifactImportRequest): Promise<ManualArtifactImportResult> {
    validateBase(input, "artifact");
    if (!SAFE_ID.test(input.importId) || input.files.length < 1 || input.files.length > MANUAL_RELAY_LIMITS.maxFiles) throw new ManualRelayError("ARTIFACT_REJECTED", "artifact import count or identity is invalid");
    const declarations = input.files.map((file) => {
      if (!SAFE_PATH.test(file.relativePath) || file.relativePath.includes("..") || file.relativePath.includes("\\") || isAbsolute(file.relativePath) || !ALLOWED_EXTENSIONS.has(extname(file.relativePath).toLowerCase()) || Buffer.byteLength(file.declaredPurpose) > MANUAL_RELAY_LIMITS.maxPurposeBytes || !/^sha256:[0-9a-f]{64}$/u.test(file.declaredSha256)) throw new ManualRelayError("ARTIFACT_REJECTED", "artifact declaration is unsafe");
      return file;
    });
    const collisionKeys = declarations.map((file) => process.platform === "win32" ? file.relativePath.toLowerCase() : file.relativePath);
    if (new Set(collisionKeys).size !== collisionKeys.length) throw new ManualRelayError("ARTIFACT_REJECTED", "artifact paths collide");
    const payloadFingerprint = sha256(canonical({ active: input.active, assignmentId: input.assignment.assignmentId, workerIdentityLabel: input.workerIdentityLabel, files: declarations.map(({ relativePath, declaredPurpose, declaredSha256 }) => ({ relativePath, declaredPurpose, declaredSha256 })), attestationId: input.attestation.attestationId }));
    const replay = this.replay<ManualArtifactImportResult>(input.idempotencyKey, payloadFingerprint);
    if (replay) return replay;
    const stage = resolve(this.quarantineRoot, input.active.taskId, input.active.attemptId, input.importId);
    if (!contained(this.quarantineRoot, stage) || canonicalPath(stage) === canonicalPath(this.quarantineRoot)) throw new ManualRelayError("ARTIFACT_REJECTED", "quarantine path escaped its root");
    await mkdir(dirname(stage), { recursive: true });
    await mkdir(stage, { recursive: false }).catch((error) => { throw new ManualRelayError("ARTIFACT_REJECTED", (error as NodeJS.ErrnoException).code === "EEXIST" ? "quarantine collision" : "quarantine could not be created"); });
    const artifacts: QuarantinedArtifactRef[] = [];
    let total = 0;
    try {
      for (const file of declarations) {
        const info = await lstat(file.sourcePath);
        if (!info.isFile() || info.isSymbolicLink()) throw new ManualRelayError("ARTIFACT_REJECTED", "artifact source must be a regular non-link file");
        await rejectLinkComponents(file.sourcePath);
        if (info.size > MANUAL_RELAY_LIMITS.maxFileBytes || (total += info.size) > MANUAL_RELAY_LIMITS.maxTotalArtifactBytes) throw new ManualRelayError("OVERSIZED_IMPORT", "artifact import exceeds its bound");
        const bytes = await readFile(file.sourcePath);
        const contentHash = sha256(bytes);
        if (contentHash !== file.declaredSha256) throw new ManualRelayError("ARTIFACT_REJECTED", "artifact hash does not match its declaration");
        const target = resolve(stage, ...file.relativePath.split("/"));
        if (!contained(stage, target)) throw new ManualRelayError("ARTIFACT_REJECTED", "artifact target escaped quarantine");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
        artifacts.push(Object.freeze({ artifactId: `artifact-${contentHash.slice("sha256:".length, "sha256:".length + 48)}`, relativePath: file.relativePath, contentHash, bytes: info.size, declaredPurpose: sanitize(file.declaredPurpose), state: "quarantined" }));
      }
      const resultId = `manual-result-${payloadFingerprint.slice("sha256:".length, "sha256:".length + 48)}`;
      const result: ManualArtifactImportResult = Object.freeze({
        resultId, taskId: input.active.taskId, attemptId: input.active.attemptId, operationId: input.active.operationId, payloadFingerprint,
        provenance: "owner-attested manual relay", assurance: "weaker-manual", artifacts: Object.freeze(artifacts), appliedToProject: false, appliedToWorktree: false,
        run: manualRun({ ...input, resultId, capability: "artifact-import" }), replayed: false,
      });
      this.persist(input.idempotencyKey, payloadFingerprint, "artifact", result);
      return result;
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }
}
