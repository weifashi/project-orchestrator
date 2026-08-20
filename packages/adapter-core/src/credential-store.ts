import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export class AdapterCredential {
  readonly installationIdentity: string;
  readonly #secret: string;

  constructor(secret: string) {
    this.#secret = secret;
    this.installationIdentity = `local-${createHash('sha256')
      .update('project-orchestrator-adapter\0').update(secret).digest('hex').slice(0, 32)}`;
    Object.freeze(this);
  }

  withSecret<T>(use: (secret: string) => T): T {
    return use(this.#secret);
  }

  toJSON(): Readonly<{ installationIdentity: string; credential: '[REDACTED]' }> {
    return Object.freeze({ installationIdentity: this.installationIdentity, credential: '[REDACTED]' });
  }

  [inspect.custom](): string {
    return `AdapterCredential(${this.installationIdentity}, [REDACTED])`;
  }
}

export function defaultCredentialPath(home = process.env['HOME'] ?? '.'): string {
  return resolve(home, '.project-orchestrator/runtime/adapter-credential');
}

export function loadAdapterCredential(path = defaultCredentialPath()): AdapterCredential {
  const stats = lstatSync(path);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stats.uid;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== currentUid || (stats.mode & 0o077) !== 0) {
    throw new Error('CREDENTIAL_FILE_INSECURE');
  }
  const secret = readFileSync(path, 'utf8').trim();
  if (secret.length === 0) throw new Error('CREDENTIAL_FILE_EMPTY');
  return new AdapterCredential(secret);
}
