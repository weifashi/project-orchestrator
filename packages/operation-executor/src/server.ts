import { spawn } from 'node:child_process';
import { chmodSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import type { DriverRegistry } from './driver-registry.js';
import type { OperationHelperRequest, OperationRequest, OperationResult } from './types.js';
const MAX_OUTPUT = 64 * 1024;
const MAX_FRAME = 256 * 1024;
const redact = (value: string): string => value.replace(/(token|secret|password|credential)\s*[=:]\s*\S+/gi, '$1=[REDACTED]');

function operationRequest(value: unknown): OperationHelperRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_OPERATION_REQUEST');
  const request = value as Record<string, unknown>;
  if (request['kind'] === 'ping' && Object.keys(request).length === 1) return { kind: 'ping' };
  if (request['kind'] === 'execute') {
    const keys = Object.keys(request).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['actionType', 'kind', 'parameters', 'targetFingerprint'])
      || typeof request['actionType'] !== 'string' || request['actionType'].length === 0
      || typeof request['targetFingerprint'] !== 'string' || request['targetFingerprint'].length === 0
      || request['parameters'] === null || typeof request['parameters'] !== 'object' || Array.isArray(request['parameters'])) {
      throw new Error('INVALID_OPERATION_REQUEST');
    }
    return request as OperationRequest;
  }
  if (request['kind'] === 'reconcile') {
    const allowed = new Set(['actionType', 'externalReference', 'kind', 'operationId', 'targetFingerprint']);
    if (Object.keys(request).some((key) => !allowed.has(key))
      || typeof request['actionType'] !== 'string' || request['actionType'].length === 0
      || typeof request['targetFingerprint'] !== 'string' || request['targetFingerprint'].length === 0
      || typeof request['operationId'] !== 'string' || request['operationId'].length === 0
      || (request['externalReference'] !== undefined && typeof request['externalReference'] !== 'string')) {
      throw new Error('INVALID_OPERATION_REQUEST');
    }
    return request as OperationRequest;
  }
  throw new Error('INVALID_OPERATION_REQUEST');
}

export async function executeOperation(registry: DriverRegistry, request: OperationRequest): Promise<OperationResult> {
  const driver = registry.get(request.actionType);
  let args: string[];
  if (request.kind === 'execute') {
    const keys = Object.keys(request.parameters);
    if (keys.some((key) => !driver.allowedParameterKeys.includes(key))) throw new Error('POLICY_VIOLATION: parameter key not allowed');
    args = [...driver.fixedArgs, '--target', request.targetFingerprint,
      ...driver.allowedParameterKeys.filter((key) => key in request.parameters).flatMap((key) => [`--${key}`, String(request.parameters[key])])];
  } else {
    if (driver.reconcileArgs === undefined) throw new Error('POLICY_VIOLATION: driver cannot reconcile');
    args = [...driver.reconcileArgs, '--target', request.targetFingerprint, '--operation-id', request.operationId,
      ...(request.externalReference === undefined ? [] : ['--external-reference', request.externalReference])];
  }
  return new Promise((resolve) => {
    const child = spawn(driver.executable, args, {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...(driver.credentialFile === undefined ? {} : { PROJECT_ORCHESTRATOR_CREDENTIAL_FILE: driver.credentialFile }) },
      stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
    let stdout = ''; let stderr = ''; let truncated = false;
    const add = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next) <= MAX_OUTPUT) return next;
      truncated = true; return Buffer.from(next).subarray(0, MAX_OUTPUT).toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = add(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = add(stderr, chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), driver.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: 'unknown', evidence: { exitCode: null, stdout: redact(stdout), stderr: redact(`${stderr}${error.message}`), truncated } });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code === 0 && signal === null ? 'succeeded' : 'unknown', evidence: { exitCode: code, stdout: redact(stdout), stderr: redact(stderr), truncated } });
    });
  });
}

export function startOperationServer(socketPath: string, registry: DriverRegistry): Promise<Server> {
  rmSync(socketPath, { force: true });
  const server = createServer((socket) => {
    let buffer = ''; socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME) { socket.destroy(new Error('FRAME_TOO_LARGE')); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let request: OperationHelperRequest;
        try {
          request = operationRequest(JSON.parse(line) as unknown);
        } catch (error) {
          socket.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'invalid request' })}\n`); continue;
        }
        if (request.kind === 'ping') {
          socket.write(`${JSON.stringify({ ready: true })}\n`);
          continue;
        }
        void executeOperation(registry, request).then(
          (result) => socket.write(`${JSON.stringify(result)}\n`),
          (error: unknown) => socket.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'error' })}\n`),
        );
      }
    });
  });
  server.once('close', () => rmSync(socketPath, { force: true }));
  return new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, () => { chmodSync(socketPath, 0o600); resolve(server); }));
}
