CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE content_objects (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  storage_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE workflow_templates (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK(task_type IN ('new_project','feature','bugfix')),
  status TEXT NOT NULL CHECK(status IN ('active','disabled','archived')),
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(current_version_id) REFERENCES workflow_versions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE workflow_drafts (
  workflow_template_id TEXT PRIMARY KEY REFERENCES workflow_templates(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  draft_envelope TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_template_id TEXT NOT NULL REFERENCES workflow_templates(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK(version_number > 0),
  description TEXT NOT NULL,
  safety_baseline_version INTEGER NOT NULL CHECK(safety_baseline_version > 0),
  content_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
  content_hash TEXT NOT NULL,
  published_at TEXT NOT NULL,
  UNIQUE(workflow_template_id, version_number)
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','disabled','archived')),
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(current_version_id) REFERENCES role_versions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE role_drafts (
  role_id TEXT PRIMARY KEY REFERENCES roles(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  draft_envelope TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE role_versions (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK(version_number > 0),
  content_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
  skill_hash TEXT NOT NULL,
  input_schema_envelope TEXT NOT NULL,
  output_schema_envelope TEXT NOT NULL,
  requested_capabilities TEXT NOT NULL,
  effective_capabilities TEXT NOT NULL,
  forbidden_capabilities TEXT NOT NULL,
  completion_contract_envelope TEXT NOT NULL,
  published_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('published','revoked')),
  UNIQUE(role_id, version_number)
);

CREATE INDEX idx_workflow_templates_status ON workflow_templates(status);
CREATE INDEX idx_workflow_versions_parent_version ON workflow_versions(workflow_template_id, version_number);
CREATE INDEX idx_roles_status ON roles(status);
CREATE INDEX idx_role_versions_parent_version ON role_versions(role_id, version_number);
CREATE INDEX idx_role_versions_status ON role_versions(status);

CREATE TRIGGER workflow_current_version_ownership_insert
BEFORE INSERT ON workflow_templates
WHEN NEW.current_version_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM workflow_versions
    WHERE id = NEW.current_version_id AND workflow_template_id = NEW.id
  ) THEN RAISE(ABORT, 'CURRENT_VERSION_OWNERSHIP') END;
END;

CREATE TRIGGER workflow_current_version_ownership_update
BEFORE UPDATE OF current_version_id ON workflow_templates
WHEN NEW.current_version_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM workflow_versions
    WHERE id = NEW.current_version_id AND workflow_template_id = NEW.id
  ) THEN RAISE(ABORT, 'CURRENT_VERSION_OWNERSHIP') END;
END;

CREATE TRIGGER role_current_version_ownership_insert
BEFORE INSERT ON roles
WHEN NEW.current_version_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM role_versions
    WHERE id = NEW.current_version_id AND role_id = NEW.id
  ) THEN RAISE(ABORT, 'CURRENT_VERSION_OWNERSHIP') END;
END;

CREATE TRIGGER role_current_version_ownership_update
BEFORE UPDATE OF current_version_id ON roles
WHEN NEW.current_version_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM role_versions
    WHERE id = NEW.current_version_id AND role_id = NEW.id
  ) THEN RAISE(ABORT, 'CURRENT_VERSION_OWNERSHIP') END;
END;

CREATE TRIGGER immutable_workflow_version
BEFORE UPDATE ON workflow_versions
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_VERSION');
END;

CREATE TRIGGER immutable_workflow_version_delete
BEFORE DELETE ON workflow_versions
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_VERSION');
END;

CREATE TRIGGER immutable_role_version_content
BEFORE UPDATE ON role_versions
WHEN NEW.id != OLD.id
  OR NEW.role_id != OLD.role_id
  OR NEW.version_number != OLD.version_number
  OR NEW.content_object_id != OLD.content_object_id
  OR NEW.skill_hash != OLD.skill_hash
  OR NEW.input_schema_envelope != OLD.input_schema_envelope
  OR NEW.output_schema_envelope != OLD.output_schema_envelope
  OR NEW.requested_capabilities != OLD.requested_capabilities
  OR NEW.effective_capabilities != OLD.effective_capabilities
  OR NEW.forbidden_capabilities != OLD.forbidden_capabilities
  OR NEW.completion_contract_envelope != OLD.completion_contract_envelope
  OR NEW.published_at != OLD.published_at
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_VERSION');
END;

CREATE TRIGGER immutable_role_version_delete
BEFORE DELETE ON role_versions
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_VERSION');
END;
