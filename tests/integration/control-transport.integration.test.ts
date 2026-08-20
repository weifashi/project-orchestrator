import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ContentStore } from '@project-orchestrator/content-store';
import {
  createCredentialAuthenticator,
  OperationHelperClient,
  startAgentListener,
} from '@project-orchestrator/control-server';
import { migrate, openDatabase } from '@project-orchestrator/sqlite-store';
import { DriverRegistry, startOperationServer } from '../../packages/operation-executor/src/index.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('uses the isolated operation helper client over its private Unix socket', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operation-client-'));
  directories.push(directory);
  const socketPath = join(directory, 'operations.sock');
  const server = await startOperationServer(socketPath, new DriverRegistry([{
    actionType: 'fixture', executable: '/bin/echo', allowedParameterKeys: ['version'],
    fixedArgs: [], timeoutMs: 1_000,
  }]));
  const result = await new OperationHelperClient(socketPath).execute({
    actionType: 'fixture', targetFingerprint: 'node-a', parameters: { version: '1' },
  });
  expect(result.status).toBe('succeeded');
  expect(result.evidence).toMatchObject({ exitCode: 0 });
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function readLines(socketPath: string, lines: unknown[]): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    const responses: Record<string, unknown>[] = [];
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(lines.map((line) => `${JSON.stringify(line)}\n`).join('')));
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        responses.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
        buffer = buffer.slice(newline + 1);
        if (responses.length === lines.length) {
          socket.end();
          resolve(responses);
        }
      }
    });
    socket.on('error', reject);
  });
}

it('derives installation identity from credential, validates frames, and isolates confirmation channel', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'control-socket-'));
  directories.push(directory);
  const db = openDatabase(join(directory, 'db.sqlite'));
  migrate(db);
  const content = new ContentStore(join(directory, 'objects'), db);
  const capabilities = content.putCanonicalJson({});
  const credential = 'adapter-secret';
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO client_installations
    (id,client_type,adapter_version,capability_object_id,credential_hash,status,last_seen_at)
    VALUES('installation-a','codex','1',?,?,'active',?)`)
    .run(capabilities.id, createHash('sha256').update(credential).digest('hex'), now);

  const socketPath = join(directory, 'control.sock');
  const dispatched: Array<Record<string, unknown>> = [];
  const confirmations: Array<Record<string, unknown>> = [];
  const server = await startAgentListener({
    socketPath,
    authenticate: createCredentialAuthenticator(db),
    dispatch: (request, principal) => {
      dispatched.push({ request, principal });
      return { accepted: true };
    },
    submitConfirmation: (request, principal) => {
      confirmations.push({ request, principal });
      return { accepted: true };
    },
  });
  expect(statSync(socketPath).mode & 0o777).toBe(0o600);

  const agentResponses = await readLines(socketPath, [
    { credential, channel: 'agent' },
    { kind: 'tool', tool: 'heartbeat_run', lease_epoch: 1, lease_token: 'hidden', payload: { request_id: 'r', run_id: 'run' } },
  ]);
  expect(agentResponses).toEqual([{ authenticated: true }, { ok: true, result: { accepted: true } }]);
  expect(dispatched[0]?.principal).toMatchObject({ installation_id: 'installation-a', session_id: 'installation-a:root' });

  const invalidResponses = await readLines(socketPath, [
    { credential, channel: 'agent', installation_id: 'spoofed', root_session_id: 'spoofed' },
  ]);
  expect(invalidResponses[0]?.error).toMatch(/SCHEMA_INVALID/);

  const privateResponses = await readLines(socketPath, [
    { credential, channel: 'trusted_confirmation' },
    { kind: 'submit_confirmation', payload: { confirmation_request_id: 'c', nonce: 'n', exact_action_hash: 'h', expires_at: now, decision: 'approve' } },
  ]);
  expect(privateResponses[1]).toMatchObject({ ok: true });
  expect(confirmations).toHaveLength(1);

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
});
