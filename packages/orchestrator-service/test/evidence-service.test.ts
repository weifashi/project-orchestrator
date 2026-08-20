import { linkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { EvidenceService, RecoveryService, workspaceFingerprint } from '../src/index.js';
import { runtimeFixture, workspace } from './runtime-fixture.js';
const clean: string[] = [];
afterEach(() => clean.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
function seed(f: ReturnType<typeof runtimeFixture>) {
  f.db.prepare("INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES('wv','workflow',1,'',1,?,'h',?)").run(f.object.id, f.now);
  f.db.prepare("INSERT INTO runs(id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,client_installation_id,origin_session_id,status,updated_at) VALUES('run','project','wv','','{}','codex','install','root','running',?)").run(f.now);
  f.db.prepare("INSERT INTO stage_runs(id,run_id,stage_key,role_version_id,status,max_attempts,created_at,updated_at) VALUES('stage','run','s','role-v1','running',1,?,?)").run(f.now, f.now);
  f.db.prepare("INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at) VALUES('attempt','stage',1,'running','{}',?)").run(f.now);
  f.db.prepare("UPDATE stage_runs SET latest_attempt_id='attempt' WHERE id='stage'").run();
  const fingerprint = workspaceFingerprint(workspace);
  f.db.prepare(`INSERT INTO run_snapshots(run_id,workflow_object_id,role_bundle_object_id,rule_bundle_object_id,safety_baseline_object_id,adapter_capability_object_id,repository_head,staged_patch_object_id,unstaged_patch_object_id,untracked_manifest_object_id,submodule_manifest_object_id,working_tree_fingerprint,created_at)
    VALUES('run',?,?,?,?,?,'head',?,?,?,?,?,?)`).run(f.object.id, f.object.id, f.object.id, f.object.id, f.object.id, f.object.id, f.object.id, f.object.id, f.object.id, fingerprint, f.now);
}
it('copies only owned regular non-linked project files into CAS and rejects cross-run attempts', () => {
  const f = runtimeFixture(); clean.push(f.dir); seed(f);
  writeFileSync(`${f.dir}/evidence.txt`, 'proof');
  symlinkSync(`${f.dir}/evidence.txt`, `${f.dir}/link.txt`);
  linkSync(`${f.dir}/evidence.txt`, `${f.dir}/hard.txt`);
  const service = new EvidenceService(f.db, f.content);
  expect(() => service.recordArtifact({ runId: 'other', stageAttemptId: 'attempt', sourcePath: 'evidence.txt', artifactType: 'test_evidence', summary: 'x', producerRoleVersionId: 'role-v1' })).toThrow('does not belong');
  expect(() => service.recordArtifact({ runId: 'run', stageAttemptId: 'attempt', sourcePath: 'link.txt', artifactType: 'test_evidence', summary: 'x', producerRoleVersionId: 'role-v1' })).toThrow();
  expect(() => service.recordArtifact({ runId: 'run', stageAttemptId: 'attempt', sourcePath: 'hard.txt', artifactType: 'test_evidence', summary: 'x', producerRoleVersionId: 'role-v1' })).toThrow('hard-linked');
  rmSync(`${f.dir}/hard.txt`);
  const recorded = service.recordArtifact({ runId: 'run', stageAttemptId: 'attempt', sourcePath: 'evidence.txt', artifactType: 'test_evidence', summary: 'proof', producerRoleVersionId: 'role-v1' });
  expect(Buffer.from(f.content.read(recorded.contentObjectId)).toString()).toBe('proof');
  f.db.close();
});
it('recovers from the latest trusted checkpoint and returns stable mismatch evidence', () => {
  const f = runtimeFixture(); clean.push(f.dir); seed(f);
  const service = new EvidenceService(f.db, f.content);
  service.recordCheckpoint({ runId: 'run', kind: 'run_start', baselineFingerprint: workspaceFingerprint(workspace), state: workspace });
  expect(() => service.recordCheckpoint({ runId: 'run', stageAttemptId: 'attempt', kind: 'after_attempt', baselineFingerprint: workspaceFingerprint(workspace), state: workspace })).toThrow('succeeded');
  f.db.prepare("UPDATE stage_attempts SET status='succeeded',output_envelope='{}',completed_at=? WHERE id='attempt'").run(f.now);
  const checkpoint = service.recordCheckpoint({ runId: 'run', stageAttemptId: 'attempt', kind: 'after_attempt', baselineFingerprint: workspaceFingerprint(workspace), state: workspace });
  const recovery = new RecoveryService(f.db, f.content);
  expect(recovery.check('run', workspace)).toEqual({ ok: true });
  const mismatch = recovery.check('run', { ...workspace, unstagedPatch: 'changed' });
  expect(mismatch).toMatchObject({ ok: false, code: 'WORKTREE_CHANGED' });
  if (!mismatch.ok) f.content.verify(mismatch.diffObjectId);
  expect(checkpoint.fingerprint).toHaveLength(64);
  f.db.close();
});
