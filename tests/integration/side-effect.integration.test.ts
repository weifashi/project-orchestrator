import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { OperationHelperClient } from '@project-orchestrator/control-server';
import { ConfirmationService, LeaseService, OperationService } from '@project-orchestrator/orchestrator-service';
import { DriverRegistry, startOperationServer } from '../../packages/operation-executor/src/index.js';
import { principal, runtimeFixture } from '../../packages/orchestrator-service/test/runtime-fixture.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

it('keeps an uncertain helper result unknown and reconciles it through the isolated helper', async () => {
  const fixture = runtimeFixture();
  directories.push(fixture.dir);
  fixture.db.prepare("INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES('wv','workflow',1,'',1,?,?,?)")
    .run(fixture.object.id, 'a'.repeat(64), fixture.now);
  fixture.db.prepare("INSERT INTO runs(id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,client_installation_id,origin_session_id,status,updated_at) VALUES('run','project','wv','','{}','codex','install','root','created',?)")
    .run(fixture.now);
  fixture.db.prepare(`INSERT INTO run_snapshots
    (run_id,workflow_object_id,role_bundle_object_id,rule_bundle_object_id,safety_baseline_object_id,
     adapter_capability_object_id,repository_head,staged_patch_object_id,unstaged_patch_object_id,
     untracked_manifest_object_id,submodule_manifest_object_id,working_tree_fingerprint,created_at)
    VALUES('run',?,?,?,?,?,'head',?,?,?,?,?,?)`)
    .run(fixture.object.id, fixture.object.id, fixture.object.id, fixture.object.id, fixture.capability.id,
      fixture.object.id, fixture.object.id, fixture.object.id, fixture.object.id, 'fingerprint', fixture.now);
  const leases = new LeaseService(fixture.db, 9, 60_000);
  const lease = leases.claim({ runId: 'run', principal, mode: 'start', expectedStatus: 'created', expectedLeaseEpoch: 0 });
  const proof = { runId: 'run', leaseEpoch: lease.leaseEpoch, leaseToken: lease.leaseToken };
  fixture.db.prepare("INSERT INTO stage_runs(id,run_id,stage_key,role_version_id,status,max_attempts,created_at,updated_at) VALUES('stage','run','stage','role-v1','running',1,?,?)")
    .run(fixture.now, fixture.now);
  fixture.db.prepare("INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at) VALUES('attempt','stage',1,'running','{}',?)")
    .run(fixture.now);
  fixture.db.prepare("UPDATE stage_runs SET latest_attempt_id='attempt' WHERE id='stage'").run();

  const socketPath = join(fixture.dir, 'operation.sock');
  const confirmations = new ConfirmationService(fixture.db, undefined, fixture.content);
  const operations = new OperationService(
    fixture.db, fixture.content, leases, confirmations, new OperationHelperClient(socketPath, 250),
  );
  const prepared = operations.prepare({
    requestId: 'prepare', proof, principal, stageAttemptId: 'attempt', actionType: 'fixture.deploy',
    targetFingerprint: 'node-01', parameters: { version: '2.28.6' }, summary: 'fixture deployment',
  });
  confirmations.submitDecision({
    confirmationRequestId: prepared.confirmationRequestId, nonce: prepared.nonce,
    exactActionHash: prepared.actionHash, decision: 'approve', principal: { ...principal, trustedInteractive: true },
  });

  expect(await operations.execute({ requestId: 'execute', proof, principal, operationId: prepared.operationId }))
    .toMatchObject({ status: 'unknown' });
  expect(fixture.db.prepare('SELECT status FROM side_effect_operations WHERE id=?').get(prepared.operationId))
    .toEqual({ status: 'unknown' });

  const server = await startOperationServer(socketPath, DriverRegistry.forTestFixtures([{
    actionType: 'fixture.deploy', executable: '/bin/echo', allowedParameterKeys: ['version'],
    fixedArgs: ['execute'], reconcileArgs: ['reconcile'], timeoutMs: 1_000,
  }]));
  expect(await operations.reconcile({ requestId: 'reconcile', proof, principal, operationId: prepared.operationId }))
    .toMatchObject({ status: 'succeeded' });
  expect(fixture.db.prepare('SELECT status FROM side_effect_operations WHERE id=?').get(prepared.operationId))
    .toEqual({ status: 'reconciled' });
  expect(fixture.db.prepare('SELECT count(*) AS count FROM artifacts WHERE run_id=?').get('run'))
    .toEqual({ count: 2 });

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fixture.db.close();
});
