import { describe, expect, it } from 'vitest';
import { AgentToolNames } from '@project-orchestrator/contracts';
import { SessionGuard } from '../../packages/adapter-core/src/session-guard.js';

describe('subagent write denial', () => {
  it('rejects every model-visible orchestration write for a subagent principal', () => {
    const guard = new SessionGuard({ sessionId: 'root-1' });
    guard.rememberLease('run-1', { leaseEpoch: 1, leaseToken: 'hidden-token' });
    for (const tool of AgentToolNames) {
      expect(() => guard.assertCanWrite({ kind: 'subagent', sessionId: 'child', rootSessionId: 'root-1' }, tool))
        .toThrow(/SUBAGENT_WRITE_FORBIDDEN/);
    }
  });
});
