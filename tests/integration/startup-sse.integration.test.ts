import { createHash, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { ContentStore } from '@project-orchestrator/content-store';
import { buildWebListener, interruptExpiredLeases, prepareRuntimeStartup, startControlServer } from '@project-orchestrator/control-server';
import { LeaseService } from '@project-orchestrator/orchestrator-service';
import { EventRepository, migrate, openDatabase } from '@project-orchestrator/sqlite-store';

const directories: string[] = [];
const HASH = 'a'.repeat(64);
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
  db.prepare("INSERT INTO role_versions(id,role_id,version_number,content_object_id,skill_hash,input_schema_envelope,output_schema_envelope,requested_capabilities,effective_capabilities,forbidden_capabilities,completion_contract_envelope,published_at,status) VALUES('role-v1','role',1,?,?,'{}','{}','[]','[]','[]','{}',?,'published')").run(object.id,HASH,now);
  db.prepare("INSERT INTO workflow_templates(id,slug,name,task_type,status,created_at,updated_at) VALUES('wt','workflow','Workflow','feature','active',?,?)").run(now,now);
  db.prepare("INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES('wv','wt',1,'',1,?,?,?)").run(object.id,HASH,now);
  db.prepare("INSERT INTO runs(id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,client_installation_id,origin_session_id,status,lease_epoch,server_epoch,lease_token_hash,lease_expires_at,lease_holder_session_id,updated_at) VALUES('run','project','wv','','{}','codex','install','root','running',1,1,?,?,'root',?)").run(createHash('sha256').update('lease').digest('hex'),new Date(Date.now()+60_000).toISOString(),now);
  db.prepare("INSERT INTO stage_runs(id,run_id,stage_key,role_version_id,status,max_attempts,created_at,updated_at) VALUES('stage','run','stage','role-v1','running',1,?,?)").run(now,now);
  db.prepare("INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at) VALUES('attempt','stage',1,'running','{}',?)").run(now);
  db.prepare("UPDATE stage_runs SET latest_attempt_id='attempt' WHERE id='stage'").run();
  return { db, content };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('port unavailable');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function bootstrapCookie(baseUrl: string, origin: string) {
  const response = await fetch(`${baseUrl}/bootstrap/register`, {
    method: 'POST', redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'owner', password: 'twelve-char-password', confirm_password: 'twelve-char-password' }),
  });
  expect(response.status).toBe(302);
  return String(response.headers.get('set-cookie')).split(';', 1)[0]!;
}

it('derives server epoch from the maximum fenced run and emits deterministic interruption events before traffic', () => {
  const { db } = runtimeFixture();
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 60_000).toISOString();
  for (const [id, status] of [['pending-confirmation', 'pending'], ['approved-confirmation', 'approved']]) {
    db.prepare(`INSERT INTO confirmation_requests
      (id,run_id,stage_run_id,stage_attempt_id,confirmation_type,request_summary,action_hash,nonce_hash,
       safety_baseline_object_id,requested_installation_id,status,requested_at,expires_at)
      VALUES(?,'run','stage','attempt','release','release',?,?,
       (SELECT capability_object_id FROM client_installations WHERE id='install'),'install',?,?,?)`)
      .run(id, HASH, HASH, status, now, expires);
    db.prepare(`INSERT INTO side_effect_operations
      (id,run_id,stage_attempt_id,action_type,target_fingerprint,request_hash,parameters_envelope,
       confirmation_request_id,lease_epoch,status,created_at)
      VALUES(?,'run','attempt','deploy','node',?,'{}',?,1,'intent_recorded',?)`)
      .run(`${id}-operation`, HASH, id, now);
  }
  expect(prepareRuntimeStartup(db)).toBe(2);
  db.prepare("UPDATE runs SET server_epoch=7 WHERE id='run'").run();
  expect(prepareRuntimeStartup(db)).toBe(8);
  expect(db.pragma('application_id', { simple: true })).toBe(0x504f5243);
  expect(db.pragma('user_version', { simple: true })).toBe(8);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_metadata'").get()).toBeUndefined();
  expect(db.prepare("SELECT status,lease_token_hash FROM runs WHERE id='run'").get()).toEqual({ status: 'interrupted', lease_token_hash: null });
  expect(db.prepare("SELECT status FROM stage_attempts WHERE id='attempt'").get()).toEqual({ status: 'interrupted' });
  expect((new EventRepository(db).list('run')).map(({ sequenceNumber,eventType })=>[sequenceNumber,eventType])).toEqual([
    [1,'stage_interrupted'],[2,'run_interrupted'],
  ]);
  expect(db.prepare("SELECT count(*) AS count FROM confirmation_requests WHERE run_id='run' AND status='expired'").get())
    .toEqual({ count: 2 });
  expect(db.prepare("SELECT count(*) AS count FROM side_effect_operations WHERE run_id='run' AND status='abandoned'").get())
    .toEqual({ count: 2 });
  db.close();
});

