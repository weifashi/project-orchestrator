import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  buildWebListener,
  createCredentialAuthenticator,
  initializeLocalState,
  inspectLocalState,
} from '@project-orchestrator/control-server';
import { ContentStore } from '@project-orchestrator/content-store';
import { openDatabase } from '@project-orchestrator/sqlite-store';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

it('initializes built-ins and distinct active Codex and Claude installations idempotently', () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'distribution-init-'));
  directories.push(dataDirectory);
  chmodSync(dataDirectory, 0o700);
  const credentialFiles = {
    codex: join(dataDirectory, 'codex-credential'),
    claude: join(dataDirectory, 'claude-credential'),
  };
  writeFileSync(credentialFiles.codex, 'codex-secret\n', { mode: 0o600 });
  writeFileSync(credentialFiles.claude, 'claude-secret\n', { mode: 0o600 });
  const input = {
    databasePath: join(dataDirectory, 'orchestrator.sqlite'),
    objectsPath: join(dataDirectory, 'objects'),
    credentialFiles,
  };

  initializeLocalState(input);
  initializeLocalState(input);

  const db = openDatabase(input.databasePath);
  expect(db.prepare('SELECT slug FROM workflow_templates ORDER BY slug').all()).toEqual([
    { slug: 'bug-fix' }, { slug: 'feature-development' }, { slug: 'new-project' },
  ]);
  expect(db.prepare('SELECT id,client_type,status FROM client_installations ORDER BY client_type').all()).toEqual([
    { id: 'local-claude', client_type: 'claude', status: 'active' },
    { id: 'local-codex', client_type: 'codex', status: 'active' },
  ]);
  const authenticate = createCredentialAuthenticator(db);
  expect(authenticate('codex-secret')).toMatchObject({ installationId: 'local-codex', clientType: 'codex' });
  expect(authenticate('claude-secret')).toMatchObject({ installationId: 'local-claude', clientType: 'claude' });
  expect(() => authenticate('wrong')).toThrow('UNAUTHENTICATED');
  db.close();

  expect(inspectLocalState(input)).toMatchObject({ ok: true, code: 'HEALTHY', activeInstallations: 2 });
  expect(statSync(credentialFiles.codex).mode & 0o077).toBe(0);
  expect(readFileSync(credentialFiles.codex, 'utf8')).not.toContain('claude-secret');

  writeFileSync(credentialFiles.codex, 'rotated-without-reinitializing\n');
  expect(inspectLocalState(input)).toMatchObject({
    ok: false,
    code: 'UNHEALTHY',
    databaseIntegrity: true,
    contentIntegrity: true,
    activeInstallations: 2,
  });
});

it('serves health through the configured Coder host while the app remains loopback-oriented', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'distribution-health-'));
  directories.push(directory);
  const db = openDatabase(join(directory, 'db.sqlite'));
  const content = new ContentStore(join(directory, 'objects'), db);
  const origin = 'https://3847--main--wfs--weifashi.coder.example';
  const app = buildWebListener({
    db, content, sessionSecret: 'csrf', allowedOrigins: [origin],
    allowedHosts: ['127.0.0.1', 'localhost', '3847--main--wfs--weifashi.coder.example'],
    healthIdentity: { version: '0.1.37', databaseId: 'db-identity', operationsReady: async () => true },
  });
  const health = await app.inject({
    method: 'GET', url: '/health', headers: { host: '3847--main--wfs--weifashi.coder.example' },
  });
  expect(health.statusCode).toBe(200);
  expect(health.json()).toEqual({ ok: true, version: '0.1.37', database_id: 'db-identity', operations_ready: true });
  expect(health.body).not.toContain(directory);
  const rejected = await app.inject({ method: 'GET', url: '/health', headers: { host: 'evil.example' }, remoteAddress: '203.0.113.42' });
  expect(rejected.statusCode).toBe(403);
  await app.close();
  db.close();
});
