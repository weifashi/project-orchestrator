import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { ContentStore } from '@project-orchestrator/content-store';
import { buildWebListener, interruptExpiredLeases, prepareRuntimeStartup } from '@project-orchestrator/control-server';
import { EventRepository, migrate, openDatabase } from '@project-orchestrator/sqlite-store';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runtimeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'startup-sse-'));
  directories.push(directory);
  const db = openDatabase(join(directory, 'db.sqlite'));
  migrate(db);
  const content = new ContentStore(join(directory, 'objects'), db);
  const object = content.putCanonicalJson({});
  const now = new Date().toISOString();
  db.prepare("INSERT INTO client_installations(id,client_type,adapter_version,capability_object_id,credential_hash,status,last_seen_at) VALUES('install','codex','1',?,?,'active',?)").run(object.id,createHash('sha256').update('fixture').digest('hex'),now);
  db.prepare("INSERT INTO projects(id,canonical_path,display_name,repository_fingerprint,created_at,last_seen_at) VALUES('project',?,'P','fp',?,?)").run(directory,now,now);
  db.prepare("INSERT INTO roles(id,slug,name,status,created_at,updated_at) VALUES('role','role','Role','active',?,?)").run(now,now);
  db.prepare("INSERT INTO role_versions(id,role_id,version_number,content_object_id,skill_hash,input_schema_envelope,output_schema_envelope,requested_capabilities,effective_capabilities,forbidden_capabilities,completion_contract_envelope,published_at,status) VALUES('role-v1','role',1,?,'h','{}','{}','[]','[]','[]','{}',?,'published')").run(object.id,now);
  db.prepare("INSERT INTO workflow_templates(id,slug,name,task_type,status,created_at,updated_at) VALUES('wt','workflow','Workflow','feature','active',?,?)").run(now,now);
  db.prepare("INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES('wv','wt',1,'',1,?,'h',?)").run(object.id,now);
  db.prepare("INSERT INTO runs(id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,client_installation_id,origin_session_id,status,lease_epoch,server_epoch,lease_token_hash,lease_expires_at,lease_holder_session_id,updated_at) VALUES('run','project','wv','','{}','codex','install','root','running',1,1,?,?,'root',?)").run(createHash('sha256').update('lease').digest('hex'),new Date(Date.now()+60_000).toISOString(),now);
  db.prepare("INSERT INTO stage_runs(id,run_id,stage_key,role_version_id,status,max_attempts,created_at,updated_at) VALUES('stage','run','stage','role-v1','running',1,?,?)").run(now,now);
  db.prepare("INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at) VALUES('attempt','stage',1,'running','{}',?)").run(now);
  db.prepare("UPDATE stage_runs SET latest_attempt_id='attempt' WHERE id='stage'").run();
  return { db, content };
}

it('persists server epoch and emits deterministic interruption events before accepting traffic', () => {
  const { db } = runtimeFixture();
  expect(prepareRuntimeStartup(db)).toBe(1);
  expect(prepareRuntimeStartup(db)).toBe(2);
  expect(db.prepare("SELECT status,lease_token_hash FROM runs WHERE id='run'").get()).toEqual({ status: 'interrupted', lease_token_hash: null });
  expect(db.prepare("SELECT status FROM stage_attempts WHERE id='attempt'").get()).toEqual({ status: 'interrupted' });
  expect((new EventRepository(db).list('run')).map(({ sequenceNumber,eventType })=>[sequenceNumber,eventType])).toEqual([
    [1,'stage_interrupted'],[2,'run_interrupted'],
  ]);
  db.close();
});

it('interrupts an expired heartbeat lease with the same ordered audit trail', () => {
  const { db } = runtimeFixture();
  db.prepare("UPDATE runs SET lease_expires_at=? WHERE id='run'").run(new Date(Date.now()-1_000).toISOString());
  expect(interruptExpiredLeases(db)).toBe(1);
  expect((new EventRepository(db).list('run')).map(({eventType,payload})=>[eventType,payload])).toEqual([
    ['stage_interrupted',{reason:'lease_expired'}],
    ['run_interrupted',{previousStatus:'running',reason:'lease_expired'}],
  ]);
  db.close();
});

