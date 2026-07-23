import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { ControlPlaneConfig } from "./config.js";

type Migration = Readonly<{ version: number; sql: string }>;
const migrations: readonly Migration[] = [
  { version: 1, sql: `
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE administrators (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, disabled_at TEXT);
    CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, administrator_id TEXT NOT NULL REFERENCES administrators(id), csrf_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, idle_expires_at TEXT NOT NULL, revoked_at TEXT, last_seen_at TEXT NOT NULL);
    CREATE INDEX sessions_active_idx ON sessions(administrator_id, expires_at, idle_expires_at);
    CREATE TABLE auth_events (id INTEGER PRIMARY KEY, event_kind TEXT NOT NULL, administrator_id TEXT REFERENCES administrators(id), occurred_at TEXT NOT NULL, request_id TEXT NOT NULL);
    CREATE TABLE idempotency_records (scope_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_digest TEXT NOT NULL, first_message_id TEXT NOT NULL, response_ref TEXT, recorded_at TEXT NOT NULL, PRIMARY KEY(scope_key, idempotency_key));
    CREATE TABLE event_streams (stream_id TEXT PRIMARY KEY, head_sequence INTEGER NOT NULL DEFAULT 0, oldest_retained_sequence INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE events (stream_id TEXT NOT NULL REFERENCES event_streams(stream_id), sequence INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL, PRIMARY KEY(stream_id, sequence));
    CREATE TABLE tasks (task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, state TEXT NOT NULL, attempt_id TEXT, blocked_context_json TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  ` },
  { version: 2, sql: `
    CREATE TABLE administrator_singleton_guard (id INTEGER PRIMARY KEY CHECK (id = 1));
    INSERT INTO administrator_singleton_guard(id)
      SELECT CASE WHEN COUNT(*) <= 1 THEN 1 ELSE 2 END FROM administrators;
    CREATE TRIGGER administrators_singleton_insert
      BEFORE INSERT ON administrators
      WHEN (SELECT COUNT(*) FROM administrators) >= 1
      BEGIN SELECT RAISE(ABORT, 'administrator singleton invariant'); END;
  ` },
  { version: 3, sql: `
    CREATE INDEX IF NOT EXISTS auth_events_occurred_at_idx ON auth_events(occurred_at, id);
  ` },
  { version: 4, sql: `
    ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN created_at TEXT;
    ALTER TABLE tasks ADD COLUMN current_operation_id TEXT;
    ALTER TABLE tasks ADD COLUMN cancellation_requested_at TEXT;

    CREATE TABLE task_attempts (
      attempt_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_sequence INTEGER NOT NULL,
      action_json TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      input_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, attempt_sequence)
    );
    CREATE TRIGGER task_attempts_immutable_update
      BEFORE UPDATE ON task_attempts BEGIN SELECT RAISE(ABORT, 'task attempt is immutable'); END;
    CREATE TRIGGER task_attempts_immutable_delete
      BEFORE DELETE ON task_attempts BEGIN SELECT RAISE(ABORT, 'task attempt is immutable'); END;

    CREATE TABLE task_state_transitions (
      transition_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      actor TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      blocked_context_json TEXT,
      expected_version INTEGER NOT NULL,
      resulting_version INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      occurred_at TEXT NOT NULL,
      UNIQUE(task_id, resulting_version)
    );

    CREATE TABLE m4_write_scopes (
      scope_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE m4_leases (
      lease_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      status TEXT NOT NULL,
      generation INTEGER NOT NULL,
      lease_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE m4_assignments (
      assignment_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      status TEXT NOT NULL,
      assignment_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(task_id, attempt_id, operation_id)
    );
    CREATE TABLE m4_approvals (
      approval_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      status TEXT NOT NULL,
      approved_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE m4_grants (
      grant_id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL UNIQUE REFERENCES m4_approvals(approval_id),
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      status TEXT NOT NULL,
      grant_json TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      consumed_at TEXT,
      result_ref TEXT
    );
    CREATE TABLE m4_dispatch_queue (
      queue_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      grant_id TEXT NOT NULL REFERENCES m4_grants(grant_id),
      status TEXT NOT NULL,
      enqueued_at TEXT NOT NULL,
      claimed_at TEXT,
      UNIQUE(task_id, attempt_id, operation_id)
    );
    CREATE INDEX m4_dispatch_fifo_idx ON m4_dispatch_queue(status, queue_sequence);
    CREATE TABLE m4_results (
      result_ref TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL UNIQUE,
      result_digest TEXT NOT NULL,
      result_json TEXT NOT NULL,
      status TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE TABLE m4_commands (
      command_scope TEXT NOT NULL,
      command_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      result_json TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(command_scope, command_id)
    );
    CREATE TABLE m4_reconciliations (
      reconciliation_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      owner_evidence_ref TEXT NOT NULL,
      runtime_evidence_ref TEXT,
      recorded_at TEXT NOT NULL
    );
  ` },
  { version: 5, sql: `
    CREATE TABLE m5_adapter_readiness (
      readiness_id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      readiness_state TEXT NOT NULL,
      freeze_state TEXT NOT NULL,
      readiness_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE TABLE m5_worker_states (
      worker_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK(state IN ('enabled','disabled','frozen')),
      updated_at TEXT NOT NULL
    );
    INSERT INTO m5_worker_states(worker_id,state,updated_at) VALUES
      ('codex-cli','enabled',CURRENT_TIMESTAMP),
      ('manual-relay','enabled',CURRENT_TIMESTAMP);
  ` },
  { version: 6, sql: `
    CREATE TABLE m6_mutations (
      mutation_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      result_json TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(mutation_scope, idempotency_key)
    );
    CREATE TABLE m6_manual_results (
      result_ref TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      result_digest TEXT NOT NULL,
      result_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      UNIQUE(task_id, attempt_id, operation_id)
    );
    CREATE TRIGGER m6_manual_results_immutable_update
      BEFORE UPDATE ON m6_manual_results BEGIN SELECT RAISE(ABORT, 'manual result is immutable'); END;
    CREATE TRIGGER m6_manual_results_immutable_delete
      BEFORE DELETE ON m6_manual_results BEGIN SELECT RAISE(ABORT, 'manual result is immutable'); END;
  ` },
  { version: 7, sql: `
    CREATE TABLE m7_capture_requests (
      capture_id TEXT PRIMARY KEY,
      identity_digest TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      journal_id TEXT,
      baseline_commit TEXT,
      final_commit TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','capturing','captured','failed','incomplete','quarantined')),
      failure_reason TEXT,
      limitations_json TEXT NOT NULL DEFAULT '[]',
      evidence_summary_json TEXT,
      retry_of_capture_id TEXT REFERENCES m7_capture_requests(capture_id),
      requested_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(task_id, attempt_id, operation_id, identity_digest)
    );
    CREATE INDEX m7_capture_task_idx ON m7_capture_requests(owner_id, task_id, attempt_id, requested_at);
    CREATE INDEX m7_capture_pending_idx ON m7_capture_requests(status, requested_at);

    CREATE TABLE m7_review_packages (
      package_id TEXT PRIMARY KEY,
      capture_id TEXT NOT NULL UNIQUE REFERENCES m7_capture_requests(capture_id),
      owner_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      status TEXT NOT NULL CHECK(status IN ('captured','incomplete','quarantined')),
      schema_version TEXT NOT NULL,
      package_digest TEXT NOT NULL UNIQUE,
      manifest_digest TEXT NOT NULL UNIQUE,
      package_file_name TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
      package_json TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      finalized_at TEXT NOT NULL
    );
    CREATE TRIGGER m7_review_packages_immutable_update
      BEFORE UPDATE ON m7_review_packages BEGIN SELECT RAISE(ABORT, 'review package is immutable'); END;
    CREATE TRIGGER m7_review_packages_immutable_delete
      BEFORE DELETE ON m7_review_packages BEGIN SELECT RAISE(ABORT, 'review package is immutable'); END;

    CREATE TABLE m7_mutations (
      mutation_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      result_json TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(mutation_scope, idempotency_key)
    );
  ` },
  { version: 8, sql: `
    CREATE TABLE m8_operational_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      event_kind TEXT NOT NULL,
      owner_id TEXT,
      project_id TEXT,
      task_id TEXT,
      attempt_id TEXT,
      operation_id TEXT,
      source TEXT NOT NULL,
      actor_category TEXT NOT NULL,
      old_state TEXT,
      new_state TEXT,
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      event_digest TEXT NOT NULL UNIQUE,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX m8_events_project_sequence_idx ON m8_operational_events(project_id, sequence);

    CREATE TABLE m8_projection_state (
      projection_id INTEGER PRIMARY KEY CHECK(projection_id = 1),
      schema_version TEXT NOT NULL,
      cursor_sequence INTEGER NOT NULL DEFAULT 0 CHECK(cursor_sequence >= 0),
      projected_event_count INTEGER NOT NULL DEFAULT 0 CHECK(projected_event_count >= 0),
      status TEXT NOT NULL CHECK(status IN ('empty','current','gap','tampered','failed','rebuilding')),
      file_digest TEXT,
      verified_at TEXT,
      rebuilt_at TEXT,
      failure_reason TEXT,
      version INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO m8_projection_state(projection_id,schema_version,status) VALUES(1,'m8.bridge-log/v1','empty');

    CREATE TABLE m8_recovery_incidents (
      incident_id TEXT PRIMARY KEY,
      owner_id TEXT,
      project_id TEXT,
      task_id TEXT,
      attempt_id TEXT,
      operation_id TEXT,
      condition TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('info','warning','high','critical')),
      first_detected_at TEXT NOT NULL,
      latest_detected_at TEXT NOT NULL,
      resolution_state TEXT NOT NULL CHECK(resolution_state IN ('open','acknowledged','reviewed','resolved','closed')),
      allowed_actions_json TEXT NOT NULL,
      blocked_actions_json TEXT NOT NULL,
      related_refs_json TEXT NOT NULL,
      notes TEXT NOT NULL,
      resolution_provenance_json TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      UNIQUE(condition, project_id, task_id, attempt_id, operation_id)
    );
    CREATE INDEX m8_incidents_owner_state_idx ON m8_recovery_incidents(owner_id, resolution_state, latest_detected_at);

    CREATE TABLE m8_emergency_stops (
      stop_id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('global','project')),
      project_id TEXT,
      owner_id TEXT NOT NULL REFERENCES administrators(id),
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','released')),
      activated_at TEXT NOT NULL,
      released_at TEXT,
      released_by TEXT REFERENCES administrators(id),
      version INTEGER NOT NULL DEFAULT 1,
      CHECK((scope_type='global' AND project_id IS NULL) OR (scope_type='project' AND project_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX m8_one_active_global_stop ON m8_emergency_stops(scope_type) WHERE status='active' AND scope_type='global';
    CREATE UNIQUE INDEX m8_one_active_project_stop ON m8_emergency_stops(project_id) WHERE status='active' AND scope_type='project';
    CREATE TABLE m8_emergency_state (
      scope_key TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
      updated_at TEXT NOT NULL
    );
    INSERT INTO m8_emergency_state(scope_key,version,updated_at) VALUES('global',0,CURRENT_TIMESTAMP);

    CREATE TABLE m8_stop_operations (
      stop_id TEXT NOT NULL REFERENCES m8_emergency_stops(stop_id),
      operation_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      cancellation_state TEXT NOT NULL CHECK(cancellation_state IN ('blocked-before-start','requested','confirmed','failed','uncertain')),
      requested_at TEXT,
      updated_at TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      PRIMARY KEY(stop_id, operation_id)
    );

    CREATE TABLE m8_reconciliation_runs (
      run_id TEXT PRIMARY KEY,
      trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('control-plane-start','bridge-start','owner-request')),
      status TEXT NOT NULL CHECK(status IN ('running','completed','completed-with-incidents','failed')),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      summary_json TEXT NOT NULL,
      run_digest TEXT
    );

    CREATE TABLE m8_bridge_state (
      bridge_id TEXT PRIMARY KEY,
      connection_state TEXT NOT NULL CHECK(connection_state IN ('connected','disconnected','unknown')),
      last_seen_at TEXT,
      executable_provenance_digest TEXT,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO m8_bridge_state(bridge_id,connection_state,updated_at) VALUES('local-bridge','unknown',CURRENT_TIMESTAMP);

    CREATE TABLE m8_mutations (
      mutation_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      result_json TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(mutation_scope,idempotency_key)
    );
  ` },
  { version: 9, sql: `
    CREATE TABLE m9_repository_bindings (
      repository_binding_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES administrators(id),
      project_id TEXT NOT NULL,
      binding_kind TEXT NOT NULL CHECK(binding_kind IN ('source-managed','target-owner')),
      repository_identity TEXT NOT NULL,
      canonical_path TEXT NOT NULL,
      validation_plans_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(owner_id, project_id, binding_kind),
      UNIQUE(repository_identity)
    );
    CREATE TRIGGER m9_repository_binding_path_immutable
      BEFORE UPDATE OF canonical_path,repository_identity,owner_id,project_id,binding_kind ON m9_repository_bindings
      BEGIN SELECT RAISE(ABORT, 'repository binding identity is immutable'); END;

    CREATE TABLE m9_apply_requests (
      apply_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES administrators(id),
      source_project_id TEXT NOT NULL,
      target_project_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      capture_id TEXT NOT NULL REFERENCES m7_capture_requests(capture_id),
      package_id TEXT NOT NULL REFERENCES m7_review_packages(package_id),
      package_schema_version TEXT NOT NULL,
      package_digest TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      source_repository_identity TEXT NOT NULL,
      reviewed_baseline TEXT NOT NULL,
      reviewed_commit TEXT NOT NULL,
      reviewed_paths_json TEXT NOT NULL,
      target_repository_identity TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      expected_old_head TEXT NOT NULL,
      apply_mode TEXT NOT NULL CHECK(apply_mode IN ('exact-reviewed-commit')),
      validation_plan_id TEXT NOT NULL,
      validation_plan_json TEXT NOT NULL,
      eligibility_json TEXT NOT NULL,
      request_digest TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('planned','prepare-queued','preparing','validating','ready','conflicted','validation-failed','cancel-requested','cancelled','apply-unknown','promotion-queued','promoting','promoted','stale','promotion-blocked','promotion-unknown')),
      owner_approval_id TEXT,
      capability_grant_id TEXT,
      capability_consumed_at TEXT,
      prepared_head TEXT,
      preparation_digest TEXT NOT NULL,
      prepare_result_json TEXT,
      validation_evidence_digest TEXT,
      apply_worktree_digest TEXT,
      promotion_confirmation_id TEXT,
      promotion_confirmation_digest TEXT,
      promotion_result_json TEXT,
      rollback_evidence_json TEXT NOT NULL,
      failure_details TEXT,
      limitation_details_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(owner_id, package_id, target_project_id, target_ref, expected_old_head, request_digest)
    );
    CREATE INDEX m9_apply_owner_status_idx ON m9_apply_requests(owner_id,status,updated_at);
    CREATE INDEX m9_apply_task_idx ON m9_apply_requests(owner_id,task_id,attempt_id,created_at);

    CREATE TABLE m9_capability_grants (
      grant_id TEXT PRIMARY KEY,
      apply_id TEXT NOT NULL UNIQUE REFERENCES m9_apply_requests(apply_id),
      owner_id TEXT NOT NULL REFERENCES administrators(id),
      capability TEXT NOT NULL CHECK(capability IN ('prepare-exact-reviewed-commit')),
      binding_digest TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('issued','consumed','revoked','expired')),
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );

    CREATE TABLE m9_apply_evidence (
      evidence_id TEXT PRIMARY KEY,
      apply_id TEXT NOT NULL REFERENCES m9_apply_requests(apply_id),
      evidence_kind TEXT NOT NULL,
      evidence_digest TEXT NOT NULL UNIQUE,
      evidence_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      UNIQUE(apply_id,evidence_kind,evidence_digest)
    );
    CREATE TRIGGER m9_apply_evidence_immutable_update
      BEFORE UPDATE ON m9_apply_evidence BEGIN SELECT RAISE(ABORT, 'apply evidence is immutable'); END;
    CREATE TRIGGER m9_apply_evidence_immutable_delete
      BEFORE DELETE ON m9_apply_evidence BEGIN SELECT RAISE(ABORT, 'apply evidence is immutable'); END;

    CREATE TABLE m9_mutations (
      mutation_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      result_json TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(mutation_scope,idempotency_key)
    );

    CREATE TRIGGER m9_finalized_prepare_evidence_guard
      BEFORE UPDATE OF prepare_result_json,validation_evidence_digest,apply_worktree_digest,prepared_head ON m9_apply_requests
      WHEN OLD.prepare_result_json IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'finalized preparation evidence is immutable'); END;
    CREATE TRIGGER m9_finalized_promotion_evidence_guard
      BEFORE UPDATE OF promotion_result_json,promotion_confirmation_digest ON m9_apply_requests
      WHEN OLD.promotion_result_json IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'finalized promotion evidence is immutable'); END;
  ` },
  { version: 10, sql: `
    CREATE TABLE m10_routing_policies (
      policy_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES administrators(id),
      project_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      policy_json TEXT NOT NULL,
      policy_digest TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_id,project_id)
    );
    CREATE TABLE m10_quota_observations (
      observation_id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('available','constrained','exhausted','unknown','unavailable')),
      confidence TEXT NOT NULL CHECK(confidence IN ('high','medium','low','unknown')),
      source TEXT NOT NULL CHECK(source IN ('provider-reported','adapter-observed','inferred','owner-attested','unknown')),
      observed_at TEXT NOT NULL,
      expires_at TEXT,
      reset_at TEXT,
      remaining INTEGER,
      limitation TEXT,
      observation_json TEXT NOT NULL,
      observation_digest TEXT NOT NULL UNIQUE
    );
    CREATE INDEX m10_quota_latest_idx ON m10_quota_observations(worker_id,adapter_id,observed_at DESC);
    CREATE TRIGGER m10_quota_immutable_update BEFORE UPDATE ON m10_quota_observations BEGIN SELECT RAISE(ABORT, 'quota observation is immutable'); END;
    CREATE TRIGGER m10_quota_immutable_delete BEFORE DELETE ON m10_quota_observations BEGIN SELECT RAISE(ABORT, 'quota observation is immutable'); END;
    CREATE TABLE m10_health_observations (
      observation_id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      source TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      observation_digest TEXT NOT NULL UNIQUE
    );
    CREATE INDEX m10_health_latest_idx ON m10_health_observations(worker_id,adapter_id,observed_at DESC);
    CREATE TABLE m10_routing_requests (
      routing_request_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES administrators(id),
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      expected_task_version INTEGER NOT NULL,
      input_json TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      risk_class TEXT NOT NULL CHECK(risk_class IN ('low','medium','high','owner-only')),
      risk_reasons_json TEXT NOT NULL,
      policy_rules_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','recommended','no-eligible-route','confirmed','rejected','stale')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_id,task_id,attempt_id,operation_id,input_digest)
    );
    CREATE INDEX m10_request_owner_task_idx ON m10_routing_requests(owner_id,task_id,created_at DESC);
    CREATE TABLE m10_candidate_evaluations (
      evaluation_id TEXT PRIMARY KEY,
      routing_request_id TEXT NOT NULL REFERENCES m10_routing_requests(routing_request_id),
      worker_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      rank INTEGER NOT NULL,
      eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),
      score INTEGER NOT NULL,
      evaluation_json TEXT NOT NULL,
      evaluation_digest TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      UNIQUE(routing_request_id,worker_id,adapter_id)
    );
    CREATE TABLE m10_recommendations (
      recommendation_id TEXT PRIMARY KEY,
      routing_request_id TEXT NOT NULL UNIQUE REFERENCES m10_routing_requests(routing_request_id),
      owner_id TEXT NOT NULL REFERENCES administrators(id),
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      recommendation_version TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      quota_digest TEXT NOT NULL,
      selected_worker_id TEXT,
      selected_adapter_id TEXT,
      risk_class TEXT NOT NULL,
      recommendation_json TEXT NOT NULL,
      recommendation_digest TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('generated','no-eligible-route','confirmed','rejected','stale')),
      generated_at TEXT NOT NULL,
      finalized_at TEXT NOT NULL
    );
    CREATE TRIGGER m10_recommendation_finalized_guard BEFORE UPDATE OF recommendation_json,recommendation_digest,input_digest,quota_digest,selected_worker_id,selected_adapter_id,recommendation_version ON m10_recommendations BEGIN SELECT RAISE(ABORT, 'finalized recommendation is immutable'); END;
    CREATE TABLE m10_route_confirmations (
      confirmation_id TEXT PRIMARY KEY,
      recommendation_id TEXT NOT NULL UNIQUE REFERENCES m10_recommendations(recommendation_id),
      owner_id TEXT NOT NULL REFERENCES administrators(id),
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      selected_worker_id TEXT NOT NULL,
      selected_adapter_id TEXT NOT NULL,
      recommendation_version TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      risk_class TEXT NOT NULL,
      capability_scope_json TEXT NOT NULL,
      quota_digest TEXT NOT NULL,
      expected_task_version INTEGER NOT NULL,
      emergency_state_digest TEXT NOT NULL,
      confirmation_digest TEXT NOT NULL UNIQUE,
      confirmed_at TEXT NOT NULL
    );
    CREATE TRIGGER m10_confirmation_immutable_update BEFORE UPDATE ON m10_route_confirmations BEGIN SELECT RAISE(ABORT, 'route confirmation is immutable'); END;
    CREATE TRIGGER m10_confirmation_immutable_delete BEFORE DELETE ON m10_route_confirmations BEGIN SELECT RAISE(ABORT, 'route confirmation is immutable'); END;
    CREATE TABLE m10_fallback_plans (
      fallback_plan_id TEXT PRIMARY KEY,
      routing_request_id TEXT NOT NULL REFERENCES m10_routing_requests(routing_request_id),
      recommendation_id TEXT NOT NULL REFERENCES m10_recommendations(recommendation_id),
      owner_id TEXT NOT NULL REFERENCES administrators(id),
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
      operation_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      options_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('proposed','confirmed','unavailable','stale')),
      created_at TEXT NOT NULL,
      confirmed_at TEXT,
      UNIQUE(recommendation_id)
    );
    CREATE TABLE m10_routing_incidents (
      incident_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES administrators(id),
      project_id TEXT NOT NULL,
      task_id TEXT,
      recommendation_id TEXT,
      condition TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(owner_id,condition,recommendation_id)
    );
    CREATE TABLE m10_mutations (
      mutation_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      result_json TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(mutation_scope,idempotency_key)
    );
    CREATE TABLE m10_reconciliation_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      run_digest TEXT NOT NULL UNIQUE
    );
  ` },
];
const checksum = (sql: string): string => createHash("sha256").update(sql).digest("hex");
export class MigrationError extends Error { constructor() { super("Control Plane database migration failed."); this.name = "MigrationError"; } }

