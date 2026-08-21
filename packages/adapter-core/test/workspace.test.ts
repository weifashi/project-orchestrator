import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureGitWorkspaceSnapshot } from '../src/workspace.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

it('captures the committed, changed, and untracked state of a Git workspace', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-snapshot-'));
  directories.push(directory);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory });
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(directory, 'tracked.txt'), 'first\n');
  git('add', 'tracked.txt');
  git('commit', '-m', 'initial');
  writeFileSync(join(directory, 'tracked.txt'), 'second\n');
  writeFileSync(join(directory, 'new.txt'), 'new\n');

  const snapshot = captureGitWorkspaceSnapshot(directory);

  expect(snapshot.canonicalProjectPath).toBe(directory);
  expect(snapshot.repositoryHead).toMatch(/^[0-9a-f]{40}$/);
  expect(snapshot.unstagedPatch).toContain('-first');
  expect(snapshot.unstagedPatch).toContain('+second');
  expect(snapshot.untrackedManifest).toEqual(['new.txt']);
});

it('rejects a directory without a committed Git workspace', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-snapshot-'));
  directories.push(directory);
  expect(() => captureGitWorkspaceSnapshot(directory)).toThrow('WORKSPACE_SNAPSHOT_UNAVAILABLE');
});
