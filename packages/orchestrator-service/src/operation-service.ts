import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson, type ContentStore } from '@project-orchestrator/content-store';
import { EventRepository, IdempotencyRepository } from '@project-orchestrator/sqlite-store';
import type { LeaseService } from './lease-service.js';
import type { AdapterPrincipal, LeaseProof } from './runtime-types.js';
import type { ConfirmationService } from './confirmation-service.js';
import { readRunCapabilities, requireManagedOperations } from './capability-service.js';

export type OperationExecutionResult = { status: 'succeeded' | 'unknown'; externalReference?: string; evidence: unknown };
export type OperationHelper = {
  execute(input: { actionType: string; targetFingerprint: string; parameters: Record<string, unknown> }): Promise<OperationExecutionResult>;
  reconcile?(input: { operationId: string; actionType: string; targetFingerprint: string; externalReference?: string }): Promise<OperationExecutionResult>;
};
const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
type OperationRow = {
  id: string; run_id: string; stage_attempt_id: string; action_type: string; target_fingerprint: string;
  request_hash: string; parameters_envelope: string; confirmation_request_id: string; status: string; external_reference: string | null;
};
type ReconciliationAttempt = { id: string; roleVersionId: string };

export class OperationService {
  readonly events: EventRepository;
  readonly idem: IdempotencyRepository;
  constructor(
    readonly db: Database.Database,
    readonly content: ContentStore,
    readonly leases: LeaseService,
    readonly confirmations: ConfirmationService,
    readonly helper: OperationHelper,
  ) {
    this.events = new EventRepository(db);
    this.idem = new IdempotencyRepository(db);
  }

  prepare(input: {
    requestId: string; proof: LeaseProof; principal: AdapterPrincipal; stageAttemptId: string;
    actionType: string; targetFingerprint: string; parameters: Record<string, unknown>; summary: string; ttlMs?: number;
  }): { operationId: string; actionHash: string; confirmationRequestId: string; nonce: string; expiresAt: string } {
    const intent = { action_type: input.actionType, target_fingerprint: input.targetFingerprint, parameters: input.parameters };
    const actionHash = hash(intent);
    return this.db.transaction(() => {
      this.leases.validate(input.proof, input.principal);
      requireManagedOperations(readRunCapabilities(this.db, this.content, input.proof.runId));
      const begun = this.idem.begin(input.principal.installationId, 'prepare_side_effect', input.requestId, hash({ ...input, proof: { ...input.proof, leaseToken: hash(input.proof.leaseToken) } }));
      if (begun.kind === 'replay') throw new Error('ALREADY_PREPARED');
      const ownership = this.requireAttempt(input.stageAttemptId, input.proof.runId, 'running');
      const snapshot = this.db.prepare('SELECT safety_baseline_object_id FROM run_snapshots WHERE run_id=?')
        .get(input.proof.runId) as { safety_baseline_object_id: string };
      const confirmation = this.confirmations.request({
        runId: input.proof.runId, stageRunId: ownership.stage_run_id, stageAttemptId: input.stageAttemptId,
        type: input.actionType, summary: input.summary,
        actionHash, safetyBaselineObjectId: snapshot.safety_baseline_object_id, installationId: input.principal.installationId,
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      });
      const operationId = randomUUID();
      this.db.prepare(`INSERT INTO side_effect_operations
        (id,run_id,stage_attempt_id,action_type,target_fingerprint,request_hash,parameters_envelope,
         confirmation_request_id,lease_epoch,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,'intent_recorded',?)`)
        .run(operationId, input.proof.runId, input.stageAttemptId, input.actionType, input.targetFingerprint,
          actionHash, canonicalJson(input.parameters), confirmation.id, input.proof.leaseEpoch, new Date().toISOString());
      const now = new Date().toISOString();
      const stageChanged = this.db.prepare("UPDATE stage_runs SET status='waiting_for_user',updated_at=? WHERE id=? AND run_id=? AND status='running'")
        .run(now, ownership.stage_run_id, input.proof.runId);
      const otherWork = this.db.prepare(`SELECT 1 FROM stage_runs WHERE run_id=? AND id<>?
        AND status IN ('ready','running') LIMIT 1`).get(input.proof.runId, ownership.stage_run_id);
      const runChanged = otherWork ? undefined : this.db.prepare("UPDATE runs SET status='waiting_for_user',updated_at=? WHERE id=? AND status='running'")
        .run(now, input.proof.runId);
      if (stageChanged.changes !== 1 || (runChanged !== undefined && runChanged.changes !== 1)) {
        throw new Error('INVALID_TRANSITION: operation confirmation cannot enter waiting state');
      }
      this.events.append(input.proof.runId, 'side_effect_prepared', 'server', { operationId }, ownership.stage_run_id);
      this.idem.complete(begun.id, { prepared: true, operationId, confirmationRequestId: confirmation.id });
      return { operationId, actionHash, confirmationRequestId: confirmation.id, nonce: confirmation.nonce, expiresAt: confirmation.expiresAt };
    }).immediate();
  }

