CREATE TABLE client_installations (
 id TEXT PRIMARY KEY, client_type TEXT NOT NULL CHECK(client_type IN ('codex','claude')),
 adapter_version TEXT NOT NULL, capability_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 credential_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','disabled','revoked')), last_seen_at TEXT NOT NULL,
 UNIQUE(client_type,id)
);
CREATE TABLE projects (
 id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 repository_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
);
CREATE TABLE runs (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
 workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
 objective TEXT NOT NULL, input_envelope TEXT NOT NULL, origin_client_type TEXT NOT NULL CHECK(origin_client_type IN ('codex','claude')),
 client_installation_id TEXT NOT NULL REFERENCES client_installations(id) ON DELETE RESTRICT, origin_session_id TEXT NOT NULL,
 lease_holder_session_id TEXT, status TEXT NOT NULL CHECK(status IN ('created','running','waiting_for_user','paused','interrupted','failed','cancelled','completed')),
 lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch >= 0), server_epoch INTEGER NOT NULL DEFAULT 0 CHECK(server_epoch >= 0), lease_token_hash TEXT, lease_expires_at TEXT,
 recovery_credential_hash TEXT, next_event_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_event_sequence >= 1),
 started_at TEXT, updated_at TEXT NOT NULL, completed_at TEXT, failure_code TEXT, failure_summary TEXT,
 is_retryable INTEGER NOT NULL DEFAULT 0 CHECK(is_retryable IN (0,1))
);
CREATE TABLE run_snapshots (
 run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
 workflow_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 role_bundle_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 rule_bundle_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 safety_baseline_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 adapter_capability_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 repository_head TEXT NOT NULL, staged_patch_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 unstaged_patch_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 untracked_manifest_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 submodule_manifest_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 working_tree_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE stage_runs (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT, stage_key TEXT NOT NULL,
 iteration_group_key TEXT, iteration_number INTEGER NOT NULL DEFAULT 0 CHECK(iteration_number >= 0),
 role_version_id TEXT NOT NULL REFERENCES role_versions(id) ON DELETE RESTRICT,
 status TEXT NOT NULL CHECK(status IN ('queued','ready','running','waiting_for_user','succeeded','failed','skipped','cancelled','interrupted')),
 latest_attempt_id TEXT, max_attempts INTEGER NOT NULL CHECK(max_attempts > 0),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
 UNIQUE(run_id,stage_key,iteration_number), UNIQUE(id,run_id),
 FOREIGN KEY(latest_attempt_id) REFERENCES stage_attempts(id) ON DELETE RESTRICT
);
CREATE TABLE run_iterations (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT, group_key TEXT NOT NULL,
 iteration_number INTEGER NOT NULL CHECK(iteration_number BETWEEN 1 AND 3), status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
 findings_manifest_object_id TEXT REFERENCES content_objects(id) ON DELETE RESTRICT, created_at TEXT NOT NULL, completed_at TEXT,
 UNIQUE(run_id,group_key,iteration_number)
);
CREATE TABLE stage_attempts (
 id TEXT PRIMARY KEY, stage_run_id TEXT NOT NULL REFERENCES stage_runs(id) ON DELETE RESTRICT,
 attempt_number INTEGER NOT NULL CHECK(attempt_number > 0), status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted')),
 input_envelope TEXT NOT NULL, output_envelope TEXT, artifact_manifest_object_id TEXT REFERENCES content_objects(id) ON DELETE RESTRICT,
 evidence_manifest_object_id TEXT REFERENCES content_objects(id) ON DELETE RESTRICT, changed_files_object_id TEXT REFERENCES content_objects(id) ON DELETE RESTRICT,
 started_at TEXT NOT NULL, completed_at TEXT, failure_code TEXT, failure_summary TEXT, UNIQUE(stage_run_id,attempt_number)
);
CREATE TABLE workspace_checkpoints (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
 stage_attempt_id TEXT REFERENCES stage_attempts(id) ON DELETE RESTRICT,
 checkpoint_kind TEXT NOT NULL CHECK(checkpoint_kind IN ('run_start','before_attempt','progress','after_attempt')),
 baseline_fingerprint TEXT NOT NULL, resulting_fingerprint TEXT NOT NULL,
 staged_patch_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 unstaged_patch_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 untracked_manifest_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 submodule_manifest_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT, created_at TEXT NOT NULL
);
CREATE TABLE confirmation_requests (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
 stage_run_id TEXT NOT NULL REFERENCES stage_runs(id) ON DELETE RESTRICT, confirmation_type TEXT NOT NULL,
 request_summary TEXT NOT NULL, action_hash TEXT NOT NULL, nonce_hash TEXT NOT NULL,
 safety_baseline_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 requested_installation_id TEXT NOT NULL REFERENCES client_installations(id) ON DELETE RESTRICT,
 status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired','consumed')),
 requested_at TEXT NOT NULL, expires_at TEXT NOT NULL, decision_client_installation_id TEXT REFERENCES client_installations(id) ON DELETE RESTRICT,
 decision_session_id TEXT, decided_at TEXT, consumed_at TEXT
);
CREATE TABLE side_effect_operations (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
 stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT, action_type TEXT NOT NULL,
 target_fingerprint TEXT NOT NULL, request_hash TEXT NOT NULL, parameters_envelope TEXT NOT NULL,
 confirmation_request_id TEXT NOT NULL UNIQUE REFERENCES confirmation_requests(id) ON DELETE RESTRICT,
 lease_epoch INTEGER NOT NULL CHECK(lease_epoch > 0), status TEXT NOT NULL CHECK(status IN ('intent_recorded','executing','succeeded','unknown','reconciled','abandoned')),
 external_reference TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
);
CREATE TABLE artifacts (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
 stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
 artifact_type TEXT NOT NULL CHECK(artifact_type IN ('document','log','test_evidence','file_manifest','ui_prototype','deployment_record','rollback_record','other')),
 content_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT, source_path TEXT, summary TEXT NOT NULL,
 producer_role_version_id TEXT NOT NULL REFERENCES role_versions(id) ON DELETE RESTRICT, metadata_envelope TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE memories (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
 source_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT, memory_type TEXT NOT NULL, scope TEXT NOT NULL,
 title TEXT NOT NULL, summary TEXT NOT NULL, content_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 retention_policy TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE events (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
 stage_run_id TEXT REFERENCES stage_runs(id) ON DELETE RESTRICT, sequence_number INTEGER NOT NULL CHECK(sequence_number > 0),
 event_type TEXT NOT NULL, source_principal_id TEXT NOT NULL, payload_envelope TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(run_id,sequence_number)
);
CREATE TABLE idempotency_requests (
 id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 response_envelope TEXT, error_envelope TEXT, status TEXT NOT NULL CHECK(status IN ('in_progress','completed','failed')), created_at TEXT NOT NULL,
 UNIQUE(principal_id,operation,request_id)
);
CREATE INDEX idx_runs_active ON runs(status,updated_at);
CREATE INDEX idx_runs_project_history ON runs(project_id,updated_at DESC);
CREATE INDEX idx_stage_runs_frontier ON stage_runs(run_id,status,iteration_number);
CREATE INDEX idx_confirmations_pending ON confirmation_requests(run_id,status,expires_at);
CREATE INDEX idx_events_tail ON events(run_id,sequence_number);
CREATE INDEX idx_snapshots_cas ON run_snapshots(workflow_object_id,role_bundle_object_id);
CREATE INDEX idx_artifacts_cas ON artifacts(content_object_id,artifact_type);
CREATE INDEX idx_memories_cas ON memories(content_object_id);
CREATE TRIGGER immutable_attempt AFTER UPDATE ON stage_attempts
WHEN OLD.status != 'running' BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ATTEMPT'); END;
CREATE TRIGGER terminal_run_immutable BEFORE UPDATE OF status ON runs
WHEN OLD.status IN ('cancelled','completed') AND NEW.status != OLD.status
BEGIN SELECT RAISE(ABORT,'INVALID_TRANSITION'); END;
CREATE TRIGGER terminal_stage_run_immutable BEFORE UPDATE ON stage_runs
WHEN OLD.status IN ('succeeded','skipped','cancelled')
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_STAGE_RUN'); END;
