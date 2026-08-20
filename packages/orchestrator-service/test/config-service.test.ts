import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentStore } from '@project-orchestrator/content-store';
import { SqliteConfigRepository, migrate, openDatabase } from '@project-orchestrator/sqlite-store';
import { ConfigService } from '../src/index.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orchestrator-service-'));
  directories.push(directory);
  const db = openDatabase(join(directory, 'store.sqlite'));
  migrate(db);
  const repository = new SqliteConfigRepository(db);
  const content = new ContentStore(join(directory, 'objects'), db);
  const service = new ConfigService(repository, content, {
    capabilityAllowlist: ['read-workspace', 'write-workspace', 'managed-side-effect'],
  });
  return { db, repository, content, service };
}

function roleEnvelope(slug: string, requested = ['read-workspace', 'unknown-capability']) {
  return {
    schema_id: 'project-orchestrator/role-version', schema_version: 1,
    data: {
      slug, display_name: slug, responsibilities: ['Do the work'], requested_capabilities: requested,
      forbidden_capabilities: [], input_schema: { schema_id: `${slug}/input`, schema_version: 1, data: {} },
      output_schema: { schema_id: `${slug}/output`, schema_version: 1, data: {} },
      completion_contract: { schema_id: `${slug}/completion`, schema_version: 1, data: {} }, body_markdown: '# Role',
    },
  };
}

function workflowEnvelope(roleVersionId: string, overrides: Record<string, unknown> = {}) {
  return {
    schema_id: 'project-orchestrator/workflow-version', schema_version: 1,
    data: {
      slug: 'workflow', version: 1,
      stages: [
        { key: 'implementation', role_version_id: roleVersionId, optional: false, mandatory_gate: false, failure_policy: 'trigger_iteration', max_attempts: 1, iteration_group_key: 'delivery_loop', requires_confirmation: false },
        { key: 'testing', role_version_id: roleVersionId, optional: false, mandatory_gate: true, failure_policy: 'trigger_iteration', max_attempts: 1, iteration_group_key: 'delivery_loop', requires_confirmation: false },
      ],
      edges: [{ from: 'implementation', to: 'testing', edge_type: 'on_success' }],
      iteration_groups: [{ key: 'delivery_loop', entry_stage_key: 'implementation', gate_stage_keys: ['testing'], aggregation_policy: 'collect_all', max_iterations: 3 }],
      ...overrides,
    },
  };
}