  async execute(input: { requestId: string; proof: LeaseProof; principal: AdapterPrincipal; operationId: string }): Promise<OperationExecutionResult> {
    const begun = this.db.transaction(() => {
      this.leases.validate(input.proof, input.principal);
      requireManagedOperations(readRunCapabilities(this.db, this.content, input.proof.runId));
      const idempotency = this.idem.begin(input.principal.installationId, 'execute_side_effect', input.requestId,
        hash({ ...input, proof: { ...input.proof, leaseToken: hash(input.proof.leaseToken) } }));
      if (idempotency.kind === 'replay') return { replay: idempotency.response as OperationExecutionResult } as const;
      const operation = this.getOperation(input.operationId);
      if (operation.run_id !== input.proof.runId) throw new Error('POLICY_VIOLATION: operation does not belong to run');
      if (operation.status !== 'intent_recorded') throw new Error(`INVALID_TRANSITION: operation ${operation.status} cannot execute`);
      this.requireAttempt(operation.stage_attempt_id, operation.run_id, 'running');
      this.confirmations.consume(operation.confirmation_request_id, operation.request_hash);
      const changed = this.db.prepare(`UPDATE side_effect_operations SET status='executing',started_at=?
        WHERE id=? AND run_id=? AND status='intent_recorded'`).run(new Date().toISOString(), operation.id, operation.run_id);
      if (changed.changes !== 1) throw new Error('INVALID_TRANSITION: operation execution race');
      this.events.append(operation.run_id, 'side_effect_executing', 'server', { operationId: operation.id });
      return { operation, idempotencyId: idempotency.id } as const;
    }).immediate();
    if ('replay' in begun) return begun.replay;
    let result: OperationExecutionResult;
    try {
      result = await this.helper.execute({
        actionType: begun.operation.action_type,
        targetFingerprint: begun.operation.target_fingerprint,
        parameters: JSON.parse(begun.operation.parameters_envelope) as Record<string, unknown>,
      });
    } catch (error) {
      result = { status: 'unknown', evidence: { error: error instanceof Error ? error.message : 'transport failure' } };
    }
    return this.db.transaction(() => {
      const current = this.getOperation(begun.operation.id);
      if (current.status !== 'executing') throw new Error('INVALID_TRANSITION: operation no longer executing');
      this.freezeEvidence(current, result, this.requireReconciliationAttempt(current));
      this.db.prepare(`UPDATE side_effect_operations SET status=?,external_reference=?,completed_at=?
        WHERE id=? AND status='executing'`).run(result.status, result.externalReference ?? null, new Date().toISOString(), current.id);
      this.events.append(current.run_id, result.status === 'succeeded' ? 'side_effect_succeeded' : 'side_effect_unknown',
        'server', { operationId: current.id, externalReference: result.externalReference ?? null });
      this.idem.complete(begun.idempotencyId, result);
      return result;
    }).immediate();
  }

  async reconcile(input: { requestId: string; proof: LeaseProof; principal: AdapterPrincipal; operationId: string }): Promise<OperationExecutionResult> {
    const prepared = this.db.transaction(() => {
      this.leases.validate(input.proof, input.principal);
      requireManagedOperations(readRunCapabilities(this.db, this.content, input.proof.runId));
      const idempotency = this.idem.begin(input.principal.installationId, 'reconcile_side_effect', input.requestId,
        hash({ ...input, proof: { ...input.proof, leaseToken: hash(input.proof.leaseToken) } }));
      if (idempotency.kind === 'replay') return { replay: idempotency.response as OperationExecutionResult } as const;
      const operation = this.getOperation(input.operationId);
      if (operation.run_id !== input.proof.runId || operation.status !== 'unknown') throw new Error('INVALID_TRANSITION: only owned unknown operation may reconcile');
      this.requireReconciliationAttempt(operation);
      if (!this.helper.reconcile) throw new Error('POLICY_VIOLATION: driver cannot reconcile');
      return { operation, idempotencyId: idempotency.id } as const;
    }).immediate();
    if ('replay' in prepared) return prepared.replay;
    let result: OperationExecutionResult;
    try {
      result = await this.helper.reconcile!({
        operationId: prepared.operation.id, actionType: prepared.operation.action_type, targetFingerprint: prepared.operation.target_fingerprint,
        ...(prepared.operation.external_reference === null ? {} : { externalReference: prepared.operation.external_reference }),
      });
    } catch (error) {
      this.db.transaction(() => this.idem.fail(prepared.idempotencyId, {
        code: 'OPERATION_RECONCILE_FAILED',
        message: error instanceof Error ? error.message : 'operation helper failure',
      })).immediate();
      throw error;
    }
    return this.db.transaction(() => {
      this.leases.validate(input.proof, input.principal);
      const current = this.getOperation(prepared.operation.id);
      if (current.status !== 'unknown') throw new Error('INVALID_TRANSITION: operation no longer unknown');
      const evidenceAttempt = this.requireReconciliationAttempt(current);
      this.freezeEvidence(current, result, evidenceAttempt);
      if (result.status === 'succeeded') {
        this.db.prepare(`UPDATE side_effect_operations SET status='reconciled',external_reference=?,completed_at=?
          WHERE id=? AND status='unknown'`).run(result.externalReference ?? null, new Date().toISOString(), current.id);
        this.events.append(current.run_id, 'side_effect_reconciled', 'server', { operationId: current.id });
      } else {
        this.events.append(current.run_id, 'side_effect_unknown', 'server',
          { operationId: current.id, reason: 'reconcile_inconclusive' });
      }
      this.idem.complete(prepared.idempotencyId, result);
      return result;
    }).immediate();
  }

