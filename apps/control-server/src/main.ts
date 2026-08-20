import { startControlServer } from './runtime.js';

const termination = new Promise<void>((resolve) => process.once('SIGTERM', resolve));
const runtime = await startControlServer();
await termination;
try {
  await runtime.shutdown();
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`control server shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
}
