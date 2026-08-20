/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AdapterPrincipal } from './runtime-types.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const matches = (value: string, expected: string): boolean => {
  const actualBytes = Buffer.from(hash(value), 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

export class ConfirmationService {
  constructor(readonly db: Database.Database) {}

  request(input: { runId: string; stageRunId: string; type: string; summary: string; actionHash: string; safetyBaselineObjectId: string; installationId: string; ttlMs?: number }): { id: string; nonce: string; expiresAt: string } {
    const id = randomUUID();
    const nonce = randomBytes(32).toString('base64url');
    const requestedAt = new Date();
    const expiresAt = new Date(requestedAt.getTime() + (input.ttlMs ?? 300_000)).toISOString();
    this.db.prepare("INSERT INTO confirmation_requests(id,run_id,stage_run_id,confirmation_type,request_summary,action_hash,nonce_hash,safety_baseline_object_id,requested_installation_id,status,requested_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)")
      .run(id, input.runId, input.stageRunId, input.type, input.summary, input.actionHash, hash(nonce), input.safetyBaselineObjectId, input.installationId, requestedAt.toISOString(), expiresAt);
    return { id, nonce, expiresAt };
  }

  submitDecision(input: { confirmationRequestId: string; nonce: string; exactActionHash: string; decision: 'approve' | 'reject'; principal: AdapterPrincipal }): void {
    if (!input.principal.trustedInteractive) throw new Error('POLICY_VIOLATION: confirmation requires trusted adapter channel');
    const outcome = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM confirmation_requests WHERE id=?').get(input.confirmationRequestId) as any;
      if (!row) throw new Error('NOT_FOUND: confirmation');
      if (row.status !== 'pending') throw new Error('INVALID_TRANSITION: confirmation already decided');
      if (Date.parse(row.expires_at) <= Date.now()) {
        this.db.prepare("UPDATE confirmation_requests SET status='expired' WHERE id=? AND status='pending'").run(row.id);
        return 'expired' as const;
      }
      if (row.requested_installation_id !== input.principal.installationId || row.action_hash !== input.exactActionHash || !matches(input.nonce, row.nonce_hash)) {
        throw new Error('POLICY_VIOLATION: confirmation binding mismatch');
      }
      const status = input.decision === 'approve' ? 'approved' : 'rejected';
      this.db.prepare('UPDATE confirmation_requests SET status=?,decision_client_installation_id=?,decision_session_id=?,decided_at=? WHERE id=? AND status=?')
        .run(status, input.principal.installationId, input.principal.sessionId, new Date().toISOString(), row.id, 'pending');
      if (status === 'approved') {
        this.db.prepare("UPDATE stage_runs SET status='running',updated_at=? WHERE id=? AND status='waiting_for_user'").run(new Date().toISOString(), row.stage_run_id);
        this.db.prepare("UPDATE runs SET status='running',updated_at=? WHERE id=? AND status='waiting_for_user'").run(new Date().toISOString(), row.run_id);
      }
      if (status === 'rejected') {
        const stage = this.db.prepare('SELECT latest_attempt_id FROM stage_runs WHERE id=?').get(row.stage_run_id) as any;
        if (stage?.latest_attempt_id) this.db.prepare("UPDATE stage_attempts SET status='failed',failure_code='USER_REJECTED',failure_summary='User rejected confirmation',completed_at=? WHERE id=? AND status='running'").run(new Date().toISOString(), stage.latest_attempt_id);
        this.db.prepare("UPDATE stage_runs SET status='failed',completed_at=?,updated_at=? WHERE id=? AND status='waiting_for_user'").run(new Date().toISOString(), new Date().toISOString(), row.stage_run_id);
        this.db.prepare("UPDATE runs SET status='paused',lease_token_hash=NULL,lease_expires_at=NULL,lease_holder_session_id=NULL,updated_at=? WHERE id=? AND status='waiting_for_user'").run(new Date().toISOString(), row.run_id);
      }
      return status;
    }).immediate();
    if (outcome === 'expired') throw new Error('INVALID_TRANSITION: confirmation expired');
  }

  consume(id: string, actionHash: string): void {
    const row = this.db.prepare('SELECT status,action_hash,expires_at FROM confirmation_requests WHERE id=?').get(id) as any;
    if (!row || row.status !== 'approved' || row.action_hash !== actionHash || Date.parse(row.expires_at) <= Date.now()) throw new Error('POLICY_VIOLATION: approval unavailable');
    const result = this.db.prepare("UPDATE confirmation_requests SET status='consumed',consumed_at=? WHERE id=? AND status='approved'").run(new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error('INVALID_TRANSITION: approval replay');
  }
}