  private freezeEvidence(
    operation: OperationRow,
    result: OperationExecutionResult,
    evidenceAttempt: ReconciliationAttempt,
  ): void {
    const object = this.content.putCanonicalJson(result.evidence);
    this.db.prepare(`INSERT INTO artifacts
      (id,run_id,stage_attempt_id,artifact_type,content_object_id,source_path,summary,producer_role_version_id,metadata_envelope,created_at)
      VALUES(?,?,?,?,?,NULL,?,?,?,?)`)
      .run(randomUUID(), operation.run_id, evidenceAttempt.id,
        result.status === 'succeeded' ? 'deployment_record' : 'log', object.id,
        `Managed operation ${operation.action_type} ${result.status}`, evidenceAttempt.roleVersionId,
        canonicalJson({ operationId: operation.id, sourceAttemptId: operation.stage_attempt_id,
          externalReference: result.externalReference ?? null }), new Date().toISOString());
  }

  private requireReconciliationAttempt(operation: OperationRow): ReconciliationAttempt {
    const row = this.db.prepare(`SELECT source.status AS source_status,source.attempt_number AS source_attempt_number,
        stage.status AS stage_status,stage.latest_attempt_id,stage.role_version_id,
        latest.status AS latest_status,latest.attempt_number AS latest_attempt_number
      FROM stage_attempts source JOIN stage_runs stage ON stage.id=source.stage_run_id
      LEFT JOIN stage_attempts latest ON latest.id=stage.latest_attempt_id AND latest.stage_run_id=stage.id
      WHERE source.id=? AND stage.run_id=?`).get(operation.stage_attempt_id, operation.run_id) as {
        source_status: string; source_attempt_number: number; stage_status: string; latest_attempt_id: string | null;
        role_version_id: string; latest_status: string | null; latest_attempt_number: number | null;
      } | undefined;
    if (!row) throw new Error('POLICY_VIOLATION: attempt does not belong to run');
    const sourceIsCurrent = row.latest_attempt_id === operation.stage_attempt_id && row.source_status === 'running';
    const interruptedRetryIsCurrent = row.source_status === 'interrupted'
      && row.latest_attempt_id !== operation.stage_attempt_id
      && row.latest_attempt_number !== null
      && row.latest_attempt_number > row.source_attempt_number;
    if (row.stage_status !== 'running' || row.latest_attempt_id === null || row.latest_status !== 'running'
      || (!sourceIsCurrent && !interruptedRetryIsCurrent)) {
      throw new Error('INVALID_TRANSITION: operation has no current running reconciliation attempt');
    }
    return { id: row.latest_attempt_id, roleVersionId: row.role_version_id };
  }

  private requireAttempt(id: string, runId: string, status?: string): { stage_run_id: string; role_version_id: string; status: string } {
    const row = this.db.prepare(`SELECT a.status,s.id AS stage_run_id,s.role_version_id FROM stage_attempts a
      JOIN stage_runs s ON s.id=a.stage_run_id WHERE a.id=? AND s.run_id=?`).get(id, runId) as {
      stage_run_id: string; role_version_id: string; status: string;
    } | undefined;
    if (!row) throw new Error('POLICY_VIOLATION: attempt does not belong to run');
    if (status !== undefined && row.status !== status) throw new Error('INVALID_TRANSITION: attempt state');
    return row;
  }

  private getOperation(id: string): OperationRow {
    const row = this.db.prepare('SELECT * FROM side_effect_operations WHERE id=?').get(id) as OperationRow | undefined;
    if (!row) throw new Error('NOT_FOUND: operation');
    return row;
  }
}
