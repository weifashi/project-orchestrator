import { chmodSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { ContractValidator } from '@project-orchestrator/contracts';
import {
  AgentHandshakeSchema,
  InternalConfirmationDecisionSchema,
  InternalIpcRequestSchema,
  type AgentHandshake,
  type InternalConfirmationDecision,
  type InternalIpcRequest,
  type InternalPrincipal,
} from '@project-orchestrator/contracts/internal-ipc';
import type { CredentialAuthenticator } from './principal.js';

export type AgentDispatcher = (
  request: InternalIpcRequest,
  principal: InternalPrincipal,
) => Promise<unknown> | unknown;
export type ConfirmationDispatcher = (
  request: InternalConfirmationDecision,
  principal: InternalPrincipal,
) => Promise<unknown> | unknown;

type ListenerInput = {
  socketPath: string;
  authenticate: CredentialAuthenticator;
  maxFrameBytes?: number;
  dispatch: AgentDispatcher;
  submitConfirmation: ConfirmationDispatcher;
};

type ConnectionState = { socket: Socket; pending: () => Promise<void> };
const connectionStates = new WeakMap<Server, Set<ConnectionState>>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'invalid';
}

export function startAgentListener(input: ListenerInput): Promise<Server> {
  rmSync(input.socketPath, { force: true });
  const validator = new ContractValidator();
  const connections = new Set<ConnectionState>();
  const server = createServer((socket) => {
    let buffer = '';
    let bound: InternalPrincipal | undefined;
    let channel: AgentHandshake['channel'] | undefined;
    let processing = Promise.resolve();
    const state: ConnectionState = { socket, pending: () => processing };
    connections.add(state);
    socket.setEncoding('utf8');

    const write = (value: unknown): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
    };
    const processLine = async (line: string): Promise<void> => {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (bound === undefined) {
          const handshake = validator.check(AgentHandshakeSchema, parsed);
          const installation = input.authenticate(handshake.credential);
          bound = Object.freeze({
            installation_id: installation.installationId,
            root_session_id: installation.rootSessionId,
            session_id: installation.sessionId,
          });
          channel = handshake.channel;
          write({ authenticated: true });
          return;
        }
        if (channel === 'agent') {
          const request = validator.check(InternalIpcRequestSchema, parsed);
          write({ ok: true, result: await input.dispatch(request, bound) });
          return;
        }
        const request = validator.check(InternalConfirmationDecisionSchema, parsed);
        write({ ok: true, result: await input.submitConfirmation(request, bound) });
      } catch (error) {
        write({ ok: false, error: errorMessage(error) });
      }
    };

    socket.on('data', (chunk) => {
      buffer += chunk;
      const maxFrameBytes = input.maxFrameBytes ?? 256 * 1024;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > maxFrameBytes) {
          socket.destroy(new Error('FRAME_TOO_LARGE'));
          return;
        }
        processing = processing.then(() => processLine(line));
      }
      if (Buffer.byteLength(buffer) > maxFrameBytes) socket.destroy(new Error('FRAME_TOO_LARGE'));
    });
    socket.on('error', () => undefined);
    socket.once('close', () => connections.delete(state));
  });
  connectionStates.set(server, connections);
  return new Promise((resolve, reject) => {
    server.once('error', reject).listen(input.socketPath, () => {
      chmodSync(input.socketPath, 0o600);
      resolve(server);
    });
  });
}

export async function closeAgentListener(server: Server): Promise<void> {
  const connections = connectionStates.get(server) ?? new Set<ConnectionState>();
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  for (const { socket } of connections) socket.pause();
  await Promise.all([...connections].map(async ({ socket, pending }) => {
    await pending();
    socket.end();
  }));
  await closed;
  connectionStates.delete(server);
}
