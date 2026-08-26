ALTER TABLE roles ADD COLUMN removed_at TEXT;

CREATE INDEX idx_roles_removed_at ON roles(removed_at) WHERE removed_at IS NOT NULL;
