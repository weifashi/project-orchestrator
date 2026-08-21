import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export type GitWorkspaceSnapshot = Readonly<{
  canonicalProjectPath: string;
  repositoryHead: string;
  stagedPatch: string;
  unstagedPatch: string;
  untrackedManifest: unknown;
  submoduleManifest: unknown;
}>;

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trimEnd();
  } catch {
    throw new Error('WORKSPACE_SNAPSHOT_UNAVAILABLE');
  }
}

/** Captures the immutable Git state required before a Run can be created. */
export function captureGitWorkspaceSnapshot(cwd: string): GitWorkspaceSnapshot {
  const canonicalProjectPath = realpathSync(cwd);
  return {
    canonicalProjectPath,
    repositoryHead: git(canonicalProjectPath, ['rev-parse', 'HEAD']),
    stagedPatch: git(canonicalProjectPath, ['diff', '--cached', '--no-ext-diff']),
    unstagedPatch: git(canonicalProjectPath, ['diff', '--no-ext-diff']),
    untrackedManifest: git(canonicalProjectPath, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean),
    submoduleManifest: git(canonicalProjectPath, ['submodule', 'status', '--recursive']).split('\n').filter(Boolean),
  };
}
