import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '@project-orchestrator/sqlite-store';
import { ContentStore, canonicalJson } from '../src/index.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orchestrator-cas-'));
  directories.push(directory);
  const db = openDatabase(join(directory, 'store.sqlite'));
  migrate(db);
  const root = join(directory, 'objects');
  return { db, root, store: new ContentStore(root, db) };
}

describe('content store', () => {
  it('canonicalizes objects recursively while preserving array order', () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: true })).toBe('{"a":true,"z":[{"a":1,"b":2}]}');
    expect(() => canonicalJson({ missing: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ infinite: Number.POSITIVE_INFINITY })).toThrow(/finite/);
  });

  it('deduplicates identical and concurrent writes and leaves no temp files', async () => {
    const { db, root, store } = fixture();
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => store.putUtf8('same')),
      Promise.resolve().then(() => store.putUtf8('same')),
    ]);
    expect(second).toEqual(first);
    expect(db.prepare('SELECT count(*) AS count FROM content_objects').get()).toEqual({ count: 1 });
    expect(readdirSync(dirname(join(root, first.storageKey))).filter((name) => name.includes('.tmp-'))).toEqual([]);
    expect(lstatSync(join(root, first.storageKey)).mode & 0o777).toBe(0o444);
    db.close();
  });

  it('detects tampering and refuses symlinks or storage paths outside the root', () => {
    const { db, root, store } = fixture();
    const object = store.putUtf8('trusted');
    const path = join(root, object.storageKey);
    chmodSync(path, 0o644);
    writeFileSync(path, 'tampered');
    expect(() => store.verify(object.id)).toThrow(/CONTENT_HASH_MISMATCH/);
    unlinkSync(path);
    const external = join(dirname(root), 'external');
    writeFileSync(external, 'trusted');
    symlinkSync(external, path);
    expect(() => store.read(object.id)).toThrow(/SYMLINK/);
    db.prepare('UPDATE content_objects SET storage_key=? WHERE id=?').run('../external', object.id);
    expect(() => store.read(object.id)).toThrow(/UNSAFE_STORAGE_KEY/);
    expect(readFileSync(external, 'utf8')).toBe('trusted');
    db.close();
  });
});
