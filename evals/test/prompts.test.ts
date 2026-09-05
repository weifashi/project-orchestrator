import { describe, expect, it } from 'vitest';
import { executorPrompt, extractJsonObject, judgePrompt } from '../src/prompts.js';
import { readRole } from '../src/roles.js';
import { parseScenario } from '../src/scenario.js';

const testing = readRole('testing');
const scenario = parseScenario('testing', 'a', `---
role: testing
title: t
input_envelope: { schema_id: project-orchestrator/testing-input, schema_version: 1, data: { objective: verify the fix } }
expected_topics: [x]
must_not_claim: [y]
---
The implementation report says all tests pass.`);

describe('executorPrompt', () => {
  it('inlines SKILL.md and every reference into the system prompt', () => {
    const { system, user } = executorPrompt(testing, scenario);
    expect(system).toContain('# Testing');
    expect(system).toContain('references/output-schema.json');
    expect(system).toContain('references/completion-contract.md');
    expect(user).toContain('verify the fix');
    expect(user).toContain('all tests pass');
    expect(user).toMatch(/only.*JSON/i);
  });
});

describe('judgePrompt', () => {
  it('gives the judge the rubric, the forbidden section, the scenario, and the output', () => {
    const { system, user } = judgePrompt('# rubric', testing, scenario, '{"data":{}}');
    expect(system).toContain('# rubric');
    expect(user).toContain('Forbidden claims and actions');
    expect(user).toContain('{"data":{}}');
  });
});

describe('extractJsonObject', () => {
  it('finds a JSON object inside prose and code fences', () => {
    expect(extractJsonObject('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('{"a":{"b":[1,2]}} trailing')).toEqual({ a: { b: [1, 2] } });
  });

  it('returns undefined when there is no parseable object', () => {
    expect(extractJsonObject('no json here')).toBeUndefined();
    expect(extractJsonObject('{"unbalanced": ')).toBeUndefined();
  });
});
