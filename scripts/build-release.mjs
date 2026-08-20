import { createHash } from 'node:crypto';
import process from 'node:process';
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { basename, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const release = join(root, 'release', `project-orchestrator-${pkg.version}`);
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
};
await rm(release, { recursive: true, force: true });
run('pnpm', ['build']);
await mkdir(join(release, 'app'), { recursive: true });
for (const [filter, name] of [
  ['@project-orchestrator/control-server', 'control'],
  ['@project-orchestrator/mcp-adapter', 'mcp'],
  ['@project-orchestrator/operation-executor', 'operations'],
]) {
  run('pnpm', ['--filter', filter, 'deploy', '--legacy', '--prod', join(release, 'app', name)]);
}
await cp(join(root, 'apps/web-console/dist'), join(release, 'web'), { recursive: true });
await cp(join(root, 'packages/sqlite-store/migrations'), join(release, 'migrations'), { recursive: true });
await cp(join(root, 'adapters/codex/project-orchestrator'), join(release, 'marketplaces/codex/plugins/project-orchestrator'), { recursive: true });
await mkdir(join(release, 'marketplaces/codex/.agents/plugins'), { recursive: true });
await cp(join(root, 'distribution/codex-marketplace/marketplace.json'), join(release, 'marketplaces/codex/.agents/plugins/marketplace.json'));
await cp(join(root, 'adapters/claude/project-orchestrator'), join(release, 'marketplaces/claude/plugins/project-orchestrator'), { recursive: true });
await mkdir(join(release, 'marketplaces/claude/.claude-plugin'), { recursive: true });
await cp(join(root, 'distribution/claude-marketplace/marketplace.json'), join(release, 'marketplaces/claude/.claude-plugin/marketplace.json'));
await cp(join(root, 'installer'), join(release, 'installer'), { recursive: true });
await cp(join(root, 'scripts/install.sh'), join(release, 'install.sh'));
await cp(join(root, 'LICENSE'), join(release, 'LICENSE'));
await writeFile(join(release, 'VERSION'), `${pkg.version}\n`);

const wrapper = (entry, prelude = '') => `#!/usr/bin/env bash\nset -euo pipefail\nSOURCE=$(readlink -f "${'${BASH_SOURCE[0]}'}")\nROOT=$(cd "$(dirname "$SOURCE")/.." && pwd)\n${prelude}exec node "$ROOT/${entry}" "$@"\n`;
await mkdir(join(release, 'bin'), { recursive: true });
const common = 'export PROJECT_ORCHESTRATOR_WEB_STATIC="$ROOT/web"\nexport PROJECT_ORCHESTRATOR_VERSION_FILE="$ROOT/VERSION"\n';
const wrappers = {
  'project-orchestratord': wrapper('app/control/dist/main.js', common),
  'project-orchestrator': wrapper('app/control/dist/main.js', common),
  'project-orchestrator-mcp': wrapper('app/mcp/dist/main.js'),
  'project-orchestrator-operations': wrapper('app/operations/dist/main.js', 'SOCKET=${PROJECT_ORCHESTRATOR_OPERATION_SOCKET:-"$HOME/.project-orchestrator/runtime/operations.sock"}\nset -- "$SOCKET" "$@"\n'),
};
for (const [name, contents] of Object.entries(wrappers)) {
  const path = join(release, 'bin', name); await writeFile(path, contents); await chmod(path, 0o755);
}

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path)); else if (entry.isFile()) result.push(path);
  }
  return result;
}
for (const path of await files(release)) if (path.endsWith('.map')) await rm(path);
const inventory = [];
for (const name of ['control', 'mcp', 'operations']) {
  const deployed = JSON.parse(await readFile(join(release, 'app', name, 'package.json'), 'utf8'));
  inventory.push({ name: deployed.name, version: deployed.version, dependencies: deployed.dependencies ?? {} });
}
await writeFile(join(release, 'THIRD_PARTY_NOTICES.json'), `${JSON.stringify(inventory, null, 2)}\n`);
const manifestLines = [];
for (const path of (await files(release)).sort()) {
  if (basename(path) === 'manifest.sha256') continue;
  manifestLines.push(`${createHash('sha256').update(await readFile(path)).digest('hex')}  ${relative(release, path)}`);
}
await writeFile(join(release, 'manifest.sha256'), `${manifestLines.join('\n')}\n`);
// Legacy pnpm deploy switches the workspace modules metadata to production mode.
// Restore the development install so release builds do not poison later checks.
run('pnpm', ['install', '--frozen-lockfile']);
process.stdout.write(`${release}\n`);
