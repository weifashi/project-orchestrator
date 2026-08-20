import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { ContentStore } from '@project-orchestrator/content-store';
import { WorkspaceCheckpointRepository } from '@project-orchestrator/sqlite-store';
import { workspaceFingerprint } from './evidence-service.js';
import type { AuthenticatedAdapterContext, WorkspaceState } from './runtime-types.js';

export type RecoveryMismatchCode =
  | 'PROJECT_PATH_CHANGED'
  | 'REPOSITORY_HEAD_CHANGED'
  | 'WORKTREE_CHANGED'
  | 'RULE_BUNDLE_CHANGED'
  | 'ADAPTER_INCOMPATIBLE'
  | 'SAFETY_BASELINE_INCOMPATIBLE'
  | 'ARTIFACT_MISSING';

export type RecoveryContext = AuthenticatedAdapterContext & Readonly<{
  ruleBundleObjectId: string;
  safetyBaselineObjectId: string;
  adapterCapabilityObjectId: string;
}>;

export type RecoveryCheck =
  | { ok: true }
  | { ok: false; code: RecoveryMismatchCode; diffObjectId: string };

type SnapshotRow = {
  workflow_object_id: string;
  role_bundle_object_id: string;
  rule_bundle_object_id: string;
  safety_baseline_object_id: string;
  adapter_capability_object_id: string;
  repository_head: string;
  staged_patch_object_id: string;
  unstaged_patch_object_id: string;
  untracked_manifest_object_id: string;
  submodule_manifest_object_id: string;
  working_tree_fingerprint: string;
};

function canonicalDirectory(path: string): string | undefined {
  try {
    if (!isAbsolute(path)) return undefined;
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return undefined;
    const actual = realpathSync(path);
    return actual === resolve(path) ? actual : undefined;
  } catch {
    return undefined;
  }
}

export class RecoveryService {
  constructor(readonly db: Database.Database, readonly content: ContentStore) {}

  check(runId: string, current: WorkspaceState, context: RecoveryContext): RecoveryCheck {
    const snapshot = this.db.prepare(`SELECT s.*,p.canonical_path FROM run_snapshots s
      JOIN runs r ON r.id=s.run_id JOIN projects p ON p.id=r.project_id WHERE s.run_id=?`)
      .get(runId) as (SnapshotRow & { canonical_path: string }) | undefined;
    if (!snapshot) throw new Error('NOT_FOUND: snapshot');
    const checkpoint = new WorkspaceCheckpointRepository(this.db).latest(runId);
    const mismatch = (code: RecoveryMismatchCode, details: Record<string, unknown>): RecoveryCheck => {
      const diff = this.content.putCanonicalJson({ code, ...details });
      return { ok: false, code, diffObjectId: diff.id };
    };

    const databaseRoot = canonicalDirectory(snapshot.canonical_path);
    const adapterRoot = canonicalDirectory(context.canonicalProjectPath);
    if (databaseRoot === undefined || adapterRoot === undefined || databaseRoot !== adapterRoot) {
      return mismatch('PROJECT_PATH_CHANGED', {
        expectedCanonicalPath: databaseRoot ?? snapshot.canonical_path,
        actualCanonicalPath: adapterRoot ?? context.canonicalProjectPath,
      });
    }

    const expectedHead = checkpoint?.repository_head ?? snapshot.repository_head;
    const expectedFingerprint = checkpoint?.resulting_fingerprint ?? snapshot.working_tree_fingerprint;
    if (current.repositoryHead !== expectedHead) {
      return mismatch('REPOSITORY_HEAD_CHANGED', { expectedHead, actualHead: current.repositoryHead });
    }
    const actualFingerprint = workspaceFingerprint(current);
    if (actualFingerprint !== expectedFingerprint) {
      return mismatch('WORKTREE_CHANGED', { expectedFingerprint, actualFingerprint });
    }
    if (context.ruleBundleObjectId !== snapshot.rule_bundle_object_id) {
      return mismatch('RULE_BUNDLE_CHANGED', {
        expectedObjectId: snapshot.rule_bundle_object_id, actualObjectId: context.ruleBundleObjectId,
      });
    }
    if (context.adapterCapabilityObjectId !== snapshot.adapter_capability_object_id) {
      return mismatch('ADAPTER_INCOMPATIBLE', {
        expectedObjectId: snapshot.adapter_capability_object_id, actualObjectId: context.adapterCapabilityObjectId,
      });
    }
    if (context.safetyBaselineObjectId !== snapshot.safety_baseline_object_id) {
      return mismatch('SAFETY_BASELINE_INCOMPATIBLE', {
        expectedObjectId: snapshot.safety_baseline_object_id, actualObjectId: context.safetyBaselineObjectId,
      });
    }

    const requiredObjectIds = new Set([
      snapshot.workflow_object_id,
      snapshot.role_bundle_object_id,
      snapshot.rule_bundle_object_id,
      snapshot.safety_baseline_object_id,
      snapshot.adapter_capability_object_id,
      snapshot.staged_patch_object_id,
      snapshot.unstaged_patch_object_id,
      snapshot.untracked_manifest_object_id,
      snapshot.submodule_manifest_object_id,
      ...(checkpoint === undefined ? [] : [
        checkpoint.staged_patch_object_id,
        checkpoint.unstaged_patch_object_id,
        checkpoint.untracked_manifest_object_id,
        checkpoint.submodule_manifest_object_id,
      ]),
    ]);
    for (const objectId of requiredObjectIds) {
      try {
        this.content.verify(objectId);
      } catch {
        return mismatch('ARTIFACT_MISSING', { missingObjectId: objectId, checkpointSequence: checkpoint?.sequence_number ?? null });
      }
    }
    return { ok: true };
  }
}
