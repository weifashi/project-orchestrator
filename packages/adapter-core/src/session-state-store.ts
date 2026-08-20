import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

type StoredState = Readonly<{
  schema_version: 1;
  recovery_credentials: Readonly<Record<string, string>>;
}>;

function currentUid(fallback: number): number {
  return typeof process.getuid === 'function' ? process.getuid() : fallback;
}

function validatePrivatePath(path: string, kind: 'directory' | 'file'): void {
  const stats = lstatSync(path);
  const expectedType = kind === 'directory' ? stats.isDirectory() : stats.isFile();
  if (!expectedType || stats.isSymbolicLink() || stats.uid !== currentUid(stats.uid) || (stats.mode & 0o077) !== 0) {
    throw new Error('SESSION_STATE_PATH_INSECURE');
  }
}

function emptyState(): StoredState {
  return { schema_version: 1, recovery_credentials: {} };
}

export function defaultSessionStatePath(home = process.env['HOME'] ?? '.'): string {
  return resolve(home, '.project-orchestrator/runtime/adapter-sessions.json');
}

export class RecoveryCredentialStore {
  readonly #path: string;

  constructor(path = defaultSessionStatePath()) {
    this.#path = resolve(path);
  }

  get(runId: string): string | undefined {
    return this.#read().recovery_credentials[runId];
  }

  set(runId: string, credential: string): void {
    if (runId.length === 0 || credential.length === 0) throw new Error('SESSION_STATE_INVALID');
    const current = this.#read();
    this.#write({
      schema_version: 1,
      recovery_credentials: { ...current.recovery_credentials, [runId]: credential },
    });
  }

  delete(runId: string): void {
    const current = this.#read();
    if (!(runId in current.recovery_credentials)) return;
    const next = { ...current.recovery_credentials };
    delete next[runId];
    this.#write({ schema_version: 1, recovery_credentials: next });
  }

  #read(): StoredState {
    let raw: string;
    try {
      validatePrivatePath(this.#path, 'file');
      raw = readFileSync(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    if (parsed.schema_version !== 1 || parsed.recovery_credentials === null
      || typeof parsed.recovery_credentials !== 'object' || Array.isArray(parsed.recovery_credentials)
      || Object.values(parsed.recovery_credentials).some((value) => typeof value !== 'string' || value.length === 0)) {
      throw new Error('SESSION_STATE_INVALID');
    }
    return { schema_version: 1, recovery_credentials: { ...parsed.recovery_credentials } };
  }

  #write(state: StoredState): void {
    const directory = dirname(this.#path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    validatePrivatePath(directory, 'directory');
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, this.#path);
    chmodSync(this.#path, 0o600);
  }

  toJSON(): Readonly<{ path: string; recovery_credentials: '[REDACTED]' }> {
    return { path: this.#path, recovery_credentials: '[REDACTED]' };
  }
}
