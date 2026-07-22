import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { detectRedactions } from "@chubz/shared";
import type { Principal } from "./auth.js";
import type { ControlPlaneConfig } from "./config.js";
import type { ControlPlaneDatabase } from "./database.js";
import { M6Error } from "./m6-ui.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const OID = /^[0-9a-f]{40,64}$/u;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const sha256 = (value: string | Buffer): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
};
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown, label: string): string => { if (typeof value !== "string" || !ID.test(value) || value.includes("..")) throw new M6Error("INVALID_REQUEST", `${label} is invalid`); return value; };
const idempotency = (value: unknown): string => { if (typeof value !== "string" || !IDEMPOTENCY.test(value)) throw new M6Error("INVALID_REQUEST", "idempotency key is invalid"); return value; };
const canonicalPath = (value: string): string => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
const contained = (root: string, candidate: string): boolean => { const rel = relative(canonicalPath(root), canonicalPath(candidate)); return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const rejectLinks = (target: string): void => {
  const absolute = resolve(target); const root = absolute.slice(0, absolute.indexOf(sep) + 1); let cursor = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) { cursor = resolve(cursor, part); try { if (lstatSync(cursor).isSymbolicLink()) throw new M6Error("CONFLICT", "review package path is not trusted"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; } }
};
const sensitiveKey = (key: string): boolean => /password|secret|token|credential|authorization|cookie|private.?key|capability.?grant|grant.?json|raw.?environment|authentication.?file|signature/iu.test(key);
const IDENTITY_KEYS = new Set(["ownerId", "projectId", "taskId", "attemptId", "operationId", "journalId", "workerId", "adapterId", "adapterRunId", "captureId", "packageId", "validationId", "attestationId"]);
const assertSanitized = (value: unknown, depth = 0, trustedIdentity = false): void => {
  if (depth > 12) throw new M6Error("INVALID_REQUEST", "review package exceeds structural bounds");
  if (typeof value === "string") { if (trustedIdentity && ID.test(value) && !value.includes("..") || /^(?:capture|package)-[0-9a-f]{48}$/u.test(value) || HASH.test(value) || OID.test(value)) return; const findings = detectRedactions(value); if (!findings.ok || findings.value.length > 0 || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value)) throw new M6Error("INVALID_REQUEST", "review package contains unsanitized evidence"); return; }
  if (Array.isArray(value)) { if (value.length > 1024) throw new M6Error("INVALID_REQUEST", "review package array exceeds bound"); for (const item of value) assertSanitized(item, depth + 1); return; }
  if (object(value)) { const entries = Object.entries(value); if (entries.length > 1024) throw new M6Error("INVALID_REQUEST", "review package object exceeds bound"); for (const [key, item] of entries) { if (sensitiveKey(key)) throw new M6Error("INVALID_REQUEST", "review package contains a forbidden field"); assertSanitized(item, depth + 1, IDENTITY_KEYS.has(key)); } }
};

type CaptureRow = { capture_id: string; identity_digest: string; owner_id: string; project_id: string; task_id: string; attempt_id: string; operation_id: string; worker_id: string; adapter_id: string; journal_id: string | null; baseline_commit: string | null; final_commit: string | null; status: string; failure_reason: string | null; limitations_json: string; evidence_summary_json: string | null; retry_of_capture_id: string | null; requested_at: string; started_at: string | null; finished_at: string | null; updated_at: string };
type PackageRow = { package_id: string; capture_id: string; owner_id: string; project_id: string; task_id: string; attempt_id: string; status: string; schema_version: string; package_digest: string; manifest_digest: string; package_file_name: string; byte_length: number; package_json: string; manifest_json: string; finalized_at: string };

