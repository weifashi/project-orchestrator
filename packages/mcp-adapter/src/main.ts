#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  createConservativeCapabilities,
  defaultSessionStatePath,
  IpcClient,
  loadAdapterCredential,
  RecoveryCredentialStore,
  SessionGuard,
} from '@project-orchestrator/adapter-core';
import type { AgentToolName } from '@project-orchestrator/contracts';
import { AdapterRuntime } from './server.js';

type WorkspaceState = Readonly<{
  repositoryHead: string;
  stagedPatch: string;
  unstagedPatch: string;
  untrackedManifest: unknown;
  submoduleManifest: unknown;
}>;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function diagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'ADAPTER_START_FAILED';
  return (/^[A-Z][A-Z0-9_]*(?:: [^\r\n]*)?/.exec(raw)?.[0] ?? 'ADAPTER_START_FAILED').slice(0, 512);
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trimEnd();
  } catch {
    throw new Error('WORKSPACE_SNAPSHOT_UNAVAILABLE');
  }
}

function workspaceSnapshot(cwd: string): WorkspaceState {
  return {
    repositoryHead: git(cwd, ['rev-parse', 'HEAD']),
    stagedPatch: git(cwd, ['diff', '--cached', '--no-ext-diff']),
    unstagedPatch: git(cwd, ['diff', '--no-ext-diff']),
    untrackedManifest: git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean),
    submoduleManifest: git(cwd, ['submodule', 'status', '--recursive']).split('\n').filter(Boolean),
  };
}

async function main(): Promise<void> {
  const clientType = argument('--client');
  if (clientType !== 'codex' && clientType !== 'claude') throw new Error('CLIENT_TYPE_INVALID');
  const credential = loadAdapterCredential(process.env['PROJECT_ORCHESTRATOR_ADAPTER_CREDENTIAL_FILE']
    ?? resolve(process.env['HOME'] ?? '.', `.project-orchestrator/runtime/adapter-${clientType}-credential`));
  const sessionId = process.env['PROJECT_ORCHESTRATOR_ROOT_SESSION_ID'] ?? randomUUID();
  const canonicalProjectPath = realpathSync(process.cwd());
  const socketPath = resolve(process.env['PROJECT_ORCHESTRATOR_SOCKET']
    ?? `${process.env['HOME'] ?? '.'}/.project-orchestrator/runtime/control.sock`);
  const ipc = credential.withSecret((secret) => new IpcClient({
    socketPath,
    credential: secret,
    rootSessionId: sessionId,
    canonicalProjectPath,
  }));
  await ipc.connect();
  const runtime = new AdapterRuntime({
    capabilities: createConservativeCapabilities(clientType, '0.1.2'),
    sessionGuard: new SessionGuard({
      sessionId,
      recoveryStore: new RecoveryCredentialStore(
        process.env['PROJECT_ORCHESTRATOR_ADAPTER_SESSION_FILE'] ?? defaultSessionStatePath(),
      ),
    }),
    workspace: () => workspaceSnapshot(canonicalProjectPath),
    send: (request) => ipc.request(request),
  });
  const tools = runtime.tools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const server = new Server({ name: 'project-orchestrator', version: '0.1.2' }, {
    capabilities: { tools: {} },
    instructions: JSON.stringify({
      host_capabilities: runtime.capabilities,
      rules: [
        'Run writes are root-session only.',
        'Execute ready roles serially when parallelSubagentIsolation is false.',
        'Confirmation decisions are never model tools.',
      ],
    }),
  });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object'; properties?: Record<string, unknown> },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name as AgentToolName);
    if (tool === undefined) return { isError: true, content: [{ type: 'text', text: 'TOOL_NOT_FOUND' }] };
    return tool.invoke(request.params.arguments ?? {});
  });
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
  transport.onclose = () => { void ipc.close(); };
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(`project-orchestrator-mcp: ${diagnostic(error)}\n`);
  process.exitCode = 1;
});