it('keeps SSE open, resumes after Last-Event-ID, and streams newly appended events exactly once', async () => {
  const { db, content } = runtimeFixture();
  const events = new EventRepository(db);
  events.append('run','agent_note','install',{note:'one'});
  events.append('run','agent_note','install',{note:'two'});
  const app=buildWebListener({db,content,webToken:'web',csrfToken:'csrf',allowedOrigin:'http://127.0.0.1',ssePollIntervalMs:10});
  await app.listen({host:'127.0.0.1',port:0});
  const address=app.server.address();
  if(address===null||typeof address==='string')throw new Error('listener unavailable');
  const abort=new AbortController();
  const response=await fetch(`http://127.0.0.1:${address.port}/api/stream/events?run_id=run`,{headers:{cookie:'po_session=web','last-event-id':'1',origin:'http://127.0.0.1'},signal:abort.signal});
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader=response.body!.getReader();
  const decoder=new TextDecoder();
  let received='';
  while(!received.includes('id: 2'))received+=decoder.decode((await reader.read()).value,{stream:true});
  events.append('run','agent_note','install',{note:'three'});
  while(!received.includes('id: 3'))received+=decoder.decode((await reader.read()).value,{stream:true});
  expect(received.match(/id: 2/g)).toHaveLength(1);
  expect(received.match(/id: 3/g)).toHaveLength(1);
  await reader.cancel();abort.abort();await app.close();db.close();
});

it('awaits SIGTERM shutdown and removes the accepting Agent socket before exit', async () => {
  const directory=mkdtempSync(join(tmpdir(),'sigterm-'));directories.push(directory);chmodSync(directory,0o700);
  const databasePath=join(directory,'db.sqlite');const db=openDatabase(databasePath);migrate(db);
  const content=new ContentStore(join(directory,'objects'),db);const capabilities=content.putCanonicalJson({});const credential='adapter-secret';const now=new Date().toISOString();
  db.prepare("INSERT INTO client_installations(id,client_type,adapter_version,capability_object_id,credential_hash,status,last_seen_at) VALUES('install','codex','1',?,?,'active',?)").run(capabilities.id,createHash('sha256').update(credential).digest('hex'),now);db.close();
  const webTokenPath=join(directory,'web-token');const adapterPath=join(directory,'adapter-token');writeFileSync(webTokenPath,'web');writeFileSync(`${webTokenPath}.csrf`,'csrf');writeFileSync(adapterPath,credential);chmodSync(webTokenPath,0o600);chmodSync(`${webTokenPath}.csrf`,0o600);chmodSync(adapterPath,0o600);
  const socketPath=join(directory,'control.sock');
  const child=spawn(process.execPath,['apps/control-server/dist/main.js'],{cwd:process.cwd(),env:{...process.env,PROJECT_ORCHESTRATOR_DATA:directory,PROJECT_ORCHESTRATOR_DB:databasePath,PROJECT_ORCHESTRATOR_OBJECTS:join(directory,'objects'),PROJECT_ORCHESTRATOR_SOCKET:socketPath,PROJECT_ORCHESTRATOR_OPERATION_SOCKET:join(directory,'operations.sock'),PROJECT_ORCHESTRATOR_WEB_TOKEN_FILE:webTokenPath,PROJECT_ORCHESTRATOR_ADAPTER_CREDENTIAL_FILE:adapterPath,PROJECT_ORCHESTRATOR_PORT:'0'},stdio:['ignore','pipe','pipe']});
  const deadline=Date.now()+5_000;while(!existsSync(socketPath)&&Date.now()<deadline)await new Promise((resolve)=>setTimeout(resolve,20));
  expect(existsSync(socketPath)).toBe(true);const adapter=connect(socketPath);adapter.setEncoding('utf8');await once(adapter,'connect');adapter.write(`${JSON.stringify({credential,channel:'agent'})}\n`);await once(adapter,'data');child.kill('SIGTERM');const [code,signal]=await once(child,'exit') as [number|null,NodeJS.Signals|null];
  expect({code,signal}).toEqual({code:0,signal:null});expect(existsSync(socketPath)).toBe(false);
});
