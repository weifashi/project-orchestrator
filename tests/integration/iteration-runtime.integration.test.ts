import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ContentStore } from '@project-orchestrator/content-store';
import { LeaseService, RunService } from '@project-orchestrator/orchestrator-service';
import { migrate, openDatabase } from '@project-orchestrator/sqlite-store';
const output = { schema_id: 'project-orchestrator/stage-output' as const, schema_version: 1 as const, data: { status: 'succeeded' as const, summary: 'ok', artifact_object_ids: [], evidence_object_ids: [], risks: [], next_stage_notes: [] } };
it('creates fresh bounded iteration stage runs and fails after iteration three', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iteration-int-'));
  try {
    const db = openDatabase(join(dir, 'db')); migrate(db); const content = new ContentStore(join(dir, 'objects'), db); const now = new Date().toISOString(); const object = content.putCanonicalJson({});
    const stage = (key: string, extra: Record<string, unknown> = {}) => ({ key, role_version_id: 'rv', optional: false, mandatory_gate: false, failure_policy: 'trigger_iteration' as const, max_attempts: 1, iteration_group_key: 'delivery', requires_confirmation: false, ...extra });
    const workflow = { schema_id: 'project-orchestrator/workflow-version' as const, schema_version: 1 as const, data: { slug: 'w', version: 1, stages: [stage('implementation'), stage('review', { mandatory_gate: true }), stage('testing', { mandatory_gate: true }), { key: 'operations', role_version_id: 'rv', optional: false, mandatory_gate: false, failure_policy: 'fail' as const, max_attempts: 1, requires_confirmation: false }], edges: [{ from: 'implementation', to: 'review', edge_type: 'on_success' as const }, { from: 'implementation', to: 'testing', edge_type: 'on_success' as const }, { from: 'review', to: 'operations', edge_type: 'on_success' as const }, { from: 'testing', to: 'operations', edge_type: 'on_success' as const }], iteration_groups: [{ key: 'delivery', entry_stage_key: 'implementation', gate_stage_keys: ['review', 'testing'], aggregation_policy: 'collect_all' as const, max_iterations: 3 }] } };
    const workflowObject = content.putCanonicalJson(workflow);
    db.prepare("INSERT INTO client_installations(id,client_type,adapter_version,capability_object_id,credential_hash,status,last_seen_at) VALUES('i','codex','1',?,?,'active',?)").run(object.id, createHash('sha256').update('c').digest('hex'), now);
    db.prepare("INSERT INTO projects(id,canonical_path,display_name,repository_fingerprint,created_at,last_seen_at) VALUES('p',?,'P','f',?,?)").run(dir, now, now);
    db.prepare("INSERT INTO roles(id,slug,name,status,created_at,updated_at) VALUES('r','r','R','active',?,?)").run(now, now);
    db.prepare("INSERT INTO role_versions(id,role_id,version_number,content_object_id,skill_hash,input_schema_envelope,output_schema_envelope,requested_capabilities,effective_capabilities,forbidden_capabilities,completion_contract_envelope,published_at,status) VALUES('rv','r',1,?,'h','{}','{}','[]','[]','[]','{}',?,'published')").run(object.id, now);
    db.prepare("INSERT INTO workflow_templates(id,slug,name,task_type,status,created_at,updated_at) VALUES('wt','w','W','feature','active',?,?)").run(now, now);
    db.prepare("INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES('wv','wt',1,'',1,?,'h',?)").run(workflowObject.id, now);
    const principal = { installationId: 'i', sessionId: 'root', rootSessionId: 'root', clientType: 'codex' as const }; const service = new RunService(db, content, new LeaseService(db, 1, 60_000));
    const run = service.createRun({ requestId: 'create', projectId: 'p', workflowVersionId: 'wv', objective: '', runInput: {}, principal, workspace: { repositoryHead: 'h', stagedPatch: '', unstagedPatch: '', untrackedManifest: [], submoduleManifest: [] } });
    const lease = service.claimRun({ requestId: 'claim', runId: run.runId, mode: 'start', expectedStatus: 'created', expectedLeaseEpoch: 0, principal }); const proof = { runId: run.runId, leaseEpoch: lease.leaseEpoch, leaseToken: lease.leaseToken };
    for (let iteration = 1; iteration <= 3; iteration += 1) {
      const implementation = db.prepare("SELECT id FROM stage_runs WHERE run_id=? AND stage_key='implementation' AND iteration_number=?").get(run.runId, iteration) as { id: string };
      service.beginStage({ requestId: `begin-i-${iteration}`, proof, stageRunId: implementation.id, principal }); service.completeStage({ requestId: `complete-i-${iteration}`, proof, stageRunId: implementation.id, principal, output, workspace: { repositoryHead: 'h', stagedPatch: '', unstagedPatch: '', untrackedManifest: [], submoduleManifest: [] } });
      const review = db.prepare("SELECT id FROM stage_runs WHERE run_id=? AND stage_key='review' AND iteration_number=?").get(run.runId, iteration) as { id: string };
      service.beginStage({ requestId: `begin-r-${iteration}`, proof, stageRunId: review.id, principal }); service.failStage({ requestId: `fail-r-${iteration}`, proof, stageRunId: review.id, principal, errorCode: 'REVIEW_FAILED', summary: 'findings' });
    }
    expect(db.prepare('SELECT count(*) AS count FROM run_iterations WHERE run_id=?').get(run.runId)).toEqual({ count: 3 });
    expect(db.prepare('SELECT status FROM runs WHERE id=?').get(run.runId)).toEqual({ status: 'failed' });
    expect(db.prepare("SELECT count(*) AS count FROM stage_runs WHERE run_id=? AND iteration_number=4").get(run.runId)).toEqual({ count: 0 });
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
