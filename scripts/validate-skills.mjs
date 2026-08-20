import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';

export const ROLE_SLUGS = [
  'requirements', 'research', 'architecture', 'ui-design', 'implementation',
  'code-review', 'testing', 'security', 'operations', 'memory-docs',
];
const ALL_SKILLS = ['project-orchestrator', ...ROLE_SLUGS];
const ROLE_HEADINGS = [
  '# ', '## Responsibility', '## Required inputs', '## Procedure',
  '## Required outputs', '## Completion checks', '## Forbidden claims and actions',
];

function parseFrontmatter(markdown, path) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (match === null) throw new Error(`${path}: missing YAML frontmatter`);
  const value = YAML.parse(match[1]);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: invalid frontmatter`);
  return value;
}

async function validateOpenAiYaml(directory) {
  const path = `${directory}/agents/openai.yaml`;
  const value = YAML.parse(await readFile(path, 'utf8'));
  const topKeys = Object.keys(value ?? {});
  if (topKeys.length !== 1 || topKeys[0] !== 'interface') throw new Error(`${path}: only interface is allowed`);
  const expected = ['display_name', 'short_description', 'default_prompt'];
  const keys = Object.keys(value.interface ?? {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) throw new Error(`${path}: unexpected interface keys`);
  if (!String(value.interface.default_prompt).includes(`$${directory.split('/').at(-1)}`)) {
    throw new Error(`${path}: default_prompt must name the Skill`);
  }
}

export async function validateAllSkills(root = resolve('skills')) {
  const actual = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...ALL_SKILLS].sort())) throw new Error(`Skill slugs differ: ${actual.join(',')}`);
  const seedSource = await readFile(resolve('packages/orchestrator-service/src/seed-builtins.ts'), 'utf8');
  for (const slug of ROLE_SLUGS) {
    if (!seedSource.includes(`'${slug}'`)) throw new Error(`Built-in seed is missing role ${slug}`);
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  let schemaCount = 0;
  for (const slug of ALL_SKILLS) {
    const directory = resolve(root, slug);
    const skillPath = `${directory}/SKILL.md`;
    const markdown = await readFile(skillPath, 'utf8');
    const frontmatter = parseFrontmatter(markdown, skillPath);
    if (JSON.stringify(Object.keys(frontmatter).sort()) !== JSON.stringify(['description', 'name'])) {
      throw new Error(`${skillPath}: frontmatter permits only name and description`);
    }
    if (frontmatter.name !== slug) throw new Error(`${skillPath}: name/path mismatch`);
    if (!String(frontmatter.description).startsWith('Use when ')) throw new Error(`${skillPath}: description must start with Use when`);
    if (markdown.split('\n').length > 500) throw new Error(`${skillPath}: exceeds 500 lines`);
    if (/\b(TODO|TBD)\b|\/Users\/|\/home\/[^/]+\/|lease_token\s*[:=]|credential\s*[:=]/i.test(markdown)) {
      throw new Error(`${skillPath}: mutable path, placeholder, or secret-bearing example`);
    }
    if (ROLE_SLUGS.includes(slug)) {
      for (const heading of ROLE_HEADINGS) {
        if (!markdown.includes(heading)) throw new Error(`${skillPath}: missing heading ${heading}`);
      }
      for (const reference of ['input-schema.json', 'output-schema.json']) {
        const referencePath = `${directory}/references/${reference}`;
        const schema = JSON.parse(await readFile(referencePath, 'utf8'));
        ajv.compile(schema);
        schemaCount += 1;
      }
      await readFile(`${directory}/references/completion-contract.md`, 'utf8');
    } else {
      await readFile(`${directory}/references/tool-reference.md`, 'utf8');
      await readFile(`${directory}/references/error-recovery.md`, 'utf8');
    }
    await validateOpenAiYaml(directory);
  }
  return { skillCount: ALL_SKILLS.length, roleCount: ROLE_SLUGS.length, schemaCount };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateAllSkills().then((result) => {
    for (const slug of ALL_SKILLS) {
      const validation = spawnSync('python3', [
        '/home/weifashi/.codex/skills/.system/skill-creator/scripts/quick_validate.py',
        resolve('skills', slug),
      ], { encoding: 'utf8' });
      if (validation.status !== 0) throw new Error(validation.stderr || validation.stdout || `Official validation failed: ${slug}`);
    }
    process.stdout.write(`Validated ${result.skillCount} Skills, ${result.roleCount} roles, ${result.schemaCount} Schemas.\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
