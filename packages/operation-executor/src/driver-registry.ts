import { lstatSync, readFileSync } from 'node:fs';
import type { OperationDriver } from './types.js';

function assertProtectedFile(path: string, label: string): void {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`INVALID_DRIVER_REGISTRY: ${label} must be regular file`);
  if (stats.uid !== 0 || (stats.mode & 0o022) !== 0) {
    throw new Error(`INVALID_DRIVER_REGISTRY: ${label} must be root-owned and read-only outside root`);
  }
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
  private constructor(entries: readonly OperationDriver[]) {
    const drivers = new Map<string, OperationDriver>();
    for (const entry of entries) {
      if (drivers.has(entry.actionType) || !entry.executable.startsWith('/') || entry.timeoutMs < 1 || entry.timeoutMs > 600_000) {
        throw new Error('INVALID_DRIVER_REGISTRY');
      }
      assertProtectedFile(entry.executable, 'executable');
      if (entry.credentialFile !== undefined) assertProtectedFile(entry.credentialFile, 'credential file');
      drivers.set(entry.actionType, freezeDriver(entry));
    }
    this.drivers = drivers;
  }

  static fromFile(path: string): DriverRegistry {
    assertProtectedFile(path, 'production registry');
    return new DriverRegistry(JSON.parse(readFileSync(path, 'utf8')) as OperationDriver[]);
  }

  static forProduction(registryPath?: string): DriverRegistry {
    return registryPath === undefined
      ? new DriverRegistry(BUILT_IN_OPERATION_DRIVERS)
      : DriverRegistry.fromFile(registryPath);
  }

  static forTestFixtures(entries: readonly OperationDriver[]): DriverRegistry {
    return new DriverRegistry(entries);
  }

  get(actionType: string): OperationDriver {
    const driver = this.drivers.get(actionType);
    if (!driver) throw new Error('POLICY_VIOLATION: unknown action type');
    return driver;
  }
}
