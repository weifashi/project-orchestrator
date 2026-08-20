import { rmSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { ConfirmationService } from '../src/index.js';
import { principal, runtimeFixture } from './runtime-fixture.js';

const clean: string[] = [];
const HASH = 'a'.repeat(64);
afterEach(() => clean.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function scenario(policy: 'pause' | 'fail') {
  const fixture = runtimeFixture();
  clean.push(fixture.dir);
  const workflow = fixture.content.putCanonicalJson({
    schema_id: 'project-orchestrator/workflow-version', schema_version: 1,
    data: { slug: 'workflow', version: 1, stages: [
      { key: 'confirm', role_version_id: 'role-v1', optional: false, mandatory_gate: false, failure_policy: policy, max_attempts: 1, requires_confirmation: true },
      { key: 'peer', role_version_id: 'role-v1', optional: false, mandatory_gate: false, failure_policy: 'fail', max_attempts: 1, requires_confirmation: false },
    ], edges: [{ from: 'confirm', to: 'peer', edge_type: 'requires' }], iteration_groups: [] },
  });
  fixture.db.prepare("INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES('wv','workflow',1,'',1,?,?,?)")
    .run(workflow.id, HASH, fixture.now);
  fixture.db.prepare("INSERT INTO runs(id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,client_installation_id,origin_session_id,status,lease_holder_session_id,lease_epoch,server_epoch,lease_token_hash,lease_expires_at,updated_at) VALUES('run','project','wv','','{}','codex','install','root','running','root',1,1,?,? ,?)")
    .run('0'.repeat(64), new Date(Date.now() + 60_000).toISOString(), fixture.now);
  fixture.db.prepare(`INSERT INTO run_snapshots
    (run_id,workflow_object_id,role_bundle_object_id,rule_bundle_object_id,safety_baseline_object_id,
     adapter_capability_object_id,repository_head,staged_patch_object_id,unstaged_patch_object_id,
     untracked_manifest_object_id,submodule_manifest_object_id,working_tree_fingerprint,created_at)
    VALUES('run',?,?,?,?,?,'head',?,?,?,?,?,?)`)
    .run(workflow.id, fixture.object.id, fixture.object.id, fixture.object.id, fixture.capability.id,
      fixture.object.id, fixture.object.id, fixture.object.id, fixture.object.id, 'fp', fixture.now);
  for (const [id, status] of [['confirm', 'running'], ['peer', 'running']]) {
    fixture.db.prepare("INSERT INTO stage_runs(id,run_id,stage_key,role_version_id,status,max_attempts,created_at,updated_at) VALUES(?, 'run',?,'role-v1',?,1,?,?)")
      .run(id, id, status, fixture.now, fixture.now);
    fixture.db.prepare("INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at) VALUES(?,?,1,'running','{}',?)")
      .run(`${id}-attempt`, id, fixture.now);
    fixture.db.prepare('UPDATE stage_runs SET latest_attempt_id=? WHERE id=?').run(`${id}-attempt`, id);
  }
  const service = new ConfirmationService(fixture.db, undefined, fixture.content);
  const pending = service.request({ runId: 'run', stageRunId: 'confirm', stageAttemptId: 'confirm-attempt',
    type: 'other', summary: 'pending', actionHash: 'b'.repeat(64), safetyBaselineObjectId: fixture.object.id, installationId: 'install' });
  const approved = service.request({ runId: 'run', stageRunId: 'confirm', stageAttemptId: 'confirm-attempt',
    type: 'deploy', summary: 'approved', actionHash: 'c'.repeat(64), safetyBaselineObjectId: fixture.object.id, installationId: 'install' });
  fixture.db.prepare(`INSERT INTO side_effect_operations
    (id,run_id,stage_attempt_id,action_type,target_fingerprint,request_hash,parameters_envelope,
     confirmation_request_id,lease_epoch,status,created_at)
    VALUES('approved-operation','run','confirm-attempt','deploy','node',?,'{}',?,1,'intent_recorded',?)`)
    .run('c'.repeat(64), approved.id, fixture.now);
  service.submitDecision({ confirmationRequestId: approved.id, nonce: approved.nonce, exactActionHash: 'c'.repeat(64), decision: 'approve',
    principal: { ...principal, trustedInteractive: true } });
  const request = service.request({ runId: 'run', stageRunId: 'confirm', stageAttemptId: 'confirm-attempt',
    type: 'release', summary: 'release', actionHash: HASH, safetyBaselineObjectId: fixture.object.id, installationId: 'install' });
  fixture.db.prepare("UPDATE stage_runs SET status='waiting_for_user' WHERE id='confirm'").run();
  fixture.db.prepare("UPDATE runs SET status='waiting_for_user' WHERE id='run'").run();
  service.submitDecision({ confirmationRequestId: request.id, nonce: request.nonce, exactActionHash: HASH, decision: 'reject',
    principal: { ...principal, trustedInteractive: true } });
  return { ...fixture, pendingId: pending.id, approvedId: approved.id };
}

it('freezes every active child when confirmation rejection cancels the run', () => {
  const fixture = scenario('fail');
  expect(fixture.db.prepare("SELECT status FROM runs WHERE id='run'").get()).toEqual({ status: 'cancelled' });
  expect(fixture.db.prepare("SELECT status FROM stage_runs WHERE id='confirm'").get()).toEqual({ status: 'failed' });
  expect(fixture.db.prepare("SELECT status FROM stage_runs WHERE id='peer'").get()).toEqual({ status: 'cancelled' });
  expect(fixture.db.prepare("SELECT status FROM stage_attempts WHERE id='peer-attempt'").get()).toEqual({ status: 'interrupted' });
  expect(fixture.db.prepare('SELECT status FROM confirmation_requests WHERE id=?').get(fixture.pendingId)).toEqual({ status: 'expired' });
  expect(fixture.db.prepare('SELECT status FROM confirmation_requests WHERE id=?').get(fixture.approvedId)).toEqual({ status: 'expired' });
  expect(fixture.db.prepare("SELECT status FROM side_effect_operations WHERE id='approved-operation'").get()).toEqual({ status: 'abandoned' });
  expect((fixture.db.prepare("SELECT event_type FROM events WHERE run_id='run' ORDER BY sequence_number").all() as Array<{event_type:string}>).map((row) => row.event_type))
    .toContain('run_cancelled');
  fixture.db.close();
});

it('interrupts parallel attempts but preserves resumable queued work when rejection pauses', () => {
  const fixture = scenario('pause');
  expect(fixture.db.prepare("SELECT status FROM runs WHERE id='run'").get()).toEqual({ status: 'paused' });
  expect(fixture.db.prepare("SELECT status FROM stage_runs WHERE id='peer'").get()).toEqual({ status: 'interrupted' });
  expect(fixture.db.prepare("SELECT status FROM stage_attempts WHERE id='peer-attempt'").get()).toEqual({ status: 'interrupted' });
  fixture.db.close();
});
