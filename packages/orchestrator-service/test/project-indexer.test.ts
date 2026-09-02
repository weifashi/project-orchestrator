import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildProjectIndex } from '../src/project-indexer.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'project-indexer-'));
  directories.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  return root;
}

function file(root: string, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function track(root: string): void {
  execFileSync('git', ['-C', root, 'add', '-A']);
}

it('indexes safe tracked files and extracts common language structure', async () => {
  const root = repository();
  file(root, 'src/app.ts', "import { run } from './run.js';\nimport 'https://user:secret@example.com/pkg.ts?token=hidden';\nimport 'file:///home/alice/private.ts';\nimport '\\\\server\\share\\private.ts';\nexport function start() {}\nexport interface Options {}\n");
  file(root, 'cmd/main.go', 'package main\nimport "fmt"\ntype Server struct{}\nfunc Start() {}\n');
  file(root, 'lib/main.dart', "import 'package:flutter/widgets.dart';\nclass App {}\nvoid boot() {}\n");
  file(root, 'tools/main.py', 'from pathlib import Path\nclass Tool:\n    pass\ndef run():\n    pass\n');
  file(root, 'README.md', '# Project\n');
  file(root, '.env', 'PASSWORD=hidden\n');
  file(root, '.envrc', 'export PASSWORD=hidden\n');
  file(root, 'vault.kdbx', 'credential container');
  file(root, 'config.keystore', 'credential container');
  file(root, 'odd-name.txt', '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n');
  file(root, 'dist/generated.js', 'export const generated = true;\n');
  file(root, 'binary.dat', Buffer.from([0, 1, 2]));
  file(root, 'nul-late.dat', Buffer.concat([Buffer.alloc(9_000, 65), Buffer.from([0])]));
  file(root, 'large.txt', Buffer.alloc(1024 * 1024 + 1, 65));
  file(root, 'untracked.ts', 'export const no = true;\n');
  symlinkSync('/tmp', join(root, 'outside-link'));
  track(root);
  execFileSync('git', ['-C', root, 'reset', 'untracked.ts']);

  const result = await buildProjectIndex({ root, now: '2026-09-02T00:00:00.000Z' });

  expect(result.envelope.data.files.map((entry) => entry.path)).toEqual([
    'README.md', 'cmd/main.go', 'lib/main.dart', 'src/app.ts', 'tools/main.py',
  ]);
  expect(result.envelope.data.files.find((entry) => entry.path === 'src/app.ts')).toMatchObject({
    language: 'typescript', imports: ['./run.js', '[absolute-import]', 'https://example.com/pkg.ts'],
    symbols: [{ kind: 'function', name: 'start', line: 5 }, { kind: 'interface', name: 'Options', line: 6 }],
  });
  expect(result.envelope.data.files.find((entry) => entry.path === 'cmd/main.go')).toMatchObject({
    imports: ['fmt'], symbols: [{ kind: 'type', name: 'Server', line: 3 }, { kind: 'function', name: 'Start', line: 4 }],
  });
  expect(result.envelope.data.files.find((entry) => entry.path === 'lib/main.dart')).toMatchObject({
    imports: ['package:flutter/widgets.dart'],
    symbols: [{ kind: 'class', name: 'App', line: 2 }, { kind: 'function', name: 'boot', line: 3 }],
  });
  expect(result.envelope.data.files.find((entry) => entry.path === 'tools/main.py')).toMatchObject({
    imports: ['pathlib'], symbols: [{ kind: 'class', name: 'Tool', line: 2 }, { kind: 'function', name: 'run', line: 4 }],
  });
  expect(result.envelope.data.skipped).toEqual({
    binary: 2, generated_or_dependency: 1, sensitive: 5, too_large: 1, unsupported_or_missing: 1,
  });
  expect(JSON.stringify(result.envelope)).not.toContain('PASSWORD=hidden');
  expect(JSON.stringify(result.envelope)).not.toContain('secret');
});

it('reuses unchanged records and counts added, changed, and deleted paths', async () => {
  const root = repository();
  file(root, 'a.ts', 'export const a = 1;\n');
  file(root, 'b.ts', 'export const b = 1;\n');
  track(root);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
  const first = await buildProjectIndex({ root, now: '2026-09-02T00:00:00.000Z' });

  file(root, 'a.ts', 'export const a = 2;\n');
  rmSync(join(root, 'b.ts'));
  file(root, 'c.py', 'def created():\n    pass\n');
  track(root);
  const second = await buildProjectIndex({ root, previous: first.envelope, now: '2026-09-02T00:01:00.000Z' });

  expect(second.changedFileCount).toBe(3);
  expect(second.reusedFileCount).toBe(0);
  expect(second.envelope.data.files.map((entry) => entry.path)).toEqual(['a.ts', 'c.py']);
  expect(second.envelope.data.tree_fingerprint).not.toBe(first.envelope.data.tree_fingerprint);

  const third = await buildProjectIndex({ root, previous: second.envelope, now: '2026-09-02T00:02:00.000Z' });
  expect(third.changedFileCount).toBe(0);
  expect(third.reusedFileCount).toBe(2);
});
