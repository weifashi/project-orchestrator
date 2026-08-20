import { describe, expect, it } from 'vitest';
import { InteractiveConfirmationChannel } from '../src/interactive-confirmation.js';
import { createConservativeCapabilities, SessionGuard } from '@project-orchestrator/adapter-core';
import { AdapterRuntime } from '../src/server.js';

const request = {
  confirmation_request_id: 'confirmation-1', nonce: 'nonce-1', exact_action_hash: 'a'.repeat(64),
  exact_action: 'Deploy release 1.2.3', target: 'production/node-1', expires_at: '2030-01-01T00:00:00.000Z',
} as const;

describe('trusted interactive confirmation', () => {
  it('fails closed when the Host has no trusted callback', async () => {
    const channel = new InteractiveConfirmationChannel();
    expect(channel.available).toBe(false);
    await expect(channel.confirm(request)).rejects.toThrow(/HOST_CONFIRMATION_UNAVAILABLE/);
  });

  it('shows exact immutable details and submits only the trusted decision envelope', async () => {
    const seen: unknown[] = [];
    const channel = new InteractiveConfirmationChannel({
      prompt: async (display) => { seen.push(display); return 'approve'; },
      submit: async (decision) => { seen.push(decision); return { accepted: true }; },
    });
    await expect(channel.confirm(request)).resolves.toEqual({ accepted: true });
    expect(seen[0]).toEqual(expect.objectContaining({ exact_action: request.exact_action, target: request.target, expires_at: request.expires_at }));
    expect(seen[1]).toEqual({
      kind: 'submit_confirmation',
      payload: {
        confirmation_request_id: request.confirmation_request_id,
        nonce: request.nonce,
        exact_action_hash: request.exact_action_hash,
        expires_at: request.expires_at,
        decision: 'approve',
      },
    });
  });

  it('rejects every confirmation-producing managed action before IPC when trusted Host confirmation is unavailable', async () => {
    const guard = new SessionGuard({ sessionId: 'root-1' });
    guard.rememberLease('run-1', { leaseEpoch: 1, leaseToken: 'hidden' });
    let sent = false;
    const runtime = new AdapterRuntime({
      capabilities: createConservativeCapabilities('claude', '0.1.0'),
      sessionGuard: guard,
      send: async () => { sent = true; return {}; },
    });
    await expect(runtime.invoke('request_confirmation', {
      request_id: 'request-1', run_id: 'run-1', stage_run_id: 'stage-1', confirmation_type: 'release',
      summary: 'release', exact_action_hash: 'a'.repeat(64),
    })).rejects.toThrow(/HOST_CONFIRMATION_UNAVAILABLE/);
    await expect(runtime.invoke('prepare_side_effect', {
      request_id: 'request-2', run_id: 'run-1', stage_attempt_id: 'attempt-1', action_type: 'deploy',
      target_fingerprint: 'production', parameters: {}, summary: 'release',
    })).rejects.toThrow(/HOST_CONFIRMATION_UNAVAILABLE/);
    await expect(runtime.invoke('execute_side_effect', { request_id: 'request-3', run_id: 'run-1', operation_id: 'operation-1' }))
      .rejects.toThrow(/HOST_CONFIRMATION_UNAVAILABLE/);
    expect(sent).toBe(false);
  });
});
