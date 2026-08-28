import { createHash } from 'node:crypto';
import process from 'node:process';
import { rmSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const release = join(root, 'release', `project-orchestrator-${pkg.version}`);
const staging = join(root, 'release', `.project-orchestrator-${pkg.version}-staging-${process.pid}`);
const ready = join(root, 'release', `.project-orchestrator-${pkg.version}-ready-${process.pid}`);
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
};
let workspaceDeployActive = false;
process.once('exit', () => {
  rmSync(staging, { recursive: true, force: true });
  rmSync(ready, { recursive: true, force: true });
  if (!workspaceDeployActive) return;
  const result = spawnSync('pnpm', ['install', '--frozen-lockfile'], { cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
  if (result.status !== 0) process.exitCode = 1;
});
await rm(staging, { recursive: true, force: true });
await rm(ready, { recursive: true, force: true });
run('pnpm', ['build']);
await mkdir(join(staging, 'app'), { recursive: true });
workspaceDeployActive = true;
const deployments = [
  ['@project-orchestrator/control-server', 'control'],
  ['@project-orchestrator/mcp-adapter', 'mcp'],
  ['@project-orchestrator/operation-executor', 'operations'],
];
for (const [filter, name] of deployments) {
  run('pnpm', ['--filter', filter, 'deploy', '--legacy', '--prod', join(staging, 'app', name)]);
}
// pnpm deploy leaves build-machine metadata and command shims in node_modules.
// .modules.yaml contains a timestamp and store path, while generated .bin files
// contain the per-process staging path. Neither is needed by the runtime, and
// retaining them makes two builds from identical source produce different bytes.
async function removeDeployMetadata(directory, insideNodeModules = false) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const nestedNodeModules = insideNodeModules || entry.name === 'node_modules';
    if (nestedNodeModules && entry.isDirectory() && entry.name === '.bin') {
      await rm(path, { recursive: true, force: true });
    } else if (nestedNodeModules && entry.isFile() && entry.name === '.modules.yaml') {
      await rm(path);
    } else if (entry.isDirectory()) {
      await removeDeployMetadata(path, nestedNodeModules);
    }
  }
}
for (const [, name] of deployments) await removeDeployMetadata(join(staging, 'app', name));
await cp(join(root, 'apps/web-console/dist'), join(staging, 'web'), { recursive: true });
await cp(join(root, 'packages/sqlite-store/migrations'), join(staging, 'migrations'), { recursive: true });
await cp(join(root, 'adapters/codex/project-orchestrator'), join(staging, 'marketplaces/codex/plugins/project-orchestrator'), { recursive: true });
await mkdir(join(staging, 'marketplaces/codex/.agents/plugins'), { recursive: true });
await cp(join(root, 'distribution/codex-marketplace/marketplace.json'), join(staging, 'marketplaces/codex/.agents/plugins/marketplace.json'));
await cp(join(root, 'adapters/claude/project-orchestrator'), join(staging, 'marketplaces/claude/plugins/project-orchestrator'), { recursive: true });
await mkdir(join(staging, 'marketplaces/claude/.claude-plugin'), { recursive: true });
await cp(join(root, 'distribution/claude-marketplace/marketplace.json'), join(staging, 'marketplaces/claude/.claude-plugin/marketplace.json'));
await cp(join(root, 'installer'), join(staging, 'installer'), { recursive: true });
await cp(join(root, 'scripts/install.sh'), join(staging, 'install.sh'));
await cp(join(root, 'LICENSE'), join(staging, 'LICENSE'));
await writeFile(join(staging, 'VERSION'), `${pkg.version}\n`);

