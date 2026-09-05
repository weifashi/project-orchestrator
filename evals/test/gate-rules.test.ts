import { describe, expect, it } from 'vitest';
import { checkHardGates, checkRoleGate, contractFields } from '../src/gate.js';
import { readRole } from '../src/roles.js';
import { parseScenario, type Scenario } from '../src/scenario.js';
import type { Recording } from '../src/recording.js';

const testing = readRole('testing');
const scenario = parseScenario('testing', 'a', `---
role: testing
title: t
input_envelope: { schema_id: project-orchestrator/testing-input, schema_version: 1, data: {} }
expected_topics: [x]
must_not_claim: ["tests pass based on the implementation report"]
---
body`);

const goodEnvelope = {
  schema_id: 'project-orchestrator/testing-output', schema_version: 1,
  data: {
    status: 'succeeded', summary: 'ran the suite', artifact_object_ids: ['a1'], evidence_object_ids: ['e1'],
    risks: [], next_stage_notes: [],
    deliverables: { test_matrix: 'a1', commands_and_exit_codes: 'a1', raw_evidence: 'a1' },
  },
};

const recording = (name: string, scores: Partial<Recording['scores']> = {}, hash = 'h'.repeat(64)): Recording => ({
  schema_version: 1, role: 'testing', scenario: name, skill_hash: hash, rubric_hash: 'r'.repeat(64),
  executor_model: 'm', judge_model: 'm', recorded_at: '', output_text: JSON.stringify(goodEnvelope), output_envelope: goodEnvelope,
  scores: { persona: 5, domain: 4, context: 4, boundary: 5, actionability: 4, ...scores },
  rationale: { persona: '', domain: '', context: '', boundary: '', actionability: '' },
  hard_gates: { schema_valid: true, contract_complete: true, forbidden_absent: true },
});

describe('contractFields', () => {
  it('extracts backticked identifiers from the completion contract', () => {
    expect(contractFields(testing.completionContract)).toEqual(['test_matrix', 'commands_and_exit_codes', 'raw_evidence']);
  });
});

describe('checkHardGates', () => {
  it('passes a conforming envelope', () => {
    const gates = checkHardGates(testing, scenario, goodEnvelope, JSON.stringify(goodEnvelope));
    expect(gates).toEqual({ schema_valid: true, contract_complete: true, forbidden_absent: true, failures: [] });
  });

  it('fails schema when a required field is missing', () => {
    const { summary: _omit, ...data } = goodEnvelope.data;
    const gates = checkHardGates(testing, scenario, { ...goodEnvelope, data }, '');
    expect(gates.schema_valid).toBe(false);
    expect(gates.failures.join('\n')).toMatch(/summary/);
  });

  it('fails contract when a deliverable listed in the contract is empty', () => {
    const envelope = { ...goodEnvelope, data: { ...goodEnvelope.data, deliverables: { ...goodEnvelope.data.deliverables, raw_evidence: '' } } };
    const gates = checkHardGates(testing, scenario, envelope, '');
    expect(gates.contract_complete).toBe(false);
  });

  it('fails forbidden when a must_not_claim phrase appears, case-insensitively', () => {
    const gates = checkHardGates(testing, scenario, goodEnvelope, 'Tests PASS based on the implementation REPORT.');
    expect(gates.forbidden_absent).toBe(false);
  });
});

describe('checkRoleGate', () => {
  const two: Scenario[] = [scenario, { ...scenario, name: 'b' }];
  const base = (over: Partial<Parameters<typeof checkRoleGate>[0]> = {}) => checkRoleGate({
    role: 'testing', scenarios: two,
    recordings: new Map([['a', recording('a')], ['b', recording('b')]]),
    currentSkillHash: 'h'.repeat(64), currentRubricHash: 'r'.repeat(64),
    baseline: { persona: 5, domain: 4, context: 4, boundary: 5, actionability: 4 },
    ...over,
  });

  it('passes when everything lines up', () => {
    expect(base()).toMatchObject({ ok: true, failures: [] });
  });

  it('requires at least two scenarios', () => {
    expect(base({ scenarios: [scenario] }).failures.join('\n')).toMatch(/at least 2 scenarios/);
  });

  it('requires a recording per scenario', () => {
    expect(base({ recordings: new Map([['a', recording('a')]]) }).failures.join('\n')).toMatch(/missing recording.*b/);
  });

  it('flags a stale skill hash with the re-record hint', () => {
    expect(base({ currentSkillHash: 'x'.repeat(64) }).failures.join('\n')).toMatch(/pnpm evals:record/);
  });

  it('flags a stale rubric hash', () => {
    expect(base({ currentRubricHash: 'x'.repeat(64) }).failures.join('\n')).toMatch(/rubric/);
  });

  it('fails a hard gate stored on the recording', () => {
    const bad = { ...recording('a'), hard_gates: { schema_valid: false, contract_complete: true, forbidden_absent: true } };
    expect(base({ recordings: new Map([['a', bad], ['b', recording('b')]]) }).failures.join('\n')).toMatch(/schema_valid/);
  });

  it('fails when the average drops below 3.5', () => {
    const low = { persona: 3, domain: 3, context: 3, boundary: 4, actionability: 3 };
    expect(base({ recordings: new Map([['a', recording('a', low)], ['b', recording('b', low)]]), baseline: undefined }).failures.join('\n')).toMatch(/average/);
  });

  it('fails when one dimension drops more than 10% below baseline', () => {
    expect(base({ recordings: new Map([['a', recording('a', { boundary: 4 })], ['b', recording('b', { boundary: 4 })]]) }).failures.join('\n')).toMatch(/boundary.*baseline/);
  });

  it('does not enforce regression without a baseline', () => {
    expect(base({ baseline: undefined, recordings: new Map([['a', recording('a', { boundary: 4 })], ['b', recording('b', { boundary: 4 })]]) }).ok).toBe(true);
  });
});
