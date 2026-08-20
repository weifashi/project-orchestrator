import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RecoveryCredentialStore } from '../src/session-state-store.js';
import { SessionGuard } from '../src/session-guard.js';

describe('private adapter session state', () => {
  it('persists hidden recovery credentials across MCP process guards with mode 0600', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adapter-state-'));
    const path = join(directory, 'sessions.json');
    const first = new SessionGuard({ sessionId: 'root-1', recoveryStore: new RecoveryCredentialStore(path) });
    first.rememberRecoveryCredential('run-1', 'recovery-secret');

    const secondStore = new RecoveryCredentialStore(path);
    const second = new SessionGuard({ sessionId: 'root-2', recoveryStore: secondStore });

    expect(second.recoveryCredential('run-1')).toBe('recovery-secret');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(secondStore)).not.toContain('recovery-secret');
  });

  it('deletes terminal Run recovery material from persistent state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adapter-state-delete-'));
    const path = join(directory, 'sessions.json');
    const store = new RecoveryCredentialStore(path);
    const guard = new SessionGuard({ sessionId: 'root-1', recoveryStore: store });
    guard.rememberRecoveryCredential('run-1', 'recovery-secret');
    guard.forgetRun('run-1');
    expect(new RecoveryCredentialStore(path).get('run-1')).toBeUndefined();
  });
});
