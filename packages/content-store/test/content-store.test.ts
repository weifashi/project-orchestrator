import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

  it('deduplicates identical writes and restores read-only mode on an existing object', () => {
    const { db, root, store } = fixture();
    const first = store.putUtf8('same');
    chmodSync(join(root, first.storageKey), 0o664);
    const second = store.putUtf8('same');
    expect(second).toEqual(first);
    expect(db.prepare('SELECT count(*) AS count FROM content_objects').get()).toEqual({ count: 1 });
    expect(readdirSync(dirname(join(root, first.storageKey))).filter((name) => name.includes('.tmp-'))).toEqual([]);
    expect(lstatSync(join(root, first.storageKey)).mode & 0o777).toBe(0o444);
    db.close();
  });

  it('converges on a pre-existing atomic target and cleans temporary files', () => {
    const { db, root, store } = fixture();
    const bytes = Buffer.from('pre-existing');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const directory = join(root, hash.slice(0, 2));
    mkdirSync(directory);
    writeFileSync(join(directory, hash), bytes, { mode: 0o664 });
    const object = store.putBytes(bytes, 'text/plain');
    expect(object.sha256).toBe(hash);
    expect(lstatSync(join(root, object.storageKey)).mode & 0o777).toBe(0o444);
    expect(readdirSync(directory).filter((name) => name.includes('.tmp-'))).toEqual([]);
    db.close();
  });

  it('rejects an intermediate symlink before writing outside the objects root', () => {
    const { db, root, store } = fixture();
    const bytes = Buffer.from('symlink-attempt');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const external = join(dirname(root), 'external-directory');
    mkdirSync(external);
    symlinkSync(external, join(root, hash.slice(0, 2)));
    expect(() => store.putBytes(bytes, 'text/plain')).toThrow(/SYMLINK/);
    expect(readdirSync(external)).toEqual([]);
    db.close();
  });

  it('cleans a temp file when an existing atomic target is invalid', () => {
    const { db, root, store } = fixture();
    const bytes = Buffer.from('invalid-target');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const directory = join(root, hash.slice(0, 2));
    mkdirSync(join(directory, hash), { recursive: true });
    expect(() => store.putBytes(bytes, 'text/plain')).toThrow(/CONTENT_NOT_REGULAR_FILE/);
    expect(readdirSync(directory).filter((name) => name.includes('.tmp-'))).toEqual([]);
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
