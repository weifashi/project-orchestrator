import { createHmac } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { IpcClient } from '../src/ipc-client.js';

async function listen(handler: (socket: Socket) => void): Promise<{ path: string; close: () => Promise<void> }> {
  const path = join(tmpdir(), `orchestrator-ipc-${crypto.randomUUID()}.sock`);
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve));
  return { path, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

function authenticatedServer(onRequest: (socket: Socket, value: Record<string, unknown>) => void): (socket: Socket) => void {
  return (socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    let buffer = '';
    let step = 0;
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const value = JSON.parse(line) as Record<string, unknown>;
        if (step === 0) {
          step += 1;
          socket.write(`${JSON.stringify({ installation_id: 'installation-1', challenge: 'challenge-1', algorithm: 'hmac-sha256' })}\n`);
        } else if (step === 1) {
          step += 1;
          expect(value).toMatchObject({
            kind: 'bind_root_session',
            challenge: 'challenge-1',
            proof: createHmac('sha256', 'adapter-secret').update('challenge-1\0root-1\0/workspace').digest('base64url'),
          });
          socket.write('{"authenticated":true}\n');
        } else {
          onRequest(socket, value);
        }
      }
    });
  };
}

describe('IPC client', () => {
  it('authenticates, correlates concurrent requests, and enforces bounded frames', async () => {
    const server = await listen(authenticatedServer((socket, value) => {
      const requestId = (value['payload'] as Record<string, unknown>)['request_id'];
      setTimeout(() => socket.write(`${JSON.stringify({ ok: true, result: { request_id: requestId } })}\n`), requestId === 'slow' ? 5 : 0);
    }));
    const client = new IpcClient({
      socketPath: server.path, credential: 'adapter-secret', rootSessionId: 'root-1',
      canonicalProjectPath: '/workspace', maxFrameBytes: 1024 * 1024,
    });

    const [first, second] = await Promise.all([
      client.request({ kind: 'tool', tool: 'create_run', payload: { request_id: 'slow' } }),
      client.request({ kind: 'tool', tool: 'create_run', payload: { request_id: 'fast' } }),
    ]);
    expect(first).toEqual({ request_id: 'slow' });
    expect(second).toEqual({ request_id: 'fast' });
    await client.close();
    await server.close();
  });

  it('times out when the local socket cannot be connected', async () => {
    const client = new IpcClient({
      socketPath: join(tmpdir(), `missing-${crypto.randomUUID()}.sock`), credential: 'adapter-secret',
      rootSessionId: 'root-1', canonicalProjectPath: '/workspace', timeoutMs: 20,
    });
    await expect(client.connect()).rejects.toThrow(/IPC_(CONNECT_FAILED|TIMEOUT)/);
  });

  it('rejects an outgoing frame larger than one MiB', async () => {
    const server = await listen(authenticatedServer((socket) => socket.write('{"ok":true,"result":{}}\n')));
    const client = new IpcClient({
      socketPath: server.path, credential: 'adapter-secret', rootSessionId: 'root-1',
      canonicalProjectPath: '/workspace', maxFrameBytes: 1024 * 1024,
    });
    await expect(client.request({ kind: 'tool', tool: 'create_run', payload: { request_id: 'large', value: 'x'.repeat(1024 * 1024) } }))
      .rejects.toThrow(/IPC_FRAME_TOO_LARGE/);
    await client.close();
    await server.close();
  });

  it('does not replay a request after disconnect makes the result unknown', async () => {
    let received = 0;
    const server = await listen(authenticatedServer((socket) => {
      received += 1;
      socket.destroy();
    }));
    const client = new IpcClient({
      socketPath: server.path, credential: 'adapter-secret', rootSessionId: 'root-1', canonicalProjectPath: '/workspace',
    });
    await expect(client.request({ kind: 'tool', tool: 'complete_stage', payload: { request_id: 'once' } }))
      .rejects.toThrow(/IPC_RESULT_UNKNOWN/);
    expect(received).toBe(1);
    await client.close();
    await server.close();
  });

  it('closes a timed-out connection so its late response cannot satisfy the next write', async () => {
    let connections = 0;
    const server = await listen((socket) => {
      connections += 1;
      const connection = connections;
      authenticatedServer((authenticatedSocket) => {
        if (connection === 1) {
          setTimeout(() => authenticatedSocket.write('{"ok":true,"result":{"request_id":"old"}}\n'), 30);
        } else {
          authenticatedSocket.write('{"ok":true,"result":{"request_id":"fresh"}}\n');
        }
      })(socket);
    });
    const client = new IpcClient({
      socketPath: server.path, credential: 'adapter-secret', rootSessionId: 'root-1',
      canonicalProjectPath: '/workspace', timeoutMs: 20,
    });
    await expect(client.request({ kind: 'tool', tool: 'complete_stage', payload: { request_id: 'old' } }))
      .rejects.toThrow(/IPC_RESULT_UNKNOWN/);
    await expect(client.request({ kind: 'tool', tool: 'complete_stage', payload: { request_id: 'fresh' } }))
      .resolves.toEqual({ request_id: 'fresh' });
    expect(connections).toBe(2);
    await client.close();
    await server.close();
  });
});