export class ControlPlaneDatabase {
  readonly connection: Database.Database;
  constructor(config: ControlPlaneConfig) {
    this.connection = new Database(config.databasePath);
    this.connection.pragma("journal_mode = WAL");
    this.connection.pragma("foreign_keys = ON");
    this.connection.pragma("busy_timeout = 5000");
    try { this.migrate(); } catch (error) { this.connection.close(); throw error; }
  }
  migrate(): void {
    const db = this.connection;
    try {
      db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
      const known = db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all() as Array<{ version: number; checksum: string }>;
      for (const record of known) {
        const migration = migrations.find((entry) => entry.version === record.version);
        if (migration === undefined || checksum(migration.sql) !== record.checksum) throw new MigrationError();
      }
      if (known.some((entry, index) => entry.version !== index + 1)) throw new MigrationError();
      const apply = db.transaction(() => {
        for (const migration of migrations) {
          if (known.some((entry) => entry.version === migration.version)) continue;
          db.exec(migration.sql);
          db.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)").run(migration.version, checksum(migration.sql), new Date().toISOString());
        }
      });
      apply();
    } catch (error) { if (error instanceof MigrationError) throw error; throw new MigrationError(); }
  }
  isReady(): boolean { try { return this.connection.prepare("SELECT 1 AS ok").get() !== undefined; } catch { return false; } }
  close(): void { this.connection.close(); }
}
