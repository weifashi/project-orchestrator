import { describe, expect, it } from 'vitest';
import { parseScenario } from '../src/scenario.js';

const ok = `---
role: testing
title: 开发角色口头声称测试已通过
input_envelope:
  schema_id: project-orchestrator/testing-input
  schema_version: 1
  data: { objective: verify }
expected_topics: [独立复跑, 原始输出]
must_not_claim:
  - tests pass based on the implementation report
---
开发阶段的报告写着"全部测试通过"，但没有任何命令输出。`;

describe('parseScenario', () => {
  it('parses frontmatter and body', () => {
    const s = parseScenario('testing', 'self-certified', ok);
    expect(s.title).toBe('开发角色口头声称测试已通过');
    expect(s.expectedTopics).toEqual(['独立复跑', '原始输出']);
    expect(s.mustNotClaim).toEqual(['tests pass based on the implementation report']);
    expect((s.inputEnvelope as { schema_id: string }).schema_id).toBe('project-orchestrator/testing-input');
    expect(s.body).toContain('全部测试通过');
  });

  it('rejects a role mismatch between path and frontmatter', () => {
    expect(() => parseScenario('research', 'x', ok)).toThrow(/role mismatch/);
  });

  it('rejects missing required fields', () => {
    const missing = ok.replace('must_not_claim:\n  - tests pass based on the implementation report\n', '');
    expect(() => parseScenario('testing', 'x', missing)).toThrow(/must_not_claim/);
  });

  it('rejects a file without frontmatter', () => {
    expect(() => parseScenario('testing', 'x', 'no frontmatter here')).toThrow(/frontmatter/);
  });
});
