import { basename } from "node:path";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { ContentStore } from "@project-orchestrator/content-store";

const wildcard = (params: unknown): string =>
  String((params as { "*": string })["*"]);
const parsed = <T>(value: string): T => JSON.parse(value) as T;
const currentEnvelope = (
  db: Database.Database,
  content: ContentStore,
  kind: "workflow" | "role",
  id: string,
  publishedOnly = false,
): unknown => {
  const draftTable = kind === "workflow" ? "workflow_drafts" : "role_drafts";
  const parent = kind === "workflow" ? "workflow_template_id" : "role_id";
  const entityTable = kind === "workflow" ? "workflow_templates" : "roles";
  const versionTable =
    kind === "workflow" ? "workflow_versions" : "role_versions";
  const published = db
    .prepare(
      `SELECT e.updated_at,v.content_object_id,v.version_number FROM ${entityTable} e JOIN ${versionTable} v ON v.id=e.current_version_id WHERE e.id=?`,
    )
    .get(id) as
    | { updated_at: string; content_object_id: string; version_number: number }
    | undefined;
  const loadPublished = (): Record<string, unknown> | undefined =>
    published === undefined
      ? undefined
      : parsed<Record<string, unknown>>(
          Buffer.from(content.read(published.content_object_id)).toString(
            "utf8",
          ),
        );
  const draft = publishedOnly
    ? undefined
    : (db
        .prepare(
          `SELECT revision,draft_envelope,updated_at FROM ${draftTable} WHERE ${parent}=?`,
        )
        .get(id) as
        | { revision: number; draft_envelope: string; updated_at: string }
        | undefined);
  let envelope = draft
    ? parsed<Record<string, unknown>>(draft.draft_envelope)
    : loadPublished();
  if (envelope === undefined) return undefined;
  if (kind === "workflow" && published !== undefined) {
    const data =
      typeof envelope["data"] === "object" && envelope["data"] !== null
        ? (envelope["data"] as Record<string, unknown>)
        : undefined;
    const draftVersion = data?.["version"];
    if (
      draft !== undefined &&
      (typeof draftVersion !== "number" ||
        draftVersion <= published.version_number)
    ) {
      envelope = loadPublished() as Record<string, unknown>;
    }
    if (typeof envelope["data"] === "object" && envelope["data"] !== null) {
      (envelope["data"] as Record<string, unknown>)["version"] =
        Math.max(
          published.version_number,
          typeof draftVersion === "number" ? draftVersion - 1 : 0,
        ) + 1;
    }
  }
  return {
    entity_id: id,
    revision: draft?.revision ?? 0,
    envelope,
    updated_at: draft?.updated_at ?? published?.updated_at ?? "",
  };
};
const mapRun = (row: Record<string, unknown>) => ({
  ...row,
  active_stages: parsed<string[]>(String(row["active_stages"] ?? "[]")),
});

