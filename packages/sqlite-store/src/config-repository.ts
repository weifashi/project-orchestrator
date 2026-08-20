import type Database from 'better-sqlite3';

export type WorkflowTaskType = 'new_project' | 'feature' | 'bugfix';

export type CreateWorkflowTemplateInput = {
  id: string;
  slug: string;
  name: string;
  taskType: WorkflowTaskType;
};

export type CreateRoleInput = { id: string; slug: string; name: string };

export type PublishedWorkflowInsert = {
  id: string;
  workflowTemplateId: string;
  versionNumber: number;
  description: string;
  safetyBaselineVersion: number;
  contentObjectId: string;
  contentHash: string;
};

export type PublishedRoleInsert = {
  id: string;
  roleId: string;
  versionNumber: number;
  contentObjectId: string;
  skillHash: string;
  inputSchemaEnvelope: unknown;
  outputSchemaEnvelope: unknown;
  requestedCapabilities: string[];
  effectiveCapabilities: string[];
  forbiddenCapabilities: string[];
  completionContractEnvelope: unknown;
};

export type PublishedWorkflowRecord = Readonly<{
  id: string;
  workflowTemplateId: string;
  slug: string;
  taskType: WorkflowTaskType;
  versionNumber: number;
  description: string;
  safetyBaselineVersion: number;
  contentObjectId: string;
  contentHash: string;
  publishedAt: string;
}>;

export type PublishedRoleRecord = Readonly<{
  id: string;
  roleId: string;
  slug: string;
  versionNumber: number;
  contentObjectId: string;
  skillHash: string;
  requestedCapabilities: readonly string[];
  effectiveCapabilities: readonly string[];
  forbiddenCapabilities: readonly string[];
  status: 'published' | 'revoked';
  roleStatus: 'active' | 'disabled' | 'archived';
  publishedAt: string;
}>;

export type RoleRecord = Readonly<{
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'disabled' | 'archived';
  currentVersionId?: string;
}>;

export type WorkflowTemplateRecord = Readonly<{
  id: string;
  slug: string;
  name: string;
  taskType: WorkflowTaskType;
  status: 'active' | 'disabled' | 'archived';
  currentVersionId?: string;
}>;

export interface ConfigRepository {
  saveWorkflowDraft(templateId: string, expectedRevision: number, envelope: unknown): number;
  publishWorkflow(input: PublishedWorkflowInsert): void;
  saveRoleDraft(roleId: string, expectedRevision: number, envelope: unknown): number;
  publishRole(input: PublishedRoleInsert): void;
  getPublishedWorkflow(id: string): PublishedWorkflowRecord | undefined;
  getPublishedRole(id: string): PublishedRoleRecord | undefined;
}

type RoleRow = {
  id: string; slug: string; name: string; status: RoleRecord['status']; current_version_id: string | null;
};
type TemplateRow = {
  id: string; slug: string; name: string; task_type: WorkflowTaskType;
  status: WorkflowTemplateRecord['status']; current_version_id: string | null;
};
type PublishedRoleRow = {
  id: string; role_id: string; slug: string; version_number: number; content_object_id: string; skill_hash: string;
  requested_capabilities: string; effective_capabilities: string; forbidden_capabilities: string;
  status: PublishedRoleRecord['status']; role_status: PublishedRoleRecord['roleStatus']; published_at: string;
};
type PublishedWorkflowRow = {
  id: string; workflow_template_id: string; slug: string; task_type: WorkflowTaskType; version_number: number;
  description: string; safety_baseline_version: number; content_object_id: string; content_hash: string; published_at: string;
};

function immutable<T extends object>(value: T): Readonly<T> {
  for (const item of Object.values(value)) {
    if (item !== null && typeof item === 'object') Object.freeze(item);
  }
  return Object.freeze(value);
}

export class SqliteConfigRepository implements ConfigRepository {
  constructor(readonly db: Database.Database) {}

