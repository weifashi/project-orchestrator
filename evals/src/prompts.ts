import type { RoleFiles } from './roles.js';
import type { Scenario } from './scenario.js';

// SKILL.md 让角色去读 references/*，但 API 调用里没有文件系统，所以把它们原文内联进 system prompt。
export function executorPrompt(role: RoleFiles, scenario: Scenario): { system: string; user: string } {
  const references = Object.entries(role.references)
    .map(([name, content]) => `\n\n---\n\n## references/${name}\n\n${content}`)
    .join('');
  const system = `${role.skill}${references}`;
  const user = [
    `# Scenario: ${scenario.title}`,
    '',
    scenario.body,
    '',
    '# Stage input envelope',
    '',
    '```json',
    JSON.stringify(scenario.inputEnvelope, null, 2),
    '```',
    '',
    'Act as this role for the stage above. Reply with only one JSON object: the output envelope that validates against references/output-schema.json. No prose before or after the JSON.',
  ].join('\n');
  return { system, user };
}

export function judgePrompt(rubric: string, role: RoleFiles, scenario: Scenario, outputText: string): { system: string; user: string } {
  const user = [
    `# Role under evaluation: ${role.role}`,
    '',
    '## SKILL.md',
    '',
    role.skill,
    '',
    '## Forbidden claims and actions (for the boundary dimension)',
    '',
    role.forbiddenSection,
    '',
    `## Scenario: ${scenario.title}`,
    '',
    scenario.body,
    '',
    `Expected topics: ${scenario.expectedTopics.join(', ')}`,
    '',
    '## Stage input envelope',
    '',
    '```json',
    JSON.stringify(scenario.inputEnvelope, null, 2),
    '```',
    '',
    '## Output produced by the role',
    '',
    outputText,
  ].join('\n');
  return { system: rubric, user };
}

// 取文本里第一个花括号平衡的对象；模型偶尔会在 JSON 外加一句话或代码围栏。
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, index + 1)) as unknown; } catch { return undefined; }
      }
    }
  }
  return undefined;
}