describe('configuration service', () => {
  it('intersects requested role capabilities with the platform allowlist', () => {
    const { db, repository, service } = fixture();
    repository.createRole({ id: 'role', slug: 'role', name: 'Role' });
    const published = service.publishRole({ roleId: 'role', envelope: roleEnvelope('role') });
    expect(repository.getPublishedRole(published.id)?.effectiveCapabilities).toEqual(['read-workspace']);
    db.close();
  });

  it('rejects a forbidden production capability', () => {
    const { db, repository, service } = fixture();
    repository.createRole({ id: 'role', slug: 'role', name: 'Role' });
    expect(() => service.publishRole({ roleId: 'role', envelope: roleEnvelope('role', ['production-shell']) }))
      .toThrow(/POLICY_VIOLATION/);
    db.close();
  });

  it('rejects publishing a role whose output schema is not valid JSON Schema', () => {
    const { db, repository, service } = fixture();
    repository.createRole({ id: 'role', slug: 'role', name: 'Role' });
    const envelope = roleEnvelope('role');
    envelope.data.output_schema.data = { type: 'definitely-not-a-json-schema-type' };
    expect(() => service.publishRole({ roleId: 'role', envelope })).toThrow('SCHEMA_INVALID');
    db.close();
  });

  it('rejects an unsupported safety baseline version', () => {
    const { db, repository, content } = fixture();
    expect(() => new ConfigService(repository, content, { safetyBaselineVersion: 999 }))
      .toThrow(/SAFETY_BASELINE_INCOMPATIBLE/);
    db.close();
  });

  it('enforces the built-in safety baseline on a first publication', () => {
    const { db, repository, service } = fixture();
    repository.createRole({ id: 'implementation-role', slug: 'implementation', name: 'Implementation' });
    const implementation = service.publishRole({
      roleId: 'implementation-role', envelope: roleEnvelope('implementation'),
    });
    repository.createWorkflowTemplate({
      id: 'new-project-template', slug: 'new-project', name: 'New Project', taskType: 'new_project',
    });
    expect(() => service.publishWorkflow({
      workflowTemplateId: 'new-project-template',
      envelope: {
        schema_id: 'project-orchestrator/workflow-version', schema_version: 1,
        data: {
          slug: 'new-project', version: 1,
          stages: [{
            key: 'implementation', role_version_id: implementation.id, optional: false,
            mandatory_gate: false, failure_policy: 'fail', max_attempts: 1, requires_confirmation: false,
          }],
          edges: [], iteration_groups: [],
        },
      },
    })).toThrow(/SAFETY_BASELINE/);
    db.close();
  });

  it.each([
    ['missing role', (roleId: string) => workflowEnvelope(`${roleId}-missing`)],
    ['cycle', (roleId: string) => workflowEnvelope(roleId, { edges: [
      { from: 'implementation', to: 'testing', edge_type: 'on_success' },
      { from: 'testing', to: 'implementation', edge_type: 'on_success' },
    ] })],
    ['missing mandatory gate', (roleId: string) => workflowEnvelope(roleId, { stages: [
      { key: 'implementation', role_version_id: roleId, optional: false, mandatory_gate: false, failure_policy: 'trigger_iteration', max_attempts: 1, iteration_group_key: 'delivery_loop', requires_confirmation: false },
      { key: 'testing', role_version_id: roleId, optional: false, mandatory_gate: false, failure_policy: 'trigger_iteration', max_attempts: 1, iteration_group_key: 'delivery_loop', requires_confirmation: false },
    ] })],
    ['too many iterations', (roleId: string) => workflowEnvelope(roleId, { iteration_groups: [
      { key: 'delivery_loop', entry_stage_key: 'implementation', gate_stage_keys: ['testing'], aggregation_policy: 'collect_all', max_iterations: 4 },
    ] })],
    ['disconnected stage', (roleId: string) => workflowEnvelope(roleId, { stages: [
      { key: 'implementation', role_version_id: roleId, optional: false, mandatory_gate: false, failure_policy: 'fail', max_attempts: 1, requires_confirmation: false },
      { key: 'testing', role_version_id: roleId, optional: false, mandatory_gate: false, failure_policy: 'fail', max_attempts: 1, requires_confirmation: false },
      { key: 'orphan', role_version_id: roleId, optional: false, mandatory_gate: false, failure_policy: 'fail', max_attempts: 1, requires_confirmation: false },
    ], edges: [{ from: 'implementation', to: 'testing', edge_type: 'requires' }], iteration_groups: [] })],
    ['unknown iteration group', (roleId: string) => workflowEnvelope(roleId, { stages: [
      { key: 'implementation', role_version_id: roleId, optional: false, mandatory_gate: false, failure_policy: 'fail', max_attempts: 1, requires_confirmation: false },
      { key: 'testing', role_version_id: roleId, optional: false, mandatory_gate: false, failure_policy: 'fail', max_attempts: 1, iteration_group_key: 'missing', requires_confirmation: false },
    ], iteration_groups: [] })],
    ['gate before iteration entry', (roleId: string) => workflowEnvelope(roleId, {
      stages: [
        { key: 'implementation', role_version_id: roleId, optional: false, mandatory_gate: false, failure_policy: 'trigger_iteration', max_attempts: 1, iteration_group_key: 'delivery_loop', requires_confirmation: false },
        { key: 'testing', role_version_id: roleId, optional: false, mandatory_gate: true, failure_policy: 'trigger_iteration', max_attempts: 1, iteration_group_key: 'delivery_loop', requires_confirmation: false },
      ],
      edges: [{ from: 'testing', to: 'implementation', edge_type: 'requires' }],
    })],
    ['undeclared iteration member', (roleId: string) => workflowEnvelope(roleId, {
      stages: [
        { key: 'implementation', role_version_id: roleId, optional: false, mandatory_gate: false, failure_policy: 'trigger_iteration', max_attempts: 1, iteration_group_key: 'delivery_loop', requires_confirmation: false },
        { key: 'review', role_version_id: roleId, optional: false, mandatory_gate: false, failure_policy: 'trigger_iteration', max_attempts: 1, iteration_group_key: 'delivery_loop', requires_confirmation: false },
        { key: 'testing', role_version_id: roleId, optional: false, mandatory_gate: true, failure_policy: 'trigger_iteration', max_attempts: 1, iteration_group_key: 'delivery_loop', requires_confirmation: false },
      ],
      edges: [
        { from: 'implementation', to: 'review', edge_type: 'requires' },
        { from: 'review', to: 'testing', edge_type: 'requires' },
      ],
    })],
  ])('rejects workflow with %s', (_name, makeEnvelope) => {
    const { db, repository, service } = fixture();
    repository.createRole({ id: 'role', slug: 'role', name: 'Role' });
    const role = service.publishRole({ roleId: 'role', envelope: roleEnvelope('role') });
    repository.createWorkflowTemplate({ id: 'workflow', slug: 'workflow', name: 'Workflow', taskType: 'feature' });
    expect(() => service.publishWorkflow({ workflowTemplateId: 'workflow', envelope: makeEnvelope(role.id) })).toThrow();
    db.close();
  });

  it('keeps current versions and v1 bytes immutable across drafts and v2 publication', () => {
    const { db, repository, content, service } = fixture();
    repository.createRole({ id: 'role', slug: 'role', name: 'Role' });
    const v1 = service.publishRole({ roleId: 'role', envelope: roleEnvelope('role', ['read-workspace']) });
    const v1Bytes = content.read(v1.contentObjectId);
    service.saveRoleDraft({ entityId: 'role', expectedRevision: 0, envelope: roleEnvelope('role', ['write-workspace']) });
    expect(repository.getRole('role')?.currentVersionId).toBe(v1.id);
    const v2 = service.publishRole({ roleId: 'role', envelope: roleEnvelope('role', ['write-workspace']) });
    expect(v2.versionNumber).toBe(2);
    expect(content.read(v1.contentObjectId)).toEqual(v1Bytes);
    expect(repository.getPublishedRole(v1.id)?.versionNumber).toBe(1);
    db.close();
  });
});