export class M7ReviewService {
  private readonly packageRoot: string;
  private transitionPublisher: ((taskId: string, eventKind: string) => void) | undefined;
  public constructor(private readonly database: ControlPlaneDatabase, config: ControlPlaneConfig) {
    this.packageRoot = resolve(config.dataDirectory, "review-packages");
    const approvedOperationalRoot = resolve("B:\\AI_Agent_folder"); if (config.environment !== "test" && !contained(approvedOperationalRoot, config.dataDirectory)) throw new Error("M7 managed data must remain beneath the approved operational root");
    if (!contained(config.dataDirectory, this.packageRoot) || canonicalPath(config.dataDirectory) === canonicalPath(this.packageRoot)) throw new Error("review package root escaped managed data");
    rejectLinks(config.dataDirectory); mkdirSync(this.packageRoot, { recursive: true }); rejectLinks(this.packageRoot);
    this.reconcileAfterRestart();
  }
  public setTransitionPublisher(publisher: (taskId: string, eventKind: string) => void): void { this.transitionPublisher = publisher; }

  private mutation<T>(scope: string, key: string, request: unknown, execute: () => T): T {
    const digest = sha256(canonical(request)); const db = this.database.connection;
    return db.transaction(() => {
      const found = db.prepare("SELECT request_digest,result_json FROM m7_mutations WHERE mutation_scope=? AND idempotency_key=?").get(scope, key) as { request_digest: string; result_json: string | null } | undefined;
      if (found) { if (found.request_digest !== digest) throw new M6Error("CONFLICT", "idempotency key conflicts with a prior capture request"); if (found.result_json === null) throw new M6Error("CONFLICT", "capture request is in progress"); return JSON.parse(found.result_json) as T; }
      db.prepare("INSERT INTO m7_mutations(mutation_scope,idempotency_key,request_digest,result_json,recorded_at) VALUES(?,?,?,?,?)").run(scope, key, digest, null, new Date().toISOString());
      try { const result = execute(); db.prepare("UPDATE m7_mutations SET result_json=? WHERE mutation_scope=? AND idempotency_key=?").run(JSON.stringify(result), scope, key); return result; }
      catch (error) { db.prepare("DELETE FROM m7_mutations WHERE mutation_scope=? AND idempotency_key=? AND result_json IS NULL").run(scope, key); throw error; }
    })();
  }

