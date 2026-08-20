import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ContentStore } from '@project-orchestrator/content-store';
import type { WorkflowVersionEnvelope } from '@project-orchestrator/contracts';
import { EventRepository } from '@project-orchestrator/sqlite-store';
import type { AdapterPrincipal } from './runtime-types.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const matches = (value: string, expected: string): boolean => {
  const actualBytes = Buffer.from(hash(value), 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

type ConfirmationRow = {
  id: string; run_id: string; stage_run_id: string; status: string; expires_at: string; action_hash: string;
  nonce_hash: string; requested_installation_id: string;
};

export class ConfirmationService {
  constructor(readonly db: Database.Database, readonly events = new EventRepository(db), readonly content?: ContentStore) {}

  request(input: { runId: string; stageRunId: string; type: string; summary: string; actionHash: string; safetyBaselineObjectId: string; installationId: string; ttlMs?: number }): { id: string; nonce: string; expiresAt: string } {
    const stage = this.db.prepare('SELECT 1 FROM stage_runs WHERE id=? AND run_id=?').get(input.stageRunId, input.runId);
    if (!stage) throw new Error('POLICY_VIOLATION: confirmation stage does not belong to run');
    const id = randomUUID();
    const nonce = randomBytes(32).toString('base64url');
    const requestedAt = new Date();
    const expiresAt = new Date(requestedAt.getTime() + (input.ttlMs ?? 300_000)).toISOString();
    this.db.prepare(`INSERT INTO confirmation_requests
      (id,run_id,stage_run_id,confirmation_type,request_summary,action_hash,nonce_hash,safety_baseline_object_id,
       requested_installation_id,status,requested_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`)
      .run(id, input.runId, input.stageRunId, input.type, input.summary, input.actionHash, hash(nonce),
        input.safetyBaselineObjectId, input.installationId, requestedAt.toISOString(), expiresAt);
    this.events.append(input.runId, 'confirmation_requested', 'server', { confirmationRequestId: id }, input.stageRunId);
    return { id, nonce, expiresAt };
  }

  submitDecision(input: { confirmationRequestId: string; nonce: string; exactActionHash: string; decision: 'approve' | 'reject'; principal: AdapterPrincipal }): void {
    if (!input.principal.trustedInteractive) throw new Error('POLICY_VIOLATION: confirmation requires trusted adapter channel');
    if (input.principal.sessionId !== input.principal.rootSessionId) throw new Error('POLICY_VIOLATION: subagent confirmation rejected');
    const outcome = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM confirmation_requests WHERE id=?').get(input.confirmationRequestId) as ConfirmationRow | undefined;
      if (!row) throw new Error('NOT_FOUND: confirmation');
      if (row.status !== 'pending') throw new Error('INVALID_TRANSITION: confirmation already decided');
      if (Date.parse(row.expires_at) <= Date.now()) {
        this.db.prepare("UPDATE confirmation_requests SET status='expired' WHERE id=? AND status='pending'").run(row.id);
        return 'expired' as const;
      }
      if (row.requested_installation_id !== input.principal.installationId || row.action_hash !== input.exactActionHash
        || !matches(input.nonce, row.nonce_hash)) throw new Error('POLICY_VIOLATION: confirmation binding mismatch');
      const operation = this.db.prepare('SELECT 1 FROM side_effect_operations WHERE confirmation_request_id=?')
        .get(row.id);
      const status = input.decision === 'approve' ? (operation ? 'approved' : 'consumed') : 'rejected';
      this.db.prepare(`UPDATE confirmation_requests SET status=?,decision_client_installation_id=?,
        decision_session_id=?,decided_at=?,consumed_at=? WHERE id=? AND status='pending'`)
        .run(status, input.principal.installationId, input.principal.sessionId, new Date().toISOString(),
          status === 'consumed' ? new Date().toISOString() : null, row.id);
      if (status === 'approved' || status === 'consumed') {
        this.db.prepare("UPDATE stage_runs SET status='running',updated_at=? WHERE id=? AND status='waiting_for_user'")
          .run(new Date().toISOString(), row.stage_run_id);
        this.db.prepare("UPDATE runs SET status='running',updated_at=? WHERE id=? AND status='waiting_for_user'")
          .run(new Date().toISOString(), row.run_id);
        this.events.append(row.run_id, 'confirmation_approved', 'server', { confirmationRequestId: row.id }, row.stage_run_id);
        if (status === 'consumed') {
          this.events.append(row.run_id, 'confirmation_consumed', 'server', { confirmationRequestId: row.id }, row.stage_run_id);
        }
      } else {
        this.reject(row);
        this.events.append(row.run_id, 'confirmation_rejected', 'server', { confirmationRequestId: row.id }, row.stage_run_id);
      }
      return status;
    }).immediate();
    if (outcome === 'expired') throw new Error('INVALID_TRANSITION: confirmation expired');
  }

  consume(id: string, actionHash: string): ConfirmationRow {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM confirmation_requests WHERE id=?').get(id) as ConfirmationRow | undefined;
      if (!row || row.status !== 'approved' || row.action_hash !== actionHash || Date.parse(row.expires_at) <= Date.now()) {
        throw new Error('POLICY_VIOLATION: approval unavailable');
      }
      const result = this.db.prepare("UPDATE confirmation_requests SET status='consumed',consumed_at=? WHERE id=? AND status='approved'")
        .run(new Date().toISOString(), id);
      if (result.changes !== 1) throw new Error('INVALID_TRANSITION: approval replay');
      this.events.append(row.run_id, 'confirmation_consumed', 'server', { confirmationRequestId: row.id }, row.stage_run_id);
      return row;
    }).immediate();
  }

  private reject(row: ConfirmationRow): void {
    const now = new Date().toISOString();
    const latest = this.db.prepare('SELECT latest_attempt_id,stage_key FROM stage_runs WHERE id=? AND run_id=?')
      .get(row.stage_run_id, row.run_id) as { latest_attempt_id: string | null; stage_key: string } | undefined;
    if (latest?.latest_attempt_id) this.db.prepare(`UPDATE stage_attempts SET status='failed',failure_code='USER_REJECTED',
      failure_summary='User rejected confirmation',completed_at=? WHERE id=? AND status='running'`).run(now, latest.latest_attempt_id);
    this.db.prepare("UPDATE stage_runs SET status='failed',completed_at=?,updated_at=? WHERE id=? AND status='waiting_for_user'")
      .run(now, now, row.stage_run_id);
    let target: 'paused' | 'cancelled' = 'paused';
    if (this.content) {
      const snapshot = this.db.prepare('SELECT workflow_object_id FROM run_snapshots WHERE run_id=?').get(row.run_id) as { workflow_object_id: string } | undefined;
      if (snapshot && latest) {
        const workflow = JSON.parse(Buffer.from(this.content.read(snapshot.workflow_object_id)).toString('utf8')) as WorkflowVersionEnvelope;
        const policy = workflow.data.stages.find((stage) => stage.key === latest.stage_key)?.failure_policy;
        target = policy === 'pause' ? 'paused' : 'cancelled';
      }
    }
    this.db.prepare(`UPDATE runs SET status=?,lease_token_hash=NULL,lease_expires_at=NULL,lease_holder_session_id=NULL,
      completed_at=CASE WHEN ?='cancelled' THEN ? ELSE completed_at END,updated_at=?
      WHERE id=? AND status IN ('running','waiting_for_user')`).run(target, target, now, now, row.run_id);
  }
}
