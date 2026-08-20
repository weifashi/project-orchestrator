import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ATTEMPT_TRANSITIONS, RUN_TRANSITIONS, STAGE_TRANSITIONS, assertAttemptTransition, assertRunTransition, assertStageTransition, type AttemptStatus, type RunStatus, type StageStatus } from '../src/index.js';
function exhaustive<T extends string>(map: Record<T, readonly T[]>, assertion: (from: T, to: T) => void): void {
  const statuses = Object.keys(map) as T[];
  for (const from of statuses) for (const to of statuses) {
    if (map[from].includes(to)) expect(() => assertion(from, to)).not.toThrow();
    else expect(() => assertion(from, to)).toThrow('INVALID_TRANSITION');
  }
}
describe('closed state matrices', () => {
  it('accepts every listed edge and rejects every unspecified run/stage/attempt edge', () => {
    exhaustive(RUN_TRANSITIONS as Record<RunStatus, readonly RunStatus[]>, assertRunTransition);
    exhaustive(STAGE_TRANSITIONS as Record<StageStatus, readonly StageStatus[]>, assertStageTransition);
    exhaustive(ATTEMPT_TRANSITIONS as Record<AttemptStatus, readonly AttemptStatus[]>, assertAttemptTransition);
  });
  it('property: terminal states never leave terminal', () => {
    fc.assert(fc.property(fc.constantFrom('completed' as const, 'cancelled' as const), fc.constantFrom(...Object.keys(RUN_TRANSITIONS) as RunStatus[]), (terminal, next) => { expect(() => assertRunTransition(terminal, next)).toThrow(); }));
    fc.assert(fc.property(fc.constantFrom('succeeded' as const, 'skipped' as const, 'cancelled' as const), fc.constantFrom(...Object.keys(STAGE_TRANSITIONS) as StageStatus[]), (terminal, next) => { expect(() => assertStageTransition(terminal, next)).toThrow(); }));
    fc.assert(fc.property(fc.constantFrom('succeeded' as const, 'failed' as const, 'interrupted' as const), fc.constantFrom(...Object.keys(ATTEMPT_TRANSITIONS) as AttemptStatus[]), (terminal, next) => { expect(() => assertAttemptTransition(terminal, next)).toThrow(); }));
  });
});
