import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/index.js';
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
function database() { const directory = mkdtempSync(join(tmpdir(), 'runtime-db-')); directories.push(directory); const db = openDatabase(join(directory, 'db.sqlite')); migrate(db); return db; }
function seed(db: ReturnType<typeof openDatabase>) {
  const now = new Date().toISOString(); const hash = createHash('sha256').update('credential').digest('hex');
  db.prepare("INSERT INTO content_objects(id,sha256,media_type,size_bytes,storage_key,created_at) VALUES('o','h','application/json',2,'h/h',?)").run(now);
  db.prepare("INSERT INTO workflow_templates(id,slug,name,task_type,status,created_at,updated_at) VALUES('wt','w','W','feature','active',?,?)").run(now, now);
  db.prepare("INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES('wv','wt',1,'',1,'o','h',?)").run(now);
  db.prepare("INSERT INTO roles(id,slug,name,status,created_at,updated_at) VALUES('r','r','R','active',?,?)").run(now, now);
  db.prepare("INSERT INTO role_versions(id,role_id,version_number,content_object_id,skill_hash,input_schema_envelope,output_schema_envelope,requested_capabilities,effective_capabilities,forbidden_capabilities,completion_contract_envelope,published_at,status) VALUES('rv','r',1,'o','h','{}','{}','[]','[]','[]','{}',?,'published')").run(now);
  db.prepare("INSERT INTO client_installations(id,client_type,adapter_version,capability_object_id,credential_hash,status,last_seen_at) VALUES('i','codex','1','o',?,'active',?)").run(hash, now);
  for (const id of ['p1', 'p2']) db.prepare('INSERT INTO projects(id,canonical_path,display_name,repository_fingerprint,created_at,last_seen_at) VALUES(?,?,?,?,?,?)').run(id, `/tmp/${id}`, id, 'f', now, now);
  for (const [run, project] of [['run1', 'p1'], ['run2', 'p2']]) db.prepare("INSERT INTO runs(id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,client_installation_id,origin_session_id,status,updated_at) VALUES(?,?, 'wv','','{}','codex','i','root','running',?)").run(run, project, now);
  for (const [stage, run] of [['s1', 'run1'], ['s2', 'run2']]) db.prepare("INSERT INTO stage_runs(id,run_id,stage_key,role_version_id,status,max_attempts,created_at,updated_at) VALUES(?,?,?,'rv','running',2,?,?)").run(stage, run, stage, now, now);
  db.prepare("INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at) VALUES('a1','s1',1,'running','{}',?)").run(now);
  db.prepare("INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at) VALUES('a2','s2',1,'running','{}',?)").run(now);
  db.prepare("UPDATE stage_runs SET latest_attempt_id='a1' WHERE id='s1'").run();
  db.prepare("UPDATE stage_runs SET latest_attempt_id='a2' WHERE id='s2'").run();
  return now;
}
it('creates all runtime tables with strict defaults and indexes', () => {
  const db = database(); const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name);
  for (const name of ['runtime_metadata', 'client_installations', 'projects', 'runs', 'run_snapshots', 'workspace_checkpoints', 'stage_runs', 'run_iterations', 'stage_attempts', 'confirmation_requests', 'side_effect_operations', 'artifacts', 'memories', 'events', 'idempotency_requests']) expect(tables).toContain(name);
  const columns = db.prepare('PRAGMA table_info(stage_runs)').all() as Array<{ name: string; dflt_value: string | null }>;
  expect(columns.find((column) => column.name === 'iteration_number')?.dflt_value).toBe('0');
  expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='events'").get()).toMatchObject({ sql: expect.stringContaining('UNIQUE(run_id,sequence_number)') }); db.close();
});
it('enforces runtime ownership, unique attempts/iterations, confirmation checks and restricted history deletion', () => {
  const db = database(); const now = seed(db);
  expect(() => db.prepare("INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at) VALUES('dup','s1',1,'running','{}',?)").run(now)).toThrow(/UNIQUE/);
  db.prepare("INSERT INTO run_iterations(id,run_id,group_key,iteration_number,status,created_at) VALUES('it','run1','g',1,'running',?)").run(now);
  expect(() => db.prepare("INSERT INTO run_iterations(id,run_id,group_key,iteration_number,status,created_at) VALUES('dup-it','run1','g',1,'running',?)").run(now)).toThrow(/UNIQUE/);
  expect(() => db.prepare("INSERT INTO run_iterations(id,run_id,group_key,iteration_number,status,created_at) VALUES('it4','run1','g',4,'running',?)").run(now)).toThrow(/CHECK/);
  expect(() => db.prepare("INSERT INTO workspace_checkpoints(id,run_id,sequence_number,stage_attempt_id,checkpoint_kind,repository_head,baseline_fingerprint,resulting_fingerprint,staged_patch_object_id,unstaged_patch_object_id,untracked_manifest_object_id,submodule_manifest_object_id,created_at) VALUES('cp','run1',1,'a2','progress','h','b','r','o','o','o','o',?)").run(now)).toThrow(/CHECKPOINT_OWNERSHIP/);
  expect(() => db.prepare("INSERT INTO confirmation_requests(id,run_id,stage_run_id,stage_attempt_id,confirmation_type,request_summary,action_hash,nonce_hash,safety_baseline_object_id,requested_installation_id,status,requested_at,expires_at) VALUES('c','run1','s2','a2','x','x','a','n','o','i','pending',?,?)").run(now, now)).toThrow(/CONFIRMATION_OWNERSHIP/);
  expect(() => db.prepare("INSERT INTO confirmation_requests(id,run_id,stage_run_id,stage_attempt_id,confirmation_type,request_summary,action_hash,nonce_hash,safety_baseline_object_id,requested_installation_id,status,requested_at,expires_at) VALUES('bad','run1','s1','a1','x','x','a','n','o','i','made_up',?,?)").run(now, now)).toThrow(/CHECK/);
  db.prepare("INSERT INTO confirmation_requests(id,run_id,stage_run_id,stage_attempt_id,confirmation_type,request_summary,action_hash,nonce_hash,safety_baseline_object_id,requested_installation_id,status,requested_at,expires_at) VALUES('good','run1','s1','a1','x','x','a','n','o','i','pending',?,?)").run(now, now);
  expect(() => db.prepare("INSERT INTO artifacts(id,run_id,stage_attempt_id,artifact_type,content_object_id,summary,producer_role_version_id,metadata_envelope,created_at) VALUES('art','run2','a1','log','o','x','rv','{}',?)").run(now)).toThrow(/ARTIFACT_OWNERSHIP/);
  expect(() => db.prepare("INSERT INTO events(id,run_id,stage_run_id,sequence_number,event_type,source_principal_id,payload_envelope,created_at) VALUES('e','run1','s2',1,'agent_note','i','{}',?)").run(now)).toThrow(/EVENT_OWNERSHIP/);
  expect(() => db.prepare("DELETE FROM stage_attempts WHERE id='a1'").run()).toThrow(/IMMUTABLE_ATTEMPT/);
  expect(() => db.prepare("UPDATE stage_attempts SET stage_run_id='s2' WHERE id='a1'").run()).toThrow(/IMMUTABLE_ATTEMPT/);
  expect(() => db.prepare("DELETE FROM run_iterations WHERE id='it'").run()).toThrow(/IMMUTABLE_ITERATION/);
  expect(() => db.prepare("DELETE FROM confirmation_requests WHERE id='good'").run()).toThrow(/IMMUTABLE_CONFIRMATION/);
  expect(() => db.prepare("DELETE FROM runs WHERE id='run1'").run()).toThrow(/FOREIGN KEY/);
  db.close();
});

