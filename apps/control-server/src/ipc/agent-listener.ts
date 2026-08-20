import { chmodSync, rmSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { ContractValidator } from '@project-orchestrator/contracts';
import {
  AgentBootstrapSchema,
  AgentSessionBindingSchema,
  InternalConfirmationDecisionSchema,
  InternalIpcRequestSchema,
  type AgentBootstrap,
  type InternalConfirmationDecision,
  type InternalIpcRequest,
  type InternalPrincipal,
} from '@project-orchestrator/contracts/internal-ipc';
import { secureEqual, type AuthenticatedInstallation, type CredentialAuthenticator } from './principal.js';

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
type PendingBinding = {
  installation: AuthenticatedInstallation;
  channel: AgentBootstrap['channel'];
  challenge: string;
  credential: string;
  canonicalProjectPath: string;
};
type RootBinding = { sessionId: string; connectionCount: number };
const connectionStates = new WeakMap<Server, Set<ConnectionState>>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'invalid';
}

export function startAgentListener(input: ListenerInput): Promise<Server> {
  rmSync(input.socketPath, { force: true });
  const validator = new ContractValidator();
  const connections = new Set<ConnectionState>();
  const installationRoots = new Map<string, RootBinding>();
  const server = createServer((socket) => {
    let buffer = '';
    let bound: InternalPrincipal | undefined;
    let channel: AgentBootstrap['channel'] | undefined;
    let awaitingBinding: PendingBinding | undefined;
    let boundInstallationId: string | undefined;
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
          if (awaitingBinding === undefined) {
            const bootstrap = validator.check(AgentBootstrapSchema, parsed);
            if (bootstrap.scope !== 'root') throw new Error('SUBAGENT_SCOPE_FORBIDDEN');
            const installation = input.authenticate(bootstrap.credential);
            const challenge = randomBytes(32).toString('base64url');
            awaitingBinding = {
              installation, channel: bootstrap.channel, challenge, credential: bootstrap.credential,
              canonicalProjectPath: bootstrap.canonical_project_path,
            };
            write({ installation_id: installation.installationId, challenge, algorithm: 'hmac-sha256' });
            return;
          }
          if ((parsed as { kind?: unknown } | null)?.kind !== 'bind_root_session') {
            throw new Error('ROOT_SESSION_NOT_BOUND');
          }
          const binding = validator.check(AgentSessionBindingSchema, parsed);
          const pending = awaitingBinding;
          if (!secureEqual(binding.challenge, pending.challenge)) throw new Error('ROOT_SESSION_PROOF_INVALID');
          const expectedProof = createHmac('sha256', pending.credential)
            .update(`${pending.challenge}\0${binding.session_id}\0${pending.canonicalProjectPath}`).digest('base64url');
          if (!secureEqual(binding.proof, expectedProof)) throw new Error('ROOT_SESSION_PROOF_INVALID');
          const existing = installationRoots.get(pending.installation.installationId);
          if (existing !== undefined && existing.sessionId !== binding.session_id) {
            throw new Error('ROOT_SESSION_ALREADY_BOUND');
          }
          if (existing === undefined) {
            installationRoots.set(pending.installation.installationId, { sessionId: binding.session_id, connectionCount: 1 });
          } else {
            existing.connectionCount += 1;
          }
          bound = Object.freeze({
            installation_id: pending.installation.installationId,
            root_session_id: binding.session_id,
            session_id: binding.session_id,
            canonical_project_path: pending.canonicalProjectPath,
          });
          channel = pending.channel;
          boundInstallationId = pending.installation.installationId;
          awaitingBinding = undefined;
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
    socket.once('close', () => {
      connections.delete(state);
      const installationId = boundInstallationId;
      if (installationId === undefined) return;
      void processing.finally(() => {
        const root = installationRoots.get(installationId);
        if (root === undefined) return;
        root.connectionCount -= 1;
        if (root.connectionCount === 0) installationRoots.delete(installationId);
      });
    });
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
