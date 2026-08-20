import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContentStore } from '@project-orchestrator/content-store';
import { migrate, openDatabase } from '@project-orchestrator/sqlite-store';

export function runtimeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-service-'));
  const db = openDatabase(join(dir, 'db.sqlite'));
  migrate(db);
  const content = new ContentStore(join(dir, 'objects'), db);
  const now = new Date().toISOString();
  const object = content.putCanonicalJson({});
  const capability = content.putCanonicalJson({
    clientType: 'codex', adapterVersion: '1', trustedRootSessionIdentity: true,
    parallelSubagentIsolation: true, trustedInteractiveConfirmation: true, managedOperationExecution: true,
  });
  db.prepare(`INSERT INTO client_installations
    (id,client_type,adapter_version,capability_object_id,credential_hash,status,last_seen_at)
    VALUES('install','codex','1',?,?,'active',?)`)
    .run(capability.id, createHash('sha256').update('credential').digest('hex'), now);
  db.prepare(`INSERT INTO projects(id,canonical_path,display_name,repository_fingerprint,created_at,last_seen_at)
    VALUES('project',?,'Project','fp',?,?)`).run(dir, now, now);
  db.prepare("INSERT INTO roles(id,slug,name,status,created_at,updated_at) VALUES('role','role','Role','active',?,?)").run(now, now);
  db.prepare(`INSERT INTO role_versions
    (id,role_id,version_number,content_object_id,skill_hash,input_schema_envelope,output_schema_envelope,
     requested_capabilities,effective_capabilities,forbidden_capabilities,completion_contract_envelope,published_at,status)
    VALUES('role-v1','role',1,?,?,'{}','{}','[]','[]','[]','{}',?,'published')`)
    .run(object.id, createHash('sha256').update('skill').digest('hex'), now);
  db.prepare("UPDATE roles SET current_version_id='role-v1' WHERE id='role'").run();
  db.prepare("INSERT INTO workflow_templates(id,slug,name,task_type,status,created_at,updated_at) VALUES('workflow','workflow','Workflow','feature','active',?,?)").run(now, now);
  return { dir, db, content, object, capability, now };
}
export const principal = { installationId: 'install', sessionId: 'root', rootSessionId: 'root', clientType: 'codex' as const, canonicalProjectPath: process.cwd() };
export const workspace = { repositoryHead: 'head', stagedPatch: '', unstagedPatch: '', untrackedManifest: [], submoduleManifest: [] };
