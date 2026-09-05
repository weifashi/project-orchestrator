import { describe, expect, it } from 'vitest';
import { hashRoleFiles, rubricHash, skillHash } from '../src/hash.js';
import { readRole } from '../src/roles.js';

describe('hash', () => {
  it('is a 64-char hex sha256 and stable across calls', () => {
    const a = skillHash('testing');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(skillHash('testing')).toBe(a);
  });

  it('differs between roles', () => {
    expect(skillHash('testing')).not.toBe(skillHash('research'));
  });

  it('changes when SKILL.md changes and when any reference changes', () => {
    const base = readRole('testing');
    const skillEdited = { ...base, skill: `${base.skill}\n- extra rule` };
    const referenceEdited = { ...base, references: { ...base.references, 'completion-contract.md': `${base.references['completion-contract.md']}\n- extra` } };
    expect(hashRoleFiles(skillEdited)).not.toBe(hashRoleFiles(base));
    expect(hashRoleFiles(referenceEdited)).not.toBe(hashRoleFiles(base));
  });

  it('hashes the rubric', () => {
    expect(rubricHash()).toMatch(/^[0-9a-f]{64}$/);
  });
});
