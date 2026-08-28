import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { buildWebListener } from "@project-orchestrator/control-server";
import { runtimeFixture } from "../../packages/orchestrator-service/test/runtime-fixture.js";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((directory) =>
    rmSync(directory, { recursive: true, force: true }),
  ),
);

function seededExportFixture() {
  const fixture = runtimeFixture();
  directories.push(fixture.dir);
  const { db, content, now } = fixture;
  const workflow = content.putCanonicalJson({
    schema_id: "project-orchestrator/workflow-version",
    schema_version: 1,
    data: {
      slug: "workflow",
      version: 1,
      stages: [{ key: "testing", role_version_id: "role-v1" }],
      edges: [],
      iteration_groups: [],
    },
  });
  db.prepare(`INSERT INTO workflow_versions
    (id,workflow_template_id,version_number,description,safety_baseline_version,content_object_id,content_hash,published_at)
    VALUES('workflow-v1','workflow',1,'Evidence export',1,?,?,?)`)
    .run(workflow.id, workflow.sha256, now);
  db.prepare("UPDATE workflow_templates SET current_version_id='workflow-v1' WHERE id='workflow'").run();
  db.prepare(`INSERT INTO runs
    (id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,client_installation_id,origin_session_id,status,started_at,updated_at)
    VALUES('run-export','project','workflow-v1','Ship portable exports','{"private_input":"not exported"}','codex','install','session-private','running',?,?)`)
    .run(now, now);
  const empty = content.putCanonicalJson({});
  db.prepare(`INSERT INTO run_snapshots
    (run_id,workflow_object_id,role_bundle_object_id,rule_bundle_object_id,safety_baseline_object_id,
     adapter_capability_object_id,repository_head,staged_patch_object_id,unstaged_patch_object_id,
     untracked_manifest_object_id,submodule_manifest_object_id,working_tree_fingerprint,created_at)
    VALUES('run-export',?,?,?,?,?,'head',?,?,?,?,'fingerprint',?)`)
    .run(workflow.id, empty.id, empty.id, empty.id, fixture.capability.id,
      empty.id, empty.id, empty.id, empty.id, now);
  db.prepare(`INSERT INTO stage_runs
    (id,run_id,stage_key,role_version_id,status,max_attempts,created_at,updated_at)
    VALUES('stage-export','run-export','testing','role-v1','running',2,?,?)`).run(now, now);
  db.prepare(`INSERT INTO stage_attempts
    (id,stage_run_id,attempt_number,status,input_envelope,started_at)
    VALUES('attempt-export','stage-export',1,'running','{"prompt":"not exported"}',?)`).run(now);
  db.prepare("UPDATE stage_runs SET latest_attempt_id='attempt-export' WHERE id='stage-export'").run();

  const artifactBody = content.putUtf8("active artifact body must stay separate", "text/plain; charset=utf-8");
  db.prepare(`INSERT INTO artifacts
    (id,run_id,stage_attempt_id,artifact_type,content_object_id,source_path,summary,producer_role_version_id,metadata_envelope,created_at)
    VALUES('artifact-export','run-export','attempt-export','test_evidence',?,'tests/report.txt','42 tests passed','role-v1','{"internal":"not exported"}',?)`)
    .run(artifactBody.id, now);
  const memoryBody = content.putCanonicalJson({ decision: "Keep SQLite authoritative" });
  db.prepare(`INSERT INTO memories
    (id,project_id,source_run_id,memory_type,scope,title,summary,content_object_id,retention_policy,created_at)
    VALUES('memory-export','project','run-export','decision','project','Storage decision','SQLite remains the source of truth <script>',?,'keep',?)`)
    .run(memoryBody.id, now);
  db.prepare(`INSERT INTO confirmation_requests
    (id,run_id,stage_run_id,stage_attempt_id,confirmation_type,request_summary,action_hash,nonce_hash,
     safety_baseline_object_id,requested_installation_id,status,requested_at,expires_at)
    VALUES('confirmation-export','run-export','stage-export','attempt-export','release','Approve release',?,?,?,'install','approved',?,?)`)
    .run("a".repeat(64), createHash("sha256").update("nonce-secret").digest("hex"), empty.id, now, new Date(Date.now() + 60_000).toISOString());
  db.prepare(`INSERT INTO side_effect_operations
    (id,run_id,stage_attempt_id,action_type,target_fingerprint,request_hash,parameters_envelope,
     confirmation_request_id,lease_epoch,status,external_reference,created_at)
    VALUES('operation-export','run-export','attempt-export','deploy','node01',?,'{"token":"operation-secret"}',
     'confirmation-export',1,'unknown','deployment-1',?)`)
    .run(createHash("sha256").update("request").digest("hex"), now);
  db.prepare(`INSERT INTO events
    (id,run_id,stage_run_id,sequence_number,event_type,source_principal_id,payload_envelope,created_at)
    VALUES('event-export','run-export','stage-export',1,'agent_note','install:session-private','{"token":"event-secret"}',?)`)
    .run(now);

  db.prepare(`INSERT INTO projects(id,canonical_path,display_name,repository_fingerprint,created_at,last_seen_at)
    VALUES('other-project',?,'Other','other-fp',?,?)`).run(`${fixture.dir}/other`, now, now);
  db.prepare(`INSERT INTO runs
    (id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,client_installation_id,origin_session_id,status,updated_at)
    VALUES('other-run','other-project','workflow-v1','Other','{}','codex','install','other-session','created',?)`).run(now);
  const otherMemory = content.putCanonicalJson({ decision: "Other project only" });
  db.prepare(`INSERT INTO memories
    (id,project_id,source_run_id,memory_type,scope,title,summary,content_object_id,retention_policy,created_at)
    VALUES('other-memory','other-project','other-run','decision','project','Other decision','Must be filtered',?,'keep',?)`)
    .run(otherMemory.id, now);
  return fixture;
}

