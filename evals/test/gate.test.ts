import { describe, expect, it } from 'vitest';
import { listRoles } from '../src/roles.js';
import { rubricHash, skillHash } from '../src/hash.js';
import { listScenarios } from '../src/scenario.js';
import { listRecordings } from '../src/recording.js';
import { readBaseline } from '../src/baseline.js';
import { checkRoleGate } from '../src/gate.js';

// 这是 CI 里挡回归的那道门。它不调模型：只读仓库里提交的场景、录制和基线。
// 改了 skills/<role>/SKILL.md 或 references/* 而没有重录，会在这里以 skill_hash 不匹配失败。
describe('role eval gate', () => {
  const roles = listRoles();
  const baseline = readBaseline();
  const currentRubricHash = rubricHash();

  it('covers exactly ten built-in roles', () => {
    expect(roles).toHaveLength(10);
  });

  for (const role of roles) {
    it(`${role}: scenarios, recordings, hashes, hard gates, and scores all hold`, () => {
      const result = checkRoleGate({
        role,
        scenarios: listScenarios(role),
        recordings: listRecordings(role),
        currentSkillHash: skillHash(role),
        currentRubricHash,
        baseline: baseline.roles[role],
      });
      expect(result.failures).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }
});
