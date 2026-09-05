import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillsDir } from './paths.js';

export type RoleFiles = Readonly<{
  role: string;
  skill: string;
  references: Record<string, string>;
  outputSchema: unknown;
  inputSchema: unknown;
  completionContract: string;
  forbiddenSection: string;
}>;

const ORCHESTRATOR_SKILL = 'project-orchestrator';

export function listRoles(): string[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ORCHESTRATOR_SKILL)
    .filter((entry) => existsSync(join(skillsDir, entry.name, 'SKILL.md')) && existsSync(join(skillsDir, entry.name, 'references')))
    .map((entry) => entry.name)
    .sort();
}

// 只取「## Forbidden claims and actions」到下一个二级标题之间的内容，供评判模型判 boundary。
function forbiddenSection(skill: string): string {
  const heading = '## Forbidden claims and actions';
  const start = skill.indexOf(heading);
  if (start === -1) return '';
  const rest = skill.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

export function readRole(role: string): RoleFiles {
  if (!listRoles().includes(role)) throw new Error(`unknown role: ${role}`);
  const dir = join(skillsDir, role);
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const referenceDir = join(dir, 'references');
  const references: Record<string, string> = {};
  for (const name of readdirSync(referenceDir).sort()) references[name] = readFileSync(join(referenceDir, name), 'utf8');
  return Object.freeze({
    role,
    skill,
    references,
    outputSchema: JSON.parse(references['output-schema.json'] ?? 'null') as unknown,
    inputSchema: JSON.parse(references['input-schema.json'] ?? 'null') as unknown,
    completionContract: references['completion-contract.md'] ?? '',
    forbiddenSection: forbiddenSection(skill),
  });
}
