import { rmSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { ConfirmationService, LeaseService, OperationService } from '../src/index.js';
import { principal, runtimeFixture } from './runtime-fixture.js';
const clean: string[] = [];
afterEach(() => clean.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
it('binds prepare approval and marks uncertain effects unknown until reconciliation', async () => {
  const f = runtimeFixture(); clean.push(f.dir);
  f.db.prepare("INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES('wv','workflow',1,'',1,?,'h',?)").run(f.object.id, f.now);
  f.db.prepare("INSERT INTO runs(id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,client_installation_id,origin_session_id,status,updated_at) VALUES('run','project','wv','','{}','codex','install','root','created',?)").run(f.now);
  f.db.prepare(`INSERT INTO run_snapshots(run_id,workflow_object_id,role_bundle_object_id,rule_bundle_object_id,safety_baseline_object_id,adapter_capability_object_id,repository_head,staged_patch_object_id,unstaged_patch_object_id,untracked_manifest_object_id,submodule_manifest_object_id,working_tree_fingerprint,created_at)
    VALUES('run',?,?,?,?,?,'head',?,?,?,?,? ,?)`).run(f.object.id, f.object.id, f.object.id, f.object.id, f.object.id, f.object.id, f.object.id, f.object.id, f.object.id, 'fp', f.now);
  const leases = new LeaseService(f.db, 1, 60_000);
  const lease = leases.claim({ runId: 'run', principal, mode: 'start', expectedStatus: 'created', expectedLeaseEpoch: 0 });
  const proof = { runId: 'run', leaseEpoch: lease.leaseEpoch, leaseToken: lease.leaseToken };
  f.db.prepare("INSERT INTO stage_runs(id,run_id,stage_key,role_version_id,status,max_attempts,created_at,updated_at) VALUES('stage','run','s','role-v1','running',1,?,?)").run(f.now, f.now);
  f.db.prepare("INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at) VALUES('attempt','stage',1,'running','{}',?)").run(f.now);
  f.db.prepare("UPDATE stage_runs SET latest_attempt_id='attempt' WHERE id='stage'").run();
  const confirmations = new ConfirmationService(f.db, undefined, f.content);
  const helper = { execute: async () => { throw new Error('connection lost'); }, reconcile: async () => ({ status: 'succeeded' as const, externalReference: 'ext', evidence: {} }) };
  const operations = new OperationService(f.db, f.content, leases, confirmations, helper);
  const prepared = operations.prepare({ requestId: 'prepare', proof, principal, stageAttemptId: 'attempt', actionType: 'deploy', targetFingerprint: 'node', parameters: { version: '1' }, summary: 'deploy' });
  confirmations.submitDecision({ confirmationRequestId: prepared.confirmationRequestId, nonce: prepared.nonce, exactActionHash: prepared.actionHash, decision: 'approve', principal: { ...principal, trustedInteractive: true } });
  expect((await operations.execute({ requestId: 'execute', proof, principal, operationId: prepared.operationId })).status).toBe('unknown');
  await expect(operations.execute({ requestId: 'execute-2', proof, principal, operationId: prepared.operationId })).rejects.toThrow('cannot execute');
  expect((await operations.reconcile({ requestId: 'reconcile', proof, principal, operationId: prepared.operationId })).status).toBe('succeeded');
  expect(f.db.prepare('SELECT count(*) AS count FROM artifacts WHERE run_id=?').get('run')).toEqual({ count: 2 });
  f.db.close();
});
