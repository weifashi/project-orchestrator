import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { ContentStore } from "../packages/content-store/dist/index.js";
import {
  migrate,
  openDatabase,
  SqliteConfigRepository,
} from "../packages/sqlite-store/dist/index.js";
import {
  ConfigService,
  seedBuiltins,
} from "../packages/orchestrator-service/dist/index.js";
import { buildWebListener, createWebAuth } from "../apps/control-server/dist/app.js";

const directory = mkdtempSync(join(tmpdir(), "orchestrator-web-e2e-"));
chmodSync(directory, 0o700);
const db = openDatabase(join(directory, "orchestrator.sqlite"));
migrate(db);
const content = new ContentStore(join(directory, "objects"), db),
  repository = new SqliteConfigRepository(db);
seedBuiltins(new ConfigService(repository, content), repository);
const now = new Date().toISOString(),
  capability = content.putCanonicalJson({ e2e: true }),
  workflowVersionId = db
    .prepare(
      "SELECT current_version_id FROM workflow_templates WHERE id='builtin-workflow-feature-development'",
    )
    .pluck()
    .get();
db.prepare(
  "INSERT INTO client_installations(id,client_type,adapter_version,capability_object_id,credential_hash,status,last_seen_at) VALUES(?,?,?,?,?,'active',?)",
).run("e2e-install", "codex", "1", capability.id, "0".repeat(64), now);
db.prepare(
  "INSERT INTO projects(id,canonical_path,display_name,repository_fingerprint,created_at,last_seen_at) VALUES(?,?,?,?,?,?)",
).run("e2e-project", directory, "E2E Project", "e2e-repository", now, now);
db.prepare(
  "INSERT INTO runs(id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,client_installation_id,origin_session_id,status,updated_at) VALUES(?,?,?,?,?,'codex',?,?,'created',?)",
).run(
  "e2e-run",
  "e2e-project",
  workflowVersionId,
  "Existing Run remains pinned",
  "{}",
  "e2e-install",
  "e2e-session",
  now,
);
await createWebAuth(db, "e2e-session-secret").registerFirstUser({
  username: "owner",
  password: "twelve-char-password",
});
const app = buildWebListener({
  db,
  content,
  sessionSecret: "e2e-session-secret",
  allowedOrigins: ["http://localhost:4173"],
  allowedHosts: ["127.0.0.1", "localhost"],
  lanOrigins: ["http://127.0.0.1:4173"],
  staticDirectory: resolve("apps/web-console/dist"),
});
await app.listen({ host: "127.0.0.1", port: 4173 });
process.once("SIGTERM", () => {
  void app.close().finally(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
