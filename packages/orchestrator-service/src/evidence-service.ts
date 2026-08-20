import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson, type ContentStore } from '@project-orchestrator/content-store';
import { WorkspaceCheckpointRepository } from '@project-orchestrator/sqlite-store';
import type { AuthenticatedAdapterContext, WorkspaceState } from './runtime-types.js';

export const workspaceFingerprint = (state: WorkspaceState): string => createHash('sha256')
  .update(canonicalJson({
    repositoryHead: state.repositoryHead,
    stagedPatch: state.stagedPatch,
    unstagedPatch: state.unstagedPatch,
    untrackedManifest: state.untrackedManifest,
    submoduleManifest: state.submoduleManifest,
  }))
  .digest('hex');

function within(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== '' && !child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child);
}

type ArtifactInput = {
  runId: string;
  stageAttemptId: string;
  sourcePath: string;
  artifactType: 'document' | 'log' | 'test_evidence' | 'file_manifest' | 'ui_prototype' | 'deployment_record' | 'rollback_record' | 'other';
  summary: string;
  producerRoleVersionId: string;
  adapterContext: AuthenticatedAdapterContext;
  metadata?: unknown;
};

function authenticatedProjectRoot(databasePath: string, adapterPath: string): string {
  try {
    if (!isAbsolute(databasePath) || !isAbsolute(adapterPath)) throw new Error('not absolute');
    const databaseStats = lstatSync(databasePath);
    const adapterStats = lstatSync(adapterPath);
    if (databaseStats.isSymbolicLink() || adapterStats.isSymbolicLink()
      || !databaseStats.isDirectory() || !adapterStats.isDirectory()) throw new Error('not canonical directories');
    const databaseRoot = realpathSync(databasePath);
    const adapterRoot = realpathSync(adapterPath);
    if (databaseRoot !== resolve(databasePath) || adapterRoot !== resolve(adapterPath) || databaseRoot !== adapterRoot) {
      throw new Error('path mismatch');
    }
    return databaseRoot;
  } catch {
    throw new Error('PROJECT_PATH_CHANGED: authenticated adapter project does not match run project');
  }
}

export class EvidenceService {
  constructor(readonly db: Database.Database, readonly content: ContentStore) {}

