import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteConfigRepository, migrate, openDatabase } from '../src/index.js';

const directories: string[] = [];
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe('configuration repository', () => {
  it('uses optimistic revisions for drafts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestrator-repo-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'store.sqlite'));
    migrate(db);
    const repository = new SqliteConfigRepository(db);
    repository.createWorkflowTemplate({ id: 'workflow', slug: 'workflow', name: 'Workflow', taskType: 'feature' });
    expect(repository.saveWorkflowDraft('workflow', 0, { one: 1 })).toBe(1);
    expect(repository.saveWorkflowDraft('workflow', 1, { two: 2 })).toBe(2);
    expect(() => repository.saveWorkflowDraft('workflow', 1, { stale: true })).toThrow('REVISION_CONFLICT');
    db.close();
  });

  it('returns immutable published version records', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestrator-repo-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'store.sqlite'));
    migrate(db);
    const repository = new SqliteConfigRepository(db);
    repository.createRole({ id: 'role', slug: 'role', name: 'Role' });
    const now = new Date().toISOString();
    db.prepare('INSERT INTO content_objects(id,sha256,media_type,size_bytes,storage_key,created_at) VALUES(?,?,?,?,?,?)')
      .run('object', HASH, 'application/json', 2, 'ha/hash', now);
    repository.publishRole({
      id: 'role-v1', roleId: 'role', versionNumber: 1, contentObjectId: 'object', skillHash: HASH,
      inputSchemaEnvelope: {}, outputSchemaEnvelope: {}, requestedCapabilities: ['read'],
      effectiveCapabilities: ['read'], forbiddenCapabilities: [], completionContractEnvelope: {},
    });
    const record = repository.getPublishedRole('role-v1');
    expect(record).toMatchObject({ id: 'role-v1', versionNumber: 1, effectiveCapabilities: ['read'] });
    expect(Object.isFrozen(record)).toBe(true);
    expect(() => repository.publishRole({
      id: 'replacement', roleId: 'role', versionNumber: 1, contentObjectId: 'object', skillHash: OTHER_HASH,
      inputSchemaEnvelope: {}, outputSchemaEnvelope: {}, requestedCapabilities: [], effectiveCapabilities: [],
      forbiddenCapabilities: [], completionContractEnvelope: {},
    })).toThrow(/UNIQUE/);
    expect(() => db.prepare('UPDATE role_versions SET skill_hash=? WHERE id=?').run(OTHER_HASH, 'role-v1'))
      .toThrow(/IMMUTABLE_VERSION/);
    repository.publishRole({
      id: 'role-v2', roleId: 'role', versionNumber: 2, contentObjectId: 'object', skillHash: HASH,
      inputSchemaEnvelope: {}, outputSchemaEnvelope: {}, requestedCapabilities: ['read'],
      effectiveCapabilities: ['read'], forbiddenCapabilities: [], completionContractEnvelope: {},
    });
    expect(() => db.prepare('DELETE FROM role_versions WHERE id=?').run('role-v1')).toThrow(/IMMUTABLE_VERSION/);
    expect(repository.getRole('role')?.currentVersionId).toBe('role-v2');
    expect(repository.getPublishedRole('role-v1')).toEqual(record);
    db.close();
  });
});
