import { startControlServer, type ControlRuntime } from './runtime.js';

const state: { runtime?: ControlRuntime } = {};
let terminationRequested = false;
const shutdown = (): void => {
  terminationRequested = true;
  if (state.runtime !== undefined) {
    void state.runtime.shutdown().catch((error: unknown) => {
      process.exitCode = 1;
      process.stderr.write(`control server shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    });
  }
};
process.once('SIGTERM', shutdown);
state.runtime = await startControlServer();
if (terminationRequested) await state.runtime.shutdown();