export function registerReadRoutes(
  app: FastifyInstance,
  db: Database.Database,
  content: ContentStore,
): void {
  app.get("/api/read/workflows", async () => {
    const rows = db
      .prepare(
        `SELECT t.id,t.slug,t.name,t.task_type,t.status,t.current_version_id,t.updated_at,
   v.version_number FROM workflow_templates t LEFT JOIN workflow_versions v ON v.id=t.current_version_id ORDER BY t.slug`,
      )
      .all() as Array<Record<string, unknown>>;
    // SQLite cannot read CAS files; count stages from the verified current envelope.
    return rows.map((row) => {
      let count = 0;
      if (row["current_version_id"]) {
        const object = db
          .prepare("SELECT content_object_id FROM workflow_versions WHERE id=?")
          .get(row["current_version_id"]) as { content_object_id: string };
        const envelope = parsed<{ data?: { stages?: unknown[] } }>(
          Buffer.from(content.read(object.content_object_id)).toString("utf8"),
        );
        count = Array.isArray(envelope.data?.stages)
          ? envelope.data.stages.length
          : 0;
      }
      return {
        ...row,
        stage_count: count,
        versions: db
          .prepare(
            "SELECT id,version_number,description,published_at FROM workflow_versions WHERE workflow_template_id=? ORDER BY version_number DESC",
          )
          .all(row["id"]),
      };
    });
  });
  app.get("/api/read/workflow-drafts/*", async (req, reply) => {
    const query = req.query as { source?: string };
    const result = currentEnvelope(
      db,
      content,
      "workflow",
      wildcard(req.params),
      query.source === "published",
    );
    return result ?? reply.code(404).send({ error: "workflow not found" });
  });
  app.get("/api/read/workflow-versions/*", async (req, reply) => {
    const row = db
      .prepare(
        "SELECT workflow_template_id,content_object_id,published_at FROM workflow_versions WHERE id=?",
      )
      .get(wildcard(req.params)) as
      | {
          workflow_template_id: string;
          content_object_id: string;
          published_at: string;
        }
      | undefined;
    if (!row) return reply.code(404).send({ error: "workflow version not found" });
    return {
      entity_id: row.workflow_template_id,
      revision: 0,
      envelope: parsed<unknown>(
        Buffer.from(content.read(row.content_object_id)).toString("utf8"),
      ),
      updated_at: row.published_at,
    };
  });
  app.get("/api/read/roles", async () => {
    const rows = db
      .prepare(
        `SELECT r.id,r.slug,r.name,r.status,r.current_version_id,r.updated_at,v.version_number,
   v.requested_capabilities,v.effective_capabilities,v.forbidden_capabilities FROM roles r LEFT JOIN role_versions v ON v.id=r.current_version_id ORDER BY r.slug`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...row,
      requested_capabilities: parsed(
        String(row["requested_capabilities"] ?? "[]"),
      ),
      effective_capabilities: parsed(
        String(row["effective_capabilities"] ?? "[]"),
      ),
      forbidden_capabilities: parsed(
        String(row["forbidden_capabilities"] ?? "[]"),
      ),
      versions: db
        .prepare(
          "SELECT id,version_number,published_at,status FROM role_versions WHERE role_id=? ORDER BY version_number DESC",
        )
        .all(row["id"]),
    }));
  });
  app.get("/api/read/role-drafts/*", async (req, reply) => {
    const query = req.query as { source?: string };
    const result = currentEnvelope(
      db,
      content,
      "role",
      wildcard(req.params),
      query.source === "published",
    );
    return result ?? reply.code(404).send({ error: "role not found" });
  });
  app.get("/api/read/role-versions/*", async (req, reply) => {
    const row = db
      .prepare(
        "SELECT role_id,content_object_id,published_at FROM role_versions WHERE id=?",
      )
      .get(wildcard(req.params)) as
      | { role_id: string; content_object_id: string; published_at: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: "role version not found" });
    return {
      entity_id: row.role_id,
      revision: 0,
      envelope: parsed<unknown>(
        Buffer.from(content.read(row.content_object_id)).toString("utf8"),
      ),
      updated_at: row.published_at,
    };
  });
  app.get("/api/read/runs", async (req) => {
    const query = req.query as Record<string, string | undefined>,
      clauses: string[] = [],
      params: unknown[] = [];
    for (const [key, column] of [
      ["project_id", "r.project_id"],
      ["origin_client_type", "r.origin_client_type"],
      ["status", "r.status"],
    ] as const) {
      if (query[key]) {
        clauses.push(`${column}=?`);
        params.push(query[key]);
      }
    }
    if (query["template"]) {
      clauses.push("(t.name LIKE ? OR t.slug LIKE ?)");
      params.push(`%${query["template"]}%`, `%${query["template"]}%`);
    }
    if (query["date"]) {
      clauses.push("date(r.updated_at)=date(?)");
      params.push(query["date"]);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT r.id,r.project_id,p.display_name AS project_name,r.objective,r.workflow_version_id,t.name AS workflow_name,r.origin_client_type,r.status,r.started_at,r.updated_at,r.completed_at,r.failure_code,r.failure_summary,r.is_retryable,COALESCE((SELECT json_group_array(stage_key) FROM stage_runs s WHERE s.run_id=r.id AND s.status IN ('ready','running','waiting_for_user')),json('[]')) AS active_stages FROM runs r JOIN projects p ON p.id=r.project_id JOIN workflow_versions wv ON wv.id=r.workflow_version_id JOIN workflow_templates t ON t.id=wv.workflow_template_id ${where} ORDER BY r.updated_at DESC LIMIT 500`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapRun);
  });
  app.get("/api/read/runs/*", async (req, reply) => {
    const id = wildcard(req.params);
    const row = db
      .prepare(
        `SELECT r.id,r.project_id,p.display_name AS project_name,r.objective,r.workflow_version_id,t.name AS workflow_name,r.origin_client_type,r.status,r.started_at,r.updated_at,r.completed_at,r.failure_code,r.failure_summary,r.is_retryable,COALESCE((SELECT json_group_array(stage_key) FROM stage_runs s WHERE s.run_id=r.id AND s.status IN ('ready','running','waiting_for_user')),json('[]')) AS active_stages FROM runs r JOIN projects p ON p.id=r.project_id JOIN workflow_versions wv ON wv.id=r.workflow_version_id JOIN workflow_templates t ON t.id=wv.workflow_template_id WHERE r.id=?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: "run not found" });
    const attempts = db
      .prepare(
        "SELECT a.* FROM stage_attempts a JOIN stage_runs s ON s.id=a.stage_run_id WHERE s.run_id=? ORDER BY s.stage_key,a.attempt_number",
      )
      .all(id) as Array<Record<string, unknown>>;
    const attemptsWithFiles = attempts.map((attempt) => {
      const objectId = attempt["changed_files_object_id"];
      if (typeof objectId !== "string") return attempt;
      try {
        return {
          ...attempt,
          changed_files: parsed<unknown>(
            Buffer.from(content.read(objectId)).toString("utf8"),
          ),
        };
      } catch {
        return { ...attempt, changed_files_error: "manifest unavailable" };
      }
    });
    return {
      ...mapRun(row),
      snapshot:
        db.prepare("SELECT * FROM run_snapshots WHERE run_id=?").get(id) ??
        null,
      stages: db
        .prepare(
          "SELECT * FROM stage_runs WHERE run_id=? ORDER BY iteration_number,stage_key",
        )
        .all(id),
      attempts: attemptsWithFiles,
      iterations: db
        .prepare(
          "SELECT * FROM run_iterations WHERE run_id=? ORDER BY group_key,iteration_number",
        )
        .all(id),
      artifacts: db
        .prepare(
          "SELECT id,run_id,artifact_type,source_path,summary,created_at FROM artifacts WHERE run_id=? ORDER BY created_at",
        )
        .all(id),
      confirmations: db
        .prepare(
          "SELECT id,run_id,stage_run_id,confirmation_type,request_summary,status,requested_at,expires_at,decided_at,consumed_at FROM confirmation_requests WHERE run_id=? ORDER BY requested_at",
        )
        .all(id),
      side_effects: db
        .prepare(
          "SELECT id,run_id,stage_attempt_id,action_type,target_fingerprint,status,external_reference,created_at,started_at,completed_at FROM side_effect_operations WHERE run_id=? ORDER BY created_at",
        )
        .all(id),
      memories: db
        .prepare(
          "SELECT id,project_id,source_run_id,memory_type,scope,title,summary,retention_policy,created_at FROM memories WHERE source_run_id=? ORDER BY created_at",
        )
        .all(id),
      events: db
        .prepare(
          "SELECT id,run_id,stage_run_id,sequence_number,event_type,payload_envelope,created_at FROM events WHERE run_id=? ORDER BY sequence_number",
        )
        .all(id),
    };
  });
  app.get("/api/read/events/*", async (req) => {
    const query = req.query as { after?: string };
    const after = Number(query.after ?? 0);
    return db
      .prepare(
        "SELECT id,run_id,stage_run_id,sequence_number,event_type,payload_envelope,created_at FROM events WHERE run_id=? AND sequence_number>? ORDER BY sequence_number",
      )
      .all(
        wildcard(req.params),
        Number.isSafeInteger(after) && after >= 0 ? after : 0,
      );
  });
  app.get("/api/read/artifacts", async (req) =>
    db
      .prepare(
        "SELECT id,run_id,artifact_type,source_path,summary,created_at FROM artifacts WHERE run_id=? ORDER BY created_at",
      )
      .all((req.query as { run_id?: string }).run_id ?? ""),
  );
  app.get("/api/read/artifact-content/*", async (req, reply) => {
    const row = db
      .prepare("SELECT content_object_id,source_path FROM artifacts WHERE id=?")
      .get(wildcard(req.params)) as
      | { content_object_id: string; source_path: string | null }
      | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });
    const filename = basename(row.source_path ?? "artifact").replaceAll(
      /[^A-Za-z0-9._-]/g,
      "_",
    );
    reply
      .header(
        "Content-Disposition",
        `attachment; filename="${filename || "artifact"}"`,
      )
      .header("X-Content-Type-Options", "nosniff")
      .type("application/octet-stream");
    return Buffer.from(content.read(row.content_object_id));
  });
  app.get("/api/read/memories", async (req) => {
    const project = (req.query as { project_id?: string }).project_id;
    return project
      ? db
          .prepare(
            "SELECT m.id,m.project_id,p.display_name AS project_name,m.source_run_id,m.memory_type,m.scope,m.title,m.summary,m.retention_policy,m.created_at FROM memories m JOIN projects p ON p.id=m.project_id WHERE m.project_id=? ORDER BY m.created_at DESC",
          )
          .all(project)
      : db
          .prepare(
            "SELECT m.id,m.project_id,p.display_name AS project_name,m.source_run_id,m.memory_type,m.scope,m.title,m.summary,m.retention_policy,m.created_at FROM memories m JOIN projects p ON p.id=m.project_id ORDER BY m.created_at DESC",
          )
          .all();
  });
  app.get(
    "/api/read/memories/*",
    async (req) =>
      db
        .prepare(
          "SELECT id,project_id,source_run_id,memory_type,scope,title,summary,retention_policy,created_at FROM memories WHERE id=?",
        )
        .get(wildcard(req.params)) ?? null,
  );
  app.get("/api/read/system/diagnostics", async () => {
    const database =
      (db.pragma("database_list") as Array<{ file: string }>)[0]?.file ?? "";
    let casStatus = "verified",
      checkedObjects = 0,
      checkedBytes = 0;
    try {
      const objects = db
        .prepare(
          "SELECT id,size_bytes FROM content_objects ORDER BY created_at DESC LIMIT 33",
        )
        .all() as Array<{ id: string; size_bytes: number }>;
      for (const row of objects.slice(0, 32)) {
        if (checkedBytes + row.size_bytes > 2 * 1024 * 1024) {
          casStatus = "sampled";
          break;
        }
        content.verify(row.id);
        checkedObjects += 1;
        checkedBytes += row.size_bytes;
      }
      if (objects.length > checkedObjects) casStatus = "sampled";
    } catch {
      casStatus = "degraded";
    }
    const counts = Object.fromEntries(
      (
        db
          .prepare("SELECT status,count(*) AS count FROM runs GROUP BY status")
          .all() as Array<{ status: string; count: number }>
      ).map((row) => [row.status, row.count]),
    );
    const adapters = (
      db
        .prepare(
          "SELECT id,client_type,adapter_version,status,last_seen_at,capability_object_id FROM client_installations ORDER BY client_type,id",
        )
        .all() as Array<Record<string, unknown>>
    ).map((adapter) => {
      try {
        return {
          ...adapter,
          capability_manifest: parsed<unknown>(
            Buffer.from(
              content.read(String(adapter["capability_object_id"])),
            ).toString("utf8"),
          ),
        };
      } catch {
        return { ...adapter, capability_manifest: null };
      }
    });
    return {
      status: casStatus === "degraded" ? "degraded" : "ok",
      version: "0.0.0",
      database_path: database,
      cas_status: casStatus,
      cas_checked_objects: checkedObjects,
      cas_checked_bytes: checkedBytes,
      content_objects: (
        db.prepare("SELECT count(*) AS count FROM content_objects").get() as {
          count: number;
        }
      ).count,
      last_backup_at: null,
      web_listener: "127.0.0.1 · listening",
      control_socket: "Unix socket · listening",
      adapters,
      run_counts: counts,
    };
  });
  app.get("/api/read/system/*", async () => ({ status: "ok" }));
}
