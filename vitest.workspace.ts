import { defineWorkspace } from 'vitest/config';

const aliases = {
  '@project-orchestrator/contracts/internal-ipc': new URL('./packages/contracts/src/internal-ipc.ts', import.meta.url).pathname,
  '@project-orchestrator/contracts': new URL('./packages/contracts/src/index.ts', import.meta.url).pathname,
  '@project-orchestrator/sqlite-store': new URL('./packages/sqlite-store/src/index.ts', import.meta.url).pathname,
  '@project-orchestrator/content-store': new URL('./packages/content-store/src/index.ts', import.meta.url).pathname,
  '@project-orchestrator/orchestrator-service': new URL('./packages/orchestrator-service/src/index.ts', import.meta.url).pathname,
  '@project-orchestrator/workflow-engine': new URL('./packages/workflow-engine/src/index.ts', import.meta.url).pathname,
  '@project-orchestrator/control-server': new URL('./apps/control-server/src/app.ts', import.meta.url).pathname,
};

export default defineWorkspace([
  {
    resolve: { alias: aliases },
    test: {
      name: 'unit',
      include: ['packages/*/test/**/*.test.ts'],
      exclude: ['packages/*/test/**/*.integration.test.ts'],
      maxWorkers: 4,
    },
  },
  {
    resolve: { alias: aliases },
    test: {
      name: 'web-unit',
      include: ['apps/web-console/test/**/*.test.ts?(x)'],
      environment: 'jsdom',
      setupFiles: ['apps/web-console/test/setup.ts'],
      maxWorkers: 2,
    },
  },
  {
    resolve: { alias: aliases },
    test: {
      name: 'integration',
      include: [
        'tests/integration/**/*.test.ts',
        'tests/contract/**/*.test.ts',
        'tests/skills/**/*.test.ts',
        'packages/*/test/**/*.integration.test.ts',
      ],
      testTimeout: 30_000,
    },
  },
]);
