import { DriverRegistry } from './driver-registry.js';
import { startOperationServer } from './server.js';

const [socketPath, registryPath] = process.argv.slice(2);
if (!socketPath) throw new Error('usage: operation-executor SOCKET [ROOT_OWNED_REGISTRY]');
const server = await startOperationServer(socketPath, DriverRegistry.forProduction(registryPath));
let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  server.close((error) => {
    if (error) {
      process.exitCode = 1;
      process.stderr.write(`operation helper shutdown failed: ${error.message}\n`);
    }
  });
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
