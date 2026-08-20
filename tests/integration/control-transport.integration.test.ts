import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
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

type JsonSocket = {
  socket: Socket;
  send: (value: unknown) => void;
  read: () => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
};

async function openJsonSocket(socketPath: string): Promise<JsonSocket> {
  const socket = connect(socketPath);
  socket.setEncoding('utf8');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let buffer = '';
  const queued: Record<string, unknown>[] = [];
  const readers: Array<(value: Record<string, unknown>) => void> = [];
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const value = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      buffer = buffer.slice(newline + 1);
      const reader = readers.shift();
      if (reader === undefined) queued.push(value); else reader(value);
    }
  });
  return {
    socket,
    send: (value) => socket.write(`${JSON.stringify(value)}\n`),
    read: () => {
      const value = queued.shift();
      return value === undefined ? new Promise((resolve) => readers.push(resolve)) : Promise.resolve(value);
    },
    close: () => new Promise((resolve) => {
      if (socket.destroyed) resolve();
      else socket.end(resolve);
    }),
  };
}

async function bindRoot(
  client: JsonSocket,
  credential: string,
  sessionId: string,
  canonicalProjectPath: string,
  channel: 'agent' | 'trusted_confirmation' = 'agent',
): Promise<Record<string, unknown>> {
  client.send({ kind: 'bootstrap', credential, channel, scope: 'root', canonical_project_path: canonicalProjectPath });
  const challenge = await client.read();
  const challengeValue = String(challenge['challenge']);
  client.send({
    kind: 'bind_root_session', challenge: challengeValue, session_id: sessionId,
    proof: createHmac('sha256', credential).update(`${challengeValue}\0${sessionId}\0${canonicalProjectPath}`).digest('base64url'),
  });
  return client.read();
}

it('uses the isolated operation helper client over its private Unix socket', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operation-client-'));
  directories.push(directory);
  const socketPath = join(directory, 'operations.sock');
  const server = await startOperationServer(socketPath, DriverRegistry.forTestFixtures([{
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

it('requires a challenged installation-level root binding and rejects unbound, subagent, and competing roots', async () => {
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

  const subagent = await openJsonSocket(socketPath);
  subagent.send({ kind: 'bootstrap', credential, channel: 'agent', scope: 'subagent', canonical_project_path: directory });
  expect(await subagent.read()).toMatchObject({ ok: false, error: 'SUBAGENT_SCOPE_FORBIDDEN' });
  await subagent.close();

  const root = await openJsonSocket(socketPath);
  root.send({ kind: 'bootstrap', credential, channel: 'agent', scope: 'root', canonical_project_path: directory });
  const challenge = await root.read();
  expect(challenge).toMatchObject({ installation_id: 'installation-a', challenge: expect.any(String) });
  root.send({ kind: 'tool', tool: 'heartbeat_run', lease_epoch: 1, lease_token: 'hidden', payload: { request_id: 'unbound', run_id: 'run' } });
  expect(await root.read()).toMatchObject({ ok: false, error: 'ROOT_SESSION_NOT_BOUND' });
  const challengeValue = String(challenge['challenge']);
  root.send({ kind: 'bind_root_session', challenge: challengeValue, session_id: 'root-session-a', proof: createHmac('sha256', credential).update(`${challengeValue}\0root-session-a\0${directory}`).digest('base64url') });
  expect(await root.read()).toEqual({ authenticated: true });

  const competing = await openJsonSocket(socketPath);
  expect(await bindRoot(competing, credential, 'root-session-b', directory)).toMatchObject({
    ok: false, error: 'ROOT_SESSION_ALREADY_BOUND',
  });

  root.send({ kind: 'tool', tool: 'heartbeat_run', lease_epoch: 1, lease_token: 'hidden', payload: { request_id: 'r', run_id: 'run' } });
  expect(await root.read()).toEqual({ ok: true, result: { accepted: true } });
  expect(dispatched[0]?.principal).toMatchObject({ installation_id: 'installation-a', session_id: 'root-session-a', root_session_id: 'root-session-a', canonical_project_path: directory });

  const privateClient = await openJsonSocket(socketPath);
  expect(await bindRoot(privateClient, credential, 'root-session-a', directory, 'trusted_confirmation')).toEqual({ authenticated: true });
  privateClient.send({ kind: 'submit_confirmation', payload: { confirmation_request_id: 'c', nonce: 'n', exact_action_hash: 'a'.repeat(64), expires_at: now, decision: 'approve' } });
  expect(await privateClient.read()).toMatchObject({ ok: true });
  expect(confirmations).toHaveLength(1);

  await privateClient.close();
  await competing.close();
  await root.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
});
