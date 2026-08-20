import { createHash } from 'node:crypto';
import process from 'node:process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { validateAllSkills } from './validate-skills.mjs';

const clients = ['codex', 'claude'];
const sourceRoot = resolve('skills');

async function files(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

async function manifest(root) {
  const result = {};
  for (const path of await files(root)) {
    result[relative(root, path)] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return result;
}

async function expectedManifest() {
  return { schema_version: 1, files: await manifest(sourceRoot) };
}

async function build() {
  await validateAllSkills();
  const expected = await expectedManifest();
  for (const client of clients) {
    const root = resolve(`adapters/${client}/project-orchestrator`);
    const target = resolve(root, 'skills');
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    for (const slug of await readdir(sourceRoot)) await cp(resolve(sourceRoot, slug), resolve(target, slug), { recursive: true });
    await writeFile(resolve(root, 'generated-manifest.json'), `${JSON.stringify(expected, null, 2)}\n`);
  }
  process.stdout.write(`Copied ${Object.keys(expected.files).length} Skill files to Codex and Claude plugins.\n`);
}

async function check() {
  await validateAllSkills();
  const expected = await expectedManifest();
  for (const client of clients) {
    const root = resolve(`adapters/${client}/project-orchestrator`);
    const actualFiles = await manifest(resolve(root, 'skills'));
    const actualManifest = JSON.parse(await readFile(resolve(root, 'generated-manifest.json'), 'utf8'));
    if (JSON.stringify(actualFiles) !== JSON.stringify(expected.files) || JSON.stringify(actualManifest) !== JSON.stringify(expected)) {
      throw new Error(`${client} generated Skill tree is stale`);
    }
  }
  process.stdout.write('Generated Codex and Claude Skill trees are deterministic and current.\n');
}

(process.argv.includes('--check') ? check() : build()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
