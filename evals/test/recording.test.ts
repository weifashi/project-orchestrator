import { describe, expect, it } from 'vitest';
import { DIMENSIONS, parseRecording, type Recording } from '../src/recording.js';
import { roleMeans } from '../src/baseline.js';

const rec = (scores: Partial<Record<(typeof DIMENSIONS)[number], number>> = {}): Recording => ({
  schema_version: 1, role: 'testing', scenario: 'a', skill_hash: 'a'.repeat(64), rubric_hash: 'b'.repeat(64),
  executor_model: 'm', judge_model: 'm', recorded_at: '2026-09-05T00:00:00Z', output_text: '{}',
  output_envelope: { schema_id: 'x', schema_version: 1, data: {} },
  scores: { persona: 5, domain: 4, context: 4, boundary: 5, actionability: 4, ...scores },
  rationale: { persona: '', domain: '', context: '', boundary: '', actionability: '' },
  hard_gates: { schema_valid: true, contract_complete: true, forbidden_absent: true },
});

describe('recording', () => {
  it('round-trips a valid recording', () => {
    expect(parseRecording(rec())).toEqual(rec());
  });

  it('rejects a score outside 1-5 or non-integer', () => {
    expect(() => parseRecording(rec({ domain: 0 }))).toThrow(/domain/);
    expect(() => parseRecording(rec({ domain: 3.5 }))).toThrow(/domain/);
  });

  it('rejects a missing dimension and a bad hash', () => {
    const { scores, ...rest } = rec();
    const { boundary: _omit, ...partial } = scores;
    expect(() => parseRecording({ ...rest, scores: partial })).toThrow(/boundary/);
    expect(() => parseRecording({ ...rec(), skill_hash: 'short' })).toThrow(/skill_hash/);
  });
});

describe('roleMeans', () => {
  it('averages each dimension across recordings', () => {
    const means = roleMeans([rec({ persona: 5 }), rec({ persona: 3 })]);
    expect(means.persona).toBe(4);
    expect(means.domain).toBe(4);
  });

  it('throws on an empty list', () => {
    expect(() => roleMeans([])).toThrow(/no recordings/);
  });
});
