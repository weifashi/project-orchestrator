import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ContentStore } from '@project-orchestrator/content-store';
import type { WorkflowVersionEnvelope } from '@project-orchestrator/contracts';
import { EventRepository } from '@project-orchestrator/sqlite-store';
import type { AdapterPrincipal } from './runtime-types.js';
import { readRunCapabilities, requireTrustedConfirmation } from './capability-service.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const matches = (value: string, expected: string): boolean => {
  const actualBytes = Buffer.from(hash(value), 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

type ConfirmationRow = {
  id: string; run_id: string; stage_run_id: string; stage_attempt_id: string; status: string; expires_at: string; action_hash: string;
  nonce_hash: string; requested_installation_id: string;
};
export type ConfirmationStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';

export function invalidateRunConfirmations(
  db: Database.Database,
  runId: string,
  now = new Date().toISOString(),
): number {
  const work = (): number => {
    const invalidated = db.prepare(`UPDATE confirmation_requests SET status='expired',decided_at=COALESCE(decided_at,?)
      WHERE run_id=? AND status IN ('pending','approved')`).run(now, runId);
    db.prepare(`UPDATE side_effect_operations SET status='abandoned',completed_at=?
      WHERE run_id=? AND status='intent_recorded'`).run(now, runId);
    return invalidated.changes;
  };
  return db.inTransaction ? work() : db.transaction(work).immediate();
}

export class ConfirmationService {
  constructor(
    readonly db: Database.Database,
    readonly events: EventRepository | undefined,
    readonly content: ContentStore,
  ) {}

  private get eventRepository(): EventRepository {
    return this.events ?? new EventRepository(this.db);
  }

  request(input: { runId: string; stageRunId: string; stageAttemptId: string; type: string; summary: string; actionHash: string; safetyBaselineObjectId: string; installationId: string; ttlMs?: number }): { id: string; nonce: string; expiresAt: string } {
    requireTrustedConfirmation(readRunCapabilities(this.db, this.content, input.runId));
    const stage = this.db.prepare(`SELECT 1 FROM stage_runs s JOIN stage_attempts a ON a.id=s.latest_attempt_id
      WHERE s.id=? AND s.run_id=? AND s.status='running' AND a.id=? AND a.status='running'`)
      .get(input.stageRunId, input.runId, input.stageAttemptId);
    if (!stage) throw new Error('POLICY_VIOLATION: confirmation stage does not belong to run');
    const id = randomUUID();
    const nonce = randomBytes(32).toString('base64url');
    const requestedAt = new Date();
    const expiresAt = new Date(requestedAt.getTime() + (input.ttlMs ?? 300_000)).toISOString();
    this.db.prepare(`INSERT INTO confirmation_requests
      (id,run_id,stage_run_id,stage_attempt_id,confirmation_type,request_summary,action_hash,nonce_hash,safety_baseline_object_id,
       requested_installation_id,status,requested_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
      .run(id, input.runId, input.stageRunId, input.stageAttemptId, input.type, input.summary, input.actionHash, hash(nonce),
        input.safetyBaselineObjectId, input.installationId, requestedAt.toISOString(), expiresAt);
    this.eventRepository.append(input.runId, 'confirmation_requested', 'server', { confirmationRequestId: id }, input.stageRunId);
    return { id, nonce, expiresAt };
  }

  submitDecision(input: { confirmationRequestId: string; nonce: string; exactActionHash: string; decision: 'approve' | 'reject'; principal: AdapterPrincipal }): { status: ConfirmationStatus } {
    if (!input.principal.trustedInteractive) throw new Error('POLICY_VIOLATION: confirmation requires trusted adapter channel');
    if (input.principal.sessionId !== input.principal.rootSessionId) throw new Error('POLICY_VIOLATION: subagent confirmation rejected');
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM confirmation_requests WHERE id=?').get(input.confirmationRequestId) as ConfirmationRow | undefined;
      if (!row) throw new Error('NOT_FOUND: confirmation');
      requireTrustedConfirmation(readRunCapabilities(this.db, this.content, row.run_id));
      if (row.requested_installation_id !== input.principal.installationId || row.action_hash !== input.exactActionHash
        || !matches(input.nonce, row.nonce_hash)) throw new Error('POLICY_VIOLATION: confirmation binding mismatch');
      const now = new Date().toISOString();
      if (['pending', 'approved'].includes(row.status) && Date.parse(row.expires_at) <= Date.now()) {
        this.expireRows([row], now);
        return { status: 'expired' as const };
      }
      if (['pending', 'approved'].includes(row.status) && !this.isCurrent(row)) {
        this.expireRows([row], now);
        return { status: 'expired' as const };
      }
      if (row.status !== 'pending') return { status: row.status as ConfirmationStatus };
      const operation = this.db.prepare('SELECT 1 FROM side_effect_operations WHERE confirmation_request_id=?')
        .get(row.id);
      const status: ConfirmationStatus = input.decision === 'approve' ? (operation ? 'approved' : 'consumed') : 'rejected';
      this.db.prepare(`UPDATE confirmation_requests SET status=?,decision_client_installation_id=?,
        decision_session_id=?,decided_at=?,consumed_at=? WHERE id=? AND status='pending'`)
        .run(status, input.principal.installationId, input.principal.sessionId, now,
          status === 'consumed' ? now : null, row.id);
      if (status === 'approved' || status === 'consumed') {
        this.db.prepare("UPDATE stage_runs SET status='running',updated_at=? WHERE id=? AND status='waiting_for_user'")
          .run(now, row.stage_run_id);
        this.db.prepare("UPDATE runs SET status='running',updated_at=? WHERE id=? AND status='waiting_for_user'")
          .run(now, row.run_id);
        this.eventRepository.append(row.run_id, 'confirmation_approved', 'server', { confirmationRequestId: row.id }, row.stage_run_id);
        if (status === 'consumed') {
          this.eventRepository.append(row.run_id, 'confirmation_consumed', 'server', { confirmationRequestId: row.id }, row.stage_run_id);
        }
      } else {
        invalidateRunConfirmations(this.db, row.run_id, now);
        this.reject(row);
        this.eventRepository.append(row.run_id, 'confirmation_rejected', 'server', { confirmationRequestId: row.id }, row.stage_run_id);
      }
      return { status };
    }).immediate();
  }

  consume(id: string, actionHash: string): ConfirmationRow {
    const outcome = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM confirmation_requests WHERE id=?').get(id) as ConfirmationRow | undefined;
      if (!row) throw new Error('POLICY_VIOLATION: approval unavailable');
      requireTrustedConfirmation(readRunCapabilities(this.db, this.content, row.run_id));
      if (row.status === 'approved' && (Date.parse(row.expires_at) <= Date.now() || !this.isCurrent(row))) {
        this.expireRows([row], new Date().toISOString());
        return { expired: true as const };
      }
      if (row.status !== 'approved' || row.action_hash !== actionHash) {
        throw new Error('POLICY_VIOLATION: approval unavailable');
      }
      const result = this.db.prepare("UPDATE confirmation_requests SET status='consumed',consumed_at=? WHERE id=? AND status='approved'")
        .run(new Date().toISOString(), id);
      if (result.changes !== 1) throw new Error('INVALID_TRANSITION: approval replay');
      this.eventRepository.append(row.run_id, 'confirmation_consumed', 'server', { confirmationRequestId: row.id }, row.stage_run_id);
      return { expired: false as const, row };
    }).immediate();
    if (outcome.expired) throw new Error('POLICY_VIOLATION: approval expired');
    return outcome.row;
  }

  invalidateForRun(runId: string, now = new Date().toISOString()): number {
    return invalidateRunConfirmations(this.db, runId, now);
  }

  expireDue(now = new Date()): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM confirmation_requests
        WHERE status IN ('pending','approved') AND expires_at<=? ORDER BY run_id,stage_run_id,id`)
        .all(now.toISOString()) as ConfirmationRow[];
      this.expireRows(rows, now.toISOString());
      return rows.length;
    }).immediate();
  }

  private expireRows(rows: readonly ConfirmationRow[], now: string): void {
    if (rows.length === 0) return;
    const updateConfirmation = this.db.prepare("UPDATE confirmation_requests SET status='expired',decided_at=COALESCE(decided_at,?) WHERE id=? AND status IN ('pending','approved')");
    const abandonOperation = this.db.prepare("UPDATE side_effect_operations SET status='abandoned',completed_at=? WHERE confirmation_request_id=? AND status='intent_recorded'");
    for (const row of rows) {
      updateConfirmation.run(now, row.id);
      abandonOperation.run(now, row.id);
    }
    for (const stageRunId of new Set(rows.map((row) => row.stage_run_id))) {
      this.db.prepare(`UPDATE stage_runs SET status='running',updated_at=? WHERE id=? AND status='waiting_for_user'
        AND EXISTS(SELECT 1 FROM stage_attempts WHERE id=stage_runs.latest_attempt_id AND status='running')
        AND NOT EXISTS(SELECT 1 FROM confirmation_requests
          WHERE stage_run_id=stage_runs.id AND status IN ('pending','approved'))`).run(now, stageRunId);
    }
    for (const runId of new Set(rows.map((row) => row.run_id))) {
      this.db.prepare(`UPDATE runs SET status='running',updated_at=? WHERE id=? AND status='waiting_for_user'
        AND EXISTS(SELECT 1 FROM stage_runs WHERE run_id=runs.id AND status IN ('ready','running'))`).run(now, runId);
    }
  }

  private isCurrent(row: ConfirmationRow): boolean {
    return this.db.prepare(`SELECT 1 FROM runs r
      JOIN stage_runs s ON s.run_id=r.id
      JOIN stage_attempts a ON a.stage_run_id=s.id
      WHERE r.id=? AND r.status IN ('running','waiting_for_user')
        AND s.id=? AND s.status IN ('running','waiting_for_user') AND s.latest_attempt_id=?
        AND a.id=? AND a.status='running'`)
      .get(row.run_id, row.stage_run_id, row.stage_attempt_id, row.stage_attempt_id) !== undefined;
  }

  private reject(row: ConfirmationRow): void {
    const now = new Date().toISOString();
    const latest = this.db.prepare('SELECT latest_attempt_id,stage_key FROM stage_runs WHERE id=? AND run_id=?')
      .get(row.stage_run_id, row.run_id) as { latest_attempt_id: string | null; stage_key: string } | undefined;
    this.db.prepare(`UPDATE stage_attempts SET status='failed',failure_code='USER_REJECTED',
      failure_summary='User rejected confirmation',completed_at=? WHERE id=? AND stage_run_id=? AND status='running'`)
      .run(now, row.stage_attempt_id, row.stage_run_id);
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
    if (target === 'cancelled') {
      this.db.prepare(`UPDATE stage_attempts SET status='interrupted',failure_code='RUN_CANCELLED',
        failure_summary='Run cancelled after confirmation rejection',completed_at=? WHERE status='running'
        AND stage_run_id IN (SELECT id FROM stage_runs WHERE run_id=? AND id<>?)`)
        .run(now, row.run_id, row.stage_run_id);
      this.db.prepare(`UPDATE stage_runs SET status='cancelled',updated_at=?,completed_at=?
        WHERE run_id=? AND id<>? AND status IN ('queued','ready','running','waiting_for_user')`)
        .run(now, now, row.run_id, row.stage_run_id);
      this.db.prepare(`UPDATE runs SET status='cancelled',lease_token_hash=NULL,lease_expires_at=NULL,
        lease_holder_session_id=NULL,completed_at=?,updated_at=?
        WHERE id=? AND status IN ('running','waiting_for_user')`).run(now, now, row.run_id);
      this.eventRepository.append(row.run_id, 'run_cancelled', 'server', { reason: 'confirmation_rejected' });
      return;
    }
    const peers = this.db.prepare(`SELECT id FROM stage_runs WHERE run_id=? AND id<>?
      AND status IN ('running','waiting_for_user') ORDER BY stage_key,id`).all(row.run_id, row.stage_run_id) as Array<{ id: string }>;
    for (const peer of peers) {
      this.db.prepare(`UPDATE stage_attempts SET status='interrupted',failure_code='RUN_PAUSED',
        failure_summary='Run paused after confirmation rejection',completed_at=? WHERE stage_run_id=? AND status='running'`)
        .run(now, peer.id);
      this.db.prepare(`UPDATE stage_runs SET status='interrupted',updated_at=?,completed_at=?
        WHERE id=? AND status IN ('running','waiting_for_user')`).run(now, now, peer.id);
      this.eventRepository.append(row.run_id, 'stage_interrupted', 'server', { reason: 'confirmation_rejected_pause' }, peer.id);
    }
    this.db.prepare(`UPDATE runs SET status='paused',lease_token_hash=NULL,lease_expires_at=NULL,
      lease_holder_session_id=NULL,updated_at=? WHERE id=? AND status IN ('running','waiting_for_user')`)
      .run(now, row.run_id);
    this.eventRepository.append(row.run_id, 'run_paused', 'server', { reason: 'confirmation_rejected' });
  }
}
