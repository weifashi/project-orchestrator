import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';

export type ContentObject = Readonly<{
  id: string;
  sha256: string;
  mediaType: string;
  sizeBytes: number;
  storageKey: string;
}>;

type ContentRow = {
  id: string;
  sha256: string;
  media_type: string;
  size_bytes: number;
  storage_key: string;
};

function normalizeJson(value: unknown, path = '$'): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Canonical JSON requires finite numbers at ${path}`);
    return value;
  }
  if (value === undefined) throw new TypeError(`Canonical JSON rejects undefined at ${path}`);
  if (Array.isArray(value)) return value.map((item, index) => normalizeJson(item, `${path}[${index}]`));
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      normalized[key] = normalizeJson((value as Record<string, unknown>)[key], `${path}.${key}`);
    }
    return normalized;
  }
  throw new TypeError(`Canonical JSON rejects ${typeof value} at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function mapContent(row: ContentRow): ContentObject {
  return Object.freeze({
    id: row.id,
    sha256: row.sha256,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    storageKey: row.storage_key,
  });
}

export class ContentStore {
  readonly #root: string;

  constructor(objectsRoot: string, readonly db: Database.Database) {
    const absoluteRoot = resolve(objectsRoot);
    mkdirSync(absoluteRoot, { recursive: true, mode: 0o700 });
    const rootStats = lstatSync(absoluteRoot);
    if (rootStats.isSymbolicLink()) throw new Error('SYMLINK_CONTENT_REJECTED: objects root');
    if (!rootStats.isDirectory()) throw new Error('CONTENT_ROOT_NOT_DIRECTORY');
    this.#root = realpathSync(absoluteRoot);
  }

  putBytes(bytes: Uint8Array, mediaType: string): ContentObject {
    const data = Buffer.from(bytes);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const existing = this.findByHash(sha256);
    if (existing !== undefined) {
      this.readVerifiedObject(existing, true);
      return existing;
    }

    const storageKey = `${sha256.slice(0, 2)}/${sha256}`;
    const finalPath = this.safePath(storageKey);
    const directory = dirname(finalPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.assertDirectoryChain(directory);
    const temporaryPath = `${finalPath}.tmp-${randomUUID()}`;
    let temporaryExists = false;
    try {
      const descriptor = openSync(temporaryPath, 'wx', 0o600);
      temporaryExists = true;
      try {
        writeFileSync(descriptor, data);
        fsyncSync(descriptor);
        fchmodSync(descriptor, 0o444);
      } finally {
        closeSync(descriptor);
      }

      if (existsSync(finalPath)) {
        rmSync(temporaryPath);
        temporaryExists = false;
        this.readVerifiedPath(finalPath, sha256, data.byteLength, true);
      } else {
        renameSync(temporaryPath, finalPath);
        temporaryExists = false;
        const directoryDescriptor = openSync(directory, 'r');
        try {
          fsyncSync(directoryDescriptor);
        } finally {
          closeSync(directoryDescriptor);
        }
      }

      return this.db.transaction(() => {
        const id = randomUUID();
        this.db.prepare(`INSERT OR IGNORE INTO content_objects
          (id,sha256,media_type,size_bytes,storage_key,created_at) VALUES(?,?,?,?,?,?)`)
          .run(id, sha256, mediaType, data.byteLength, storageKey, new Date().toISOString());
        const stored = this.findByHash(sha256);
        if (stored === undefined) throw new Error('CONTENT_INDEX_FAILED');
        return stored;
      }).immediate();
    } finally {
      if (temporaryExists) rmSync(temporaryPath, { force: true });
    }
  }

  putCanonicalJson(value: unknown): ContentObject {
    return this.putUtf8(canonicalJson(value), 'application/json');
  }

  putUtf8(text: string, mediaType = 'text/plain; charset=utf-8'): ContentObject {
    return this.putBytes(Buffer.from(text, 'utf8'), mediaType);
  }

  read(objectId: string): Uint8Array {
    const object = this.get(objectId);
    return new Uint8Array(this.readVerifiedObject(object, false));
  }

  verify(objectId: string): void {
    const object = this.get(objectId);
    this.readVerifiedObject(object, false);
  }

  private readVerifiedObject(object: ContentObject, enforceReadOnly: boolean): Buffer {
    const path = this.safePath(object.storageKey);
    this.assertDirectoryChain(dirname(path));
    return this.readVerifiedPath(path, object.sha256, object.sizeBytes, enforceReadOnly);
  }

  private readVerifiedPath(path: string, expectedHash: string, expectedSize: number, enforceReadOnly: boolean): Buffer {
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('SYMLINK_CONTENT_REJECTED');
      throw error;
    }
    try {
      const stats = fstatSync(descriptor);
      if (!stats.isFile()) throw new Error('CONTENT_NOT_REGULAR_FILE');
      const bytes = readFileSync(descriptor);
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== expectedHash) throw new Error('CONTENT_HASH_MISMATCH');
      if (stats.size !== expectedSize || bytes.byteLength !== expectedSize) throw new Error('CONTENT_SIZE_MISMATCH');
      if (enforceReadOnly) fchmodSync(descriptor, 0o444);
      return bytes;
    } finally {
      closeSync(descriptor);
    }
  }

  private get(objectId: string): ContentObject {
    const row = this.db.prepare(`SELECT id,sha256,media_type,size_bytes,storage_key
      FROM content_objects WHERE id=?`).get(objectId) as ContentRow | undefined;
    if (row === undefined) throw new Error(`NOT_FOUND: content object ${objectId}`);
    return mapContent(row);
  }

  private findByHash(hash: string): ContentObject | undefined {
    const row = this.db.prepare(`SELECT id,sha256,media_type,size_bytes,storage_key
      FROM content_objects WHERE sha256=?`).get(hash) as ContentRow | undefined;
    return row === undefined ? undefined : mapContent(row);
  }

  private safePath(storageKey: string): string {
    if (isAbsolute(storageKey)) throw new Error('UNSAFE_STORAGE_KEY: absolute path');
    const candidate = resolve(this.#root, storageKey);
    if (candidate !== this.#root && !candidate.startsWith(`${this.#root}${sep}`)) {
      throw new Error('UNSAFE_STORAGE_KEY: path escapes objects root');
    }
    return candidate;
  }

  private assertDirectoryChain(directory: string): void {
    const relativeDirectory = relative(this.#root, directory);
    if (relativeDirectory.startsWith('..') || isAbsolute(relativeDirectory)) {
      throw new Error('UNSAFE_STORAGE_KEY: directory escapes objects root');
    }
    let current = this.#root;
    for (const component of relativeDirectory.split(sep).filter(Boolean)) {
      current = resolve(current, component);
      const stats = lstatSync(current);
      if (stats.isSymbolicLink()) throw new Error('SYMLINK_CONTENT_REJECTED: directory chain');
      if (!stats.isDirectory()) throw new Error('CONTENT_DIRECTORY_NOT_DIRECTORY');
      if (realpathSync(current) !== current) throw new Error('SYMLINK_CONTENT_REJECTED: real path mismatch');
    }
  }

}
