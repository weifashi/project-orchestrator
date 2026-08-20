import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ContentStore } from '@project-orchestrator/content-store';
import { LeaseService, RunService } from '@project-orchestrator/orchestrator-service';
import { migrate, openDatabase } from '@project-orchestrator/sqlite-store';

it('claims a retryable failed run and creates its next attempt atomically', () => {
  const directory = mkdtempSync(join(tmpdir(), 'failed-retry-'));
  try {
    const db = openDatabase(join(directory, 'db'));
    migrate(db);
    const content = new ContentStore(join(directory, 'objects'), db);
    const now = new Date().toISOString();
    const capability = content.putCanonicalJson({ clientType: 'codex', adapterVersion: '1', trustedRootSessionIdentity: true, parallelSubagentIsolation: true, trustedInteractiveConfirmation: true, managedOperationExecution: true });
    const roleObject = content.putCanonicalJson({ schema_id: 'project-orchestrator/role-version', schema_version: 1,
      data: { slug: 'role', display_name: 'Role', responsibilities: ['work'], requested_capabilities: [], forbidden_capabilities: [],
        input_schema: { schema_id: 'role/input', schema_version: 1, data: {} }, output_schema: { schema_id: 'role/output', schema_version: 1, data: {} },
        completion_contract: { schema_id: 'role/completion', schema_version: 1, data: {} }, body_markdown: '# Role' } });
    const workflow = content.putCanonicalJson({
      schema_id: 'project-orchestrator/workflow-version', schema_version: 1,
      data: {
        slug: 'retry', version: 1,
        stages: [{ key: 'work', role_version_id: 'role-v1', optional: false, mandatory_gate: false,
          failure_policy: 'retry_then_fail', max_attempts: 2, requires_confirmation: false }],
        edges: [], iteration_groups: [],
      },
    });
    db.prepare("INSERT INTO client_installations(id,client_type,adapter_version,capability_object_id,credential_hash,status,last_seen_at) VALUES('install','codex','1',?,?,'active',?)")
      .run(capability.id, createHash('sha256').update('credential').digest('hex'), now);
    db.prepare("INSERT INTO projects(id,canonical_path,display_name,repository_fingerprint,created_at,last_seen_at) VALUES('project',?,'Project','fp',?,?)")
      .run(directory, now, now);
    db.prepare("INSERT INTO roles(id,slug,name,status,created_at,updated_at) VALUES('role','role','Role','active',?,?)").run(now, now);
    db.prepare("INSERT INTO role_versions(id,role_id,version_number,content_object_id,skill_hash,input_schema_envelope,output_schema_envelope,requested_capabilities,effective_capabilities,forbidden_capabilities,completion_contract_envelope,published_at,status) VALUES('role-v1','role',1,?,'0000000000000000000000000000000000000000000000000000000000000000','{}','{}','[]','[]','[]','{}',?,'published')")
      .run(roleObject.id, now);
    db.prepare("INSERT INTO workflow_templates(id,slug,name,task_type,status,created_at,updated_at) VALUES('template','retry','Retry','feature','active',?,?)")
      .run(now, now);
    db.prepare("INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES('workflow-v1','template',1,'',1,?,'0000000000000000000000000000000000000000000000000000000000000000',?)")
      .run(workflow.id, now);
    const principal = { installationId: 'install', sessionId: 'root', rootSessionId: 'root', clientType: 'codex' as const, canonicalProjectPath: directory };
    const workspace = { repositoryHead: 'head', stagedPatch: '', unstagedPatch: '', untrackedManifest: [], submoduleManifest: [] };
    const service = new RunService(db, content, new LeaseService(db, 7, 60_000));
    const created = service.createRun({ requestId: 'create', projectId: 'project', workflowVersionId: 'workflow-v1', objective: 'retry', runInput: {}, principal, workspace });
    const firstLease = service.claimRun({ requestId: 'claim', runId: created.runId, mode: 'start', expectedStatus: 'created', expectedLeaseEpoch: 0, principal });
    const stage = db.prepare("SELECT id FROM stage_runs WHERE run_id=? AND stage_key='work'").get(created.runId) as { id: string };
    const firstProof = { runId: created.runId, leaseEpoch: firstLease.leaseEpoch, leaseToken: firstLease.leaseToken };
    service.beginStage({ requestId: 'begin', proof: firstProof, stageRunId: stage.id, principal });
    service.failStage({ requestId: 'fail', proof: firstProof, stageRunId: stage.id, principal, errorCode: 'FAILED', summary: 'retry' });
    expect(db.prepare('SELECT status,is_retryable FROM runs WHERE id=?').get(created.runId))
      .toEqual({ status: 'failed', is_retryable: 1 });

    const recovered = service.claimRun({
      requestId: 'retry-run', runId: created.runId, mode: 'retry', expectedStatus: 'failed',
      expectedLeaseEpoch: firstLease.leaseEpoch, stageRunId: stage.id, recoveryCredential: firstLease.recoveryCredential,
      currentWorkspace: workspace, principal,
    });
    expect(db.prepare('SELECT status,latest_attempt_id FROM stage_runs WHERE id=?').get(stage.id))
      .toMatchObject({ status: 'running', latest_attempt_id: expect.any(String) });
    expect(db.prepare('SELECT count(*) AS count FROM stage_attempts WHERE stage_run_id=?').get(stage.id)).toEqual({ count: 2 });
    expect(recovered.leaseEpoch).toBe(2);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