  recordArtifact(input: ArtifactInput): { id: string; contentObjectId: string } {
    const ownership = this.db.prepare(`SELECT p.canonical_path,s.role_version_id,s.status AS stage_status,
        s.latest_attempt_id,a.status AS attempt_status
      FROM stage_attempts a JOIN stage_runs s ON s.id=a.stage_run_id
      JOIN runs r ON r.id=s.run_id JOIN projects p ON p.id=r.project_id
      WHERE a.id=? AND r.id=?`).get(input.stageAttemptId, input.runId) as {
        canonical_path: string; role_version_id: string; stage_status: string;
        latest_attempt_id: string | null; attempt_status: string;
      } | undefined;
    if (!ownership) throw new Error('POLICY_VIOLATION: attempt does not belong to run');
    if (ownership.role_version_id !== input.producerRoleVersionId) throw new Error('POLICY_VIOLATION: producer role mismatch');
    if (ownership.latest_attempt_id !== input.stageAttemptId
      || ownership.attempt_status !== 'running' || ownership.stage_status !== 'running') {
      throw new Error('INVALID_TRANSITION: artifact requires running latest attempt');
    }
    const root = authenticatedProjectRoot(ownership.canonical_path, input.adapterContext.canonicalProjectPath);
    const candidate = resolve(root, input.sourcePath);
    if (!within(root, candidate)) throw new Error('POLICY_VIOLATION: artifact outside project');
    let descriptor: number | undefined;
    try {
      try {
        descriptor = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('ARTIFACT_MISSING: source file does not exist');
        throw error;
      }
      const descriptorStats = fstatSync(descriptor);
      const pathStats = lstatSync(candidate);
      if (!descriptorStats.isFile() || pathStats.isSymbolicLink() || !pathStats.isFile()) throw new Error('ARTIFACT_MISSING: not a regular file');
      if (descriptorStats.nlink !== 1) throw new Error('POLICY_VIOLATION: hard-linked artifact rejected');
      if (descriptorStats.dev !== pathStats.dev || descriptorStats.ino !== pathStats.ino) throw new Error('POLICY_VIOLATION: artifact changed while opening');
      const resolved = realpathSync(candidate);
      if (!within(root, resolved)) throw new Error('POLICY_VIOLATION: artifact outside project');
      const object = this.content.putBytes(readFileSync(descriptor), 'application/octet-stream');
      const id = randomUUID();
      this.db.prepare(`INSERT INTO artifacts
        (id,run_id,stage_attempt_id,artifact_type,content_object_id,source_path,summary,producer_role_version_id,metadata_envelope,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(id, input.runId, input.stageAttemptId, input.artifactType, object.id, input.sourcePath, input.summary,
          input.producerRoleVersionId, canonicalJson(input.metadata ?? {}), new Date().toISOString());
      return { id, contentObjectId: object.id };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  recordCheckpoint(input: { runId: string; stageAttemptId?: string; kind: 'run_start' | 'before_attempt' | 'progress' | 'after_attempt'; baselineFingerprint: string; state: WorkspaceState }): { id: string; fingerprint: string; sequence: number } {
    const work = (): { id: string; fingerprint: string; sequence: number } => {
      const checkpoints = new WorkspaceCheckpointRepository(this.db);
      const trusted = checkpoints.latest(input.runId);
      const snapshot = this.db.prepare('SELECT working_tree_fingerprint FROM run_snapshots WHERE run_id=?')
        .get(input.runId) as { working_tree_fingerprint: string } | undefined;
      const expectedBaseline = trusted?.resulting_fingerprint ?? snapshot?.working_tree_fingerprint;
      if (input.kind === 'run_start' && (trusted !== undefined || snapshot === undefined
        || input.stageAttemptId !== undefined || input.baselineFingerprint !== snapshot.working_tree_fingerprint)) {
        throw new Error('POLICY_VIOLATION: invalid run-start checkpoint');
      }
      if (input.kind !== 'run_start' && (trusted === undefined || expectedBaseline === undefined
        || input.baselineFingerprint !== expectedBaseline)) {
        throw new Error('WORKTREE_CHANGED: checkpoint baseline mismatch');
      }
      if (input.stageAttemptId !== undefined) {
        const attempt = this.db.prepare(`SELECT a.status AS attempt_status,s.status AS stage_status,s.latest_attempt_id
          FROM stage_attempts a JOIN stage_runs s ON s.id=a.stage_run_id
          WHERE a.id=? AND s.run_id=?`).get(input.stageAttemptId, input.runId) as {
            attempt_status: string; stage_status: string; latest_attempt_id: string | null;
          } | undefined;
        if (!attempt) throw new Error('POLICY_VIOLATION: checkpoint attempt does not belong to run');
        if (attempt.latest_attempt_id !== input.stageAttemptId) {
          throw new Error('POLICY_VIOLATION: checkpoint requires latest attempt');
        }
        if (['before_attempt', 'progress'].includes(input.kind)
          && (attempt.attempt_status !== 'running' || attempt.stage_status !== 'running')) {
          throw new Error('POLICY_VIOLATION: active checkpoint requires running attempt and stage');
        }
        if (input.kind === 'after_attempt'
          && (attempt.attempt_status !== 'succeeded' || attempt.stage_status !== 'succeeded')) {
          throw new Error('POLICY_VIOLATION: after checkpoint requires succeeded attempt and stage');
        }
      } else if (input.kind !== 'run_start') {
        throw new Error('POLICY_VIOLATION: attempt checkpoint requires attempt');
      }
      const staged = this.content.putUtf8(input.state.stagedPatch);
      const unstaged = this.content.putUtf8(input.state.unstagedPatch);
      const untracked = this.content.putCanonicalJson(input.state.untrackedManifest);
      const submodule = this.content.putCanonicalJson(input.state.submoduleManifest);
      const fingerprint = workspaceFingerprint(input.state);
      const id = randomUUID();
      const sequence = checkpoints.nextSequence(input.runId);
      this.db.prepare(`INSERT INTO workspace_checkpoints
        (id,run_id,sequence_number,stage_attempt_id,checkpoint_kind,repository_head,baseline_fingerprint,resulting_fingerprint,
         staged_patch_object_id,unstaged_patch_object_id,untracked_manifest_object_id,submodule_manifest_object_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, input.runId, sequence, input.stageAttemptId ?? null, input.kind, input.state.repositoryHead, input.baselineFingerprint,
          fingerprint, staged.id, unstaged.id, untracked.id, submodule.id, new Date().toISOString());
      return { id, fingerprint, sequence };
    };
    return this.db.inTransaction ? work() : this.db.transaction(work).immediate();
  }
}
