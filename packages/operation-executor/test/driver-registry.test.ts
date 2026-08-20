import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BUILT_IN_OPERATION_DRIVERS, DriverRegistry } from '../src/index.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

it('defaults production to an immutable fail-closed built-in registry', () => {
  expect(Object.isFrozen(BUILT_IN_OPERATION_DRIVERS)).toBe(true);
  const registry = DriverRegistry.forProduction({ enableUserDrivers: false });
  expect(() => registry.get('deploy')).toThrow('unknown action type');
});

it('requires explicit enablement and exact 0600 current-user permissions for a user registry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'driver-registry-'));
  directories.push(directory);
  const path = join(directory, 'drivers.json');
  writeFileSync(path, JSON.stringify([{
    actionType: 'fixture', executable: '/bin/echo', allowedParameterKeys: [], fixedArgs: [], timeoutMs: 1_000,
  }]));
  chmodSync(path, 0o644);
  expect(() => DriverRegistry.forProduction({ enableUserDrivers: true, userRegistryPath: path }))
    .toThrow(/0600/);
  chmodSync(path, 0o600);
  expect(() => DriverRegistry.forProduction({ enableUserDrivers: false, userRegistryPath: path }))
    .toThrow('USER_DRIVERS_DISABLED');
  expect(DriverRegistry.forProduction({ enableUserDrivers: true, userRegistryPath: path }).get('fixture').actionType)
    .toBe('fixture');
});
