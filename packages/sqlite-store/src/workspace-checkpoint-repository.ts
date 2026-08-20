import type Database from 'better-sqlite3';

export type WorkspaceCheckpointRow = Readonly<{
  id: string;
  run_id: string;
  sequence_number: number;
  stage_attempt_id: string | null;
  checkpoint_kind: 'run_start' | 'before_attempt' | 'progress' | 'after_attempt';
  repository_head: string;
  baseline_fingerprint: string;
  resulting_fingerprint: string;
  staged_patch_object_id: string;
  unstaged_patch_object_id: string;
  untracked_manifest_object_id: string;
  submodule_manifest_object_id: string;
  created_at: string;
}>;

export class WorkspaceCheckpointRepository {
  constructor(readonly db: Database.Database) {}

  latest(runId: string): WorkspaceCheckpointRow | undefined {
    return this.db.prepare(`SELECT * FROM workspace_checkpoints
      WHERE run_id=? ORDER BY sequence_number DESC LIMIT 1`).get(runId) as WorkspaceCheckpointRow | undefined;
  }

  nextSequence(runId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(sequence_number),0)+1 AS sequence
      FROM workspace_checkpoints WHERE run_id=?`).get(runId) as { sequence: number };
    return row.sequence;
  }
}
