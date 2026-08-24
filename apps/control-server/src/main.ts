import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  captureGitWorkspaceSnapshot,
  IpcClient,
  loadAdapterCredential,
} from '@project-orchestrator/adapter-core';
import { loadConfig, rotateWebSessionSecret } from "./config.js";
import { initializeLocalState, inspectLocalState } from './distribution.js';
import { startControlServer } from "./runtime.js";

const command = process.argv[2];
const dataDirectory = resolve(process.env['PROJECT_ORCHESTRATOR_DATA'] ?? `${process.env['HOME'] ?? '.'}/.project-orchestrator`);
const stateInput = {
  databasePath: resolve(process.env['PROJECT_ORCHESTRATOR_DB'] ?? `${dataDirectory}/orchestrator.sqlite`),
  objectsPath: resolve(process.env['PROJECT_ORCHESTRATOR_OBJECTS'] ?? `${dataDirectory}/objects`),
  credentialFiles: {
    codex: resolve(process.env['PROJECT_ORCHESTRATOR_CODEX_CREDENTIAL_FILE'] ?? `${dataDirectory}/runtime/adapter-codex-credential`),
    claude: resolve(process.env['PROJECT_ORCHESTRATOR_CLAUDE_CREDENTIAL_FILE'] ?? `${dataDirectory}/runtime/adapter-claude-credential`),
  },
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requireOption(name: string): string {
  const value = option(name);
  if (value === undefined || value.length === 0) throw new Error(`CLI_ARGUMENT_REQUIRED: ${name}`);
  return value;
}

async function startRunFromCli(): Promise<void> {
  const client = option('--client') ?? 'codex';
  if (client !== 'codex' && client !== 'claude') throw new Error('CLI_ARGUMENT_INVALID: --client');
  const workflowSlug = option('--workflow') ?? 'new-project';
  const objective = requireOption('--objective');
  const rawInput = option('--input-json') ?? '{}';
  let runInput: unknown;
  try {
    runInput = JSON.parse(rawInput) as unknown;
  } catch {
    throw new Error('CLI_ARGUMENT_INVALID: --input-json');
  }
  const workspace = captureGitWorkspaceSnapshot(process.cwd());
  const credential = loadAdapterCredential(stateInput.credentialFiles[client]);
  const ipc = credential.withSecret((secret) => new IpcClient({
    socketPath: resolve(process.env['PROJECT_ORCHESTRATOR_SOCKET'] ?? `${dataDirectory}/runtime/control.sock`),
    credential: secret,
    rootSessionId: randomUUID(),
    canonicalProjectPath: workspace.canonicalProjectPath,
    // The first Run persists snapshots and evidence to the local volume. A short
    // adapter timeout may abandon a completed write before its response arrives.
    timeoutMs: 30_000,
  }));
  try {
    await ipc.connect();
    const result = await ipc.request({
      kind: 'tool',
      tool: 'create_run',
      payload: {
        request_id: randomUUID(),
        workflow_slug: workflowSlug,
        objective,
        input: runInput,
        workspace: {
          repository_head: workspace.repositoryHead,
          staged_patch: workspace.stagedPatch,
          unstaged_patch: workspace.unstagedPatch,
          untracked_manifest: workspace.untrackedManifest,
          submodule_manifest: workspace.submoduleManifest,
        },
      },
    });
    process.stdout.write(`${JSON.stringify({ ...(result as Record<string, unknown>), status: 'created' })}\n`);
  } finally {
    await ipc.close();
  }
}

if (command === "--rotate-web-session-secret") {
  rotateWebSessionSecret();
  process.stdout.write("Web session secret rotated. Restart the Control Server; every browser session will sign in again.\n");
} else if (command === 'initialize') {
  initializeLocalState(stateInput);
  process.stdout.write('Local database, built-in workflows, and client installations initialized.\n');
} else if (command === 'version' || command === '--version') {
  const versionFile = process.env['PROJECT_ORCHESTRATOR_VERSION_FILE'];
  process.stdout.write(`${versionFile !== undefined && existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '0.1.5'}\n`);
} else if (command === 'url') {
  process.stdout.write(`${loadConfig().allowedOrigins[0]}\n`);
} else if (command === 'doctor') {
  const state = inspectLocalState(stateInput);
  let service = false;
  try {
    const config = loadConfig();
    const response = await fetch(`http://127.0.0.1:${config.webPort}/health`, { signal: AbortSignal.timeout(2_000) });
    service = response.ok && (await response.json() as { ok?: boolean }).ok === true;
  } catch {
    // A stopped listener is reported as a boolean, not as a credential-bearing exception.
  }
  const result = { ...state, service, listener: '127.0.0.1' };
  process.stdout.write(`${JSON.stringify(result, null, process.argv.includes('--json') ? 0 : 2)}\n`);
  if (!state.ok || !service) process.exitCode = 1;
} else if (command === 'start') {
  await startRunFromCli();
} else {
  const termination = new Promise<void>((resolve) =>
    process.once("SIGTERM", resolve),
  );
  const runtime = await startControlServer();
  await termination;
  try {
    await runtime.shutdown();
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(
      `control server shutdown failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
  }
}