it('persists and increments server epoch across consecutive idle startups', () => {
  const directory = mkdtempSync(join(tmpdir(), 'startup-epoch-'));
  directories.push(directory);
  const path = join(directory, 'db.sqlite');
  const first = openDatabase(path);
  migrate(first);
  expect(prepareRuntimeStartup(first)).toBe(1);
  first.close();

  const second = openDatabase(path);
  migrate(second);
  expect(prepareRuntimeStartup(second)).toBe(2);
  expect(second.pragma('user_version', { simple: true })).toBe(2);
  expect(second.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 0 });
  second.close();
});

it('fences an older runtime before it can claim after a concurrent startup', () => {
  const { db } = runtimeFixture();
  db.prepare(`UPDATE runs SET status='created',lease_epoch=0,server_epoch=0,lease_token_hash=NULL,
    lease_expires_at=NULL,lease_holder_session_id=NULL`).run();
  const firstEpoch = prepareRuntimeStartup(db);
  const oldRuntime = new LeaseService(db, firstEpoch, 60_000);
  expect(prepareRuntimeStartup(db)).toBe(firstEpoch + 1);
  expect(() => oldRuntime.claim({ runId: 'run', principal: { installationId: 'install', sessionId: 'root',
    rootSessionId: 'root', clientType: 'codex', canonicalProjectPath: '' }, mode: 'start', expectedStatus: 'created',
    expectedLeaseEpoch: 0 })).toThrow('STALE_LEASE');
  db.close();
});