it('enforces per-run monotonic checkpoint sequences and closed memory enums/deduplication', () => {
  const db = database(); const now = seed(db);
  const insertCheckpoint = db.prepare(`INSERT INTO workspace_checkpoints
    (id,run_id,sequence_number,checkpoint_kind,repository_head,baseline_fingerprint,resulting_fingerprint,
     staged_patch_object_id,unstaged_patch_object_id,untracked_manifest_object_id,submodule_manifest_object_id,created_at)
    VALUES(?,?,?,'progress','h','b','r','o','o','o','o',?)`);
  insertCheckpoint.run('cp-1', 'run1', 1, now);
  expect(() => insertCheckpoint.run('cp-3', 'run1', 3, now)).toThrow(/CHECKPOINT_SEQUENCE/);
  insertCheckpoint.run('cp-2', 'run1', 2, now);
  expect(() => insertCheckpoint.run('cp-duplicate', 'run1', 2, now)).toThrow();

  const insertMemory = db.prepare(`INSERT INTO memories
    (id,project_id,source_run_id,memory_type,scope,title,summary,content_object_id,retention_policy,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  insertMemory.run('memory', 'p1', 'run1', 'decision', 'project', 'title', '', 'o', 'keep', now);
  expect(() => insertMemory.run('memory-dup', 'p1', 'run1', 'decision', 'project', 'other', '', 'o', 'keep', now)).toThrow(/UNIQUE/);
  expect(() => insertMemory.run('bad-type', 'p1', 'run1', 'unknown', 'project', 'x', '', 'o', 'keep', now)).toThrow(/CHECK/);
  expect(() => insertMemory.run('bad-scope', 'p1', 'run1', 'decision', 'global', 'x', '', 'o', 'keep', now)).toThrow(/CHECK/);
  expect(() => insertMemory.run('bad-retention', 'p1', 'run1', 'decision', 'project', 'x', '', 'o', 'forever', now)).toThrow(/CHECK/);
  db.close();
});
