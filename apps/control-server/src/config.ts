import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type ControlConfig = {
  dataDirectory: string;
  databasePath: string;
  objectsPath: string;
  controlSocketPath: string;
  operationSocketPath: string;
  webHost: '127.0.0.1';
  webPort: number;
  webToken: string;
  csrfToken: string;
  adapterCredential: string;
  allowedOrigin: string;
  maxFrameBytes: number;
};

const secret = (path: string): string => {
  const stats = lstatSync(path);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stats.uid;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== currentUid || (stats.mode & 0o077) !== 0) {
    throw new Error(`POLICY_VIOLATION: secret file permissions ${path}`);
  }
  const value = readFileSync(path, 'utf8').trim();
  if (value.length === 0) throw new Error('CONFIG_MISSING: empty credential');
  return value;
};
const ensurePrivateDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const mode = lstatSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`POLICY_VIOLATION: private directory permissions ${path}`);
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControlConfig {
  const dataDirectory = resolve(env['PROJECT_ORCHESTRATOR_DATA']
    ?? `${process.env['HOME'] ?? '.'}/.local/share/project-orchestrator`);
  ensurePrivateDirectory(dataDirectory);
  const host = env['PROJECT_ORCHESTRATOR_HOST'] ?? '127.0.0.1';
  if (host !== '127.0.0.1') throw new Error('POLICY_VIOLATION: web listener must be loopback');
  const webTokenPath = env['PROJECT_ORCHESTRATOR_WEB_TOKEN_FILE'];
  const adapterPath = env['PROJECT_ORCHESTRATOR_ADAPTER_CREDENTIAL_FILE'];
  if (webTokenPath === undefined || adapterPath === undefined) throw new Error('CONFIG_MISSING: credential files');
  if (resolve(webTokenPath) === resolve(adapterPath)) throw new Error('POLICY_VIOLATION: credentials must use separate files');
  const webToken = secret(webTokenPath);
  const csrfToken = secret(`${webTokenPath}.csrf`);
  const adapterCredential = secret(adapterPath);
  if (webToken === adapterCredential || csrfToken === adapterCredential || webToken === csrfToken) {
    throw new Error('POLICY_VIOLATION: credentials must use separate values');
  }
  const controlSocketPath = resolve(env['PROJECT_ORCHESTRATOR_SOCKET'] ?? `${dataDirectory}/control.sock`);
  const operationSocketPath = resolve(env['PROJECT_ORCHESTRATOR_OPERATION_SOCKET'] ?? `${dataDirectory}/operations.sock`);
  ensurePrivateDirectory(dirname(controlSocketPath));
  ensurePrivateDirectory(dirname(operationSocketPath));
  const webPort = Number(env['PROJECT_ORCHESTRATOR_PORT'] ?? 3847);
  if (!Number.isInteger(webPort) || webPort < 0 || webPort > 65_535) throw new Error('CONFIG_INVALID: web port');
  return {
    dataDirectory,
    databasePath: resolve(env['PROJECT_ORCHESTRATOR_DB'] ?? `${dataDirectory}/orchestrator.sqlite`),
    objectsPath: resolve(env['PROJECT_ORCHESTRATOR_OBJECTS'] ?? `${dataDirectory}/objects`),
    controlSocketPath,
    operationSocketPath,
    webHost: '127.0.0.1',
    webPort,
    webToken,
    csrfToken,
    adapterCredential,
    allowedOrigin: env['PROJECT_ORCHESTRATOR_ORIGIN'] ?? `http://127.0.0.1:${webPort}`,
    maxFrameBytes: 256 * 1024,
  };
}
