CREATE TABLE client_installations (
 id TEXT PRIMARY KEY, client_type TEXT NOT NULL CHECK(client_type IN ('codex','claude')),
 adapter_version TEXT NOT NULL, capability_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 credential_hash TEXT NOT NULL CHECK(length(credential_hash)=64 AND credential_hash NOT GLOB '*[^0-9a-f]*'), status TEXT NOT NULL CHECK(status IN ('active','disabled','revoked')), last_seen_at TEXT NOT NULL,
 UNIQUE(client_type,id)
);
CREATE TABLE runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE projects (
 id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 repository_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
);
CREATE TABLE runs (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
 workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
 objective TEXT NOT NULL, input_envelope TEXT NOT NULL CHECK(json_valid(input_envelope)), origin_client_type TEXT NOT NULL CHECK(origin_client_type IN ('codex','claude')),
 client_installation_id TEXT NOT NULL REFERENCES client_installations(id) ON DELETE RESTRICT, origin_session_id TEXT NOT NULL,
 lease_holder_session_id TEXT, status TEXT NOT NULL CHECK(status IN ('created','running','waiting_for_user','paused','interrupted','failed','cancelled','completed')),
 lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch >= 0), server_epoch INTEGER NOT NULL DEFAULT 0 CHECK(server_epoch >= 0), lease_token_hash TEXT CHECK(lease_token_hash IS NULL OR (length(lease_token_hash)=64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*')), lease_expires_at TEXT,
 recovery_credential_hash TEXT CHECK(recovery_credential_hash IS NULL OR (length(recovery_credential_hash)=64 AND recovery_credential_hash NOT GLOB '*[^0-9a-f]*')), next_event_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_event_sequence >= 1),
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
 input_envelope TEXT NOT NULL CHECK(json_valid(input_envelope)), output_envelope TEXT CHECK(output_envelope IS NULL OR json_valid(output_envelope)), artifact_manifest_object_id TEXT REFERENCES content_objects(id) ON DELETE RESTRICT,
 evidence_manifest_object_id TEXT REFERENCES content_objects(id) ON DELETE RESTRICT, changed_files_object_id TEXT REFERENCES content_objects(id) ON DELETE RESTRICT,
 started_at TEXT NOT NULL, completed_at TEXT, failure_code TEXT, failure_summary TEXT, UNIQUE(stage_run_id,attempt_number)
);
CREATE TABLE workspace_checkpoints (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
 sequence_number INTEGER NOT NULL CHECK(sequence_number > 0),
 stage_attempt_id TEXT REFERENCES stage_attempts(id) ON DELETE RESTRICT,
 checkpoint_kind TEXT NOT NULL CHECK(checkpoint_kind IN ('run_start','before_attempt','progress','after_attempt')),
 repository_head TEXT NOT NULL, baseline_fingerprint TEXT NOT NULL, resulting_fingerprint TEXT NOT NULL,
 staged_patch_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 unstaged_patch_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 untracked_manifest_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 submodule_manifest_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT, created_at TEXT NOT NULL,
 UNIQUE(run_id,sequence_number)
);
CREATE TABLE confirmation_requests (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
 stage_run_id TEXT NOT NULL REFERENCES stage_runs(id) ON DELETE RESTRICT,
 stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
 confirmation_type TEXT NOT NULL CHECK(length(confirmation_type)>0),
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
 target_fingerprint TEXT NOT NULL, request_hash TEXT NOT NULL, parameters_envelope TEXT NOT NULL CHECK(json_valid(parameters_envelope)),
 confirmation_request_id TEXT NOT NULL UNIQUE REFERENCES confirmation_requests(id) ON DELETE RESTRICT,
 lease_epoch INTEGER NOT NULL CHECK(lease_epoch > 0), status TEXT NOT NULL CHECK(status IN ('intent_recorded','executing','succeeded','unknown','reconciled','abandoned')),
 external_reference TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
);
CREATE TABLE artifacts (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
 stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
 artifact_type TEXT NOT NULL CHECK(artifact_type IN ('document','log','test_evidence','file_manifest','ui_prototype','deployment_record','rollback_record','other')),
 content_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT, source_path TEXT, summary TEXT NOT NULL,
 producer_role_version_id TEXT NOT NULL REFERENCES role_versions(id) ON DELETE RESTRICT, metadata_envelope TEXT NOT NULL CHECK(json_valid(metadata_envelope)), created_at TEXT NOT NULL
);
CREATE TABLE memories (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
 source_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
 memory_type TEXT NOT NULL CHECK(memory_type IN ('decision','rule','fact','lesson','delivery_evidence')),
 scope TEXT NOT NULL CHECK(scope IN ('project','run')),
 title TEXT NOT NULL, summary TEXT NOT NULL, content_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 retention_policy TEXT NOT NULL CHECK(retention_policy IN ('keep','review','expire_after_run')), created_at TEXT NOT NULL,
 UNIQUE(project_id,memory_type,content_object_id)
);
CREATE TABLE events (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
 stage_run_id TEXT REFERENCES stage_runs(id) ON DELETE RESTRICT, sequence_number INTEGER NOT NULL CHECK(sequence_number > 0),
 event_type TEXT NOT NULL CHECK(event_type IN ('run_created','run_claimed','run_heartbeat','run_paused','run_interrupted','run_failed','run_cancelled','run_completed','stage_ready','stage_started','stage_succeeded','stage_failed','stage_retried','stage_skipped','stage_interrupted','confirmation_requested','confirmation_approved','confirmation_rejected','confirmation_consumed','artifact_recorded','checkpoint_recorded','memory_recorded','side_effect_prepared','side_effect_executing','side_effect_succeeded','side_effect_unknown','side_effect_reconciled','agent_note')), source_principal_id TEXT NOT NULL, payload_envelope TEXT NOT NULL CHECK(json_valid(payload_envelope)), created_at TEXT NOT NULL,
 UNIQUE(run_id,sequence_number)
);
CREATE TABLE idempotency_requests (
 id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 response_envelope TEXT CHECK(response_envelope IS NULL OR json_valid(response_envelope)), error_envelope TEXT CHECK(error_envelope IS NULL OR json_valid(error_envelope)), status TEXT NOT NULL CHECK(status IN ('in_progress','completed','failed')), created_at TEXT NOT NULL,
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
CREATE INDEX idx_checkpoints_cas ON workspace_checkpoints(staged_patch_object_id,unstaged_patch_object_id,untracked_manifest_object_id,submodule_manifest_object_id);
CREATE INDEX idx_checkpoints_latest ON workspace_checkpoints(run_id,sequence_number DESC);
CREATE UNIQUE INDEX idx_checkpoint_run_start ON workspace_checkpoints(run_id) WHERE checkpoint_kind='run_start';
CREATE INDEX idx_attempt_manifests ON stage_attempts(artifact_manifest_object_id,evidence_manifest_object_id,changed_files_object_id);
CREATE INDEX idx_operations_confirmation ON side_effect_operations(confirmation_request_id,status);
CREATE TRIGGER immutable_attempt AFTER UPDATE ON stage_attempts
WHEN OLD.status != 'running' BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ATTEMPT'); END;
CREATE TRIGGER immutable_attempt_identity BEFORE UPDATE ON stage_attempts
WHEN NEW.stage_run_id IS NOT OLD.stage_run_id OR NEW.attempt_number IS NOT OLD.attempt_number
 OR NEW.input_envelope IS NOT OLD.input_envelope OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ATTEMPT'); END;
CREATE TRIGGER immutable_run_identity BEFORE UPDATE ON runs
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.workflow_version_id IS NOT OLD.workflow_version_id
 OR NEW.objective IS NOT OLD.objective OR NEW.input_envelope IS NOT OLD.input_envelope
 OR NEW.origin_client_type IS NOT OLD.origin_client_type OR NEW.client_installation_id IS NOT OLD.client_installation_id
 OR NEW.origin_session_id IS NOT OLD.origin_session_id
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RUN'); END;
CREATE TRIGGER immutable_snapshot BEFORE UPDATE ON run_snapshots BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SNAPSHOT'); END;
CREATE TRIGGER immutable_snapshot_delete BEFORE DELETE ON run_snapshots BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SNAPSHOT'); END;
CREATE TRIGGER immutable_stage_identity BEFORE UPDATE ON stage_runs
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.stage_key IS NOT OLD.stage_key
 OR NEW.iteration_group_key IS NOT OLD.iteration_group_key OR NEW.iteration_number IS NOT OLD.iteration_number
 OR NEW.role_version_id IS NOT OLD.role_version_id OR NEW.max_attempts IS NOT OLD.max_attempts
 OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_STAGE_RUN'); END;
CREATE TRIGGER immutable_stage_delete BEFORE DELETE ON stage_runs BEGIN SELECT RAISE(ABORT,'IMMUTABLE_STAGE_RUN'); END;
CREATE TRIGGER immutable_iteration_identity BEFORE UPDATE ON run_iterations
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.group_key IS NOT OLD.group_key
 OR NEW.iteration_number IS NOT OLD.iteration_number OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ITERATION'); END;
CREATE TRIGGER immutable_iteration_delete BEFORE DELETE ON run_iterations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ITERATION'); END;
CREATE TRIGGER terminal_run_immutable BEFORE UPDATE OF status ON runs
WHEN OLD.status IN ('cancelled','completed') AND NEW.status != OLD.status
BEGIN SELECT RAISE(ABORT,'INVALID_TRANSITION'); END;
CREATE TRIGGER terminal_stage_run_immutable BEFORE UPDATE ON stage_runs
WHEN OLD.status IN ('succeeded','skipped','cancelled')
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_STAGE_RUN'); END;

CREATE TRIGGER stage_latest_attempt_ownership_insert BEFORE INSERT ON stage_runs
WHEN NEW.latest_attempt_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM stage_attempts WHERE id=NEW.latest_attempt_id AND stage_run_id=NEW.id
) BEGIN SELECT RAISE(ABORT,'ATTEMPT_OWNERSHIP'); END;
CREATE TRIGGER stage_latest_attempt_ownership_update BEFORE UPDATE OF latest_attempt_id ON stage_runs
WHEN NEW.latest_attempt_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM stage_attempts WHERE id=NEW.latest_attempt_id AND stage_run_id=NEW.id
) BEGIN SELECT RAISE(ABORT,'ATTEMPT_OWNERSHIP'); END;
CREATE TRIGGER checkpoint_ownership_insert BEFORE INSERT ON workspace_checkpoints
WHEN NEW.stage_attempt_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM stage_attempts a JOIN stage_runs s ON s.id=a.stage_run_id
 WHERE a.id=NEW.stage_attempt_id AND s.run_id=NEW.run_id
) BEGIN SELECT RAISE(ABORT,'CHECKPOINT_OWNERSHIP'); END;
CREATE TRIGGER checkpoint_sequence_insert BEFORE INSERT ON workspace_checkpoints
WHEN NEW.sequence_number != COALESCE((
 SELECT MAX(sequence_number)+1 FROM workspace_checkpoints WHERE run_id=NEW.run_id
),1)
BEGIN SELECT RAISE(ABORT,'CHECKPOINT_SEQUENCE'); END;
CREATE TRIGGER confirmation_ownership_insert BEFORE INSERT ON confirmation_requests
WHEN NOT EXISTS (
 SELECT 1 FROM stage_attempts a JOIN stage_runs s ON s.id=a.stage_run_id
 WHERE s.id=NEW.stage_run_id AND s.run_id=NEW.run_id AND a.id=NEW.stage_attempt_id
   AND s.latest_attempt_id=a.id AND a.status='running'
)
BEGIN SELECT RAISE(ABORT,'CONFIRMATION_OWNERSHIP'); END;
CREATE TRIGGER operation_ownership_insert BEFORE INSERT ON side_effect_operations
WHEN NOT EXISTS (
 SELECT 1 FROM stage_attempts a JOIN stage_runs s ON s.id=a.stage_run_id
 JOIN confirmation_requests c ON c.id=NEW.confirmation_request_id
 WHERE a.id=NEW.stage_attempt_id AND s.run_id=NEW.run_id AND c.run_id=NEW.run_id
   AND c.stage_run_id=s.id AND c.stage_attempt_id=a.id
) BEGIN SELECT RAISE(ABORT,'OPERATION_OWNERSHIP'); END;
CREATE TRIGGER artifact_ownership_insert BEFORE INSERT ON artifacts
WHEN NOT EXISTS (
 SELECT 1 FROM stage_attempts a JOIN stage_runs s ON s.id=a.stage_run_id
 WHERE a.id=NEW.stage_attempt_id AND s.run_id=NEW.run_id AND s.role_version_id=NEW.producer_role_version_id
) BEGIN SELECT RAISE(ABORT,'ARTIFACT_OWNERSHIP'); END;
CREATE TRIGGER event_ownership_insert BEFORE INSERT ON events
WHEN NEW.stage_run_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM stage_runs s WHERE s.id=NEW.stage_run_id AND s.run_id=NEW.run_id
) BEGIN SELECT RAISE(ABORT,'EVENT_OWNERSHIP'); END;
CREATE TRIGGER memory_ownership_insert BEFORE INSERT ON memories
WHEN NOT EXISTS (SELECT 1 FROM runs r WHERE r.id=NEW.source_run_id AND r.project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT,'MEMORY_OWNERSHIP'); END;
CREATE TRIGGER immutable_event BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVENT'); END;
CREATE TRIGGER immutable_event_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVENT'); END;
CREATE TRIGGER immutable_confirmation_delete BEFORE DELETE ON confirmation_requests BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CONFIRMATION'); END;
CREATE TRIGGER immutable_operation_delete BEFORE DELETE ON side_effect_operations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OPERATION'); END;
CREATE TRIGGER immutable_attempt_delete BEFORE DELETE ON stage_attempts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ATTEMPT'); END;
CREATE TRIGGER immutable_checkpoint BEFORE UPDATE ON workspace_checkpoints BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CHECKPOINT'); END;
CREATE TRIGGER immutable_checkpoint_delete BEFORE DELETE ON workspace_checkpoints BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CHECKPOINT'); END;
CREATE TRIGGER immutable_artifact BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARTIFACT'); END;
CREATE TRIGGER immutable_artifact_delete BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARTIFACT'); END;
CREATE TRIGGER immutable_memory BEFORE UPDATE ON memories BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMORY'); END;
CREATE TRIGGER immutable_memory_delete BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MEMORY'); END;
CREATE TRIGGER immutable_confirmation_identity BEFORE UPDATE ON confirmation_requests
WHEN NEW.run_id!=OLD.run_id OR NEW.stage_run_id!=OLD.stage_run_id OR NEW.confirmation_type!=OLD.confirmation_type
 OR NEW.stage_attempt_id!=OLD.stage_attempt_id
 OR NEW.action_hash!=OLD.action_hash OR NEW.nonce_hash!=OLD.nonce_hash OR NEW.safety_baseline_object_id!=OLD.safety_baseline_object_id
 OR NEW.requested_installation_id!=OLD.requested_installation_id OR NEW.requested_at!=OLD.requested_at OR NEW.expires_at!=OLD.expires_at
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CONFIRMATION'); END;
CREATE TRIGGER immutable_operation_identity BEFORE UPDATE ON side_effect_operations
WHEN NEW.run_id!=OLD.run_id OR NEW.stage_attempt_id!=OLD.stage_attempt_id OR NEW.action_type!=OLD.action_type
 OR NEW.target_fingerprint!=OLD.target_fingerprint OR NEW.request_hash!=OLD.request_hash
 OR NEW.parameters_envelope!=OLD.parameters_envelope OR NEW.confirmation_request_id!=OLD.confirmation_request_id
 OR NEW.lease_epoch!=OLD.lease_epoch OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OPERATION'); END;
