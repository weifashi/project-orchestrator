import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { readFile, stat } from 'node:fs/promises';
import YAML from 'yaml';
import { ROLE_SLUGS } from './validate-skills.mjs';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

const codexRoot = 'adapters/codex/project-orchestrator';
const claudeRoot = 'adapters/claude/project-orchestrator';
const codex = JSON.parse(await readFile(`${codexRoot}/.codex-plugin/plugin.json`, 'utf8'));
const claude = JSON.parse(await readFile(`${claudeRoot}/.claude-plugin/plugin.json`, 'utf8'));
if (codex.name !== 'project-orchestrator' || claude.name !== codex.name || claude.version !== codex.version) {
  throw new Error('Plugin identity/version mismatch');
}
if (codex.skills !== './skills/' || codex.mcpServers !== './.mcp.json') throw new Error('Codex component declarations missing');
for (const root of [codexRoot, claudeRoot]) {
  await stat(`${root}/skills/project-orchestrator/SKILL.md`);
  const mcp = JSON.parse(await readFile(`${root}/.mcp.json`, 'utf8'));
  const server = mcp.mcpServers?.['project-orchestrator'];
  if (server?.command !== 'project-orchestrator-mcp' || !Array.isArray(server.args) || server.args.length !== 2) {
    throw new Error(`${root}: invalid MCP command`);
  }
}
const requiredNativeTools = {
  'ui-design': ['Write', 'Edit'],
  implementation: ['Write', 'Edit', 'Bash'],
  testing: ['Bash'],
};
for (const slug of ROLE_SLUGS) {
  const markdown = await readFile(`${claudeRoot}/agents/${slug}.md`, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (match === null) throw new Error(`Claude agent ${slug}: missing frontmatter`);
  const frontmatter = YAML.parse(match[1]);
  const tools = String(frontmatter.tools ?? '').split(',').map((tool) => tool.trim());
  if (tools.some((tool) => tool.startsWith('mcp__project-orchestrator__'))) {
    throw new Error(`Claude agent ${slug}: orchestration write tool exposed`);
  }
  for (const required of requiredNativeTools[slug] ?? []) {
    if (!tools.includes(required)) throw new Error(`Claude agent ${slug}: missing native tool ${required}`);
  }
}
run('python3', ['/home/weifashi/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py', codexRoot]);
run('claude', ['plugin', 'validate', '--strict', claudeRoot]);
process.stdout.write('Validated Codex and Claude plugin manifests.\n');