const wrapper = (entry, prelude = '') => `#!/usr/bin/env bash\nset -euo pipefail\nSOURCE=$(readlink -f "${'${BASH_SOURCE[0]}'}")\nROOT=$(cd "$(dirname "$SOURCE")/.." && pwd)\n${prelude}exec node "$ROOT/${entry}" "$@"\n`;
await mkdir(join(staging, 'bin'), { recursive: true });
const common = 'export PROJECT_ORCHESTRATOR_WEB_STATIC="$ROOT/web"\nexport PROJECT_ORCHESTRATOR_VERSION_FILE="$ROOT/VERSION"\n';
const wrappers = {
  'project-orchestratord': wrapper('app/control/dist/main.js', common),
  'project-orchestrator': wrapper('app/control/dist/main.js', common),
  'project-orchestrator-mcp': wrapper('app/mcp/dist/main.js', common),
  'project-orchestrator-operations': wrapper('app/operations/dist/main.js', 'SOCKET=${PROJECT_ORCHESTRATOR_OPERATION_SOCKET:-"$HOME/.project-orchestrator/runtime/operations.sock"}\nset -- "$SOCKET" "$@"\n'),
};
for (const [name, contents] of Object.entries(wrappers)) {
  const path = join(staging, 'bin', name); await writeFile(path, contents); await chmod(path, 0o755);
}

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path)); else if (entry.isFile()) result.push(path);
  }
  return result;
}
for (const path of await files(staging)) if (path.endsWith('.map')) await rm(path);
const inventory = [];
for (const name of ['control', 'mcp', 'operations']) {
  const deployed = JSON.parse(await readFile(join(staging, 'app', name, 'package.json'), 'utf8'));
  inventory.push({ name: deployed.name, version: deployed.version, dependencies: deployed.dependencies ?? {} });
}
await writeFile(join(staging, 'THIRD_PARTY_NOTICES.json'), `${JSON.stringify(inventory, null, 2)}\n`);
// pnpm deploy may hardlink files to the workspace. A second filesystem copy
// creates an isolated release tree so installed or retained releases cannot
// mutate source files or each other.
await cp(staging, ready, { recursive: true });
const workspaceDeployments = new Map([
  [join(root, 'apps/control-server'), join(ready, 'app/control')],
  [join(root, 'packages/mcp-adapter'), join(ready, 'app/mcp')],
  [join(root, 'packages/operation-executor'), join(ready, 'app/operations')],
]);
async function relocateSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await relocateSymlinks(path);
    else if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      const resolvedTarget = resolve(dirname(path), target);
      const relocated = target.startsWith(staging)
        ? `${ready}${target.slice(staging.length)}`
        : workspaceDeployments.get(resolvedTarget);
      if (relocated !== undefined) {
        await unlink(path);
        await symlink(relative(dirname(path), relocated), path);
      }
    }
  }
}
await relocateSymlinks(ready);
async function symlinkInventory(directory, releaseRoot) {
  const inventory = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(inventory, await symlinkInventory(path, releaseRoot));
    else if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      const resolvedTarget = resolve(dirname(path), target);
      if (target.startsWith('/') || (resolvedTarget !== releaseRoot && !resolvedTarget.startsWith(`${releaseRoot}/`))) {
        throw new Error(`unsafe release symlink: ${relative(releaseRoot, path)}`);
      }
      inventory[relative(releaseRoot, path)] = target;
    }
  }
  return inventory;
}
await writeFile(join(ready, 'symlinks.json'), `${JSON.stringify(await symlinkInventory(ready, ready), null, 2)}\n`);
await rm(staging, { recursive: true, force: true });
const workspaceInodes = new Set();
for (const directory of ['apps', 'packages', 'adapters', 'distribution', 'installer', 'scripts', 'skills'].map((name) => join(root, name))) {
  for (const path of await files(directory)) {
    const entry = await stat(path);
    workspaceInodes.add(`${entry.dev}:${entry.ino}`);
  }
}
for (const name of ['LICENSE', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
  const entry = await stat(join(root, name));
  workspaceInodes.add(`${entry.dev}:${entry.ino}`);
}
for (const path of await files(ready)) {
  const entry = await stat(path);
  if (workspaceInodes.has(`${entry.dev}:${entry.ino}`)) throw new Error(`release isolation failed: ${relative(ready, path)} is hardlinked to workspace`);
}
const manifestLines = [];
for (const path of (await files(ready)).sort()) {
  if (basename(path) === 'manifest.sha256') continue;
  manifestLines.push(`${createHash('sha256').update(await readFile(path)).digest('hex')}  ${relative(ready, path)}`);
}
await writeFile(join(ready, 'manifest.sha256'), `${manifestLines.join('\n')}\n`);
// Legacy pnpm deploy switches the workspace modules metadata to production mode.
// Restore the development install so release builds do not poison later checks.
run('pnpm', ['install', '--frozen-lockfile']);
workspaceDeployActive = false;
let releaseExists = true;
try {
  await stat(release);
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') releaseExists = false;
  else throw error;
}
if (releaseExists) {
  const existingCheck = spawnSync('sha256sum', ['-c', 'manifest.sha256'], { cwd: release, stdio: 'ignore' });
  if (existingCheck.status !== 0) throw new Error(`existing release ${pkg.version} failed manifest verification; increment the version instead of replacing it`);
  const expectedSymlinks = JSON.parse(await readFile(join(release, 'symlinks.json'), 'utf8'));
  const actualSymlinks = await symlinkInventory(release, release);
  const normalize = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
  if (normalize(expectedSymlinks) !== normalize(actualSymlinks)) throw new Error(`existing release ${pkg.version} failed symlink verification; increment the version instead of replacing it`);
  const existingManifest = await readFile(join(release, 'manifest.sha256'), 'utf8');
  const readyManifest = await readFile(join(ready, 'manifest.sha256'), 'utf8');
  if (existingManifest !== readyManifest) throw new Error(`release ${pkg.version} already exists with different contents; increment the version`);
  await rm(ready, { recursive: true, force: true });
} else await rename(ready, release);
process.stdout.write(`${release}\n`);
