import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, it } from 'vitest';
import { EventRepository, IdempotencyRepository, WorkspaceCheckpointRepository, migrate, openDatabase } from '../src/index.js';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
function seeded() {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-repositories-')); dirs.push(directory); const path = join(directory, 'db'); const db = openDatabase(path); migrate(db); const now = new Date().toISOString();
  db.prepare("INSERT INTO content_objects(id,sha256,media_type,size_bytes,storage_key,created_at) VALUES('o','h','application/json',2,'h/h',?)").run(now);
  db.prepare("INSERT INTO workflow_templates(id,slug,name,task_type,status,created_at,updated_at) VALUES('wt','w','W','feature','active',?,?)").run(now, now);
  db.prepare("INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES('wv','wt',1,'',1,'o','h',?)").run(now);
  db.prepare("INSERT INTO client_installations(id,client_type,adapter_version,capability_object_id,credential_hash,status,last_seen_at) VALUES('i','codex','1','o',?,'active',?)").run(createHash('sha256').update('x').digest('hex'), now);
  db.prepare("INSERT INTO projects(id,canonical_path,display_name,repository_fingerprint,created_at,last_seen_at) VALUES('p','/tmp/p','P','f',?,?)").run(now, now);
  db.prepare("INSERT INTO runs(id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,client_installation_id,origin_session_id,status,updated_at) VALUES('run','p','wv','','{}','codex','i','root','running',?)").run(now);
  return { db, path };
}
const storeUrl = pathToFileURL(join(process.cwd(), 'packages/sqlite-store/dist/index.js')).href;
function repositoryWorker(path: string, action: 'event' | 'idempotency-holder' | 'idempotency-contender'): Worker {
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { EventRepository, IdempotencyRepository, openDatabase } from ${JSON.stringify(storeUrl)};
    const db = openDatabase(workerData.path);
    try {
      if (workerData.action === 'event') {
        const event = new EventRepository(db).append('run', 'agent_note', 'i', { worker: true });
        parentPort.postMessage({ ok: true, sequence: event.sequenceNumber });
        db.close();
      } else {
        const result = new IdempotencyRepository(db).begin('i', 'worker-op', 'worker-request', 'same-hash');
        parentPort.postMessage({ ok: true, kind: result.kind });
        if (workerData.action === 'idempotency-holder' && result.kind === 'new') {
          parentPort.once('message', () => { db.close(); process.exit(0); });
        } else db.close();
      }
    } catch (error) {
      parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
      db.close();
    }
  `;
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), { workerData: { path, action } });
}
it('allocates gap-free events across connections without MAX and rolls back business/event writes together', async () => {
  const { db, path } = seeded(); const firstEvents = new EventRepository(db);
  const workers = [repositoryWorker(path, 'event'), repositoryWorker(path, 'event')];
  const exits = workers.map((worker) => once(worker, 'exit'));
  const results = await Promise.all(workers.map(async (worker) => (await once(worker, 'message'))[0] as { ok: boolean; sequence?: number; error?: string }));
  expect(results.every((result) => result.ok)).toBe(true);
  await Promise.all(exits);
  expect((db.prepare('SELECT sequence_number FROM events ORDER BY sequence_number').all() as Array<{ sequence_number: number }>).map((row) => row.sequence_number)).toEqual([1, 2]);
  expect(() => db.transaction(() => { firstEvents.append('run', 'agent_note', 'i', { rollback: true }); db.prepare("UPDATE runs SET failure_summary='partial' WHERE id='run'").run(); throw new Error('rollback'); }).immediate()).toThrow('rollback');
  expect(db.prepare('SELECT next_event_sequence,failure_summary FROM runs WHERE id=?').get('run')).toEqual({ next_event_sequence: 3, failure_summary: null });
  expect(db.prepare('SELECT count(*) AS count FROM events').get()).toEqual({ count: 2 }); db.close();
});
it('replays identical idempotency requests and conflicts on a different hash across connections', () => {
  const { db, path } = seeded(); const second = openDatabase(path); const one = new IdempotencyRepository(db); const two = new IdempotencyRepository(second);
  const begun = one.begin('i', 'op', 'request', 'hash-a'); expect(begun.kind).toBe('new');
  expect(() => two.begin('i', 'op', 'request', 'hash-a')).toThrow('IN_PROGRESS');
  expect(() => two.begin('i', 'op', 'request', 'hash-b')).toThrow('IDEMPOTENCY_CONFLICT');
  if (begun.kind === 'new') one.complete(begun.id, { accepted: true });
  expect(two.begin('i', 'op', 'request', 'hash-a')).toEqual({ kind: 'replay', response: { accepted: true } });
  second.close(); db.close();
});

it('serializes idempotency ownership between actual worker threads', async () => {
  const { db, path } = seeded();
  const holder = repositoryWorker(path, 'idempotency-holder');
  const holderExit = once(holder, 'exit');
  const held = (await once(holder, 'message'))[0] as { ok: boolean; kind?: string };
  expect(held).toEqual({ ok: true, kind: 'new' });
  const contender = repositoryWorker(path, 'idempotency-contender');
  const contenderExit = once(contender, 'exit');
  const conflict = (await once(contender, 'message'))[0] as { ok: boolean; error?: string };
  expect(conflict).toMatchObject({ ok: false, error: expect.stringContaining('IDEMPOTENCY_IN_PROGRESS') });
  await contenderExit;
  holder.postMessage('release');
  await holderExit;
  db.close();
});

it('selects the latest workspace checkpoint by its per-run sequence, never timestamps', () => {
  const { db } = seeded();
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO workspace_checkpoints
    (id,run_id,sequence_number,checkpoint_kind,repository_head,baseline_fingerprint,resulting_fingerprint,
     staged_patch_object_id,unstaged_patch_object_id,untracked_manifest_object_id,submodule_manifest_object_id,created_at)
    VALUES(?,?,?,'progress',?,?,?,'o','o','o','o',?)`);
  insert.run('first', 'run', 1, 'head-1', 'base', 'result-1', '9999-12-31T00:00:00.000Z');
  insert.run('second', 'run', 2, 'head-2', 'result-1', 'result-2', now);
  const checkpoints = new WorkspaceCheckpointRepository(db);
  expect(checkpoints.latest('run')).toMatchObject({ id: 'second', sequence_number: 2, resulting_fingerprint: 'result-2' });
  expect(checkpoints.nextSequence('run')).toBe(3);
  db.close();
});
