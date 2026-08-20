import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/index.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe('foundation migration', () => {
  it('is repeatable and configures defensive pragmas', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestrator-db-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'store.sqlite'));
    migrate(db);
    migrate(db);

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({ count: 1 });
    db.close();
  });

  it('enforces uniqueness, ownership, and restricted deletion', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestrator-db-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'store.sqlite'));
    migrate(db);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO content_objects(id,sha256,media_type,size_bytes,storage_key,created_at) VALUES(?,?,?,?,?,?)')
      .run('object-1', 'same', 'text/plain', 1, 'aa/same', now);
    expect(() => db.prepare('INSERT INTO content_objects(id,sha256,media_type,size_bytes,storage_key,created_at) VALUES(?,?,?,?,?,?)')
      .run('object-2', 'same', 'text/plain', 1, 'bb/same', now)).toThrow(/UNIQUE/);

    for (const id of ['workflow-1', 'workflow-2']) {
      db.prepare("INSERT INTO workflow_templates(id,slug,name,task_type,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .run(id, id, id, 'feature', 'active', now, now);
    }
    db.prepare('INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('version-1', 'workflow-1', 1, '', 1, 'object-1', 'same', now);
    expect(() => db.prepare('UPDATE workflow_templates SET current_version_id=? WHERE id=?').run('version-1', 'workflow-2'))
      .toThrow(/CURRENT_VERSION_OWNERSHIP/);
    expect(() => db.prepare('DELETE FROM content_objects WHERE id=?').run('object-1')).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare('INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('version-2', 'workflow-1', 1, '', 1, 'object-1', 'same', now)).toThrow(/UNIQUE/);
    db.close();
  });
});
