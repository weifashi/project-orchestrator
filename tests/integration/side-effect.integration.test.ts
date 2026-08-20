import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { OperationHelperClient, prepareRuntimeStartup } from '@project-orchestrator/control-server';
import { ConfirmationService, LeaseService, OperationService, RunService } from '@project-orchestrator/orchestrator-service';
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
  fixture.db.pragma('user_version = 9');
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

it('recovers an interrupted execution, reconciles onto the latest retry attempt, and finalizes the run', async () => {
  const fixture = runtimeFixture();
  directories.push(fixture.dir);
  const role = fixture.content.putCanonicalJson({
    schema_id: 'project-orchestrator/role-version', schema_version: 1,
    data: { slug: 'operator', display_name: 'Operator', responsibilities: ['deploy'], requested_capabilities: [],
      forbidden_capabilities: [], input_schema: { schema_id: 'role/input', schema_version: 1, data: {} },
      output_schema: { schema_id: 'role/output', schema_version: 1, data: {} },
      completion_contract: { schema_id: 'role/completion', schema_version: 1, data: {} }, body_markdown: '# Operator' },
  });
  const workflow = fixture.content.putCanonicalJson({
    schema_id: 'project-orchestrator/workflow-version', schema_version: 1,
    data: { slug: 'recover-operation', version: 1, stages: [{ key: 'deploy', role_version_id: 'role-v2',
      optional: false, mandatory_gate: false, failure_policy: 'retry_then_fail', max_attempts: 2,
      requires_confirmation: false }], edges: [], iteration_groups: [] },
  });
  fixture.db.prepare(`INSERT INTO role_versions
    (id,role_id,version_number,content_object_id,skill_hash,input_schema_envelope,output_schema_envelope,
     requested_capabilities,effective_capabilities,forbidden_capabilities,completion_contract_envelope,published_at,status)
    VALUES('role-v2','role',2,?,?,'{}','{}','[]','[]','[]','{}',?,'published')`)
    .run(role.id, createHash('sha256').update('operator').digest('hex'), fixture.now);
  fixture.db.prepare(`INSERT INTO workflow_versions
    (id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at)
    VALUES('recover-wv','workflow',1,'',1,?,?,?)`)
    .run(workflow.id, createHash('sha256').update('workflow').digest('hex'), fixture.now);

  const workspace = { repositoryHead: 'head', stagedPatch: '', unstagedPatch: '', untrackedManifest: [], submoduleManifest: [] };
  const recoveryPrincipal = { ...principal, canonicalProjectPath: fixture.dir };
  fixture.db.pragma('user_version = 1');
  const firstLeases = new LeaseService(fixture.db, 1, 60_000);
  const firstRuns = new RunService(fixture.db, fixture.content, firstLeases);
  const created = firstRuns.createRun({ requestId: 'create-recovery', projectId: 'project', workflowVersionId: 'recover-wv',
    objective: 'deploy safely', runInput: {}, principal: recoveryPrincipal, workspace });
  const firstLease = firstRuns.claimRun({ requestId: 'claim-recovery', runId: created.runId, mode: 'start',
    expectedStatus: 'created', expectedLeaseEpoch: 0, principal: recoveryPrincipal });
  const firstProof = { runId: created.runId, leaseEpoch: firstLease.leaseEpoch, leaseToken: firstLease.leaseToken };
  const stage = fixture.db.prepare("SELECT id FROM stage_runs WHERE run_id=? AND stage_key='deploy'")
    .get(created.runId) as { id: string };
  const source = firstRuns.beginStage({ requestId: 'begin-recovery', proof: firstProof, stageRunId: stage.id,
    principal: recoveryPrincipal });

  let finishExecution: ((result: { status: 'unknown'; evidence: unknown }) => void) | undefined;
  const executionResult = new Promise<{ status: 'unknown'; evidence: unknown }>((resolve) => { finishExecution = resolve; });
  const confirmations = new ConfirmationService(fixture.db, undefined, fixture.content);
  const firstOperations = new OperationService(fixture.db, fixture.content, firstLeases, confirmations, {
    execute: async () => executionResult,
  });
  const prepared = firstOperations.prepare({ requestId: 'prepare-recovery', proof: firstProof, principal: recoveryPrincipal,
    stageAttemptId: source.attemptId, actionType: 'fixture.deploy', targetFingerprint: 'node-01',
    parameters: { version: '2.28.6' }, summary: 'fixture deployment' });
  confirmations.submitDecision({ confirmationRequestId: prepared.confirmationRequestId, nonce: prepared.nonce,
    exactActionHash: prepared.actionHash, decision: 'approve', principal: { ...recoveryPrincipal, trustedInteractive: true } });
  const staleExecution = firstOperations.execute({ requestId: 'execute-recovery', proof: firstProof,
    principal: recoveryPrincipal,
    operationId: prepared.operationId });
  expect(fixture.db.prepare('SELECT status FROM side_effect_operations WHERE id=?').get(prepared.operationId))
    .toEqual({ status: 'executing' });

  const serverEpoch = prepareRuntimeStartup(fixture.db);
  expect(fixture.db.prepare('SELECT status FROM side_effect_operations WHERE id=?').get(prepared.operationId))
    .toEqual({ status: 'unknown' });
  expect(fixture.db.prepare('SELECT status FROM stage_attempts WHERE id=?').get(source.attemptId))
    .toEqual({ status: 'interrupted' });
  finishExecution?.({ status: 'unknown', evidence: { state: 'stale-return' } });
  await expect(staleExecution).rejects.toThrow('operation no longer executing');

  const recoveredLeases = new LeaseService(fixture.db, serverEpoch, 60_000);
  const recoveredRuns = new RunService(fixture.db, fixture.content, recoveredLeases);
  const recoveredLease = recoveredRuns.claimRun({ requestId: 'recover-run', runId: created.runId, mode: 'recover',
    expectedStatus: 'interrupted', expectedLeaseEpoch: firstLease.leaseEpoch,
    recoveryCredential: firstLease.recoveryCredential, currentWorkspace: workspace, principal: recoveryPrincipal });
  const recoveredProof = { runId: created.runId, leaseEpoch: recoveredLease.leaseEpoch, leaseToken: recoveredLease.leaseToken };
  const retry = recoveredRuns.retryStage({ requestId: 'retry-stage', proof: recoveredProof, stageRunId: stage.id,
    principal: recoveryPrincipal });
  expect(() => recoveredRuns.completeStage({ requestId: 'complete-before-reconcile', proof: recoveredProof,
    stageRunId: stage.id, principal: recoveryPrincipal,
    output: { schema_id: 'project-orchestrator/stage-output', schema_version: 1, data: { status: 'succeeded',
      summary: 'not reconciled', artifact_object_ids: [], evidence_object_ids: [], risks: [], next_stage_notes: [] } },
    workspace })).toThrow('SIDE_EFFECT_OPERATION_UNRESOLVED');

  const socketPath = join(fixture.dir, 'operation-recovery.sock');
  const server = await startOperationServer(socketPath, DriverRegistry.forTestFixtures([{
    actionType: 'fixture.deploy', executable: '/bin/echo', allowedParameterKeys: ['version'],
    fixedArgs: ['execute'], reconcileArgs: ['reconcile'], timeoutMs: 1_000,
  }]));
  try {
    const recoveredOperations = new OperationService(fixture.db, fixture.content, recoveredLeases,
      new ConfirmationService(fixture.db, undefined, fixture.content), new OperationHelperClient(socketPath, 250));
    expect(await recoveredOperations.reconcile({ requestId: 'reconcile-recovery', proof: recoveredProof,
      principal: recoveryPrincipal,
      operationId: prepared.operationId })).toMatchObject({ status: 'succeeded' });
    expect(fixture.db.prepare('SELECT stage_attempt_id,status FROM side_effect_operations WHERE id=?').get(prepared.operationId))
      .toEqual({ stage_attempt_id: source.attemptId, status: 'reconciled' });
    const evidence = fixture.db.prepare(`SELECT stage_attempt_id,content_object_id,metadata_envelope FROM artifacts
      WHERE run_id=? AND artifact_type='deployment_record'`).get(created.runId) as {
        stage_attempt_id: string; content_object_id: string; metadata_envelope: string;
      };
    expect(evidence.stage_attempt_id).toBe(retry.attemptId);
    expect(JSON.parse(evidence.metadata_envelope)).toMatchObject({ operationId: prepared.operationId,
      sourceAttemptId: source.attemptId });

    recoveredRuns.completeStage({ requestId: 'complete-recovery', proof: recoveredProof, stageRunId: stage.id,
      principal: recoveryPrincipal,
      output: { schema_id: 'project-orchestrator/stage-output', schema_version: 1, data: { status: 'succeeded',
        summary: 'reconciled deployment', artifact_object_ids: [evidence.content_object_id], evidence_object_ids: [],
        risks: [], next_stage_notes: [] } }, workspace });
    recoveredRuns.finalizeRun({ requestId: 'finalize-recovery', proof: recoveredProof, principal: recoveryPrincipal });
    expect(fixture.db.prepare('SELECT status FROM runs WHERE id=?').get(created.runId)).toEqual({ status: 'completed' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  fixture.db.close();
});
