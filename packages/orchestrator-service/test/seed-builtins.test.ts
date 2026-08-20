import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentStore } from '@project-orchestrator/content-store';
import { SqliteConfigRepository, migrate, openDatabase } from '@project-orchestrator/sqlite-store';
import { BUILTIN_ROLE_SLUGS, ConfigService, seedBuiltins } from '../src/index.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe('built-in configuration', () => {
  it('seeds ten roles and three exact templates idempotently', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestrator-seed-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'store.sqlite'));
    migrate(db);
    const repository = new SqliteConfigRepository(db);
    const content = new ContentStore(join(directory, 'objects'), db);
    const service = new ConfigService(repository, content);
    seedBuiltins(service, repository);
    seedBuiltins(service, repository);

    expect(repository.listRoles().map((role) => role.slug).sort()).toEqual([...BUILTIN_ROLE_SLUGS].sort());
    expect(repository.listWorkflowTemplates().map((template) => template.slug).sort())
      .toEqual(['bug-fix', 'feature-development', 'new-project']);
    const templates = service.listPublishedTemplates();
    expect(templates).toHaveLength(3);
    const readTemplate = (slug: string) => JSON.parse(Buffer.from(content.read(
      templates.find((template) => template.slug === slug)!.contentObjectId,
    )).toString('utf8')) as { data: { stages: Array<Record<string, unknown>>; iteration_groups: Array<Record<string, unknown>> } };
    const newProject = readTemplate('new-project');
    expect(newProject.data.iteration_groups).toContainEqual({
      key: 'delivery_loop', entry_stage_key: 'implementation',
      gate_stage_keys: ['code-review', 'testing', 'security'], aggregation_policy: 'collect_all', max_iterations: 3,
    });

    const condition = (paths: string[]) => ({
      op: 'any', items: paths.map((path) => ({ op: 'eq', path, value: true })),
    });
    const expectedConditions: Record<string, Record<string, unknown>> = {
      'feature-development:architecture': condition(['run_input.changes.api', 'run_input.changes.schema', 'run_input.changes.module_boundary']),
      'feature-development:ui-design': condition(['run_input.user_visible_change']),
      'feature-development:security': condition(['run_input.changes.permissions', 'run_input.changes.secrets', 'run_input.changes.external_input', 'run_input.changes.dependencies']),
      'feature-development:operations': condition(['run_input.changes.runtime', 'run_input.changes.migration', 'run_input.changes.release_artifact']),
      'bug-fix:architecture': condition(['run_input.root_cause_changes_module_boundary']),
      'bug-fix:ui-design': condition(['run_input.user_visible_behavior_change']),
      'bug-fix:security': condition(['run_input.security_sensitive']),
      'bug-fix:operations': condition(['run_input.requires_release', 'run_input.requires_migration']),
    };
    for (const slug of ['feature-development', 'bug-fix']) {
      const workflow = JSON.parse(Buffer.from(content.read(
        templates.find((template) => template.slug === slug)!.contentObjectId,
      )).toString('utf8')) as { data: { stages: Array<{ key: string; condition?: Record<string, unknown> }> } };
      for (const stage of workflow.data.stages.filter((candidate) => candidate.condition !== undefined)) {
        expect(stage.condition).toEqual(expectedConditions[`${slug}:${stage.key}`]);
      }
    }

    const template = repository.listWorkflowTemplates().find((candidate) => candidate.slug === 'new-project')!;
    const implementationRole = repository.listRoles().find((candidate) => candidate.slug === 'implementation')!;
    expect(() => service.publishWorkflow({
      workflowTemplateId: template.id,
      envelope: {
        schema_id: 'project-orchestrator/workflow-version', schema_version: 1,
        data: {
          slug: 'new-project', version: 2,
          stages: [{
            key: 'implementation', role_version_id: implementationRole.currentVersionId,
            optional: false, mandatory_gate: false, failure_policy: 'fail', max_attempts: 1,
            requires_confirmation: false,
          }],
          edges: [], iteration_groups: [],
        },
      },
    })).toThrow(/SAFETY_BASELINE/);
    db.close();
  });
});
