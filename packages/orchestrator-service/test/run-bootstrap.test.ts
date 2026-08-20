import { rmSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { ConfigService, LeaseService, RunService, seedBuiltins } from '../src/index.js';
import { SqliteConfigRepository } from '@project-orchestrator/sqlite-store';
import { principal, runtimeFixture, workspace } from './runtime-fixture.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

it('creates a first Run by registering the authenticated project and resolving a published workflow slug', () => {
  const fixture = runtimeFixture();
  directories.push(fixture.dir);
  fixture.db.prepare("DELETE FROM projects WHERE id='project'").run();
  const config = new ConfigService(new SqliteConfigRepository(fixture.db), fixture.content);
  seedBuiltins(config, new SqliteConfigRepository(fixture.db));
  fixture.db.pragma('user_version = 1');
  const service = new RunService(fixture.db, fixture.content, new LeaseService(fixture.db, 1));

  const result = service.createRun({
    requestId: 'request-1', workflowSlug: 'new-project', objective: 'First Run', runInput: {},
    principal: { ...principal, canonicalProjectPath: fixture.dir }, workspace,
  });

  expect(fixture.db.prepare('SELECT canonical_path,display_name FROM projects').all())
    .toEqual([{ canonical_path: fixture.dir, display_name: fixture.dir.split('/').at(-1) }]);
  expect(fixture.db.prepare('SELECT status FROM runs WHERE id=?').get(result.runId)).toEqual({ status: 'created' });
  expect(fixture.db.prepare(`SELECT wt.slug FROM runs r
    JOIN workflow_versions wv ON wv.id=r.workflow_version_id
    JOIN workflow_templates wt ON wt.id=wv.workflow_template_id WHERE r.id=?`).get(result.runId))
    .toEqual({ slug: 'new-project' });
  fixture.db.close();
});
