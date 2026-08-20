import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AgentToolNames } from '@project-orchestrator/contracts';
import { describe, expect, it } from 'vitest';

const workspace = {
  repository_head: 'abc', staged_patch: '', unstaged_patch: '', untracked_manifest: [], submodule_manifest: [],
};

async function fakeIpcServer(path: string, requests: unknown[]): Promise<Server> {
  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let step = 0;
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const value = JSON.parse(line) as { kind?: string; tool?: string };
        if (step === 0) {
          step += 1;
          socket.write('{"installation_id":"installation-1","challenge":"challenge","algorithm":"hmac-sha256"}\n');
        } else if (step === 1) {
          step += 1;
          socket.write('{"authenticated":true}\n');
        } else {
          requests.push(value);
          if (value.tool === 'create_run') socket.write('{"ok":true,"result":{"runId":"run-1"}}\n');
          else if (value.tool === 'claim_run') socket.write('{"ok":true,"result":{"runId":"run-1","leaseEpoch":1,"leaseToken":"hidden","recoveryCredential":"recover"}}\n');
          else if (value.tool === 'complete_stage') socket.write('{"ok":true,"result":{"runId":"run-1","stageRunId":"stage-1","summary":"done"}}\n');
          else socket.write('{"ok":false,"error":"UNSUPPORTED_FOR_TEST"}\n');
        }
      }
    });
  });
  await new Promise<void>((resolveListen, reject) => server.once('error', reject).listen(path, resolveListen));
  return server;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

describe('stdio MCP cross-client equivalence', () => {
  it('runs Codex and Claude adapter processes against one IPC contract', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-equivalence-'));
    const credentialPath = join(directory, 'credential');
    const socketPath = join(directory, 'control.sock');
    writeFileSync(credentialPath, 'adapter-secret\n', { mode: 0o600 });
    chmodSync(credentialPath, 0o600);
    const sent: unknown[] = [];
    const ipc = await fakeIpcServer(socketPath, sent);
    const connectClient = async (clientType: 'codex' | 'claude') => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve('packages/mcp-adapter/dist/main.js'), '--client', clientType],
        cwd: process.cwd(),
        stderr: 'pipe',
        env: {
          ...process.env,
          PROJECT_ORCHESTRATOR_SOCKET: socketPath,
          PROJECT_ORCHESTRATOR_ADAPTER_CREDENTIAL_FILE: credentialPath,
          PROJECT_ORCHESTRATOR_ADAPTER_SESSION_FILE: join(directory, `${clientType}-sessions.json`),
        },
      });
      const client = new Client({ name: `test-${clientType}`, version: '1' });
      await client.connect(transport);
      return { client, transport };
    };
    const codex = await connectClient('codex');
    const claude = await connectClient('claude');
    try {
      const codexTools = await codex.client.listTools();
      const claudeTools = await claude.client.listTools();
      expect(codexTools.tools.map((tool) => tool.name)).toEqual([...AgentToolNames]);
      expect(claudeTools.tools).toEqual(codexTools.tools);

      const invokeSequence = async (client: Client) => {
        const created = await client.callTool({ name: 'create_run', arguments: {
          request_id: 'create-1', workflow_slug: 'new-project', objective: 'Build', input: {},
        } });
        const claimed = await client.callTool({ name: 'claim_run', arguments: {
          request_id: 'claim-1', run_id: 'run-1', mode: 'start', expected_status: 'created',
        } });
        const completed = await client.callTool({ name: 'complete_stage', arguments: {
          request_id: 'complete-1', run_id: 'run-1', stage_run_id: 'stage-1', workspace,
          output: { schema_id: 'project-orchestrator/stage-output', schema_version: 1, data: {
            status: 'succeeded', summary: 'done', artifact_object_ids: [], evidence_object_ids: [], risks: [], next_stage_notes: [],
          } },
        } });
        const rejectedSecret = await client.callTool({ name: 'complete_stage', arguments: {
          request_id: 'forged', run_id: 'run-1', stage_run_id: 'stage-1', lease_token: 'forged',
        } });
        return { created, claimed, completed, rejectedSecret };
      };
      expect(await invokeSequence(codex.client)).toEqual(await invokeSequence(claude.client));
      const codexCapabilities = JSON.parse(codex.client.getInstructions() ?? '{}');
      const claudeCapabilities = JSON.parse(claude.client.getInstructions() ?? '{}');
      codexCapabilities.host_capabilities.clientType = 'normalized';
      claudeCapabilities.host_capabilities.clientType = 'normalized';
      expect(codexCapabilities).toEqual(claudeCapabilities);
      expect(sent).toHaveLength(6);
      expect(sent[2]).toMatchObject({ tool: 'complete_stage', lease_epoch: 1, lease_token: 'hidden' });
      expect(sent[5]).toMatchObject({ tool: 'complete_stage', lease_epoch: 1, lease_token: 'hidden' });
    } finally {
      await codex.client.close();
      await claude.client.close();
      await closeServer(ipc);
    }
  }, 30_000);
});
