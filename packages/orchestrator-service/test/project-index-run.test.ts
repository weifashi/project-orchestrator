import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { SqliteConfigRepository } from '@project-orchestrator/sqlite-store';
import { ConfigService, LeaseService, RunService, seedBuiltins } from '../src/index.js';
import { buildProjectIndex } from '../src/project-indexer.js';
import type { ProjectIndexer } from '../src/project-index-service.js';
import { principal, runtimeFixture, workspace } from './runtime-fixture.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function setup(withGit: boolean, projectIndexer?: ProjectIndexer) {
  const f = runtimeFixture();
  directories.push(f.dir);
  f.db.prepare("DELETE FROM projects WHERE id='project'").run();
  const repository = new SqliteConfigRepository(f.db);
  const config = new ConfigService(repository, f.content);
  seedBuiltins(config, repository);
  if (withGit) {
    execFileSync('git', ['init', '-q', f.dir]);
    execFileSync('git', ['-C', f.dir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', f.dir, 'config', 'user.name', 'Test']);
    writeFileSync(`${f.dir}/index.ts`, 'export function indexed() {}\n');
    execFileSync('git', ['-C', f.dir, 'add', 'index.ts']);
    execFileSync('git', ['-C', f.dir, 'commit', '-qm', 'initial']);
  }
  f.db.pragma('user_version = 1');
  const leases = new LeaseService(f.db, 1);
  const runs = new RunService(f.db, f.content, leases,
    projectIndexer === undefined ? {} : { projectIndexer });
  const authenticated = { ...principal, canonicalProjectPath: f.dir };
  const start = (workflowSlug: 'bug-fix' | 'new-project') => {
    const created = runs.createRun({
      requestId: `create-${workflowSlug}`, workflowSlug, objective: 'Index project', runInput: {},
      principal: authenticated, workspace,
    });
    const lease = runs.claimRun({
      requestId: `claim-${workflowSlug}`, runId: created.runId, mode: 'start', expectedStatus: 'created',
      expectedLeaseEpoch: 0, principal: authenticated,
    });
    return {
      runId: created.runId,
      proof: { runId: created.runId, leaseEpoch: lease.leaseEpoch, leaseToken: lease.leaseToken },
      recoveryCredential: lease.recoveryCredential,
    };
  };
  return { f, runs, authenticated, start, config };
}

function enableResearchRetry(
  f: ReturnType<typeof runtimeFixture>,
  config: ConfigService,
  failurePolicy: 'pause' | 'retry_then_fail' = 'pause',
): void {
  const row = f.db.prepare(`SELECT wv.content_object_id FROM workflow_versions wv
    JOIN workflow_templates wt ON wt.id=wv.workflow_template_id WHERE wt.slug='bug-fix'
    ORDER BY wv.version_number DESC LIMIT 1`).get() as { content_object_id: string };
  const template = f.db.prepare("SELECT id FROM workflow_templates WHERE slug='bug-fix'").get() as { id: string };
  const envelope = JSON.parse(Buffer.from(f.content.read(row.content_object_id)).toString('utf8')) as {
    data: { version: number; stages: Array<Record<string, unknown>> };
  };
  envelope.data.version += 1;
  envelope.data.stages = envelope.data.stages.map((stage) => stage['key'] === 'research'
    ? { ...stage, failure_policy: failurePolicy, max_attempts: 2 } : stage);
  config.publishWorkflow({ workflowTemplateId: template.id, envelope });
}

it('binds one frozen project index after a Research role starts and exposes it through the leased query', async () => {
  const { f, runs, authenticated, start } = setup(true);
  const active = start('bug-fix');
  const research = f.db.prepare("SELECT id FROM stage_runs WHERE run_id=? AND stage_key='research'").get(active.runId) as { id: string };

  runs.beginStage({ requestId: 'begin-research', proof: active.proof, stageRunId: research.id, principal: authenticated });

  expect(await runs.queryProjectIndex({ requestId: 'query-index', proof: active.proof, principal: authenticated, query: 'indexed' }))
    .toMatchObject({ status: 'ready', matched_file_count: 1 });
  expect(f.db.prepare('SELECT count(*) AS count FROM run_project_indexes WHERE run_id=?').get(active.runId)).toEqual({ count: 1 });
  f.db.close();
}, 30_000);

it('also retries indexing for a Research attempt created by failed-Run recovery', async () => {
  const current = setup(false);
  enableResearchRetry(current.f, current.config, 'retry_then_fail');
  const active = current.start('bug-fix');
  const research = current.f.db.prepare("SELECT id FROM stage_runs WHERE run_id=? AND stage_key='research'")
    .get(active.runId) as { id: string };
  await current.runs.beginStage({ requestId: 'begin-failed-run', proof: active.proof, stageRunId: research.id, principal: current.authenticated });
  current.runs.failStage({ requestId: 'fail-run-research', proof: active.proof, stageRunId: research.id,
    principal: current.authenticated, errorCode: 'RESEARCH_RETRY', summary: 'retry the Run' });

  execFileSync('git', ['init', '-q', current.f.dir]);
  writeFileSync(`${current.f.dir}/index.ts`, 'export function recoveredRunIndex() {}\n');
  execFileSync('git', ['-C', current.f.dir, 'add', 'index.ts']);
  const retried = current.runs.claimRun({
    requestId: 'retry-failed-run', runId: active.runId, mode: 'retry', expectedStatus: 'failed',
    expectedLeaseEpoch: active.proof.leaseEpoch, stageRunId: research.id,
    recoveryCredential: active.recoveryCredential, currentWorkspace: workspace, principal: current.authenticated,
  });
  const retriedProof = { runId: active.runId, leaseEpoch: retried.leaseEpoch, leaseToken: retried.leaseToken };

  expect(await current.runs.queryProjectIndex({
    requestId: 'query-retried-run-index', proof: retriedProof,
    principal: current.authenticated, query: 'recoveredRunIndex',
  })).toMatchObject({ status: 'ready', matched_file_count: 1 });
  current.f.db.close();
}, 30_000);

it('does not index a non-Research role and keeps Research running when Git indexing is unavailable', async () => {
  const first = setup(false);
  const newProject = first.start('new-project');
  const requirements = first.f.db.prepare("SELECT id FROM stage_runs WHERE run_id=? AND stage_key='requirements'").get(newProject.runId) as { id: string };
  await first.runs.beginStage({ requestId: 'begin-requirements', proof: newProject.proof, stageRunId: requirements.id, principal: first.authenticated });
  expect(first.f.db.prepare('SELECT count(*) AS count FROM run_project_indexes WHERE run_id=?').get(newProject.runId)).toEqual({ count: 0 });
  first.f.db.close();

  const second = setup(false);
  const bugFix = second.start('bug-fix');
  const research = second.f.db.prepare("SELECT id FROM stage_runs WHERE run_id=? AND stage_key='research'").get(bugFix.runId) as { id: string };
  await second.runs.beginStage({ requestId: 'begin-research', proof: bugFix.proof, stageRunId: research.id, principal: second.authenticated });
  expect(second.f.db.prepare('SELECT status FROM stage_runs WHERE id=?').get(research.id)).toEqual({ status: 'running' });
  expect(second.f.db.prepare('SELECT count(*) AS count FROM run_project_indexes WHERE run_id=?').get(bugFix.runId)).toEqual({ count: 0 });
  expect(await second.runs.queryProjectIndex({ requestId: 'query-unavailable', proof: bugFix.proof, principal: second.authenticated }))
    .toEqual({ status: 'unavailable', reason: 'PROJECT_INDEX_UNAVAILABLE' });
  second.f.db.close();
}, 30_000);

it('fails closed on a project-path mismatch before creating the Research attempt', async () => {
  const current = setup(true);
  const active = current.start('bug-fix');
  const research = current.f.db.prepare("SELECT id FROM stage_runs WHERE run_id=? AND stage_key='research'")
    .get(active.runId) as { id: string };
  const other = `${current.f.dir}/other-project`;
  mkdirSync(other);

  expect(() => current.runs.beginStage({
    requestId: 'begin-wrong-path', proof: active.proof, stageRunId: research.id,
    principal: { ...current.authenticated, canonicalProjectPath: other },
  })).toThrow('PROJECT_PATH_CHANGED');
  expect(current.f.db.prepare('SELECT status,latest_attempt_id FROM stage_runs WHERE id=?').get(research.id))
    .toEqual({ status: 'ready', latest_attempt_id: null });
  expect(current.f.db.prepare('SELECT count(*) AS count FROM stage_attempts WHERE stage_run_id=?').get(research.id))
    .toEqual({ count: 0 });
  current.f.db.close();
});

it('retries indexing when Git becomes available before a Research retry', async () => {
  const current = setup(false);
  enableResearchRetry(current.f, current.config);
  const active = current.start('bug-fix');
  const research = current.f.db.prepare("SELECT id FROM stage_runs WHERE run_id=? AND stage_key='research'")
    .get(active.runId) as { id: string };
  await current.runs.beginStage({ requestId: 'begin-no-git', proof: active.proof, stageRunId: research.id, principal: current.authenticated });
  expect(current.f.db.prepare('SELECT count(*) AS count FROM run_project_indexes WHERE run_id=?').get(active.runId))
    .toEqual({ count: 0 });
  current.runs.failStage({ requestId: 'fail-research', proof: active.proof, stageRunId: research.id,
    principal: current.authenticated, errorCode: 'RESEARCH_RETRY', summary: 'Git became available' });

  execFileSync('git', ['init', '-q', current.f.dir]);
  execFileSync('git', ['-C', current.f.dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', current.f.dir, 'config', 'user.name', 'Test']);
  writeFileSync(`${current.f.dir}/index.ts`, 'export function recoveredIndex() {}\n');
  execFileSync('git', ['-C', current.f.dir, 'add', 'index.ts']);
  execFileSync('git', ['-C', current.f.dir, 'commit', '-qm', 'index source']);
  const resumed = current.runs.claimRun({
    requestId: 'resume-research', runId: active.runId, mode: 'resume', expectedStatus: 'paused',
    expectedLeaseEpoch: active.proof.leaseEpoch, recoveryCredential: active.recoveryCredential,
    currentWorkspace: workspace, principal: current.authenticated,
  });
  const resumedProof = { runId: active.runId, leaseEpoch: resumed.leaseEpoch, leaseToken: resumed.leaseToken };
  await current.runs.retryStage({ requestId: 'retry-research', proof: resumedProof, stageRunId: research.id, principal: current.authenticated });

  expect(await current.runs.queryProjectIndex({
    requestId: 'query-recovered-index', proof: resumedProof, principal: current.authenticated, query: 'recoveredIndex',
  })).toMatchObject({ status: 'ready', matched_file_count: 1 });
  expect(current.f.db.prepare('SELECT count(*) AS count FROM run_project_indexes WHERE run_id=?').get(active.runId))
    .toEqual({ count: 1 });
  current.f.db.close();
}, 30_000);

it('does not surface a stale index job as a policy error after its attempt finishes', async () => {
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const indexing = new Promise<void>((resolve) => { started = resolve; });
  const delayed: ProjectIndexer = async (input) => {
    started?.();
    await gate;
    return buildProjectIndex(input);
  };
  const current = setup(true, delayed);
  const active = current.start('bug-fix');
  const research = current.f.db.prepare("SELECT id FROM stage_runs WHERE run_id=? AND stage_key='research'")
    .get(active.runId) as { id: string };
  const attempt = current.runs.beginStage({
    requestId: 'begin-stale-index', proof: active.proof, stageRunId: research.id, principal: current.authenticated,
  });
  await indexing;
  const query = current.runs.queryProjectIndex({
    requestId: 'query-stale-index', proof: active.proof, principal: current.authenticated,
  });
  current.runs.failStage({ requestId: 'fail-stale-index', proof: active.proof, stageRunId: research.id,
    principal: current.authenticated, errorCode: 'STOP_INDEX', summary: `stop ${attempt.attemptId}` });
  release?.();

  await expect(query).rejects.toThrow('STALE_LEASE');
  expect(current.f.db.prepare('SELECT count(*) AS count FROM run_project_indexes WHERE run_id=?').get(active.runId))
    .toEqual({ count: 0 });
  current.f.db.close();
}, 30_000);

it('keeps waiting for a replacement retry job when the prior index job finishes first', async () => {
  const releases: Array<(() => void) | undefined> = [];
  const starts: Array<Promise<void>> = [];
  const startResolvers: Array<(() => void) | undefined> = [];
  const gates: Array<Promise<void>> = [];
  for (let index = 0; index < 2; index += 1) {
    starts.push(new Promise<void>((resolve) => { startResolvers[index] = resolve; }));
    gates.push(new Promise<void>((resolve) => { releases[index] = resolve; }));
  }
  let invocation = 0;
  const delayed: ProjectIndexer = async (input) => {
    const index = invocation;
    invocation += 1;
    const gate = gates[index];
    if (!gate) throw new Error('unexpected project index invocation');
    startResolvers[index]?.();
    await gate;
    return buildProjectIndex(input);
  };
  const current = setup(true, delayed);
  enableResearchRetry(current.f, current.config);
  const active = current.start('bug-fix');
  const research = current.f.db.prepare("SELECT id FROM stage_runs WHERE run_id=? AND stage_key='research'")
    .get(active.runId) as { id: string };
  current.runs.beginStage({
    requestId: 'begin-replaced-index', proof: active.proof, stageRunId: research.id, principal: current.authenticated,
  });
  await starts[0];
  const oldQuery = current.runs.queryProjectIndex({
    requestId: 'query-replaced-index', proof: active.proof, principal: current.authenticated, query: 'indexed',
  }).then((value) => ({ value }), (error: unknown) => ({ error }));
  current.runs.failStage({ requestId: 'fail-replaced-index', proof: active.proof, stageRunId: research.id,
    principal: current.authenticated, errorCode: 'RETRY_INDEX', summary: 'retry index' });
  const resumed = current.runs.claimRun({
    requestId: 'resume-replaced-index', runId: active.runId, mode: 'resume', expectedStatus: 'paused',
    expectedLeaseEpoch: active.proof.leaseEpoch, recoveryCredential: active.recoveryCredential,
    currentWorkspace: workspace, principal: current.authenticated,
  });
  const resumedProof = { runId: active.runId, leaseEpoch: resumed.leaseEpoch, leaseToken: resumed.leaseToken };
  current.runs.retryStage({
    requestId: 'retry-replaced-index', proof: resumedProof, stageRunId: research.id, principal: current.authenticated,
  });
  await starts[1];
  let resumedQuerySettled = false;
  const resumedQuery = current.runs.queryProjectIndex({
    requestId: 'query-replacement-index', proof: resumedProof, principal: current.authenticated, query: 'indexed',
  }).finally(() => { resumedQuerySettled = true; });
  releases[0]?.();
  const oldOutcome = await oldQuery;
  expect(oldOutcome).toHaveProperty('error');
  expect(String('error' in oldOutcome ? oldOutcome.error : '')).toContain('STALE_LEASE');
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  expect(resumedQuerySettled).toBe(false);
  releases[1]?.();
  await expect(resumedQuery).resolves.toMatchObject({ status: 'ready', matched_file_count: 1 });
  current.f.db.close();
}, 30_000);
