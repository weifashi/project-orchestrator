import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
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

  it('deduplicates simultaneous writes from independent processes and database connections', async () => {
    const { db, root, store } = fixture();
    const databasePath = (db.prepare('PRAGMA database_list').get() as { file: string }).file;
    const directory = dirname(root);
    const readyPaths = [join(directory, 'writer-1.ready'), join(directory, 'writer-2.ready')];
    const goPath = join(directory, 'writers.go');
    const workerPath = new URL('./content-writer.mjs', import.meta.url).pathname;
    type WriterResult = { output: string; error?: never } | { output?: never; error: Error };
    const states: Array<{ error?: Error }> = [];
    const children: Array<ReturnType<typeof spawn>> = [];
    const runWriter = (readyPath: string): Promise<WriterResult> => new Promise((resolve) => {
      const state: { error?: Error } = {};
      states.push(state);
      const child = spawn(process.execPath, [workerPath, databasePath, root, readyPath, goPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: WriterResult): void => {
        if (settled) return;
        settled = true;
        if (result.error !== undefined) state.error = result.error;
        resolve(result);
      };
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', (error) => { finish({ error }); });
      child.on('close', (code) => {
        if (code === 0) finish({ output: stdout.trim() });
        else finish({ error: new Error(`writer exited ${String(code)}: ${stderr}`) });
      });
    });
    const writers = readyPaths.map((readyPath) => runWriter(readyPath));
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 10_000;
        const waitForReady = (): void => {
          const failure = states.find((state) => state.error !== undefined)?.error;
          if (failure !== undefined) {
            reject(failure);
          } else if (readyPaths.every((path) => existsSync(path))) {
            resolve();
          } else if (Date.now() >= deadline) {
            reject(new Error('writers did not become ready'));
          } else {
            setTimeout(waitForReady, 10);
          }
        };
        waitForReady();
      });
    } catch (error) {
      for (const child of children) child.kill();
      throw error;
    }
    writeFileSync(goPath, 'go');
    const results = await Promise.all(writers);
    const failure = results.find((result) => result.error !== undefined)?.error;
    if (failure !== undefined) throw failure;
    const objectIds = results.map((result) => result.output as string);
    expect(new Set(objectIds).size).toBe(1);
    expect(db.prepare('SELECT count(*) AS count FROM content_objects').get()).toEqual({ count: 1 });
    const objectId = objectIds[0] as string;
    store.verify(objectId);
    const object = db.prepare('SELECT storage_key FROM content_objects WHERE id=?').get(objectId) as { storage_key: string };
    expect(readdirSync(dirname(join(root, object.storage_key))).filter((name) => name.includes('.tmp-'))).toEqual([]);
    db.close();
  }, 20_000);

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