it("exports one Run as versioned JSON and Markdown without runtime secrets or active artifact bodies", async () => {
  const fixture = seededExportFixture();
  const app = buildWebListener({
    db: fixture.db,
    content: fixture.content,
    sessionSecret: "session-secret",
    allowedOrigins: ["https://public.example"],
    allowedHosts: ["127.0.0.1"],
    lanOrigins: ["http://127.0.0.1:3847"],
  });
  const rowCountBefore = fixture.db.prepare("SELECT count(*) AS count FROM content_objects").get();
  const changesBefore = fixture.db.prepare("SELECT total_changes() AS count").get();
  const runBefore = fixture.db.prepare("SELECT status,updated_at FROM runs WHERE id='run-export'").get();
  const json = await app.inject({ method: "GET", url: "/api/read/run-exports/run-export?format=json", headers: { host: "127.0.0.1" } });
  expect(json.statusCode).toBe(200);
  expect(json.headers["content-disposition"]).toBe('attachment; filename="run-run-export.json"');
  expect(json.headers["content-type"]).toContain("application/json");
  expect(json.headers["cache-control"]).toBe("no-store");
  expect(json.headers["x-content-type-options"]).toBe("nosniff");
  expect(json.json()).toMatchObject({
    schema_id: "project-orchestrator/run-export",
    schema_version: 1,
    data: {
      run: { id: "run-export", objective: "Ship portable exports" },
      snapshot: { workflow_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      workflow_snapshot: { schema_id: "project-orchestrator/workflow-version" },
      stages: [{ id: "stage-export", stage_key: "testing" }],
      artifacts: [{ id: "artifact-export", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), size_bytes: Buffer.byteLength("active artifact body must stay separate") }],
      memories: [{ title: "Storage decision", content: { decision: "Keep SQLite authoritative" } }],
      events: [{ id: "event-export", event_type: "agent_note" }],
    },
  });
  expect(json.body).not.toMatch(/private_input|session-private|nonce-secret|operation-secret|event-secret|storage_key|lease_token|recovery_credential|active artifact body/);

  const markdown = await app.inject({ method: "GET", url: "/api/read/run-exports/run-export?format=markdown&lang=zh-CN", headers: { host: "127.0.0.1" } });
  expect(markdown.statusCode).toBe(200);
  expect(markdown.headers["content-disposition"]).toBe('attachment; filename="run-run-export.md"');
  expect(markdown.headers["content-type"]).toContain("text/markdown");
  expect(markdown.body).toContain("# Ship portable exports");
  expect(markdown.body).toContain("SQLite remains the source of truth");
  expect(markdown.body).toContain("&lt;script&gt;");
  expect(markdown.body).not.toContain("<script>");
  expect(markdown.body).toContain("42 tests passed");
  expect(markdown.body).toContain("未经审查的上下文");
  expect(markdown.body).not.toMatch(/operation-secret|event-secret|active artifact body/);
  const english = await app.inject({ method: "GET", url: "/api/read/run-exports/run-export?format=markdown&lang=en", headers: { host: "127.0.0.1" } });
  expect(english.body).toContain("**Trust boundary:**");
  expect(english.body).toContain("## Artifacts and evidence");
  expect(fixture.db.prepare("SELECT count(*) AS count FROM content_objects").get()).toEqual(rowCountBefore);
  expect(fixture.db.prepare("SELECT total_changes() AS count").get()).toEqual(changesBefore);
  expect(fixture.db.prepare("SELECT status,updated_at FROM runs WHERE id='run-export'").get()).toEqual(runBefore);
  expect((await app.inject({ method: "GET", url: "/api/read/run-exports/missing?format=json", headers: { host: "127.0.0.1" } })).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url: "/api/read/run-exports/run-export?format=xml", headers: { host: "127.0.0.1" } })).statusCode).toBe(400);
  expect((await app.inject({ method: "GET", url: "/api/read/run-exports/run-export?format=json&lang=fr", headers: { host: "127.0.0.1" } })).statusCode).toBe(400);
  await app.close();
  fixture.db.close();
});

it("exports only the selected project's memory records", async () => {
  const fixture = seededExportFixture();
  const app = buildWebListener({
    db: fixture.db,
    content: fixture.content,
    sessionSecret: "session-secret",
    allowedOrigins: ["https://public.example"],
    allowedHosts: ["127.0.0.1"],
    lanOrigins: ["http://127.0.0.1:3847"],
  });
  const json = await app.inject({ method: "GET", url: "/api/read/memory-exports?project_id=project&format=json", headers: { host: "127.0.0.1" } });
  expect(json.statusCode).toBe(200);
  expect(json.json()).toMatchObject({
    schema_id: "project-orchestrator/memory-export",
    schema_version: 1,
    data: { project_filter: "project", memories: [{ id: "memory-export", title: "Storage decision" }] },
  });
  expect(json.body).not.toContain("other-memory");
  const markdown = await app.inject({ method: "GET", url: "/api/read/memory-exports?project_id=project&format=markdown", headers: { host: "127.0.0.1" } });
  expect(markdown.headers["content-disposition"]).toBe('attachment; filename="project-project-memories.md"');
  expect(markdown.body).toContain("# 项目记忆导出");
  expect(markdown.body).toContain("Keep SQLite authoritative");
  expect(markdown.body).not.toContain("Other project only");
  await app.close();
  fixture.db.close();
});
