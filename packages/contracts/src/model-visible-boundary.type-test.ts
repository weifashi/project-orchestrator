import type { Static } from '@sinclair/typebox';
import type { HeartbeatRunToolRequestSchema } from './tool-contracts.js';

const visibleRequest = { request_id: 'request', run_id: 'run' } satisfies
  Static<typeof HeartbeatRunToolRequestSchema>;

const requestWithSecret: Static<typeof HeartbeatRunToolRequestSchema> = {
  ...visibleRequest,
  // @ts-expect-error Authentication material is internal-only and cannot type-check as a visible request.
  lease_token: 'must-not-be-visible',
};

void requestWithSecret;
