import { DriverRegistry } from './driver-registry.js';
import { startOperationServer } from './server.js';

const [socketPath, userRegistryPath] = process.argv.slice(2);
if (!socketPath) throw new Error('usage: operation-executor SOCKET [USER_REGISTRY]');
const enableUserDrivers = process.env['PROJECT_ORCHESTRATOR_ENABLE_USER_DRIVERS'] === '1';
await startOperationServer(socketPath, DriverRegistry.forProduction({
  enableUserDrivers,
  ...(userRegistryPath === undefined ? {} : { userRegistryPath }),
}));
