import { chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadAdapterCredential } from '../src/credential-store.js';

describe('adapter credential store', () => {
  it('accepts only a private regular credential file and derives a stable non-secret identity', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adapter-credential-'));
    const path = join(directory, 'credential');
    writeFileSync(path, 'adapter-secret\n', { mode: 0o600 });

    const first = loadAdapterCredential(path);
    const second = loadAdapterCredential(path);

    expect(first.installationIdentity).toBe(second.installationIdentity);
    expect(first.installationIdentity).not.toContain('adapter-secret');
    expect(JSON.stringify(first)).not.toContain('adapter-secret');
    expect(first.withSecret((secret) => secret)).toBe('adapter-secret');
  });

  it('rejects group-readable credential files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adapter-credential-mode-'));
    const path = join(directory, 'credential');
    writeFileSync(path, 'adapter-secret', { mode: 0o600 });
    chmodSync(path, 0o640);

    expect(() => loadAdapterCredential(path)).toThrow(/CREDENTIAL_FILE_INSECURE/);
  });
});
