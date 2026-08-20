import { rmSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { MemoryService } from '../src/index.js';
import { runtimeFixture } from './runtime-fixture.js';

const clean: string[] = [];
const HASH = 'a'.repeat(64);
afterEach(() => clean.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function seed(f: ReturnType<typeof runtimeFixture>, roleSlug: string, effectiveCapabilities: string[] = []) {
  const envelope = f.content.putCanonicalJson({ data: { slug: roleSlug } });
  const roleBundle = f.content.putCanonicalJson({ roles: [{ roleVersionId: 'memory-role-v1', envelope: { data: { slug: roleSlug } } }] });
  f.db.prepare("UPDATE role_versions SET status='revoked' WHERE id='role-v1'").run();
  f.db.prepare("INSERT INTO roles(id,slug,name,status,created_at,updated_at) VALUES('memory-role',?,'Memory','active',?,?)").run(roleSlug, f.now, f.now);
  f.db.prepare(`INSERT INTO role_versions
    (id,role_id,version_number,content_object_id,skill_hash,input_schema_envelope,output_schema_envelope,
     requested_capabilities,effective_capabilities,forbidden_capabilities,completion_contract_envelope,published_at,status)
    VALUES('memory-role-v1','memory-role',1,?,?,'{}','{}','[]',?,'[]','{}',?,'published')`)
    .run(envelope.id, HASH, JSON.stringify(effectiveCapabilities), f.now);
  f.db.prepare("INSERT INTO workflow_versions(id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at) VALUES('wv','workflow',1,'',1,?,?,?)").run(f.object.id, HASH, f.now);
  f.db.prepare("INSERT INTO runs(id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,client_installation_id,origin_session_id,status,updated_at) VALUES('run','project','wv','','{}','codex','install','root','running',?)").run(f.now);
  f.db.prepare("INSERT INTO stage_runs(id,run_id,stage_key,role_version_id,status,max_attempts,created_at,updated_at) VALUES('memory-stage','run','memory','memory-role-v1','running',1,?,?)").run(f.now, f.now);
  f.db.prepare(`INSERT INTO run_snapshots
    (run_id,workflow_object_id,role_bundle_object_id,rule_bundle_object_id,safety_baseline_object_id,adapter_capability_object_id,
     repository_head,staged_patch_object_id,unstaged_patch_object_id,untracked_manifest_object_id,submodule_manifest_object_id,working_tree_fingerprint,created_at)
    VALUES('run',?,?,?,?,?,'head',?,?,?,?,'fingerprint',?)`)
    .run(f.object.id, roleBundle.id, f.object.id, f.object.id, f.object.id, f.object.id, f.object.id, f.object.id, f.object.id, f.now);
}

const request = {
  runId: 'run', stageRunId: 'memory-stage', memoryType: 'decision' as const, scope: 'project' as const,
  title: 'Architecture', summary: 'Selected backend', retentionPolicy: 'keep' as const,
  content: {
    choice: 'SQLite', nested: { apiToken: 'secret-token', harmless: 'visible' },
    list: [{ password: 'hunter2' }, 'Authorization: Bearer abc.def.ghi'],
  },
};

it('allows only the frozen memory-docs role or an explicitly write-memory-capable role', () => {
  const denied = runtimeFixture(); clean.push(denied.dir); seed(denied, 'implementation');
  expect(() => new MemoryService(denied.db, denied.content).record(request)).toThrow('POLICY_VIOLATION');
  denied.db.close();

  const allowed = runtimeFixture(); clean.push(allowed.dir); seed(allowed, 'custom-memory-writer', ['write-memory']);
  expect(new MemoryService(allowed.db, allowed.content).record(request)).toMatchObject({ deduplicated: false });
  allowed.db.close();
});

it('recursively redacts sensitive content and deduplicates by project, type, and redacted content', () => {
  const f = runtimeFixture(); clean.push(f.dir); seed(f, 'memory-docs');
  const service = new MemoryService(f.db, f.content);
  const first = service.record(request);
  const second = service.record({ ...request, title: 'Duplicate with another title' });
  expect(second).toEqual({ ...first, deduplicated: true });
  expect(f.db.prepare('SELECT count(*) AS count FROM memories').get()).toEqual({ count: 1 });
  const stored = JSON.parse(Buffer.from(f.content.read(first.contentObjectId)).toString()) as Record<string, unknown>;
  expect(stored).toEqual({
    choice: 'SQLite', nested: { apiToken: '[REDACTED]', harmless: 'visible' },
    list: [{ password: '[REDACTED]' }, 'Authorization: Bearer [REDACTED]'],
  });
  f.db.close();
});

it('rejects stages from another run even when their frozen role can write memory', () => {
  const f = runtimeFixture(); clean.push(f.dir); seed(f, 'memory-docs');
  expect(() => new MemoryService(f.db, f.content).record({ ...request, runId: 'other' })).toThrow('stage does not belong');
  f.db.close();
});
