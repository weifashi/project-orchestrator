import { rmSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { ConfirmationService, LeaseService, OperationService, type OperationHelper } from '../src/index.js';
import { principal, runtimeFixture } from './runtime-fixture.js';

const clean: string[] = [];
afterEach(() => clean.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function fixture(helper: OperationHelper, managedOperationExecution = true) {
  const f = runtimeFixture();
  clean.push(f.dir);
  const capability = managedOperationExecution ? f.capability : f.content.putCanonicalJson({
    clientType: 'codex', adapterVersion: '1', trustedRootSessionIdentity: true,
    parallelSubagentIsolation: true, trustedInteractiveConfirmation: true, managedOperationExecution: false,
  });
  f.db.prepare("INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES('wv','workflow',1,'',1,?,?,?)").run(f.object.id, 'a'.repeat(64), f.now);
  f.db.prepare("INSERT INTO runs(id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,client_installation_id,origin_session_id,status,updated_at) VALUES('run','project','wv','','{}','codex','install','root','created',?)").run(f.now);
  f.db.prepare(`INSERT INTO run_snapshots(run_id,workflow_object_id,role_bundle_object_id,rule_bundle_object_id,safety_baseline_object_id,adapter_capability_object_id,repository_head,staged_patch_object_id,unstaged_patch_object_id,untracked_manifest_object_id,submodule_manifest_object_id,working_tree_fingerprint,created_at)
    VALUES('run',?,?,?,?,?,'head',?,?,?,?,? ,?)`).run(f.object.id, f.object.id, f.object.id, f.object.id, capability.id, f.object.id, f.object.id, f.object.id, f.object.id, 'fp', f.now);
  f.db.pragma('user_version = 1');
  const leases = new LeaseService(f.db, 1, 60_000);
  const lease = leases.claim({ runId: 'run', principal, mode: 'start', expectedStatus: 'created', expectedLeaseEpoch: 0 });
  const proof = { runId: 'run', leaseEpoch: lease.leaseEpoch, leaseToken: lease.leaseToken };
  f.db.prepare("INSERT INTO stage_runs(id,run_id,stage_key,role_version_id,status,max_attempts,created_at,updated_at) VALUES('stage','run','s','role-v1','running',1,?,?)").run(f.now, f.now);
  f.db.prepare("INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at) VALUES('attempt','stage',1,'running','{}',?)").run(f.now);
  f.db.prepare("UPDATE stage_runs SET latest_attempt_id='attempt' WHERE id='stage'").run();
  const confirmations = new ConfirmationService(f.db, undefined, f.content);
  const operations = new OperationService(f.db, f.content, leases, confirmations, helper);
  return { ...f, confirmations, operations, proof };
}

it('moves the stage and idle run to waiting on prepare, then resumes both after approval', () => {
  const f = fixture({ execute: async () => ({ status: 'succeeded', evidence: {} }) });
  const prepared = f.operations.prepare({
    requestId: 'prepare', proof: f.proof, principal, stageAttemptId: 'attempt', actionType: 'deploy',
    targetFingerprint: 'node', parameters: { version: '1' }, summary: 'deploy',
  });
  expect(f.db.prepare("SELECT status FROM stage_runs WHERE id='stage'").get()).toEqual({ status: 'waiting_for_user' });
  expect(f.db.prepare("SELECT status FROM runs WHERE id='run'").get()).toEqual({ status: 'waiting_for_user' });
  f.confirmations.submitDecision({
    confirmationRequestId: prepared.confirmationRequestId, nonce: prepared.nonce,
    exactActionHash: prepared.actionHash, decision: 'approve', principal: { ...principal, trustedInteractive: true },
  });
  expect(f.db.prepare("SELECT status FROM stage_runs WHERE id='stage'").get()).toEqual({ status: 'running' });
  expect(f.db.prepare("SELECT status FROM runs WHERE id='run'").get()).toEqual({ status: 'running' });
  f.db.close();
});

it('keeps a parallel run active while only the operation stage waits for approval', () => {
  const f = fixture({ execute: async () => ({ status: 'succeeded', evidence: {} }) });
  f.db.prepare("INSERT INTO stage_runs(id,run_id,stage_key,role_version_id,status,max_attempts,created_at,updated_at) VALUES('peer','run','peer','role-v1','ready',1,?,?)")
    .run(f.now, f.now);
  f.operations.prepare({ requestId: 'prepare', proof: f.proof, principal, stageAttemptId: 'attempt',
    actionType: 'deploy', targetFingerprint: 'node', parameters: {}, summary: 'deploy' });
  expect(f.db.prepare("SELECT status FROM stage_runs WHERE id='stage'").get()).toEqual({ status: 'waiting_for_user' });
  expect(f.db.prepare("SELECT status FROM runs WHERE id='run'").get()).toEqual({ status: 'running' });
  f.db.close();
});

it('fails closed when managed operations are disabled by the frozen adapter capability', () => {
  const f = fixture({ execute: async () => ({ status: 'succeeded', evidence: {} }) }, false);
  expect(() => f.operations.prepare({ requestId: 'prepare', proof: f.proof, principal, stageAttemptId: 'attempt',
    actionType: 'deploy', targetFingerprint: 'node', parameters: {}, summary: 'deploy' }))
    .toThrow('MANAGED_OPERATION_UNAVAILABLE');
  f.db.close();
});

it('binds approval and marks uncertain effects unknown until reconciliation', async () => {
  const helper = {
    execute: async () => { throw new Error('connection lost'); },
    reconcile: async () => ({ status: 'succeeded' as const, externalReference: 'ext', evidence: {} }),
  };
  const f = fixture(helper);
  const prepared = f.operations.prepare({ requestId: 'prepare', proof: f.proof, principal, stageAttemptId: 'attempt', actionType: 'deploy', targetFingerprint: 'node', parameters: { version: '1' }, summary: 'deploy' });
  f.confirmations.submitDecision({ confirmationRequestId: prepared.confirmationRequestId, nonce: prepared.nonce, exactActionHash: prepared.actionHash, decision: 'approve', principal: { ...principal, trustedInteractive: true } });
  expect((await f.operations.execute({ requestId: 'execute', proof: f.proof, principal, operationId: prepared.operationId })).status).toBe('unknown');
  await expect(f.operations.execute({ requestId: 'execute-2', proof: f.proof, principal, operationId: prepared.operationId })).rejects.toThrow('cannot execute');
  expect((await f.operations.reconcile({ requestId: 'reconcile', proof: f.proof, principal, operationId: prepared.operationId })).status).toBe('succeeded');
  expect(f.db.prepare('SELECT count(*) AS count FROM artifacts WHERE run_id=?').get('run')).toEqual({ count: 2 });
  f.db.close();
});

it('persists a failed reconcile idempotency record, leaves operation unknown, and emits no success event', async () => {
  const f = fixture({
    execute: async () => { throw new Error('connection lost'); },
    reconcile: async () => { throw new Error('helper offline'); },
  });
  const prepared = f.operations.prepare({ requestId: 'prepare', proof: f.proof, principal, stageAttemptId: 'attempt', actionType: 'deploy', targetFingerprint: 'node', parameters: {}, summary: 'deploy' });
  f.confirmations.submitDecision({ confirmationRequestId: prepared.confirmationRequestId, nonce: prepared.nonce, exactActionHash: prepared.actionHash, decision: 'approve', principal: { ...principal, trustedInteractive: true } });
  await f.operations.execute({ requestId: 'execute', proof: f.proof, principal, operationId: prepared.operationId });
  await expect(f.operations.reconcile({ requestId: 'reconcile-fails', proof: f.proof, principal, operationId: prepared.operationId }))
    .rejects.toThrow('helper offline');
  expect(f.db.prepare('SELECT status FROM side_effect_operations WHERE id=?').get(prepared.operationId))
    .toEqual({ status: 'unknown' });
  expect(f.db.prepare("SELECT status FROM idempotency_requests WHERE operation='reconcile_side_effect' AND request_id='reconcile-fails'").get())
    .toEqual({ status: 'failed' });
  expect(f.db.prepare("SELECT count(*) AS count FROM events WHERE run_id='run' AND event_type='side_effect_reconciled'").get())
    .toEqual({ count: 0 });
  f.db.close();
});

it('keeps an inconclusive reconcile unknown and emits unknown rather than reconciled', async () => {
  const f = fixture({
    execute: async () => { throw new Error('connection lost'); },
    reconcile: async () => ({ status: 'unknown' as const, evidence: { state: 'not_found' } }),
  });
  const prepared = f.operations.prepare({ requestId: 'prepare', proof: f.proof, principal,
    stageAttemptId: 'attempt', actionType: 'deploy', targetFingerprint: 'node', parameters: {}, summary: 'deploy' });
  f.confirmations.submitDecision({ confirmationRequestId: prepared.confirmationRequestId, nonce: prepared.nonce,
    exactActionHash: prepared.actionHash, decision: 'approve', principal: { ...principal, trustedInteractive: true } });
  await f.operations.execute({ requestId: 'execute', proof: f.proof, principal, operationId: prepared.operationId });
  expect(await f.operations.reconcile({ requestId: 'reconcile-unknown', proof: f.proof, principal,
    operationId: prepared.operationId })).toMatchObject({ status: 'unknown' });
  expect(f.db.prepare('SELECT status FROM side_effect_operations WHERE id=?').get(prepared.operationId))
    .toEqual({ status: 'unknown' });
  expect(f.db.prepare("SELECT event_type FROM events WHERE run_id='run' ORDER BY sequence_number DESC LIMIT 1").get())
    .toEqual({ event_type: 'side_effect_unknown' });
  f.db.close();
});

it('refuses to reconcile an unknown operation after its attempt is already succeeded', async () => {
  const f = fixture({
    execute: async () => { throw new Error('connection lost'); },
    reconcile: async () => ({ status: 'succeeded' as const, evidence: {} }),
  });
  const prepared = f.operations.prepare({ requestId: 'prepare', proof: f.proof, principal,
    stageAttemptId: 'attempt', actionType: 'deploy', targetFingerprint: 'node', parameters: {}, summary: 'deploy' });
  f.confirmations.submitDecision({ confirmationRequestId: prepared.confirmationRequestId, nonce: prepared.nonce,
    exactActionHash: prepared.actionHash, decision: 'approve', principal: { ...principal, trustedInteractive: true } });
  await f.operations.execute({ requestId: 'execute', proof: f.proof, principal, operationId: prepared.operationId });
  f.db.prepare(`UPDATE stage_attempts SET status='succeeded',output_envelope='{}',artifact_manifest_object_id=?,
    evidence_manifest_object_id=?,changed_files_object_id=?,completed_at=? WHERE id='attempt' AND status='running'`)
    .run(f.object.id, f.object.id, f.object.id, f.now);
  await expect(f.operations.reconcile({ requestId: 'reconcile', proof: f.proof, principal,
    operationId: prepared.operationId })).rejects.toThrow('no current running reconciliation attempt');
  f.db.close();
});
