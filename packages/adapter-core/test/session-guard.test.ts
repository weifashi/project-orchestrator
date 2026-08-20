import { describe, expect, it } from 'vitest';
import { createConservativeCapabilities } from '../src/capabilities.js';
import { SessionGuard } from '../src/session-guard.js';

describe('session guard', () => {
  it('defaults to serial execution when subagent isolation cannot be proven', () => {
    expect(createConservativeCapabilities('codex', '0.1.0')).toMatchObject({
      trustedRootSessionIdentity: true,
      parallelSubagentIsolation: false,
      trustedInteractiveConfirmation: false,
    });
  });

  it('rejects leased writes from a subagent before attaching hidden lease material', () => {
    const guard = new SessionGuard({ sessionId: 'root-1' });
    guard.rememberLease('run-1', { leaseEpoch: 4, leaseToken: 'adapter-secret' });

    expect(() => guard.attachLease(
      { kind: 'subagent', sessionId: 'child-1', rootSessionId: 'root-1' },
      { kind: 'tool', tool: 'complete_stage', payload: { run_id: 'run-1' } },
    )).toThrow(/SUBAGENT_WRITE_FORBIDDEN/);
  });

  it('injects lease only into the internal envelope for the bound root session', () => {
    const guard = new SessionGuard({ sessionId: 'root-1' });
    guard.rememberLease('run-1', { leaseEpoch: 4, leaseToken: 'adapter-secret' });

    const request = guard.attachLease(
      { kind: 'root', sessionId: 'root-1' },
      { kind: 'tool', tool: 'complete_stage', payload: { run_id: 'run-1' } },
    );

    expect(request).toMatchObject({ lease_epoch: 4, lease_token: 'adapter-secret' });
  });
});
