import { lstatSync, readFileSync } from 'node:fs';
import type { OperationDriver } from './types.js';

function assertProtectedFile(path: string, label: string): void {
  const stats = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : stats.uid;
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`INVALID_DRIVER_REGISTRY: ${label} must be regular file`);
  if (stats.uid !== 0 && stats.uid !== uid) throw new Error(`INVALID_DRIVER_REGISTRY: ${label} owner`);
  if ((stats.mode & 0o022) !== 0) throw new Error(`INVALID_DRIVER_REGISTRY: ${label} is writable by group/world`);
}

function assertCurrentUserSecretFile(path: string, label: string): void {
  const stats = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : stats.uid;
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`INVALID_DRIVER_REGISTRY: ${label} must be regular file`);
  if (stats.uid !== uid) throw new Error(`INVALID_DRIVER_REGISTRY: ${label} must be owned by current user`);
  if ((stats.mode & 0o777) !== 0o600) throw new Error(`INVALID_DRIVER_REGISTRY: ${label} must have mode 0600`);
}

const freezeDriver = (entry: OperationDriver): OperationDriver => Object.freeze({
  ...entry,
  allowedParameterKeys: Object.freeze([...entry.allowedParameterKeys]),
  fixedArgs: Object.freeze([...entry.fixedArgs]),
  ...(entry.reconcileArgs === undefined ? {} : { reconcileArgs: Object.freeze([...entry.reconcileArgs]) }),
});

export const BUILT_IN_OPERATION_DRIVERS: readonly OperationDriver[] = Object.freeze([]);

export class DriverRegistry {
  private readonly drivers: ReadonlyMap<string, OperationDriver>;
  constructor(entries: readonly OperationDriver[]) {
    const drivers = new Map<string, OperationDriver>();
    for (const entry of entries) {
      if (drivers.has(entry.actionType) || !entry.executable.startsWith('/') || entry.timeoutMs < 1 || entry.timeoutMs > 600_000) {
        throw new Error('INVALID_DRIVER_REGISTRY');
      }
      assertProtectedFile(entry.executable, 'executable');
      if (entry.credentialFile !== undefined) assertCurrentUserSecretFile(entry.credentialFile, 'credential file');
      drivers.set(entry.actionType, freezeDriver(entry));
    }
    this.drivers = drivers;
  }

  static fromFile(path: string): DriverRegistry {
    assertCurrentUserSecretFile(path, 'user registry');
    return new DriverRegistry(JSON.parse(readFileSync(path, 'utf8')) as OperationDriver[]);
  }

  static forProduction(input: { enableUserDrivers: boolean; userRegistryPath?: string }): DriverRegistry {
    if (!input.enableUserDrivers) {
      if (input.userRegistryPath !== undefined) throw new Error('USER_DRIVERS_DISABLED');
      return new DriverRegistry(BUILT_IN_OPERATION_DRIVERS);
    }
    if (input.userRegistryPath === undefined) throw new Error('USER_DRIVER_REGISTRY_REQUIRED');
    return DriverRegistry.fromFile(input.userRegistryPath);
  }

  get(actionType: string): OperationDriver {
    const driver = this.drivers.get(actionType);
    if (!driver) throw new Error('POLICY_VIOLATION: unknown action type');
    return driver;
  }
}
