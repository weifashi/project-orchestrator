import { execFileSync } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '@project-orchestrator/sqlite-store';
import { ProjectIndexService } from '../src/project-index-service.js';
import { buildProjectIndex } from '../src/project-indexer.js';
import { runtimeFixture } from './runtime-fixture.js';

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.db.close()));

function scenario() {
  const f = runtimeFixture();
  fixtures.push(f);
  const projectRoot = join(f.dir, 'repo');
  mkdirSync(projectRoot);
  f.db.prepare("UPDATE projects SET canonical_path=? WHERE id='project'").run(projectRoot);
  execFileSync('git', ['init', '-q', projectRoot]);
  execFileSync('git', ['-C', projectRoot, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', projectRoot, 'config', 'user.name', 'Test']);
  mkdirSync(join(projectRoot, 'src'));
  writeFileSync(join(projectRoot, 'src', 'service.ts'), "import { db } from './db.js';\nexport function loadOrder() {}\n");
  writeFileSync(join(projectRoot, 'src', 'db.ts'), 'export const db = {};\n');
  execFileSync('git', ['-C', projectRoot, 'add', '-A']);
  execFileSync('git', ['-C', projectRoot, 'commit', '-qm', 'initial']);
  const roleBundle = f.content.putCanonicalJson({ roles: [{
    roleVersionId: 'role-v1', envelope: { data: { slug: 'research' } },
  }] });
  f.db.prepare(`INSERT INTO workflow_versions
    (id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at)
    VALUES('workflow-v1','workflow',1,'',1,?,?,?)`).run(f.object.id, 'a'.repeat(64), f.now);
  const insertRun = (run: string, stage: string, attempt: string) => {
    f.db.prepare(`INSERT INTO runs(id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,
      client_installation_id,origin_session_id,status,updated_at) VALUES(?,'project','workflow-v1','','{}','codex','install','root','running',?)`)
      .run(run, f.now);
    f.db.prepare(`INSERT INTO run_snapshots(run_id,workflow_object_id,role_bundle_object_id,rule_bundle_object_id,
      safety_baseline_object_id,adapter_capability_object_id,repository_head,staged_patch_object_id,unstaged_patch_object_id,
      untracked_manifest_object_id,submodule_manifest_object_id,working_tree_fingerprint,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(run, f.object.id, roleBundle.id, f.object.id, f.object.id, f.capability.id,
      'head', f.object.id, f.object.id, f.object.id, f.object.id, 'fingerprint', f.now);
    f.db.prepare(`INSERT INTO stage_runs(id,run_id,stage_key,role_version_id,status,max_attempts,created_at,updated_at)
      VALUES(?,?, 'research','role-v1','running',1,?,?)`).run(stage, run, f.now, f.now);
    f.db.prepare(`INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at)
      VALUES(?,?,1,'running','{}',?)`).run(attempt, stage, f.now);
    f.db.prepare('UPDATE stage_runs SET latest_attempt_id=? WHERE id=?').run(attempt, stage);
  };
  insertRun('run1', 'stage1', 'attempt1');
  return { f, projectRoot, service: new ProjectIndexService(f.db, f.content), insertRun };
}

it('persists a CAS index, freezes it to the Run, and queries paths, imports, and symbols', async () => {
  const { f, projectRoot, service } = scenario();
  const ensured = await service.ensureForResearchAttempt({
    runId: 'run1', stageRunId: 'stage1', attemptId: 'attempt1', canonicalProjectPath: projectRoot,
  });
  expect(ensured.status).toBe('ready');
  expect(() => f.content.verify(ensured.projectIndexObjectId!)).not.toThrow();
  expect(f.db.prepare('SELECT count(*) AS count FROM project_indexes').get()).toEqual({ count: 1 });
  expect(f.db.prepare('SELECT count(*) AS count FROM run_project_indexes').get()).toEqual({ count: 1 });

  expect(await service.queryForRun({ runId: 'run1', query: 'loadOrder', limit: 5 })).toMatchObject({
    status: 'ready', file_count: 2, matched_file_count: 1,
    files: [{ path: 'src/service.ts', language: 'typescript', symbol_count: 1 }],
  });
  expect(await service.queryForRun({ runId: 'run1', query: './db.js' })).toMatchObject({
    matched_file_count: 1, files: [{ path: 'src/service.ts' }],
  });
  const firstPage = await service.queryForRun({ runId: 'run1', language: 'typescript', limit: 1 });
  expect(firstPage).toMatchObject({ matched_file_count: 2, cursor: 0, next_cursor: 1, files: [{ language: 'typescript' }] });
  expect(await service.queryForRun({ runId: 'run1', language: 'typescript', cursor: 1, limit: 1 }))
    .toMatchObject({ matched_file_count: 2, cursor: 1, next_cursor: null, files: [{ language: 'typescript' }] });
  expect(JSON.stringify(await service.queryForRun({ runId: 'run1', limit: 20 })).length).toBeLessThan(4096);
});

it('reuses an unchanged project index for a new Run and never rewrites an old Run binding', async () => {
  const { f, projectRoot, service, insertRun } = scenario();
  const first = await service.ensureForResearchAttempt({
    runId: 'run1', stageRunId: 'stage1', attemptId: 'attempt1', canonicalProjectPath: projectRoot,
  });
  insertRun('run2', 'stage2', 'attempt2');
  const same = await service.ensureForResearchAttempt({
    runId: 'run2', stageRunId: 'stage2', attemptId: 'attempt2', canonicalProjectPath: projectRoot,
  });
  expect(same.projectIndexObjectId).toBe(first.projectIndexObjectId);
  expect(f.db.prepare('SELECT count(*) AS count FROM project_indexes').get()).toEqual({ count: 1 });

  execFileSync('git', ['-C', projectRoot, 'commit', '--allow-empty', '-qm', 'same tree, new head']);
  insertRun('run4', 'stage4', 'attempt4');
  const sameFilesNewHead = await service.ensureForResearchAttempt({
    runId: 'run4', stageRunId: 'stage4', attemptId: 'attempt4', canonicalProjectPath: projectRoot,
  });
  expect(sameFilesNewHead.projectIndexObjectId).not.toBe(first.projectIndexObjectId);
  expect(await service.queryForRun({ runId: 'run4' })).toMatchObject({ changed_file_count: 0 });

  writeFileSync(join(projectRoot, 'src', 'service.ts'), 'export function changed() {}\n');
  execFileSync('git', ['-C', projectRoot, 'add', '-A']);
  insertRun('run3', 'stage3', 'attempt3');
  const changed = await service.ensureForResearchAttempt({
    runId: 'run3', stageRunId: 'stage3', attemptId: 'attempt3', canonicalProjectPath: projectRoot,
  });
  expect(changed.projectIndexObjectId).not.toBe(first.projectIndexObjectId);
  expect(await service.queryForRun({ runId: 'run1', query: 'loadOrder' })).toMatchObject({ matched_file_count: 1 });
  expect(await service.queryForRun({ runId: 'run1', query: 'changed' })).toMatchObject({ matched_file_count: 0 });
  expect(await service.queryForRun({ runId: 'run3', query: 'changed' })).toMatchObject({
    changed_file_count: 1, matched_file_count: 1,
  });
});

it('returns an explicit unavailable result before a Run has a successful binding', async () => {
  const { service } = scenario();
  expect(await service.queryForRun({ runId: 'missing' })).toEqual({
    status: 'unavailable', reason: 'PROJECT_INDEX_UNAVAILABLE',
  });
});

it('records each Run change count against the latest binding across an A to B to A sequence', async () => {
  const { projectRoot, service, insertRun } = scenario();
  const first = await service.ensureForResearchAttempt({
    runId: 'run1', stageRunId: 'stage1', attemptId: 'attempt1', canonicalProjectPath: projectRoot,
  });
  writeFileSync(join(projectRoot, 'src', 'service.ts'), 'export function versionB() {}\n');
  execFileSync('git', ['-C', projectRoot, 'add', '-A']);
  insertRun('run2', 'stage2', 'attempt2');
  await service.ensureForResearchAttempt({
    runId: 'run2', stageRunId: 'stage2', attemptId: 'attempt2', canonicalProjectPath: projectRoot,
  });
  writeFileSync(join(projectRoot, 'src', 'service.ts'), "import { db } from './db.js';\nexport function loadOrder() {}\n");
  execFileSync('git', ['-C', projectRoot, 'add', '-A']);
  insertRun('run3', 'stage3', 'attempt3');
  const restored = await service.ensureForResearchAttempt({
    runId: 'run3', stageRunId: 'stage3', attemptId: 'attempt3', canonicalProjectPath: projectRoot,
  });
  expect(restored.projectIndexObjectId).toBe(first.projectIndexObjectId);
  expect(await service.queryForRun({ runId: 'run3' })).toMatchObject({ changed_file_count: 1 });

  insertRun('run4', 'stage4', 'attempt4');
  await service.ensureForResearchAttempt({
    runId: 'run4', stageRunId: 'stage4', attemptId: 'attempt4', canonicalProjectPath: projectRoot,
  });
  expect(await service.queryForRun({ runId: 'run4' })).toMatchObject({ changed_file_count: 0 });
});

it('never binds a Run to an existing index whose CAS object is missing', async () => {
  const { f, projectRoot, service, insertRun } = scenario();
  const first = await service.ensureForResearchAttempt({
    runId: 'run1', stageRunId: 'stage1', attemptId: 'attempt1', canonicalProjectPath: projectRoot,
  });
  const object = f.db.prepare('SELECT storage_key FROM content_objects WHERE id=?')
    .get(first.projectIndexObjectId) as { storage_key: string };
  unlinkSync(join(f.dir, 'objects', object.storage_key));
  expect(await service.queryForRun({ runId: 'run1' })).toEqual({
    status: 'unavailable', reason: 'PROJECT_INDEX_CORRUPT',
  });
  insertRun('run2', 'stage2', 'attempt2');

  await expect(service.ensureForResearchAttempt({
    runId: 'run2', stageRunId: 'stage2', attemptId: 'attempt2', canonicalProjectPath: projectRoot,
  })).rejects.toThrow('PROJECT_INDEX_CORRUPT');
  expect(f.db.prepare('SELECT count(*) AS count FROM run_project_indexes WHERE run_id=?').get('run2')).toEqual({ count: 0 });
});

it('verifies a newly written CAS object before creating immutable index records', async () => {
  const { f, projectRoot, service } = scenario();
  const original = f.content.putCanonicalJson.bind(f.content);
  f.content.putCanonicalJson = (value: unknown) => {
    const object = original(value);
    unlinkSync(join(f.dir, 'objects', object.storageKey));
    return object;
  };
  try {
    await expect(service.ensureForResearchAttempt({
      runId: 'run1', stageRunId: 'stage1', attemptId: 'attempt1', canonicalProjectPath: projectRoot,
    })).rejects.toThrow('PROJECT_INDEX_CORRUPT');
  } finally {
    f.content.putCanonicalJson = original;
  }
  expect(f.db.prepare('SELECT count(*) AS count FROM project_indexes').get()).toEqual({ count: 0 });
  expect(f.db.prepare('SELECT count(*) AS count FROM run_project_indexes').get()).toEqual({ count: 0 });
});

it('returns every oversized match on a later page instead of consuming and dropping it', async () => {
  const { projectRoot, service } = scenario();
  const imports = Array.from({ length: 20 }, (_, index) => `import '${'包'.repeat(300)}-${index}';`).join('\n');
  writeFileSync(join(projectRoot, 'src', 'service.ts'), `${imports}\nexport function loadOrder() {}\n`);
  execFileSync('git', ['-C', projectRoot, 'add', '-A']);
  await service.ensureForResearchAttempt({
    runId: 'run1', stageRunId: 'stage1', attemptId: 'attempt1', canonicalProjectPath: projectRoot,
  });

  const result = await service.queryForRun({ runId: 'run1', query: 'service.ts', limit: 20 });
  expect(result).toMatchObject({ status: 'ready', matched_file_count: 1, next_cursor: null });
  if (result.status !== 'ready') throw new Error('expected ready project index');
  expect(result.files).toHaveLength(1);
  expect(result.files[0]).toMatchObject({ path: 'src/service.ts', details_truncated: true });
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(4096);
});

it('does not hold a SQLite write transaction while asynchronous indexing is in progress', async () => {
  const { f, projectRoot } = scenario();
  let releaseIndex: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseIndex = resolve; });
  const service = new ProjectIndexService(f.db, f.content, async (input) => {
    markStarted?.();
    await gate;
    return buildProjectIndex(input);
  });
  const pending = service.ensureForResearchAttempt({
    runId: 'run1', stageRunId: 'stage1', attemptId: 'attempt1', canonicalProjectPath: projectRoot,
  });
  await started;

  expect(() => f.db.prepare("UPDATE projects SET last_seen_at='2026-09-02T00:00:01.000Z' WHERE id='project'").run())
    .not.toThrow();
  releaseIndex?.();
  await expect(pending).resolves.toMatchObject({ status: 'ready' });
});

it('does not hold the SQLite write lock while persisting the CAS envelope', async () => {
  const { f, projectRoot } = scenario();
  const databasePath = (f.db.prepare('PRAGMA database_list').get() as { file: string }).file;
  const observer = openDatabase(databasePath);
  const original = f.content.putCanonicalJson.bind(f.content);
  f.content.putCanonicalJson = (value: unknown) => {
    expect(() => observer.prepare("UPDATE projects SET last_seen_at='2026-09-02T00:00:02.000Z' WHERE id='project'").run())
      .not.toThrow();
    return original(value);
  };
  try {
    const service = new ProjectIndexService(f.db, f.content);
    await expect(service.ensureForResearchAttempt({
      runId: 'run1', stageRunId: 'stage1', attemptId: 'attempt1', canonicalProjectPath: projectRoot,
    })).resolves.toMatchObject({ status: 'ready' });
  } finally {
    observer.close();
  }
});

it('recomputes the Run change count when another Run binds while indexing is in progress', async () => {
  const { projectRoot, service, insertRun, f } = scenario();
  await service.ensureForResearchAttempt({
    runId: 'run1', stageRunId: 'stage1', attemptId: 'attempt1', canonicalProjectPath: projectRoot,
  });

  writeFileSync(join(projectRoot, 'src', 'service.ts'), 'export function versionB() {}\n');
  execFileSync('git', ['-C', projectRoot, 'add', '-A']);
  const versionB = await buildProjectIndex({ root: projectRoot, now: '2026-09-02T00:01:00.000Z' });
  insertRun('run2', 'stage2', 'attempt2');
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const indexing = new Promise<void>((resolve) => { started = resolve; });
  const delayed = new ProjectIndexService(f.db, f.content, async () => {
    started?.();
    await gate;
    return versionB;
  });
  const pendingB = delayed.ensureForResearchAttempt({
    runId: 'run2', stageRunId: 'stage2', attemptId: 'attempt2', canonicalProjectPath: projectRoot,
  });
  await indexing;

  writeFileSync(join(projectRoot, 'src', 'service.ts'), "import { db } from './db.js';\nexport function loadOrder() {}\n");
  writeFileSync(join(projectRoot, 'src', 'db.ts'), 'export const db = { version: 2 };\n');
  execFileSync('git', ['-C', projectRoot, 'add', '-A']);
  insertRun('run3', 'stage3', 'attempt3');
  await service.ensureForResearchAttempt({
    runId: 'run3', stageRunId: 'stage3', attemptId: 'attempt3', canonicalProjectPath: projectRoot,
  });
  release?.();
  await pendingB;

  expect(await service.queryForRun({ runId: 'run2' })).toMatchObject({ status: 'ready', changed_file_count: 2 });
});

it('always advances past a path whose JSON escaping alone exceeds the query budget', async () => {
  const { f, projectRoot } = scenario();
  const service = new ProjectIndexService(f.db, f.content, async () => ({
    envelope: {
      schema_id: 'project-orchestrator/project-index', schema_version: 1,
      data: {
        source_head: 'head', tree_fingerprint: 'b'.repeat(64), generated_at: '2026-09-02T00:00:00.000Z',
        files: [{
          path: '\u0001'.repeat(1024), language: 'text', size_bytes: 0, content_sha256: 'a'.repeat(64),
          imports: [], symbols: [],
        }],
        skipped: { binary: 0, generated_or_dependency: 0, sensitive: 0, too_large: 0, unsupported_or_missing: 0 },
      },
    },
    changedFileCount: 1, reusedFileCount: 0, skippedFileCount: 0,
  }));
  await service.ensureForResearchAttempt({
    runId: 'run1', stageRunId: 'stage1', attemptId: 'attempt1', canonicalProjectPath: projectRoot,
  });

  const result = await service.queryForRun({ runId: 'run1', limit: 1 });
  expect(result).toMatchObject({
    status: 'ready', matched_file_count: 1, next_cursor: null,
    files: [{ path: '[oversized-path]', path_truncated: true, details_truncated: true }],
  });
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(4096);
});

it('normalizes indexer failures and invalid envelopes to availability errors without binding the Run', async () => {
  const { f, projectRoot } = scenario();
  const unavailable = new ProjectIndexService(f.db, f.content, async () => {
    const error = new Error('repository disappeared') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  });
  await expect(unavailable.ensureForResearchAttempt({
    runId: 'run1', stageRunId: 'stage1', attemptId: 'attempt1', canonicalProjectPath: projectRoot,
  })).rejects.toThrow('PROJECT_INDEX_UNAVAILABLE');

  const corrupt = new ProjectIndexService(f.db, f.content, async () => ({
    envelope: { invalid: true }, changedFileCount: 0, reusedFileCount: 0, skippedFileCount: 0,
  } as never));
  await expect(corrupt.ensureForResearchAttempt({
    runId: 'run1', stageRunId: 'stage1', attemptId: 'attempt1', canonicalProjectPath: projectRoot,
  })).rejects.toThrow('PROJECT_INDEX_CORRUPT');
  expect(f.db.prepare('SELECT count(*) AS count FROM run_project_indexes').get()).toEqual({ count: 0 });
});

it('normalizes SQLite operational persistence failures without binding the active attempt', async () => {
  const { f, projectRoot, service } = scenario();
  const database = f.db as typeof f.db & { transaction: typeof f.db.transaction };
  const original = database.transaction;
  database.transaction = (() => {
    const error = new Error('database is busy') as Error & { code: string };
    error.code = 'SQLITE_BUSY';
    throw error;
  }) as typeof f.db.transaction;
  try {
    await expect(service.ensureForResearchAttempt({
      runId: 'run1', stageRunId: 'stage1', attemptId: 'attempt1', canonicalProjectPath: projectRoot,
    })).rejects.toThrow('PROJECT_INDEX_UNAVAILABLE');
  } finally {
    database.transaction = original;
  }
  expect(f.db.prepare('SELECT count(*) AS count FROM run_project_indexes').get()).toEqual({ count: 0 });
  expect(f.db.prepare("SELECT status FROM stage_attempts WHERE id='attempt1'").get()).toEqual({ status: 'running' });
});

it('normalizes SQLite operational failures during post-attempt context validation', async () => {
  const { f, projectRoot, service } = scenario();
  const database = f.db as typeof f.db & { prepare: typeof f.db.prepare };
  const original = database.prepare.bind(database);
  let injected = false;
  database.prepare = ((sql: string) => {
    if (!injected && sql.includes('SELECT r.project_id')) {
      injected = true;
      const error = new Error('database is busy') as Error & { code: string };
      error.code = 'SQLITE_BUSY';
      throw error;
    }
    return original(sql);
  }) as typeof f.db.prepare;
  try {
    await expect(service.ensureForResearchAttempt({
      runId: 'run1', stageRunId: 'stage1', attemptId: 'attempt1', canonicalProjectPath: projectRoot,
    })).rejects.toThrow('PROJECT_INDEX_UNAVAILABLE');
  } finally {
    database.prepare = original as typeof f.db.prepare;
  }
  expect(f.db.prepare('SELECT count(*) AS count FROM run_project_indexes').get()).toEqual({ count: 0 });
});
