import { describe, expect, it } from 'vitest';
import { listRoles, readRole } from '../src/roles.js';

describe('roles', () => {
  it('lists exactly the ten built-in roles, sorted, excluding the orchestrator skill', () => {
    const roles = listRoles();
    expect(roles).toEqual([
      'architecture', 'code-review', 'implementation', 'memory-docs', 'operations',
      'requirements', 'research', 'security', 'testing', 'ui-design',
    ]);
  });

  it('reads a role with its references and forbidden section', () => {
    const role = readRole('testing');
    expect(role.skill).toContain('# Testing');
    expect(Object.keys(role.references).sort()).toEqual(['completion-contract.md', 'input-schema.json', 'output-schema.json']);
    expect(role.completionContract).toContain('`test_matrix`');
    expect(role.forbiddenSection).toContain('Do not accept oral or implementation-role claims as evidence.');
    expect((role.outputSchema as { type: string }).type).toBe('object');
  });

  it('rejects an unknown role', () => {
    expect(() => readRole('nope')).toThrow(/unknown role/);
  });
});