  createWorkflowTemplate(input: CreateWorkflowTemplateInput): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO workflow_templates
      (id,slug,name,task_type,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .run(input.id, input.slug, input.name, input.taskType, 'active', now, now);
  }

  createRole(input: CreateRoleInput): void {
    const now = new Date().toISOString();
    this.db.prepare('INSERT OR IGNORE INTO roles(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(input.id, input.slug, input.name, 'active', now, now);
  }

  saveWorkflowDraft(templateId: string, expectedRevision: number, envelope: unknown): number {
    return this.saveDraft('workflow_drafts', 'workflow_template_id', templateId, expectedRevision, envelope);
  }

  saveRoleDraft(roleId: string, expectedRevision: number, envelope: unknown): number {
    return this.saveDraft('role_drafts', 'role_id', roleId, expectedRevision, envelope);
  }

  private saveDraft(table: 'workflow_drafts' | 'role_drafts', parentColumn: string, parentId: string, expectedRevision: number, envelope: unknown): number {
    const nextRevision = expectedRevision + 1;
    const serialized = JSON.stringify(envelope);
    const now = new Date().toISOString();
    const changed = this.db.transaction(() => {
      if (expectedRevision === 0) {
        return this.db.prepare(`INSERT OR IGNORE INTO ${table}(${parentColumn},revision,draft_envelope,updated_at) VALUES(?,?,?,?)`)
          .run(parentId, nextRevision, serialized, now).changes;
      }
      return this.db.prepare(`UPDATE ${table} SET revision=?,draft_envelope=?,updated_at=? WHERE ${parentColumn}=? AND revision=?`)
        .run(nextRevision, serialized, now, parentId, expectedRevision).changes;
    }).immediate();
    if (changed !== 1) throw new Error('REVISION_CONFLICT');
    return nextRevision;
  }

  publishWorkflow(input: PublishedWorkflowInsert): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO workflow_versions
        (id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at)
        VALUES(?,?,?,?,?,?,?,?)`)
        .run(input.id, input.workflowTemplateId, input.versionNumber, input.description, input.safetyBaselineVersion,
          input.contentObjectId, input.contentHash, now);
      const result = this.db.prepare('UPDATE workflow_templates SET current_version_id=?,updated_at=? WHERE id=? AND status=?')
        .run(input.id, now, input.workflowTemplateId, 'active');
      if (result.changes !== 1) throw new Error('NOT_FOUND: active workflow template');
    }).immediate();
  }

  publishRole(input: PublishedRoleInsert): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO role_versions
        (id,role_id,version_number,content_object_id,skill_hash,input_schema_envelope,output_schema_envelope,
         requested_capabilities,effective_capabilities,forbidden_capabilities,completion_contract_envelope,published_at,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(input.id, input.roleId, input.versionNumber, input.contentObjectId, input.skillHash,
          JSON.stringify(input.inputSchemaEnvelope), JSON.stringify(input.outputSchemaEnvelope),
          JSON.stringify(input.requestedCapabilities), JSON.stringify(input.effectiveCapabilities),
          JSON.stringify(input.forbiddenCapabilities), JSON.stringify(input.completionContractEnvelope), now, 'published');
      const result = this.db.prepare('UPDATE roles SET current_version_id=?,updated_at=? WHERE id=? AND status=?')
        .run(input.id, now, input.roleId, 'active');
      if (result.changes !== 1) throw new Error('NOT_FOUND: active role');
    }).immediate();
  }

  getPublishedWorkflow(id: string): PublishedWorkflowRecord | undefined {
    const row = this.db.prepare(`SELECT v.*,t.slug,t.task_type FROM workflow_versions v
      JOIN workflow_templates t ON t.id=v.workflow_template_id WHERE v.id=?`).get(id) as PublishedWorkflowRow | undefined;
    return row === undefined ? undefined : this.mapWorkflow(row);
  }

  getPublishedRole(id: string): PublishedRoleRecord | undefined {
    const row = this.db.prepare(`SELECT v.*,r.slug,r.status AS role_status FROM role_versions v
      JOIN roles r ON r.id=v.role_id WHERE v.id=?`).get(id) as PublishedRoleRow | undefined;
    return row === undefined ? undefined : immutable({
      id: row.id, roleId: row.role_id, slug: row.slug, versionNumber: row.version_number,
      contentObjectId: row.content_object_id, skillHash: row.skill_hash,
      requestedCapabilities: JSON.parse(row.requested_capabilities) as string[],
      effectiveCapabilities: JSON.parse(row.effective_capabilities) as string[],
      forbiddenCapabilities: JSON.parse(row.forbidden_capabilities) as string[],
      status: row.status, roleStatus: row.role_status, publishedAt: row.published_at,
    });
  }

  getRole(id: string): RoleRecord | undefined {
    const row = this.db.prepare('SELECT id,slug,name,status,current_version_id FROM roles WHERE id=?').get(id) as RoleRow | undefined;
    if (row === undefined) return undefined;
    const base = { id: row.id, slug: row.slug, name: row.name, status: row.status };
    return immutable(row.current_version_id === null ? base : { ...base, currentVersionId: row.current_version_id });
  }

  getWorkflowTemplate(id: string): WorkflowTemplateRecord | undefined {
    const row = this.db.prepare('SELECT id,slug,name,task_type,status,current_version_id FROM workflow_templates WHERE id=?').get(id) as TemplateRow | undefined;
    if (row === undefined) return undefined;
    const base = { id: row.id, slug: row.slug, name: row.name, taskType: row.task_type, status: row.status };
    return immutable(row.current_version_id === null ? base : { ...base, currentVersionId: row.current_version_id });
  }

  listRoles(): RoleRecord[] {
    return (this.db.prepare('SELECT id FROM roles ORDER BY slug').all() as Array<{ id: string }>)
      .map(({ id }) => this.getRole(id) as RoleRecord);
  }

  listWorkflowTemplates(): WorkflowTemplateRecord[] {
    return (this.db.prepare('SELECT id FROM workflow_templates ORDER BY slug').all() as Array<{ id: string }>)
      .map(({ id }) => this.getWorkflowTemplate(id) as WorkflowTemplateRecord);
  }

  nextRoleVersion(roleId: string): number {
    const row = this.db.prepare('SELECT coalesce(max(version_number),0)+1 AS version FROM role_versions WHERE role_id=?').get(roleId) as { version: number };
    return row.version;
  }

  nextWorkflowVersion(templateId: string): number {
    const row = this.db.prepare('SELECT coalesce(max(version_number),0)+1 AS version FROM workflow_versions WHERE workflow_template_id=?').get(templateId) as { version: number };
    return row.version;
  }

  listPublishedWorkflows(taskType?: string): PublishedWorkflowRecord[] {
    const rows = (taskType === undefined
      ? this.db.prepare(`SELECT v.*,t.slug,t.task_type FROM workflow_versions v JOIN workflow_templates t
          ON t.current_version_id=v.id WHERE t.status='active' ORDER BY t.slug`).all()
      : this.db.prepare(`SELECT v.*,t.slug,t.task_type FROM workflow_versions v JOIN workflow_templates t
          ON t.current_version_id=v.id WHERE t.status='active' AND t.task_type=? ORDER BY t.slug`).all(taskType)) as PublishedWorkflowRow[];
    return rows.map((row) => this.mapWorkflow(row));
  }

  private mapWorkflow(row: PublishedWorkflowRow): PublishedWorkflowRecord {
    return immutable({
      id: row.id, workflowTemplateId: row.workflow_template_id, slug: row.slug, taskType: row.task_type,
      versionNumber: row.version_number, description: row.description,
      safetyBaselineVersion: row.safety_baseline_version, contentObjectId: row.content_object_id,
      contentHash: row.content_hash, publishedAt: row.published_at,
    });
  }
}
