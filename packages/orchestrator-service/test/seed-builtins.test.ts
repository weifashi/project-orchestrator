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
    const service = new ConfigService(repository, new ContentStore(join(directory, 'objects'), db));
    seedBuiltins(service, repository);
    seedBuiltins(service, repository);

    expect(repository.listRoles().map((role) => role.slug).sort()).toEqual([...BUILTIN_ROLE_SLUGS].sort());
    expect(repository.listWorkflowTemplates().map((template) => template.slug).sort())
      .toEqual(['bug-fix', 'feature-development', 'new-project']);
    const templates = service.listPublishedTemplates();
    expect(templates).toHaveLength(3);
    const newProject = JSON.parse(Buffer.from(service.readPublishedContent(
      templates.find((template) => template.slug === 'new-project')!.contentObjectId,
    )).toString('utf8')) as { data: { iteration_groups: Array<Record<string, unknown>> } };
    expect(newProject.data.iteration_groups).toContainEqual({
      key: 'delivery_loop', entry_stage_key: 'implementation',
      gate_stage_keys: ['code-review', 'testing', 'security'], aggregation_policy: 'collect_all', max_iterations: 3,
    });
    db.close();
  });
});
