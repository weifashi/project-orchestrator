import { DriverRegistry } from './driver-registry.js';
import { startOperationServer } from './server.js';

const [socketPath, registryPath] = process.argv.slice(2);
if (!socketPath) throw new Error('usage: operation-executor SOCKET [ROOT_OWNED_REGISTRY]');
await startOperationServer(socketPath, DriverRegistry.forProduction(registryPath));
