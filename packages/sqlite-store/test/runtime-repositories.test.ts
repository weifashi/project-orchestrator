import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { EventRepository, IdempotencyRepository, migrate, openDatabase } from '../src/index.js';
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
it('allocates gap-free events across connections without MAX and rolls back business/event writes together', async () => {
  const { db, path } = seeded(); const second = openDatabase(path); const firstEvents = new EventRepository(db); const secondEvents = new EventRepository(second);
  await Promise.all([Promise.resolve().then(() => firstEvents.append('run', 'agent_note', 'i', { n: 1 })), Promise.resolve().then(() => secondEvents.append('run', 'agent_note', 'i', { n: 2 }))]);
  expect((db.prepare('SELECT sequence_number FROM events ORDER BY sequence_number').all() as Array<{ sequence_number: number }>).map((row) => row.sequence_number)).toEqual([1, 2]);
  expect(() => db.transaction(() => { firstEvents.append('run', 'agent_note', 'i', { rollback: true }); db.prepare("UPDATE runs SET failure_summary='partial' WHERE id='run'").run(); throw new Error('rollback'); }).immediate()).toThrow('rollback');
  expect(db.prepare('SELECT next_event_sequence,failure_summary FROM runs WHERE id=?').get('run')).toEqual({ next_event_sequence: 3, failure_summary: null });
  expect(db.prepare('SELECT count(*) AS count FROM events').get()).toEqual({ count: 2 }); second.close(); db.close();
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
