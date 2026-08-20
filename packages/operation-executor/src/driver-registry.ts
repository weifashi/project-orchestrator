import { lstatSync, readFileSync } from 'node:fs';
import type { OperationDriver } from './types.js';

function assertProtectedFile(path: string, label: string): void {
  const stats = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : stats.uid;
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`INVALID_DRIVER_REGISTRY: ${label} must be regular file`);
  if (stats.uid !== 0 && stats.uid !== uid) throw new Error(`INVALID_DRIVER_REGISTRY: ${label} owner`);
  if ((stats.mode & 0o022) !== 0) throw new Error(`INVALID_DRIVER_REGISTRY: ${label} is writable by group/world`);
}

export class DriverRegistry {
  readonly drivers: ReadonlyMap<string, OperationDriver>;
  constructor(entries: readonly OperationDriver[]) {
    const drivers = new Map<string, OperationDriver>();
    for (const entry of entries) {
      if (drivers.has(entry.actionType) || !entry.executable.startsWith('/') || entry.timeoutMs < 1 || entry.timeoutMs > 600_000) {
        throw new Error('INVALID_DRIVER_REGISTRY');
      }
      assertProtectedFile(entry.executable, 'executable');
      if (entry.credentialFile !== undefined) assertProtectedFile(entry.credentialFile, 'credential file');
      drivers.set(entry.actionType, Object.freeze({
        ...entry,
        allowedParameterKeys: [...entry.allowedParameterKeys],
        fixedArgs: [...entry.fixedArgs],
        ...(entry.reconcileArgs === undefined ? {} : { reconcileArgs: [...entry.reconcileArgs] }),
      }));
    }
    this.drivers = drivers;
  }

  static fromFile(path: string): DriverRegistry {
    assertProtectedFile(path, 'registry');
    return new DriverRegistry(JSON.parse(readFileSync(path, 'utf8')) as OperationDriver[]);
  }

  get(actionType: string): OperationDriver {
    const driver = this.drivers.get(actionType);
    if (!driver) throw new Error('POLICY_VIOLATION: unknown action type');
    return driver;
  }
}