it('rejects a foreign SQLite application id before writing migrations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'startup-foreign-db-'));
  directories.push(directory);
  const databasePath = join(directory, 'foreign.sqlite');
  const foreign = openDatabase(databasePath);
  foreign.exec('CREATE TABLE foreign_data(id INTEGER PRIMARY KEY)');
  foreign.pragma('application_id = 123');
  foreign.close();

  await expect(startControlServer({
    dataDirectory: directory, databasePath, objectsPath: join(directory, 'objects'),
    controlSocketPath: join(directory, 'control.sock'), operationSocketPath: join(directory, 'operation.sock'),
    webHost: '127.0.0.1', webPort: 0, webSessionSecret: 'csrf', adapterCredential: 'adapter',
    allowedOrigins: ['http://127.0.0.1'], maxFrameBytes: 256 * 1024,
  })).rejects.toThrow('DATABASE_APPLICATION_ID_MISMATCH');
  const reopened = openDatabase(databasePath);
  expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all())
    .toEqual([{ name: 'foreign_data' }]);
  reopened.close();
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
  const app=buildWebListener({db,content,sessionSecret:'csrf',allowedOrigins:['http://127.0.0.1'],ssePollIntervalMs:10});
  await app.listen({host:'127.0.0.1',port:0});
  const address=app.server.address();
  if(address===null||typeof address==='string')throw new Error('listener unavailable');
  const abort=new AbortController();
  const baseUrl=`http://127.0.0.1:${address.port}`;
  const cookie=await bootstrapCookie(baseUrl,'http://127.0.0.1');
  const response=await fetch(`${baseUrl}/api/stream/events?run_id=run`,{headers:{cookie,'last-event-id':'1',origin:'http://127.0.0.1'},signal:abort.signal});
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
  const webSessionSecretPath=join(directory,'web-session-secret');const adapterPath=join(directory,'adapter-token');writeFileSync(webSessionSecretPath,'web-session-secret');writeFileSync(adapterPath,credential);chmodSync(webSessionSecretPath,0o600);chmodSync(adapterPath,0o600);
  const socketPath=join(directory,'control.sock');
  const operationSocketPath=join(directory,'operations.sock');
  const operationChild=spawn(process.execPath,['packages/operation-executor/dist/main.js',operationSocketPath],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
  const operationDeadline=Date.now()+5_000;while(!existsSync(operationSocketPath)&&Date.now()<operationDeadline)await new Promise((resolve)=>setTimeout(resolve,20));
  expect(existsSync(operationSocketPath)).toBe(true);
  const port=await availablePort();
  const child=spawn(process.execPath,['apps/control-server/dist/main.js'],{cwd:process.cwd(),env:{...process.env,PROJECT_ORCHESTRATOR_DATA:directory,PROJECT_ORCHESTRATOR_DB:databasePath,PROJECT_ORCHESTRATOR_OBJECTS:join(directory,'objects'),PROJECT_ORCHESTRATOR_SOCKET:socketPath,PROJECT_ORCHESTRATOR_OPERATION_SOCKET:operationSocketPath,PROJECT_ORCHESTRATOR_WEB_SESSION_SECRET_FILE:webSessionSecretPath,PROJECT_ORCHESTRATOR_ADAPTER_CREDENTIAL_FILE:adapterPath,PROJECT_ORCHESTRATOR_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  const deadline=Date.now()+5_000;while(!existsSync(socketPath)&&Date.now()<deadline)await new Promise((resolve)=>setTimeout(resolve,20));
  expect(existsSync(socketPath)).toBe(true);const adapter=connect(socketPath);adapter.setEncoding('utf8');await once(adapter,'connect');adapter.write(`${JSON.stringify({kind:'bootstrap',credential,channel:'agent',scope:'root',canonical_project_path:directory})}\n`);const [challengeChunk]=await once(adapter,'data') as [string];const challenge=JSON.parse(challengeChunk.trim()) as {challenge:string};adapter.write(`${JSON.stringify({kind:'bind_root_session',challenge:challenge.challenge,session_id:'root',proof:createHmac('sha256',credential).update(`${challenge.challenge}\0root\0${directory}`).digest('base64url')})}\n`);await once(adapter,'data');
  const origin=`http://127.0.0.1:${port}`;const cookie=await bootstrapCookie(origin,origin);
  const response=await fetch(`${origin}/api/stream/events?run_id=missing`,{headers:{cookie}});expect(response.status).toBe(200);const reader=response.body!.getReader();const pendingRead=reader.read();
  child.kill('SIGTERM');const [code,signal]=await once(child,'exit') as [number|null,NodeJS.Signals|null];
  const closed=await Promise.race([pendingRead,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('SSE_NOT_CLOSED')),2_000))]);
  expect(closed.done).toBe(true);expect({code,signal}).toEqual({code:0,signal:null});expect(existsSync(socketPath)).toBe(false);
  operationChild.kill('SIGTERM');
  const [operationCode,operationSignal]=await once(operationChild,'exit') as [number|null,NodeJS.Signals|null];
  expect({code:operationCode,signal:operationSignal}).toEqual({code:0,signal:null});
  expect(existsSync(operationSocketPath)).toBe(false);
});
