import { linkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { EvidenceService, RecoveryService, workspaceFingerprint, type RecoveryContext, type WorkspaceState } from '../src/index.js';
import { runtimeFixture, workspace } from './runtime-fixture.js';

const clean: string[] = [];
afterEach(() => clean.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function seed(f: ReturnType<typeof runtimeFixture>, state: WorkspaceState = workspace) {
  const roleBundle = f.content.putCanonicalJson({
    roles: [{ roleVersionId: 'role-v1', envelope: { data: { slug: 'role' } } }],
  });
  f.db.prepare("INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES('wv','workflow',1,'',1,?,'h',?)").run(f.object.id, f.now);
  f.db.prepare("INSERT INTO runs(id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,client_installation_id,origin_session_id,status,updated_at) VALUES('run','project','wv','','{}','codex','install','root','running',?)").run(f.now);
  f.db.prepare("INSERT INTO stage_runs(id,run_id,stage_key,role_version_id,status,max_attempts,created_at,updated_at) VALUES('stage','run','s','role-v1','running',1,?,?)").run(f.now, f.now);
  f.db.prepare("INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at) VALUES('attempt','stage',1,'running','{}',?)").run(f.now);
  f.db.prepare("UPDATE stage_runs SET latest_attempt_id='attempt' WHERE id='stage'").run();
  const fingerprint = workspaceFingerprint(state);
  f.db.prepare(`INSERT INTO run_snapshots(run_id,workflow_object_id,role_bundle_object_id,rule_bundle_object_id,safety_baseline_object_id,adapter_capability_object_id,repository_head,staged_patch_object_id,unstaged_patch_object_id,untracked_manifest_object_id,submodule_manifest_object_id,working_tree_fingerprint,created_at)
    VALUES('run',?,?,?,?,?,?,?,?,?,?,?,?)`).run(f.object.id, roleBundle.id, f.object.id, f.object.id, f.object.id,
      state.repositoryHead, f.content.putUtf8(state.stagedPatch).id, f.content.putUtf8(state.unstagedPatch).id,
      f.content.putCanonicalJson(state.untrackedManifest).id, f.content.putCanonicalJson(state.submoduleManifest).id,
      fingerprint, f.now);
  const context: RecoveryContext = {
    canonicalProjectPath: f.dir,
    ruleBundleObjectId: f.object.id,
    safetyBaselineObjectId: f.object.id,
    adapterCapabilityObjectId: f.object.id,
  };
  return { context, roleBundle };
}

it('copies only regular files rooted in the authenticated adapter project bound to the run project', () => {
  const f = runtimeFixture(); clean.push(f.dir); seed(f);
  writeFileSync(`${f.dir}/evidence.txt`, 'proof');
  symlinkSync(`${f.dir}/evidence.txt`, `${f.dir}/link.txt`);
  linkSync(`${f.dir}/evidence.txt`, `${f.dir}/hard.txt`);
  const service = new EvidenceService(f.db, f.content);
  const input = {
    runId: 'run', stageAttemptId: 'attempt', sourcePath: 'evidence.txt', artifactType: 'test_evidence' as const,
    summary: 'proof', producerRoleVersionId: 'role-v1', adapterContext: { canonicalProjectPath: f.dir },
  };
  expect(() => service.recordArtifact({ ...input, runId: 'other' })).toThrow('does not belong');
  expect(() => service.recordArtifact({ ...input, adapterContext: { canonicalProjectPath: join(f.dir, 'other') } })).toThrow('PROJECT_PATH_CHANGED');
  expect(() => service.recordArtifact({ ...input, sourcePath: 'link.txt' })).toThrow();
  expect(() => service.recordArtifact({ ...input, sourcePath: 'hard.txt' })).toThrow('hard-linked');
  rmSync(`${f.dir}/hard.txt`);
  const recorded = service.recordArtifact(input);
  expect(Buffer.from(f.content.read(recorded.contentObjectId)).toString()).toBe('proof');
  f.db.close();
});

it('allocates monotonically sequenced checkpoints and recovers from the latest sequence', () => {
  const f = runtimeFixture(); clean.push(f.dir); const { context } = seed(f);
  const service = new EvidenceService(f.db, f.content);
  const first = service.recordCheckpoint({ runId: 'run', kind: 'run_start', baselineFingerprint: workspaceFingerprint(workspace), state: workspace });
  expect(() => service.recordCheckpoint({ runId: 'run', stageAttemptId: 'attempt', kind: 'after_attempt', baselineFingerprint: workspaceFingerprint(workspace), state: workspace })).toThrow('succeeded');
  f.db.prepare("UPDATE stage_attempts SET status='succeeded',output_envelope='{}',completed_at=? WHERE id='attempt'").run(f.now);
  const second = service.recordCheckpoint({ runId: 'run', stageAttemptId: 'attempt', kind: 'after_attempt', baselineFingerprint: workspaceFingerprint(workspace), state: workspace });
  expect([first.sequence, second.sequence]).toEqual([1, 2]);
  expect(new RecoveryService(f.db, f.content).check('run', workspace, context)).toEqual({ ok: true });
  f.db.close();
});

it('returns every stable recovery mismatch code with CAS-backed diagnostic evidence', () => {
  const f = runtimeFixture(); clean.push(f.dir); const { context } = seed(f);
  new EvidenceService(f.db, f.content).recordCheckpoint({
    runId: 'run', kind: 'run_start', baselineFingerprint: workspaceFingerprint(workspace), state: workspace,
  });
  const recovery = new RecoveryService(f.db, f.content);
  const different = f.content.putCanonicalJson({ different: true }).id;
  const cases: Array<[string, typeof workspace, RecoveryContext]> = [
    ['PROJECT_PATH_CHANGED', workspace, { ...context, canonicalProjectPath: join(f.dir, 'moved') }],
    ['REPOSITORY_HEAD_CHANGED', { ...workspace, repositoryHead: 'new-head' }, context],
    ['WORKTREE_CHANGED', { ...workspace, unstagedPatch: 'changed' }, context],
    ['RULE_BUNDLE_CHANGED', workspace, { ...context, ruleBundleObjectId: different }],
    ['ADAPTER_INCOMPATIBLE', workspace, { ...context, adapterCapabilityObjectId: different }],
    ['SAFETY_BASELINE_INCOMPATIBLE', workspace, { ...context, safetyBaselineObjectId: different }],
  ];
  for (const [code, state, candidateContext] of cases) {
    const mismatch = recovery.check('run', state, candidateContext);
    expect(mismatch).toMatchObject({ ok: false, code });
    if (!mismatch.ok) f.content.verify(mismatch.diffObjectId);
  }
  f.db.close();
});

it('returns ARTIFACT_MISSING when any CAS object of the latest checkpoint cannot be verified', () => {
  const state: WorkspaceState = {
    repositoryHead: 'head', stagedPatch: 'staged', unstagedPatch: 'unstaged',
    untrackedManifest: ['untracked'], submoduleManifest: ['submodule'],
  };
  for (const column of [
    'staged_patch_object_id', 'unstaged_patch_object_id',
    'untracked_manifest_object_id', 'submodule_manifest_object_id',
  ]) {
    const f = runtimeFixture(); clean.push(f.dir); const { context } = seed(f, state);
    new EvidenceService(f.db, f.content).recordCheckpoint({
      runId: 'run', kind: 'run_start', baselineFingerprint: workspaceFingerprint(state), state,
    });
    const row = f.db.prepare(`SELECT co.storage_key FROM workspace_checkpoints c
      JOIN content_objects co ON co.id=c.${column} WHERE c.run_id='run' AND c.sequence_number=1`)
      .get() as { storage_key: string };
    rmSync(join(f.dir, 'objects', row.storage_key));
    const mismatch = new RecoveryService(f.db, f.content).check('run', state, context);
    expect(mismatch).toMatchObject({ ok: false, code: 'ARTIFACT_MISSING' });
    if (!mismatch.ok) {
      expect(JSON.parse(Buffer.from(f.content.read(mismatch.diffObjectId)).toString()))
        .toMatchObject({ missingObjectId: expect.any(String) });
    }
    f.db.close();
  }
});