  public requestCapture(principal: Principal, taskIdRaw: unknown, raw: Record<string, unknown>): Record<string, unknown> {
    const taskId = id(taskIdRaw, "taskId"); const key = idempotency(raw["idempotencyKey"]); const expectedVersion = raw["expectedVersion"];
    if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0) throw new M6Error("INVALID_REQUEST", "task version is invalid");
    return this.mutation(`capture.request:${principal.administratorId}:${taskId}`, key, { taskId, expectedVersion }, () => {
      const task = this.database.connection.prepare("SELECT project_id,state,attempt_id,current_operation_id,version FROM tasks WHERE task_id=?").get(taskId) as { project_id: string; state: string; attempt_id: string | null; current_operation_id: string | null; version: number } | undefined;
      if (!task) throw new M6Error("NOT_FOUND", "task was not found"); if (task.version !== expectedVersion) throw new M6Error("STALE_STATE", "task version is stale");
      if (task.attempt_id === null || task.current_operation_id === null || !["RESULT_CAPTURED", "AWAITING_APPROVAL", "APPROVED", "REJECTED", "FAILED", "CANCELLED", "BLOCKED", "COMPLETED"].includes(task.state)) throw new M6Error("CONFLICT", "attempt is not eligible for evidence capture");
      const attempt = this.database.connection.prepare("SELECT action_digest,action_json FROM task_attempts WHERE attempt_id=? AND task_id=?").get(task.attempt_id, taskId) as { action_digest: string; action_json: string } | undefined;
      const assignment = this.database.connection.prepare("SELECT worker_id,assignment_json FROM m4_assignments WHERE task_id=? AND attempt_id=? AND operation_id=? ORDER BY created_at DESC LIMIT 1").get(taskId, task.attempt_id, task.current_operation_id) as { worker_id: string; assignment_json: string } | undefined;
      const result = this.database.connection.prepare("SELECT result_digest,result_json FROM m4_results WHERE task_id=? AND attempt_id=? AND operation_id=? UNION ALL SELECT result_digest,result_json FROM m6_manual_results WHERE task_id=? AND attempt_id=? AND operation_id=? LIMIT 1").get(taskId, task.attempt_id, task.current_operation_id, taskId, task.attempt_id, task.current_operation_id) as { result_digest: string; result_json: string } | undefined;
      if (!attempt || !assignment || !result) throw new M6Error("CONFLICT", "authoritative attempt result is unavailable");
      const assignmentValue = JSON.parse(assignment.assignment_json) as Record<string, unknown>; const adapterId = typeof assignmentValue["adapterId"] === "string" ? assignmentValue["adapterId"] : assignment.worker_id === "manual-relay" ? "manual-relay" : "unknown-adapter";
      const identityDigest = sha256(canonical({ ownerId: principal.administratorId, projectId: task.project_id, taskId, attemptId: task.attempt_id, operationId: task.current_operation_id, actionDigest: attempt.action_digest, resultDigest: result.result_digest, workerId: assignment.worker_id, adapterId }));
      const existing = this.database.connection.prepare("SELECT capture_id,status,requested_at FROM m7_capture_requests WHERE identity_digest=?").get(identityDigest) as { capture_id: string; status: string; requested_at: string } | undefined;
      if (existing) return { taskId, attemptId: task.attempt_id, captureId: existing.capture_id, status: existing.status, requestedAt: existing.requested_at, replayed: true };
      const captureId = `capture-${identityDigest.slice("sha256:".length, "sha256:".length + 48)}`; const at = new Date().toISOString();
      this.database.connection.prepare("INSERT INTO m7_capture_requests(capture_id,identity_digest,owner_id,project_id,task_id,attempt_id,operation_id,worker_id,adapter_id,status,requested_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)").run(captureId, identityDigest, principal.administratorId, task.project_id, taskId, task.attempt_id, task.current_operation_id, assignment.worker_id, adapterId, at, at);
      this.transitionPublisher?.(taskId, "evidence.capture-pending");
      return { taskId, attemptId: task.attempt_id, captureId, status: "pending", requestedAt: at, replayed: false };
    });
  }

  public retryCapture(principal: Principal, taskIdRaw: unknown, captureIdRaw: unknown, raw: Record<string, unknown>): Record<string, unknown> {
    const taskId = id(taskIdRaw, "taskId"); const priorId = id(captureIdRaw, "captureId"); const key = idempotency(raw["idempotencyKey"]); const expectedVersion = raw["expectedVersion"];
    if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0) throw new M6Error("INVALID_REQUEST", "task version is invalid");
    return this.mutation(`capture.retry:${principal.administratorId}:${taskId}:${priorId}`, key, { taskId, priorId, expectedVersion }, () => {
      const task = this.database.connection.prepare("SELECT version,attempt_id,current_operation_id FROM tasks WHERE task_id=?").get(taskId) as { version: number; attempt_id: string | null; current_operation_id: string | null } | undefined;
      const prior = this.database.connection.prepare("SELECT * FROM m7_capture_requests WHERE capture_id=? AND owner_id=? AND task_id=?").get(priorId, principal.administratorId, taskId) as CaptureRow | undefined;
      if (!task || !prior) throw new M6Error("NOT_FOUND", "capture was not found"); if (task.version !== expectedVersion) throw new M6Error("STALE_STATE", "task version is stale");
      if (task.attempt_id !== prior.attempt_id || task.current_operation_id !== prior.operation_id || !["failed", "incomplete"].includes(prior.status)) throw new M6Error("CONFLICT", "capture retry is not explicitly allowed");
      const identityDigest = sha256(canonical({ retryOf: prior.capture_id, priorIdentity: prior.identity_digest, idempotencyKey: key })); const captureId = `capture-${identityDigest.slice("sha256:".length, "sha256:".length + 48)}`; const at = new Date().toISOString();
      this.database.connection.prepare("INSERT INTO m7_capture_requests(capture_id,identity_digest,owner_id,project_id,task_id,attempt_id,operation_id,worker_id,adapter_id,status,retry_of_capture_id,requested_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?)").run(captureId, identityDigest, prior.owner_id, prior.project_id, prior.task_id, prior.attempt_id, prior.operation_id, prior.worker_id, prior.adapter_id, prior.capture_id, at, at);
      this.transitionPublisher?.(taskId, "evidence.capture-retry-pending");
      return { taskId, attemptId: prior.attempt_id, captureId, status: "pending", retryOfCaptureId: prior.capture_id, requestedAt: at, replayed: false };
    });
  }

  public beginSystemCapture(captureIdRaw: unknown): Record<string, unknown> {
    const captureId = id(captureIdRaw, "captureId"); const at = new Date().toISOString(); const changed = this.database.connection.prepare("UPDATE m7_capture_requests SET status='capturing',started_at=COALESCE(started_at,?),updated_at=? WHERE capture_id=? AND status='pending'").run(at, at, captureId);
    if (changed.changes !== 1) { const row = this.database.connection.prepare("SELECT status FROM m7_capture_requests WHERE capture_id=?").get(captureId) as { status: string } | undefined; if (!row) throw new M6Error("NOT_FOUND", "capture was not found"); if (row.status !== "capturing") throw new M6Error("CONFLICT", "capture cannot enter capturing state"); }
    if (changed.changes === 1) { const capture = this.database.connection.prepare("SELECT task_id FROM m7_capture_requests WHERE capture_id=?").get(captureId) as { task_id: string }; this.transitionPublisher?.(capture.task_id, "evidence.capture-capturing"); }
    return { captureId, status: "capturing", startedAt: at };
  }

  public failSystemCapture(captureIdRaw: unknown, reasonRaw: unknown, quarantined = false): Record<string, unknown> {
    const captureId = id(captureIdRaw, "captureId"); const reason = typeof reasonRaw === "string" ? Array.from(reasonRaw.slice(0, 512), (character) => character.codePointAt(0)! < 32 ? " " : character).join("") : "capture failed"; assertSanitized(reason); const at = new Date().toISOString(); const status = quarantined ? "quarantined" : "failed";
    const changed = this.database.connection.prepare("UPDATE m7_capture_requests SET status=?,failure_reason=?,finished_at=?,updated_at=? WHERE capture_id=? AND status IN ('pending','capturing')").run(status, reason, at, at, captureId); if (changed.changes !== 1) throw new M6Error("CONFLICT", "capture failure transition is unavailable"); const capture = this.database.connection.prepare("SELECT task_id FROM m7_capture_requests WHERE capture_id=?").get(captureId) as { task_id: string }; this.transitionPublisher?.(capture.task_id, `evidence.capture-${status}`); return { captureId, status, failureReason: reason, finishedAt: at };
  }

  /** Local Bridge integration boundary. The caller must already be authenticated as the outbound Bridge. */
  public finalizeSystemCapture(input: Readonly<{ captureId: string; packageDocument: unknown; manifest: unknown }>): Record<string, unknown> {
    const captureId = id(input.captureId, "captureId"); if (!object(input.packageDocument) || !object(input.manifest)) throw new M6Error("INVALID_REQUEST", "capture package is malformed");
    const capture = this.database.connection.prepare("SELECT * FROM m7_capture_requests WHERE capture_id=?").get(captureId) as CaptureRow | undefined; if (!capture) throw new M6Error("NOT_FOUND", "capture was not found");
    const binding = input.packageDocument["binding"];
    if (input.packageDocument["schemaVersion"] !== "m7.review-package/v1" || input.manifest["schemaVersion"] !== "m7.review-manifest/v1") throw new M6Error("INVALID_REQUEST", "review package schema is unsupported");
    if (!object(binding) || binding["ownerId"] !== capture.owner_id || binding["projectId"] !== capture.project_id || binding["taskId"] !== capture.task_id || binding["attemptId"] !== capture.attempt_id || binding["operationId"] !== capture.operation_id || binding["workerId"] !== capture.worker_id || binding["adapterId"] !== capture.adapter_id || input.packageDocument["captureId"] !== capture.capture_id) throw new M6Error("CONFLICT", "capture package binding conflicts with authoritative state");
    assertSanitized(input.packageDocument); assertSanitized(input.manifest);
    const packageId = id(input.packageDocument["packageId"], "packageId"); const packageDigest = input.packageDocument["packageDigest"]; const manifestDigest = input.manifest["manifestDigest"];
    if (typeof packageDigest !== "string" || !HASH.test(packageDigest) || typeof manifestDigest !== "string" || !HASH.test(manifestDigest)) throw new M6Error("INVALID_REQUEST", "package hash is invalid");
    const { packageId: _packageId, packageDigest: _packageDigest, ...packageCore } = input.packageDocument;
    if (packageDigest !== sha256(`chubz.m7.review-package/v1\n${canonical(packageCore)}`) || packageId !== `package-${packageDigest.slice("sha256:".length, "sha256:".length + 48)}`) throw new M6Error("CONFLICT", "package content hash verification failed");
    const { manifestDigest: _manifestDigest, ...manifestCore } = input.manifest;
    if (manifestDigest !== sha256(`chubz.m7.review-manifest/v1\n${canonical(manifestCore)}`) || input.manifest["packageId"] !== packageId || input.manifest["captureId"] !== captureId) throw new M6Error("CONFLICT", "manifest hash verification failed");
    const packageJson = `${canonical(input.packageDocument)}\n`; const manifestJson = `${canonical(input.manifest)}\n`; const bytes = Buffer.byteLength(packageJson);
    if (bytes > MAX_PACKAGE_BYTES || !Array.isArray(input.manifest["files"]) || input.manifest["files"].length !== 1 || !object(input.manifest["files"][0]) || input.manifest["files"][0]["name"] !== "review-package.json" || input.manifest["files"][0]["sha256"] !== sha256(packageJson) || input.manifest["files"][0]["byteLength"] !== bytes) throw new M6Error("INVALID_REQUEST", "manifest file verification failed");
    const status = input.packageDocument["packageStatus"]; if (status !== "captured" && status !== "incomplete" && status !== "quarantined") throw new M6Error("INVALID_REQUEST", "package status is invalid");
    const prior = this.database.connection.prepare("SELECT * FROM m7_review_packages WHERE capture_id=?").get(captureId) as PackageRow | undefined;
    if (prior) { if (prior.package_digest !== packageDigest || prior.manifest_digest !== manifestDigest) throw new M6Error("CONFLICT", "finalized package is immutable"); return this.packageMetadata(prior, true); }
    const target = resolve(this.packageRoot, packageId); const staging = resolve(this.packageRoot, `.staging-${captureId}`); if (!contained(this.packageRoot, target) || !contained(this.packageRoot, staging)) throw new M6Error("INVALID_REQUEST", "unsafe package identity"); rejectLinks(target); rejectLinks(staging);
    rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { recursive: false }); rejectLinks(staging); writeFileSync(resolve(staging, "review-package.json"), packageJson, { flag: "wx", mode: 0o400 }); writeFileSync(resolve(staging, "manifest.json"), manifestJson, { flag: "wx", mode: 0o400 });
    try { renameSync(staging, target); } catch (error) { rmSync(staging, { recursive: true, force: true }); if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const existing = readFileSync(resolve(target, "review-package.json")); if (sha256(existing) !== sha256(packageJson)) throw new M6Error("CONFLICT", "immutable package path has conflicting content"); }
    const git = object(input.packageDocument["git"]) ? input.packageDocument["git"] : {}; const baseline = typeof git["baselineCommit"] === "string" && OID.test(git["baselineCommit"]) ? git["baselineCommit"] : null; const final = typeof git["head"] === "string" && OID.test(git["head"]) ? git["head"] : null;
    const limitations = Array.isArray(input.packageDocument["limitations"]) ? input.packageDocument["limitations"] : []; const changedPaths = Array.isArray(input.packageDocument["changedPaths"]) ? input.packageDocument["changedPaths"] : []; const validationValues = Array.isArray(input.packageDocument["validations"]) ? input.packageDocument["validations"] : []; const validations = validationValues.map((value) => object(value) ? { validationId: value["validationId"], kind: value["kind"], command: value["command"], workingDirectory: value["workingDirectory"], startedAt: value["startedAt"], finishedAt: value["finishedAt"], exitCode: value["exitCode"], terminationReason: value["terminationReason"], authoritativeOutcome: value["authoritativeOutcome"], parser: value["parser"], stdout: object(value["stdout"]) ? { truncated: value["stdout"]["truncated"], redacted: value["stdout"]["redacted"] } : null, stderr: object(value["stderr"]) ? { truncated: value["stderr"]["truncated"], redacted: value["stderr"]["redacted"] } : null, processTreeTermination: value["processTreeTermination"], toolVersions: value["toolVersions"], artifactHashes: value["artifactHashes"] } : null).filter((value) => value !== null); const evidence = object(input.packageDocument["evidence"]) ? input.packageDocument["evidence"] : {}; const summary = { baselineCommit: baseline, finalCommit: final, changedPaths: changedPaths.length, changedPathManifest: changedPaths.map((value) => object(value) ? { path: value["path"], originalPath: value["originalPath"], operation: value["operation"], staged: value["staged"], unstaged: value["unstaged"], untracked: value["untracked"], additions: value["additions"], deletions: value["deletions"], beforeHash: value["beforeHash"], afterHash: value["afterHash"], content: value["content"] } : null).filter((value) => value !== null), diffStatistics: input.packageDocument["diffStatistics"] ?? {}, validations, evidenceCategories: { workerReportedClaim: evidence["workerReportedClaim"] !== null && evidence["workerReportedClaim"] !== undefined, systemObserved: evidence["systemObserved"] === true, ownerAttestedManualEvidence: evidence["ownerAttestedManualEvidence"] !== null && evidence["ownerAttestedManualEvidence"] !== undefined, reviewerConclusion: evidence["reviewerConclusion"] ?? null }, provenance: input.packageDocument["provenance"] ?? {}, artifacts: input.packageDocument["artifacts"] ?? {}, redactions: input.packageDocument["redactions"] ?? {}, omissions: input.packageDocument["omissions"] ?? [], packageStatus: status, applied: false };
    const at = new Date().toISOString();
    this.database.connection.transaction(() => {
      this.database.connection.prepare("INSERT INTO m7_review_packages(package_id,capture_id,owner_id,project_id,task_id,attempt_id,status,schema_version,package_digest,manifest_digest,package_file_name,byte_length,package_json,manifest_json,finalized_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(packageId, captureId, capture.owner_id, capture.project_id, capture.task_id, capture.attempt_id, status, "m7.review-package/v1", packageDigest, manifestDigest, "review-package.json", bytes, packageJson, manifestJson, at);
      this.database.connection.prepare("UPDATE m7_capture_requests SET journal_id=?,baseline_commit=?,final_commit=?,status=?,failure_reason=NULL,limitations_json=?,evidence_summary_json=?,started_at=COALESCE(started_at,?),finished_at=?,updated_at=? WHERE capture_id=? AND status IN ('pending','capturing','failed','incomplete')").run(typeof binding["journalId"] === "string" ? binding["journalId"] : null, baseline, final, status, JSON.stringify(limitations), JSON.stringify(summary), at, at, at, captureId);
    })();
    this.transitionPublisher?.(capture.task_id, `evidence.package-${status}`);
    return { packageId, captureId, status, packageDigest, manifestDigest, byteLength: bytes, finalizedAt: at, replayed: false };
  }

  public snapshotForTask(principal: Principal, taskId: string): readonly Record<string, unknown>[] {
    const rows = this.database.connection.prepare("SELECT * FROM m7_capture_requests WHERE owner_id=? AND task_id=? ORDER BY requested_at").all(principal.administratorId, taskId) as CaptureRow[];
    return rows.map((row) => { const packageRow = this.database.connection.prepare("SELECT * FROM m7_review_packages WHERE capture_id=?").get(row.capture_id) as PackageRow | undefined; return { captureId: row.capture_id, attemptId: row.attempt_id, operationId: row.operation_id, workerId: row.worker_id, adapterId: row.adapter_id, status: row.status, baselineCommit: row.baseline_commit, finalCommit: row.final_commit, failureReason: row.failure_reason, limitations: JSON.parse(row.limitations_json) as unknown, summary: row.evidence_summary_json === null ? null : JSON.parse(row.evidence_summary_json) as unknown, requestedAt: row.requested_at, startedAt: row.started_at, finishedAt: row.finished_at, package: packageRow ? this.packageMetadata(packageRow, false) : null, applied: false }; });
  }

  public listPackages(principal: Principal, taskIdRaw: unknown): readonly Record<string, unknown>[] { const taskId = id(taskIdRaw, "taskId"); return this.snapshotForTask(principal, taskId).flatMap((capture) => object(capture["package"]) ? [capture["package"] as Record<string, unknown>] : []); }
  public verifyPackage(principal: Principal, taskIdRaw: unknown, packageIdRaw: unknown): Record<string, unknown> {
    const taskId = id(taskIdRaw, "taskId"); const packageId = id(packageIdRaw, "packageId"); const row = this.database.connection.prepare("SELECT * FROM m7_review_packages WHERE package_id=? AND owner_id=? AND task_id=?").get(packageId, principal.administratorId, taskId) as PackageRow | undefined;
    if (!row) throw new M6Error("NOT_FOUND", "review package was not found"); const verified = this.verifyStoredFiles(row);
    return { packageId, verified, packageDigest: row.package_digest, manifestDigest: row.manifest_digest, byteLength: row.byte_length, verifiedAt: new Date().toISOString() };
  }
  public download(principal: Principal, packageIdRaw: unknown): Readonly<{ fileName: string; content: string; digest: string }> {
    const packageId = id(packageIdRaw, "packageId"); const row = this.database.connection.prepare("SELECT * FROM m7_review_packages WHERE package_id=? AND owner_id=?").get(packageId, principal.administratorId) as PackageRow | undefined; if (!row) throw new M6Error("NOT_FOUND", "review package was not found");
    const target = resolve(this.packageRoot, row.package_id, row.package_file_name); if (!contained(this.packageRoot, target)) throw new M6Error("NOT_FOUND", "review package was not found"); if (!this.verifyStoredFiles(row)) throw new M6Error("CONFLICT", "review package integrity verification failed"); const content = readFileSync(target, "utf8"); return { fileName: `${row.package_id}.json`, content, digest: row.package_digest };
  }

  private packageMetadata(row: PackageRow, replayed: boolean): Record<string, unknown> { return { packageId: row.package_id, captureId: row.capture_id, status: row.status, schemaVersion: row.schema_version, packageDigest: row.package_digest, manifestDigest: row.manifest_digest, byteLength: row.byte_length, finalizedAt: row.finalized_at, downloadAvailable: true, applied: false, replayed }; }
  private verifyStoredFiles(row: PackageRow): boolean {
    try {
      const directory = resolve(this.packageRoot, row.package_id); const target = resolve(directory, row.package_file_name); const manifestPath = resolve(directory, "manifest.json"); if (!contained(this.packageRoot, target) || !contained(this.packageRoot, manifestPath)) return false; rejectLinks(target); rejectLinks(manifestPath);
      const bytes = readFileSync(target); const manifestText = readFileSync(manifestPath, "utf8"); if (bytes.length !== row.byte_length || bytes.toString("utf8") !== row.package_json || manifestText !== row.manifest_json) return false;
      const manifest = JSON.parse(manifestText) as Record<string, unknown>; const { manifestDigest, ...manifestCore } = manifest; const files = manifest["files"];
      return manifestDigest === row.manifest_digest && row.manifest_digest === sha256(`chubz.m7.review-manifest/v1\n${canonical(manifestCore)}`) && Array.isArray(files) && files.length === 1 && object(files[0]) && files[0]["name"] === row.package_file_name && files[0]["sha256"] === sha256(bytes) && files[0]["byteLength"] === bytes.length;
    } catch { return false; }
  }
  private reconcileAfterRestart(): void {
    this.database.connection.prepare("UPDATE m7_capture_requests SET status='incomplete',failure_reason='capture interrupted by restart',finished_at=COALESCE(finished_at,?),updated_at=? WHERE status='capturing'").run(new Date().toISOString(), new Date().toISOString());
    rejectLinks(this.packageRoot);
    for (const entry of readdirSync(this.packageRoot, { withFileTypes: true })) {
      if (!entry.name.startsWith(".staging-")) continue; const target = resolve(this.packageRoot, entry.name); if (!contained(this.packageRoot, target) || !entry.isDirectory()) throw new Error("unsafe review-package staging entry"); rejectLinks(target); rmSync(target, { recursive: true, force: true });
    }
  }
}
