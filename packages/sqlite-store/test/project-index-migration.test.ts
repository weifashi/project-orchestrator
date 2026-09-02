import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/index.js';

const directories: string[] = [];
const HASH = 'a'.repeat(64);

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function seeded() {
  const directory = mkdtempSync(join(tmpdir(), 'project-index-db-'));
  directories.push(directory);
  const db = openDatabase(join(directory, 'db.sqlite'));
  migrate(db);
  const now = new Date().toISOString();
  const credential = createHash('sha256').update('credential').digest('hex');
  for (const id of ['object', 'index-object']) {
    db.prepare('INSERT INTO content_objects(id,sha256,media_type,size_bytes,storage_key,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, id === 'object' ? HASH : 'b'.repeat(64), 'application/json', 2, `aa/${id}`, now);
  }
  db.prepare("INSERT INTO workflow_templates(id,slug,name,task_type,status,created_at,updated_at) VALUES('workflow','workflow','Workflow','feature','active',?,?)").run(now, now);
  db.prepare("INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES('workflow-v1','workflow',1,'',1,'object',?,?)").run(HASH, now);
  db.prepare("INSERT INTO roles(id,slug,name,status,created_at,updated_at) VALUES('role','research','Research','active',?,?)").run(now, now);
  db.prepare(`INSERT INTO role_versions(id,role_id,version_number,content_object_id,skill_hash,input_schema_envelope,output_schema_envelope,
    requested_capabilities,effective_capabilities,forbidden_capabilities,completion_contract_envelope,published_at,status)
    VALUES('role-v1','role',1,'object',?,'{}','{}','[]','[]','[]','{}',?,'published')`).run(HASH, now);
  db.prepare("INSERT INTO client_installations(id,client_type,adapter_version,capability_object_id,credential_hash,status,last_seen_at) VALUES('install','codex','1','object',?,'active',?)").run(credential, now);
  for (const project of ['p1', 'p2']) {
    db.prepare('INSERT INTO projects(id,canonical_path,display_name,repository_fingerprint,created_at,last_seen_at) VALUES(?,?,?,?,?,?)')
      .run(project, `/tmp/${project}`, project, 'fp', now, now);
  }
  for (const [run, project] of [['run1', 'p1'], ['run2', 'p2'], ['run3', 'p1']]) {
    db.prepare(`INSERT INTO runs(id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,
      client_installation_id,origin_session_id,status,updated_at) VALUES(?,?,'workflow-v1','','{}','codex','install','root','running',?)`)
      .run(run, project, now);
  }
  for (const [stage, run, stageKey] of [
    ['stage1', 'run1', 'research'],
    ['stage1b', 'run1', 'code-review'],
    ['stage2', 'run2', 'research'],
    ['stage3', 'run3', 'research'],
  ]) {
    db.prepare("INSERT INTO stage_runs(id,run_id,stage_key,role_version_id,status,max_attempts,created_at,updated_at) VALUES(?,?,?,'role-v1','running',1,?,?)")
      .run(stage, run, stageKey, now, now);
  }
  db.prepare("INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at) VALUES('attempt1','stage1',1,'running','{}',?)").run(now);
  db.prepare("INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at) VALUES('attempt1b','stage1b',1,'running','{}',?)").run(now);
  db.prepare("INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at) VALUES('attempt2','stage2',1,'running','{}',?)").run(now);
  db.prepare("INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at) VALUES('attempt3','stage3',1,'running','{}',?)").run(now);
  return { db, now };
}

function insertIndex(db: ReturnType<typeof openDatabase>, now: string) {
  const statement = db.prepare(`INSERT INTO project_indexes
    (id,project_id,source_head,tree_fingerprint,content_object_id,file_count,skipped_file_count,created_at)
    VALUES(?,?,?,?,?,?,?,?)`);
  statement.run('index1', 'p1', 'head', HASH, 'index-object', 2, 1, now);
  return statement;
}

it('creates immutable project indexes and enforces binding ownership', () => {
  const { db, now } = seeded();
  const insertIndexStatement = insertIndex(db, now);
  expect(() => insertIndexStatement.run('duplicate', 'p1', 'head', HASH, 'index-object', 2, 1, now)).toThrow(/UNIQUE/);
  db.prepare("INSERT INTO run_project_indexes(run_id,project_index_id,stage_run_id,stage_attempt_id,changed_file_count,bound_at) VALUES('run1','index1','stage1','attempt1',2,?)").run(now);
  expect(() => db.prepare("INSERT INTO run_project_indexes(run_id,project_index_id,stage_run_id,stage_attempt_id,changed_file_count,bound_at) VALUES('run2','index1','stage2','attempt2',0,?)").run(now))
    .toThrow(/PROJECT_INDEX_OWNERSHIP/);
  expect(() => db.prepare("INSERT INTO run_project_indexes(run_id,project_index_id,stage_run_id,stage_attempt_id,changed_file_count,bound_at) VALUES('run3','index1','stage3','attempt3',-1,?)").run(now))
    .toThrow(/CHECK constraint failed/);
  expect(() => db.prepare("UPDATE project_indexes SET file_count=3 WHERE id='index1'").run()).toThrow(/IMMUTABLE_PROJECT_INDEX/);
  expect(() => db.prepare("DELETE FROM project_indexes WHERE id='index1'").run()).toThrow(/IMMUTABLE_PROJECT_INDEX/);
  expect(() => db.prepare("UPDATE run_project_indexes SET stage_attempt_id='attempt2' WHERE run_id='run1'").run()).toThrow(/IMMUTABLE_RUN_PROJECT_INDEX/);
  expect(() => db.prepare("DELETE FROM run_project_indexes WHERE run_id='run1'").run()).toThrow(/IMMUTABLE_RUN_PROJECT_INDEX/);
  db.close();
});

it('rejects a stage owned by another run in the same project', () => {
  const { db, now } = seeded();
  insertIndex(db, now);
  expect(() => db.prepare(`INSERT INTO run_project_indexes
    (run_id,project_index_id,stage_run_id,stage_attempt_id,changed_file_count,bound_at)
    VALUES('run1','index1','stage3','attempt3',1,?)`).run(now)).toThrow(/PROJECT_INDEX_OWNERSHIP/);
  db.close();
});

it('rejects an attempt owned by another stage in the same project', () => {
  const { db, now } = seeded();
  insertIndex(db, now);
  expect(() => db.prepare(`INSERT INTO run_project_indexes
    (run_id,project_index_id,stage_run_id,stage_attempt_id,changed_file_count,bound_at)
    VALUES('run1','index1','stage1','attempt1b',1,?)`).run(now)).toThrow(/PROJECT_INDEX_OWNERSHIP/);
  db.close();
});
