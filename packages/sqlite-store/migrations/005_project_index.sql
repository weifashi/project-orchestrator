CREATE TABLE project_indexes (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
 source_head TEXT NOT NULL,
 tree_fingerprint TEXT NOT NULL CHECK(length(tree_fingerprint)=64 AND tree_fingerprint NOT GLOB '*[^0-9a-f]*'),
 content_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
 file_count INTEGER NOT NULL CHECK(file_count>=0),
 skipped_file_count INTEGER NOT NULL CHECK(skipped_file_count>=0),
 created_at TEXT NOT NULL,
 UNIQUE(project_id,source_head,tree_fingerprint)
);

CREATE TABLE run_project_indexes (
 run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
 project_index_id TEXT NOT NULL REFERENCES project_indexes(id) ON DELETE RESTRICT,
 stage_run_id TEXT NOT NULL REFERENCES stage_runs(id) ON DELETE RESTRICT,
 stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
 changed_file_count INTEGER NOT NULL CHECK(changed_file_count>=0),
 bound_at TEXT NOT NULL
);

CREATE INDEX idx_project_indexes_latest ON project_indexes(project_id,created_at DESC,id);
CREATE INDEX idx_run_project_indexes_index ON run_project_indexes(project_index_id);

CREATE TRIGGER project_index_binding_ownership BEFORE INSERT ON run_project_indexes
WHEN NOT EXISTS (
 SELECT 1 FROM runs r
 JOIN project_indexes pi ON pi.id=NEW.project_index_id AND pi.project_id=r.project_id
 JOIN stage_runs sr ON sr.id=NEW.stage_run_id AND sr.run_id=r.id
 JOIN stage_attempts sa ON sa.id=NEW.stage_attempt_id AND sa.stage_run_id=sr.id
 WHERE r.id=NEW.run_id
)
BEGIN SELECT RAISE(ABORT,'PROJECT_INDEX_OWNERSHIP'); END;

CREATE TRIGGER immutable_project_index BEFORE UPDATE ON project_indexes
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECT_INDEX'); END;
CREATE TRIGGER immutable_project_index_delete BEFORE DELETE ON project_indexes
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECT_INDEX'); END;
CREATE TRIGGER immutable_run_project_index BEFORE UPDATE ON run_project_indexes
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RUN_PROJECT_INDEX'); END;
CREATE TRIGGER immutable_run_project_index_delete BEFORE DELETE ON run_project_indexes
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RUN_PROJECT_INDEX'); END;
