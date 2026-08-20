import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AdapterPrincipal, LeaseProof } from './runtime-types.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const equalHash = (plain: string, digest: string): boolean => {
  const actual = Buffer.from(hash(plain), 'hex');
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
export type ClaimedLease = Readonly<{ leaseEpoch: number; leaseToken: string; recoveryCredential: string; expiresAt: string }>;

export class LeaseService {
  constructor(readonly db: Database.Database, readonly serverEpoch: number = Date.now(), readonly ttlMs = 30_000) {}

  private assertCurrentServerEpoch(): void {
    if (this.db.pragma('user_version', { simple: true }) !== this.serverEpoch) throw new Error('STALE_LEASE');
  }

  claim(input: {
    runId: string;
    principal: AdapterPrincipal;
    mode: 'start' | 'resume' | 'recover' | 'retry';
    expectedStatus: 'created' | 'paused' | 'interrupted' | 'failed';
    expectedLeaseEpoch: number;
    recoveryCredential?: string;
  }): ClaimedLease {
    this.assertCurrentServerEpoch();
    if (input.principal.sessionId !== input.principal.rootSessionId) throw new Error('POLICY_VIOLATION: subagent cannot claim run');
    const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(input.runId) as {
      client_installation_id: string; origin_client_type: string; status: string; lease_epoch: number;
      recovery_credential_hash: string | null; is_retryable: number;
    } | undefined;
    if (!run) throw new Error('NOT_FOUND: run');
    if (run.client_installation_id !== input.principal.installationId || run.origin_client_type !== input.principal.clientType) {
      throw new Error('POLICY_VIOLATION: wrong installation');
    }
    const requiredStatus = { start: 'created', resume: 'paused', recover: 'interrupted', retry: 'failed' }[input.mode];
    if (input.expectedStatus !== requiredStatus || run.status !== input.expectedStatus || run.lease_epoch !== input.expectedLeaseEpoch) {
      throw new Error('STALE_LEASE: claim compare-and-swap mismatch');
    }
    if (input.mode !== 'start' && (!input.recoveryCredential || !run.recovery_credential_hash || !equalHash(input.recoveryCredential, run.recovery_credential_hash))) {
      throw new Error('STALE_LEASE: recovery credential mismatch');
    }
    if (input.mode === 'retry' && !run.is_retryable) throw new Error('INVALID_TRANSITION: run is not retryable');
    const leaseToken = randomBytes(32).toString('base64url');
    const recoveryCredential = randomBytes(32).toString('base64url');
    const leaseEpoch = run.lease_epoch + 1;
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    const changed = this.db.prepare(`UPDATE runs SET status='running',lease_epoch=?,server_epoch=?,lease_token_hash=?,
      lease_expires_at=?,lease_holder_session_id=?,recovery_credential_hash=?,updated_at=?
      WHERE id=? AND status=? AND lease_epoch=? AND client_installation_id=?`)
      .run(leaseEpoch, this.serverEpoch, hash(leaseToken), expiresAt, input.principal.rootSessionId,
        hash(recoveryCredential), new Date().toISOString(), input.runId, input.expectedStatus,
        input.expectedLeaseEpoch, input.principal.installationId);
    if (changed.changes !== 1) throw new Error('STALE_LEASE: claim lost race');
    return Object.freeze({ leaseEpoch, leaseToken, recoveryCredential, expiresAt });
  }

  validate(proof: LeaseProof, principal: AdapterPrincipal): void {
    this.assertCurrentServerEpoch();
    if (principal.sessionId !== principal.rootSessionId) throw new Error('POLICY_VIOLATION: subagent write rejected');
    const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(proof.runId) as {
      client_installation_id: string; origin_client_type: string; lease_holder_session_id: string | null;
      lease_epoch: number; server_epoch: number;
      lease_token_hash: string | null; lease_expires_at: string | null; status: string;
    } | undefined;
    if (!run || run.client_installation_id !== principal.installationId || run.origin_client_type !== principal.clientType
      || run.lease_holder_session_id !== principal.rootSessionId
      || run.lease_epoch !== proof.leaseEpoch || run.server_epoch !== this.serverEpoch || !run.lease_token_hash
      || !equalHash(proof.leaseToken, run.lease_token_hash) || !run.lease_expires_at
      || Date.parse(run.lease_expires_at) <= Date.now() || !['running', 'waiting_for_user'].includes(run.status)) {
      throw new Error('STALE_LEASE');
    }
  }

  heartbeat(proof: LeaseProof, principal: AdapterPrincipal): string {
    this.validate(proof, principal);
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    const result = this.db.prepare(`UPDATE runs SET lease_expires_at=?,updated_at=?
      WHERE id=? AND lease_epoch=? AND server_epoch=? AND lease_token_hash IS NOT NULL`)
      .run(expiresAt, new Date().toISOString(), proof.runId, proof.leaseEpoch, this.serverEpoch);
    if (result.changes !== 1) throw new Error('STALE_LEASE');
    return expiresAt;
  }

  release(runId: string): void {
    this.db.prepare('UPDATE runs SET lease_token_hash=NULL,lease_expires_at=NULL,lease_holder_session_id=NULL WHERE id=?').run(runId);
  }
}
