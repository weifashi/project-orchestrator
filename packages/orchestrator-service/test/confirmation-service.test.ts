import { rmSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { ConfirmationService } from '../src/index.js';
import { principal, runtimeFixture } from './runtime-fixture.js';

const clean: string[] = [];
const HASH = 'a'.repeat(64);
afterEach(() => clean.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function fixture() {
  const f = runtimeFixture();
  clean.push(f.dir);
  f.db.prepare("INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES('wv','workflow',1,'',1,?,?,?)")
    .run(f.object.id, HASH, f.now);
  f.db.prepare("INSERT INTO runs(id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,client_installation_id,origin_session_id,status,updated_at) VALUES('run','project','wv','','{}','codex','install','root','running',?)")
    .run(f.now);
  f.db.prepare(`INSERT INTO run_snapshots
    (run_id,workflow_object_id,role_bundle_object_id,rule_bundle_object_id,safety_baseline_object_id,
     adapter_capability_object_id,repository_head,staged_patch_object_id,unstaged_patch_object_id,
     untracked_manifest_object_id,submodule_manifest_object_id,working_tree_fingerprint,created_at)
    VALUES('run',?,?,?,?,?,'head',?,?,?,?,?,?)`)
    .run(f.object.id, f.object.id, f.object.id, f.object.id, f.capability.id,
      f.object.id, f.object.id, f.object.id, f.object.id, 'fp', f.now);
  f.db.prepare("INSERT INTO stage_runs(id,run_id,stage_key,role_version_id,status,max_attempts,created_at,updated_at) VALUES('stage','run','s','role-v1','running',1,?,?)")
    .run(f.now, f.now);
  f.db.prepare("INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at) VALUES('attempt','stage',1,'running','{}',?)")
    .run(f.now);
  f.db.prepare("UPDATE stage_runs SET latest_attempt_id='attempt' WHERE id='stage'").run();
  return { ...f, service: new ConfirmationService(f.db, undefined, f.content) };
}

it('binds decisions and rejoins the persisted current state after a lost response', () => {
  const f = fixture();
  const request = f.service.request({ runId: 'run', stageRunId: 'stage', stageAttemptId: 'attempt',
    type: 'release', summary: 'release', actionHash: HASH, safetyBaselineObjectId: f.object.id, installationId: 'install' });
  expect(() => f.service.submitDecision({ confirmationRequestId: request.id, nonce: 'wrong', exactActionHash: HASH,
    decision: 'approve', principal: { ...principal, trustedInteractive: true } })).toThrow('binding');
  expect(() => f.service.submitDecision({ confirmationRequestId: request.id, nonce: request.nonce, exactActionHash: HASH,
    decision: 'approve', principal })).toThrow('trusted');
  expect(f.service.submitDecision({ confirmationRequestId: request.id, nonce: request.nonce, exactActionHash: HASH,
    decision: 'approve', principal: { ...principal, trustedInteractive: true } })).toEqual({ status: 'consumed' });
  expect(f.service.submitDecision({ confirmationRequestId: request.id, nonce: request.nonce, exactActionHash: HASH,
    decision: 'approve', principal: { ...principal, trustedInteractive: true } })).toEqual({ status: 'consumed' });
  f.db.close();
});

it('expires due requests, restores their waiting stage and run, and abandons unexecuted operations', () => {
  const f = fixture();
  const request = f.service.request({ runId: 'run', stageRunId: 'stage', stageAttemptId: 'attempt',
    type: 'deploy', summary: 'deploy', actionHash: HASH, safetyBaselineObjectId: f.object.id,
    installationId: 'install', ttlMs: -1 });
  f.db.prepare(`INSERT INTO side_effect_operations
    (id,run_id,stage_attempt_id,action_type,target_fingerprint,request_hash,parameters_envelope,
     confirmation_request_id,lease_epoch,status,created_at)
    VALUES('operation','run','attempt','deploy','node',?,'{}',?,1,'intent_recorded',?)`)
    .run(HASH, request.id, f.now);
  f.db.prepare("UPDATE stage_runs SET status='waiting_for_user' WHERE id='stage'").run();
  f.db.prepare("UPDATE runs SET status='waiting_for_user' WHERE id='run'").run();

  expect(f.service.expireDue(new Date())).toBe(1);
  expect(f.db.prepare('SELECT status FROM confirmation_requests WHERE id=?').get(request.id)).toEqual({ status: 'expired' });
  expect(f.db.prepare("SELECT status FROM side_effect_operations WHERE id='operation'").get()).toEqual({ status: 'abandoned' });
  expect(f.db.prepare("SELECT status FROM stage_runs WHERE id='stage'").get()).toEqual({ status: 'running' });
  expect(f.db.prepare("SELECT status FROM runs WHERE id='run'").get()).toEqual({ status: 'running' });
  expect(f.service.submitDecision({ confirmationRequestId: request.id, nonce: request.nonce, exactActionHash: HASH,
    decision: 'approve', principal: { ...principal, trustedInteractive: true } })).toEqual({ status: 'expired' });
  f.db.close();
});

it('expires a decision whose stage attempt is no longer the current active context', () => {
  const f = fixture();
  const request = f.service.request({ runId: 'run', stageRunId: 'stage', stageAttemptId: 'attempt',
    type: 'release', summary: 'release', actionHash: HASH, safetyBaselineObjectId: f.object.id, installationId: 'install' });
  f.db.prepare("UPDATE stage_attempts SET status='failed',failure_code='STALE',completed_at=? WHERE id='attempt'").run(f.now);
  f.db.prepare("UPDATE stage_runs SET status='failed',completed_at=? WHERE id='stage'").run(f.now);
  expect(f.service.submitDecision({ confirmationRequestId: request.id, nonce: request.nonce, exactActionHash: HASH,
    decision: 'approve', principal: { ...principal, trustedInteractive: true } })).toEqual({ status: 'expired' });
  expect(f.db.prepare('SELECT status FROM confirmation_requests WHERE id=?').get(request.id)).toEqual({ status: 'expired' });
  f.db.close();
});
