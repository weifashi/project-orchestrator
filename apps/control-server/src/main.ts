import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, rotateWebCredentials } from "./config.js";
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

if (command === "--rotate-web-credentials") {
  rotateWebCredentials();
  process.stdout.write(
    "Web credentials rotated. Restart the Control Server and bootstrap a new browser session.\n",
  );
} else if (command === 'initialize') {
  initializeLocalState(stateInput);
  process.stdout.write('Local database, built-in workflows, and client installations initialized.\n');
} else if (command === 'version' || command === '--version') {
  const versionFile = process.env['PROJECT_ORCHESTRATOR_VERSION_FILE'];
  process.stdout.write(`${versionFile !== undefined && existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '0.1.2'}\n`);
} else if (command === 'url') {
  process.stdout.write(`${loadConfig().allowedOrigin}\n`);
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
