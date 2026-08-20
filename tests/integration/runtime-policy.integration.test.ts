import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ContentStore } from '@project-orchestrator/content-store';
import { ConfirmationService, LeaseService, OperationService, RunService } from '@project-orchestrator/orchestrator-service';
import { migrate, openDatabase } from '@project-orchestrator/sqlite-store';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
const stage = (key: string, extra: Record<string, unknown> = {}) => ({
  key, role_version_id: 'role-v1', optional: false, mandatory_gate: false,
  failure_policy: 'fail' as const, max_attempts: 1, requires_confirmation: false, ...extra,
});
const output = (summary = 'done', artifacts: string[] = [], evidence: string[] = []) => ({
  schema_id: 'project-orchestrator/stage-output' as const, schema_version: 1 as const,
  data: { status: 'succeeded' as const, summary, artifact_object_ids: artifacts,
    evidence_object_ids: evidence, risks: [], next_stage_notes: [] },
});

function fixture(input: {
  stages: Array<ReturnType<typeof stage>>;
  edges?: Array<{ from: string; to: string; edge_type: 'requires' | 'on_success' }>;
  iterationGroups?: Array<{ key: string; entry_stage_key: string; gate_stage_keys: string[]; aggregation_policy: 'collect_all'; max_iterations: number }>;
  parallel?: boolean;
  trustedConfirmation?: boolean;
  managedOperations?: boolean;
  outputSchema?: unknown;
  completion?: Record<string, unknown>;
  expectClaimFailure?: boolean;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-policy-'));
  directories.push(directory);
  const db = openDatabase(join(directory, 'db'));
  migrate(db);
  const content = new ContentStore(join(directory, 'objects'), db);
  const now = new Date().toISOString();
  const capability = content.putCanonicalJson({
    clientType: 'codex', adapterVersion: '1', trustedRootSessionIdentity: true,
    parallelSubagentIsolation: input.parallel === true,
    trustedInteractiveConfirmation: input.trustedConfirmation !== false,
    managedOperationExecution: input.managedOperations === true,
  });
  const outputSchema = { schema_id: 'role/output', schema_version: 1, data: input.outputSchema ?? {} };
  const completion = { schema_id: 'role/completion', schema_version: 1, data: input.completion ?? {} };
  const roleEnvelope = {
    schema_id: 'project-orchestrator/role-version', schema_version: 1,
    data: { slug: 'role', display_name: 'Role', responsibilities: ['work'], requested_capabilities: [],
      forbidden_capabilities: [], input_schema: { schema_id: 'role/input', schema_version: 1, data: {} },
      output_schema: outputSchema, completion_contract: completion, body_markdown: '# Role' },
  };
  const roleObject = content.putCanonicalJson(roleEnvelope);
  const workflowEnvelope = {
    schema_id: 'project-orchestrator/workflow-version', schema_version: 1,
    data: { slug: 'workflow', version: 1, stages: input.stages, edges: input.edges ?? [],
      iteration_groups: input.iterationGroups ?? [] },
  };
  const workflowObject = content.putCanonicalJson(workflowEnvelope);
  db.prepare("INSERT INTO client_installations(id,client_type,adapter_version,capability_object_id,credential_hash,status,last_seen_at) VALUES('install','codex','1',?,?,'active',?)")
    .run(capability.id, createHash('sha256').update('credential').digest('hex'), now);
  db.prepare("INSERT INTO projects(id,canonical_path,display_name,repository_fingerprint,created_at,last_seen_at) VALUES('project',?,'Project','fp',?,?)")
    .run(directory, now, now);
  db.prepare("INSERT INTO roles(id,slug,name,status,created_at,updated_at) VALUES('role','role','Role','active',?,?)").run(now, now);
  db.prepare(`INSERT INTO role_versions
    (id,role_id,version_number,content_object_id,skill_hash,input_schema_envelope,output_schema_envelope,
     requested_capabilities,effective_capabilities,forbidden_capabilities,completion_contract_envelope,published_at,status)
    VALUES('role-v1','role',1,?,'0000000000000000000000000000000000000000000000000000000000000000','{}',?,'[]','[]','[]',?,?,'published')`)
    .run(roleObject.id, JSON.stringify(outputSchema), JSON.stringify(completion), now);
  db.prepare("INSERT INTO workflow_templates(id,slug,name,task_type,status,created_at,updated_at) VALUES('template','workflow','Workflow','feature','active',?,?)").run(now, now);
  db.prepare("INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES('workflow-v1','template',1,'',1,?,'0000000000000000000000000000000000000000000000000000000000000000',?)")
    .run(workflowObject.id, now);
  const principal = { installationId: 'install', sessionId: 'root', rootSessionId: 'root', clientType: 'codex' as const, canonicalProjectPath: directory };
  const workspace = { repositoryHead: 'head', stagedPatch: '', unstagedPatch: '', untrackedManifest: [], submoduleManifest: [] };
  const leases = new LeaseService(db, 17, 60_000);
  const confirmations = new ConfirmationService(db, undefined, content);
  const service = new RunService(db, content, leases);
  const operations = new OperationService(db, content, leases, confirmations, {
    execute: async () => ({ status: 'unknown', evidence: { state: 'uncertain' } }),
    reconcile: async () => ({ status: 'succeeded', evidence: { state: 'confirmed' } }),
  });
  const run = service.createRun({ requestId: 'create', projectId: 'project', workflowVersionId: 'workflow-v1', objective: 'test', runInput: {}, principal, workspace });
  let lease: ReturnType<RunService['claimRun']> | undefined;
  let claimError: unknown;
  try {
    lease = service.claimRun({ requestId: 'claim', runId: run.runId, mode: 'start', expectedStatus: 'created', expectedLeaseEpoch: 0, principal });
  } catch (error) {
    if (!input.expectClaimFailure) throw error;
    claimError = error;
  }
  const claimed = lease as ReturnType<RunService['claimRun']>;
  const proof = { runId: run.runId, leaseEpoch: claimed?.leaseEpoch ?? 0, leaseToken: claimed?.leaseToken ?? 'unclaimed' };
  const stageId = (key: string, iteration = 0): string => (db.prepare('SELECT id FROM stage_runs WHERE run_id=? AND stage_key=? AND iteration_number=?')
    .get(run.runId, key, iteration) as { id: string }).id;
  return { directory, db, content, service, confirmations, operations, principal, workspace, runId: run.runId,
    lease: claimed, claimError, proof, stageId };
}

it('persists a claim-time condition error as a failed run and ordered event', () => {
  const f = fixture({ stages: [stage('requirements', {
    condition: { op: 'eq', path: '/input/missing', value: true },
  })], expectClaimFailure: true });
  expect(f.claimError).toBeInstanceOf(Error);
  expect(f.db.prepare('SELECT status,failure_code FROM runs WHERE id=?').get(f.runId))
    .toEqual({ status: 'failed', failure_code: 'CONDITION_EVALUATION_FAILED' });
  expect(f.db.prepare("SELECT event_type FROM events WHERE run_id=? ORDER BY sequence_number DESC LIMIT 1").get(f.runId))
    .toEqual({ event_type: 'run_failed' });
  f.db.close();
});

it('keeps an all-success run running until server-side finalize completes it', () => {
  const f = fixture({ stages: [stage('work')] });
  const id = f.stageId('work');
  f.service.beginStage({ requestId: 'begin', proof: f.proof, stageRunId: id, principal: f.principal });
  f.service.completeStage({ requestId: 'complete', proof: f.proof, stageRunId: id, principal: f.principal, output: output(), workspace: f.workspace });
  expect(f.db.prepare('SELECT status FROM runs WHERE id=?').get(f.runId)).toEqual({ status: 'running' });
  f.service.finalizeRun({ requestId: 'finalize', proof: f.proof, principal: f.principal });
  expect(f.db.prepare('SELECT status FROM runs WHERE id=?').get(f.runId)).toEqual({ status: 'completed' });
  f.db.close();
});

it('does not activate an iteration before its entry is reachable and fails on a prerequisite failure', () => {
  const f = fixture({
    stages: [stage('requirements'), stage('implementation', { iteration_group_key: 'delivery', failure_policy: 'trigger_iteration' }),
      stage('testing', { iteration_group_key: 'delivery', failure_policy: 'trigger_iteration', mandatory_gate: true }),
      stage('done')],
    edges: [{ from: 'requirements', to: 'implementation', edge_type: 'on_success' },
      { from: 'implementation', to: 'testing', edge_type: 'on_success' },
      { from: 'testing', to: 'done', edge_type: 'on_success' }],
    iterationGroups: [{ key: 'delivery', entry_stage_key: 'implementation', gate_stage_keys: ['testing'], aggregation_policy: 'collect_all', max_iterations: 3 }],
  });
  expect(f.db.prepare('SELECT count(*) AS count FROM run_iterations WHERE run_id=?').get(f.runId)).toEqual({ count: 0 });
  const requirements = f.stageId('requirements');
  f.service.beginStage({ requestId: 'begin', proof: f.proof, stageRunId: requirements, principal: f.principal });
  f.service.failStage({ requestId: 'fail', proof: f.proof, stageRunId: requirements, principal: f.principal, errorCode: 'REJECTED', summary: 'blocked' });
  expect(f.db.prepare('SELECT status FROM runs WHERE id=?').get(f.runId)).toEqual({ status: 'failed' });
  expect(f.db.prepare("SELECT count(*) AS count FROM run_iterations WHERE run_id=? AND status='running'").get(f.runId)).toEqual({ count: 0 });
  f.db.close();
});

it('requires a consumed confirmation bound to the current attempt and never reuses it on retry', () => {
  const f = fixture({ stages: [stage('release', { requires_confirmation: true, failure_policy: 'retry_then_fail', max_attempts: 2 })] });
  const id = f.stageId('release');
  f.service.beginStage({ requestId: 'begin-1', proof: f.proof, stageRunId: id, principal: f.principal });
  expect(() => f.service.completeStage({ requestId: 'complete-without-confirmation', proof: f.proof, stageRunId: id, principal: f.principal, output: output(), workspace: f.workspace }))
    .toThrow('confirmation');
  const first = f.service.requestConfirmation({ requestId: 'confirm-1', proof: f.proof, principal: f.principal, stageRunId: id, type: 'release', summary: 'release', exactActionHash: '1'.repeat(64) });
  f.confirmations.submitDecision({ confirmationRequestId: first.id, nonce: first.nonce, exactActionHash: '1'.repeat(64), decision: 'approve', principal: { ...f.principal, trustedInteractive: true } });
  f.service.failStage({ requestId: 'fail-1', proof: f.proof, stageRunId: id, principal: f.principal, errorCode: 'RETRY', summary: 'retry' });
  const retryLease = f.service.claimRun({ requestId: 'retry-run', runId: f.runId, mode: 'retry', expectedStatus: 'failed', expectedLeaseEpoch: 1,
    stageRunId: id, recoveryCredential: f.lease.recoveryCredential, currentWorkspace: f.workspace, principal: f.principal });
  const retryProof = { runId: f.runId, leaseEpoch: retryLease.leaseEpoch, leaseToken: retryLease.leaseToken };
  expect(() => f.service.completeStage({ requestId: 'complete-with-old-confirmation', proof: retryProof, stageRunId: id, principal: f.principal, output: output(), workspace: f.workspace }))
    .toThrow('confirmation');
  const second = f.service.requestConfirmation({ requestId: 'confirm-2', proof: retryProof, principal: f.principal, stageRunId: id, type: 'release', summary: 'release', exactActionHash: '2'.repeat(64) });
  f.confirmations.submitDecision({ confirmationRequestId: second.id, nonce: second.nonce, exactActionHash: '2'.repeat(64), decision: 'approve', principal: { ...f.principal, trustedInteractive: true } });
  f.service.completeStage({ requestId: 'complete-2', proof: retryProof, stageRunId: id, principal: f.principal, output: output(), workspace: f.workspace });
  f.db.close();
});

it('resumes a paused failure without prematurely failing before its local retry', () => {
  const f = fixture({ stages: [stage('review', { failure_policy: 'pause', max_attempts: 2 })] });
  const id = f.stageId('review');
  f.service.beginStage({ requestId: 'begin', proof: f.proof, stageRunId: id, principal: f.principal });
  f.service.failStage({ requestId: 'pause', proof: f.proof, stageRunId: id, principal: f.principal,
    errorCode: 'NEEDS_INPUT', summary: 'pause for review' });
  expect(f.db.prepare('SELECT status FROM runs WHERE id=?').get(f.runId)).toEqual({ status: 'paused' });
  const lease = f.service.claimRun({ requestId: 'resume', runId: f.runId, mode: 'resume', expectedStatus: 'paused',
    expectedLeaseEpoch: f.lease.leaseEpoch, recoveryCredential: f.lease.recoveryCredential,
    currentWorkspace: f.workspace, principal: f.principal });
  const proof = { runId: f.runId, leaseEpoch: lease.leaseEpoch, leaseToken: lease.leaseToken };
  f.service.retryStage({ requestId: 'retry', proof, stageRunId: id, principal: f.principal });
  expect(f.db.prepare('SELECT status FROM runs WHERE id=?').get(f.runId)).toEqual({ status: 'running' });
  expect(f.db.prepare('SELECT status FROM stage_runs WHERE id=?').get(id)).toEqual({ status: 'running' });
  f.db.close();
});

it('validates the frozen role output schema and artifact/evidence completion contract', () => {
  const f = fixture({
    stages: [stage('work')],
    outputSchema: { type: 'object', required: ['summary'], properties: { summary: { const: 'contract-ok' } } },
    completion: { required_artifacts: [{ artifact_type: 'document', min_count: 1 }],
      required_evidence: [{ artifact_type: 'test_evidence', min_count: 1 }] },
  });
  const id = f.stageId('work');
  const attempt = f.service.beginStage({ requestId: 'begin', proof: f.proof, stageRunId: id, principal: f.principal });
  expect(() => f.service.completeStage({ requestId: 'bad-schema', proof: f.proof, stageRunId: id, principal: f.principal, output: output('wrong'), workspace: f.workspace }))
    .toThrow('SCHEMA_INVALID');
  writeFileSync(join(f.directory, 'artifact.txt'), 'artifact');
  writeFileSync(join(f.directory, 'evidence.txt'), 'evidence');
  const artifact = f.service.recordArtifact({ requestId: 'artifact', proof: f.proof, principal: f.principal, stageAttemptId: attempt.attemptId,
    sourcePath: 'artifact.txt', artifactType: 'document', summary: 'artifact', producerRoleVersionId: 'role-v1' });
  expect(() => f.service.completeStage({ requestId: 'missing-evidence', proof: f.proof, stageRunId: id, principal: f.principal,
    output: output('contract-ok', [artifact.contentObjectId]), workspace: f.workspace })).toThrow('completion contract');
  const evidence = f.service.recordArtifact({ requestId: 'evidence', proof: f.proof, principal: f.principal, stageAttemptId: attempt.attemptId,
    sourcePath: 'evidence.txt', artifactType: 'test_evidence', summary: 'evidence', producerRoleVersionId: 'role-v1' });
  f.service.completeStage({ requestId: 'contract-complete', proof: f.proof, stageRunId: id, principal: f.principal,
    output: output('contract-ok', [artifact.contentObjectId], [evidence.contentObjectId]), workspace: f.workspace });
  f.service.finalizeRun({ requestId: 'finalize', proof: f.proof, principal: f.principal });
  f.db.close();
});

it('applies a frozen boolean false output schema and rejects every completion', () => {
  const f = fixture({ stages: [stage('work')], outputSchema: false });
  const id = f.stageId('work');
  f.service.beginStage({ requestId: 'begin', proof: f.proof, stageRunId: id, principal: f.principal });
  expect(() => f.service.completeStage({ requestId: 'complete', proof: f.proof, stageRunId: id,
    principal: f.principal, output: output(), workspace: f.workspace })).toThrow('SCHEMA_INVALID');
  f.db.close();
});

it('fails closed when the frozen adapter disables trusted interactive confirmation', () => {
  const f = fixture({ stages: [stage('release', { requires_confirmation: true })], trustedConfirmation: false });
  const id = f.stageId('release');
  f.service.beginStage({ requestId: 'begin', proof: f.proof, stageRunId: id, principal: f.principal });
  expect(() => f.service.requestConfirmation({ requestId: 'confirmation', proof: f.proof, principal: f.principal,
    stageRunId: id, type: 'release', summary: 'release', exactActionHash: 'a'.repeat(64) }))
    .toThrow('TRUSTED_CONFIRMATION_UNAVAILABLE');
  f.db.close();
});

it('invalidates pending confirmations when their run is cancelled', () => {
  const f = fixture({ stages: [stage('release')] });
  const id = f.stageId('release');
  f.service.beginStage({ requestId: 'begin-cancel', proof: f.proof, stageRunId: id, principal: f.principal });
  const confirmation = f.service.requestConfirmation({ requestId: 'confirmation-cancel', proof: f.proof,
    principal: f.principal, stageRunId: id, type: 'release', summary: 'release', exactActionHash: 'c'.repeat(64) });
  f.service.cancelRun({ requestId: 'cancel-with-confirmation', proof: f.proof, principal: f.principal });
  expect(f.db.prepare('SELECT status FROM confirmation_requests WHERE id=?').get(confirmation.id)).toEqual({ status: 'expired' });
  expect(f.db.prepare('SELECT status FROM runs WHERE id=?').get(f.runId)).toEqual({ status: 'cancelled' });
  f.db.close();
});

it('blocks attempt completion while a managed operation is intent-recorded or unknown', async () => {
  const f = fixture({ stages: [stage('deploy')], managedOperations: true });
  const id = f.stageId('deploy');
  const attempt = f.service.beginStage({ requestId: 'begin', proof: f.proof, stageRunId: id, principal: f.principal });
  const operation = f.operations.prepare({ requestId: 'prepare', proof: f.proof, principal: f.principal,
    stageAttemptId: attempt.attemptId, actionType: 'deploy', targetFingerprint: 'node', parameters: {}, summary: 'deploy' });
  f.confirmations.submitDecision({ confirmationRequestId: operation.confirmationRequestId, nonce: operation.nonce,
    exactActionHash: operation.actionHash, decision: 'approve', principal: { ...f.principal, trustedInteractive: true } });
  const complete = (requestId: string): void => f.service.completeStage({ requestId, proof: f.proof,
    stageRunId: id, principal: f.principal, output: output(), workspace: f.workspace });
  expect(() => complete('complete-intent')).toThrow('SIDE_EFFECT_OPERATION_UNRESOLVED');
  expect(await f.operations.execute({ requestId: 'execute', proof: f.proof, principal: f.principal,
    operationId: operation.operationId })).toMatchObject({ status: 'unknown' });
  expect(() => complete('complete-unknown')).toThrow('SIDE_EFFECT_OPERATION_UNRESOLVED');
  f.db.close();
});

it.each([{ parallel: false, expected: ['a'] }, { parallel: true, expected: ['a', 'b'] }])(
  'derives a $parallel parallel frontier from the frozen adapter capability', ({ parallel, expected }) => {
    const f = fixture({ stages: [stage('root'), stage('a'), stage('b')], parallel,
      edges: [{ from: 'root', to: 'a', edge_type: 'on_success' }, { from: 'root', to: 'b', edge_type: 'on_success' }] });
    const root = f.stageId('root');
    f.service.beginStage({ requestId: 'begin-root', proof: f.proof, stageRunId: root, principal: f.principal });
    f.service.completeStage({ requestId: 'complete-root', proof: f.proof, stageRunId: root, principal: f.principal, output: output(), workspace: f.workspace });
    const ready = f.db.prepare("SELECT stage_key FROM stage_runs WHERE run_id=? AND status='ready' ORDER BY stage_key")
      .all(f.runId) as Array<{ stage_key: string }>;
    expect(ready.map((row) => row.stage_key)).toEqual(expected);
    f.db.close();
  },
);

it('completes a successful implementation plus three-gate iteration before operations and finalize', () => {
  const group = 'delivery';
  const f = fixture({
    parallel: true,
    stages: [
      stage('implementation', { iteration_group_key: group, failure_policy: 'trigger_iteration' }),
      ...['review', 'testing', 'security'].map((key) => stage(key, {
        iteration_group_key: group, failure_policy: 'trigger_iteration', mandatory_gate: true,
      })),
      stage('operations'),
    ],
    edges: [
      ...['review', 'testing', 'security'].map((to) => ({ from: 'implementation', to, edge_type: 'on_success' as const })),
      ...['review', 'testing', 'security'].map((from) => ({ from, to: 'operations', edge_type: 'on_success' as const })),
    ],
    iterationGroups: [{ key: group, entry_stage_key: 'implementation', gate_stage_keys: ['review', 'testing', 'security'],
      aggregation_policy: 'collect_all', max_iterations: 3 }],
  });
  const complete = (key: string, iteration: number, suffix: string): void => {
    const id = f.stageId(key, iteration);
    f.service.beginStage({ requestId: `begin-${suffix}`, proof: f.proof, stageRunId: id, principal: f.principal });
    f.service.completeStage({ requestId: `complete-${suffix}`, proof: f.proof, stageRunId: id,
      principal: f.principal, output: output(), workspace: f.workspace });
  };
  complete('implementation', 1, 'implementation');
  for (const gate of ['review', 'testing', 'security']) complete(gate, 1, gate);
  expect(f.db.prepare("SELECT status FROM run_iterations WHERE run_id=? AND group_key='delivery' AND iteration_number=1")
    .get(f.runId)).toEqual({ status: 'succeeded' });
  expect(f.db.prepare("SELECT status FROM stage_runs WHERE run_id=? AND stage_key='operations'").get(f.runId))
    .toEqual({ status: 'ready' });
  complete('operations', 0, 'operations');
  f.service.finalizeRun({ requestId: 'finalize-successful-iteration', proof: f.proof, principal: f.principal });
  expect(f.db.prepare('SELECT status FROM runs WHERE id=?').get(f.runId)).toEqual({ status: 'completed' });
  f.db.close();
});
