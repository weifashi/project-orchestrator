import type Database from 'better-sqlite3';
export type RunRow = {
  id: string; project_id: string; workflow_version_id: string; objective: string; input_envelope: string;
  client_installation_id: string; origin_session_id: string; lease_holder_session_id: string | null;
  status: string; lease_epoch: number; server_epoch: number; lease_token_hash: string | null;
  lease_expires_at: string | null; recovery_credential_hash: string | null; next_event_sequence: number;
  is_retryable: number; failure_code: string | null; failure_summary: string | null; updated_at: string;
};
export type StageRunRow = {
  id: string; run_id: string; stage_key: string; iteration_group_key: string | null; iteration_number: number;
  role_version_id: string; status: string; latest_attempt_id: string | null; max_attempts: number;
};
export class RunRepository {
  constructor(readonly db: Database.Database) {}
  transaction<T>(work: () => T): T { return this.db.transaction(work).immediate(); }
  getRun(id: string): RunRow | undefined { return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as RunRow | undefined; }
  getStageRun(id: string): StageRunRow | undefined { return this.db.prepare('SELECT * FROM stage_runs WHERE id=?').get(id) as StageRunRow | undefined; }
  listStageRuns(runId: string): StageRunRow[] { return this.db.prepare('SELECT * FROM stage_runs WHERE run_id=? ORDER BY iteration_number,created_at,id').all(runId) as StageRunRow[]; }
}
