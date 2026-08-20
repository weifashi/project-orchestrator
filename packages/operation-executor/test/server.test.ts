import { expect, it } from 'vitest';
import { DriverRegistry, executeOperation } from '../src/index.js';
it('uses fixed executable/args, rejects arbitrary keys, redacts output and supports fixed reconciliation', async () => {
  const registry = new DriverRegistry([{ actionType: 'fixture', executable: '/bin/echo', allowedParameterKeys: ['version'], fixedArgs: ['password=secret'], reconcileArgs: ['reconcile'], timeoutMs: 1000 }]);
  const result = await executeOperation(registry, { kind: 'execute', actionType: 'fixture', targetFingerprint: 'node', parameters: { version: '1' } });
  expect(result.status).toBe('succeeded'); expect(result.evidence.stdout).toContain('password=[REDACTED]');
  await expect(executeOperation(registry, { kind: 'execute', actionType: 'fixture', targetFingerprint: 'node', parameters: { executable: '/bin/sh' } })).rejects.toThrow('not allowed');
  expect((await executeOperation(registry, { kind: 'reconcile', actionType: 'fixture', targetFingerprint: 'node', operationId: 'operation' })).status).toBe('succeeded');
});
