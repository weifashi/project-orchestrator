import type Database from 'better-sqlite3';
import type { ContentStore } from '@project-orchestrator/content-store';
import { workspaceFingerprint } from './evidence-service.js';
import type { WorkspaceState } from './runtime-types.js';

export type RecoveryCheck = { ok: true } | { ok: false; code: 'REPOSITORY_HEAD_CHANGED' | 'WORKTREE_CHANGED'; diffObjectId: string };

export class RecoveryService {
  constructor(readonly db: Database.Database, readonly content: ContentStore) {}

  check(runId: string, current: WorkspaceState): RecoveryCheck {
    const checkpoint = this.db.prepare(`SELECT repository_head,resulting_fingerprint FROM workspace_checkpoints
      WHERE run_id=? ORDER BY created_at DESC,id DESC LIMIT 1`).get(runId) as { repository_head: string; resulting_fingerprint: string } | undefined;
    const snapshot = this.db.prepare('SELECT repository_head,working_tree_fingerprint FROM run_snapshots WHERE run_id=?')
      .get(runId) as { repository_head: string; working_tree_fingerprint: string } | undefined;
    if (!snapshot) throw new Error('NOT_FOUND: snapshot');
    const expectedHead = checkpoint?.repository_head ?? snapshot.repository_head;
    const expectedFingerprint = checkpoint?.resulting_fingerprint ?? snapshot.working_tree_fingerprint;
    if (current.repositoryHead !== expectedHead) {
      const diff = this.content.putCanonicalJson({ expectedHead, actualHead: current.repositoryHead });
      return { ok: false, code: 'REPOSITORY_HEAD_CHANGED', diffObjectId: diff.id };
    }
    const actualFingerprint = workspaceFingerprint(current);
    if (actualFingerprint !== expectedFingerprint) {
      const diff = this.content.putCanonicalJson({ expectedFingerprint, actualFingerprint, state: current });
      return { ok: false, code: 'WORKTREE_CHANGED', diffObjectId: diff.id };
    }
    return { ok: true };
  }
}
