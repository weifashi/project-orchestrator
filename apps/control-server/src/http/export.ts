import type Database from "better-sqlite3";
import type { ContentStore } from "@project-orchestrator/content-store";

type Row = Record<string, unknown>;
type ExportFormat = "json" | "markdown";
export type ExportLocale = "zh-CN" | "en";

export type ExportEnvelope<T> = Readonly<{
  schema_id: string;
  schema_version: 1;
  exported_at: string;
  data: T;
}>;

const rows = (db: Database.Database, sql: string, ...parameters: unknown[]): Row[] =>
  db.prepare(sql).all(...parameters) as Row[];
const row = (db: Database.Database, sql: string, ...parameters: unknown[]): Row | undefined =>
  db.prepare(sql).get(...parameters) as Row | undefined;
const json = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) as unknown : value;
const contentJson = (content: ContentStore, objectId: unknown): unknown =>
  json(Buffer.from(content.read(String(objectId))).toString("utf8"));
const optionalContentJson = (content: ContentStore, objectId: unknown): unknown | null =>
  typeof objectId === "string" ? contentJson(content, objectId) : null;
/** 读一个 CAS 对象；缺失或损坏时返回错误标记而不是抛出，避免一个坏对象让整份导出 500。 */
const safeContentJson = (content: ContentStore, objectId: unknown): { value: unknown; error?: string } => {
  try { return { value: optionalContentJson(content, objectId) }; }
  catch { return { value: null, error: "content unavailable" }; }
};
const withContent = (base: Row, field: string, read: { value: unknown; error?: string }): Row =>
  read.error === undefined ? { ...base, [field]: read.value } : { ...base, [field]: null, [`${field}_error`]: read.error };

function memoryRows(db: Database.Database, content: ContentStore, projectId?: string, sourceRunId?: string): Row[] {
  const filters: string[] = [], parameters: string[] = [];
  if (projectId !== undefined) { filters.push("m.project_id=?"); parameters.push(projectId); }
  if (sourceRunId !== undefined) { filters.push("m.source_run_id=?"); parameters.push(sourceRunId); }
  const filter = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  return rows(db, `SELECT m.id,m.project_id,p.display_name AS project_name,m.source_run_id,m.memory_type,m.scope,
    m.title,m.summary,m.retention_policy,m.created_at,m.content_object_id,
    o.sha256,o.media_type,o.size_bytes
    FROM memories m JOIN projects p ON p.id=m.project_id
    JOIN content_objects o ON o.id=m.content_object_id
    ${filter} ORDER BY m.created_at,m.id`, ...parameters)
    .map((memory) => ({
      id: memory["id"], project_id: memory["project_id"], project_name: memory["project_name"],
      source_run_id: memory["source_run_id"], memory_type: memory["memory_type"], scope: memory["scope"],
      title: memory["title"], summary: memory["summary"], retention_policy: memory["retention_policy"],
      created_at: memory["created_at"], content_object_id: memory["content_object_id"],
      sha256: memory["sha256"], media_type: memory["media_type"], size_bytes: memory["size_bytes"],
    }))
    .map((memory) => withContent(memory, "content",
      safeContentJson(content, memory["content_object_id"])));
}

export function buildRunExport(
  db: Database.Database,
  content: ContentStore,
  runId: string,
  exportedAt = new Date().toISOString(),
): ExportEnvelope<Row> {
  const run = row(db, `SELECT r.id,r.project_id,p.display_name AS project_name,r.workflow_version_id,
    t.slug AS workflow_slug,t.name AS workflow_name,wv.version_number AS workflow_version,
    r.objective,r.origin_client_type,r.status,r.started_at,r.updated_at,r.completed_at,
    r.failure_code,r.failure_summary,r.is_retryable
    FROM runs r JOIN projects p ON p.id=r.project_id
    JOIN workflow_versions wv ON wv.id=r.workflow_version_id
    JOIN workflow_templates t ON t.id=wv.workflow_template_id WHERE r.id=?`, runId);
  if (run === undefined) throw new Error("NOT_FOUND: run");
  const snapshot = row(db, `SELECT rs.workflow_object_id,rs.repository_head,rs.working_tree_fingerprint,rs.created_at,
    o.sha256 AS workflow_sha256,o.media_type AS workflow_media_type,o.size_bytes AS workflow_size_bytes
    FROM run_snapshots rs JOIN content_objects o ON o.id=rs.workflow_object_id WHERE rs.run_id=?`, runId);
  if (snapshot === undefined) throw new Error("NOT_FOUND: run snapshot");

  const stages = rows(db, `SELECT s.id,s.stage_key,s.iteration_group_key,s.iteration_number,s.role_version_id,
    r.slug AS role_slug,r.name AS role_name,s.status,s.latest_attempt_id,s.max_attempts,s.created_at,s.updated_at,s.completed_at
    FROM stage_runs s JOIN role_versions rv ON rv.id=s.role_version_id JOIN roles r ON r.id=rv.role_id
    WHERE s.run_id=? ORDER BY s.iteration_number,s.stage_key,s.id`, runId);
  const attempts = rows(db, `SELECT a.id,a.stage_run_id,s.stage_key,a.attempt_number,a.status,a.output_envelope,
    a.artifact_manifest_object_id,a.evidence_manifest_object_id,a.changed_files_object_id,
    a.started_at,a.completed_at,a.failure_code,a.failure_summary
    FROM stage_attempts a JOIN stage_runs s ON s.id=a.stage_run_id
    WHERE s.run_id=? ORDER BY s.iteration_number,s.stage_key,a.attempt_number`, runId)
    .map((attempt) => ({
      id: attempt["id"], stage_run_id: attempt["stage_run_id"], stage_key: attempt["stage_key"],
      attempt_number: attempt["attempt_number"], status: attempt["status"],
      output: attempt["output_envelope"] === null ? null : json(attempt["output_envelope"]),
      artifact_manifest: optionalContentJson(content, attempt["artifact_manifest_object_id"]),
      evidence_manifest: optionalContentJson(content, attempt["evidence_manifest_object_id"]),
      changed_files: optionalContentJson(content, attempt["changed_files_object_id"]),
      started_at: attempt["started_at"], completed_at: attempt["completed_at"],
      failure_code: attempt["failure_code"], failure_summary: attempt["failure_summary"],
    }));
  const iterations = rows(db, `SELECT id,group_key,iteration_number,status,findings_manifest_object_id,created_at,completed_at
    FROM run_iterations WHERE run_id=? ORDER BY group_key,iteration_number`, runId)
    .map((iteration) => ({
      id: iteration["id"], group_key: iteration["group_key"], iteration_number: iteration["iteration_number"],
      status: iteration["status"],
      created_at: iteration["created_at"], completed_at: iteration["completed_at"],
      findings_manifest_object_id: iteration["findings_manifest_object_id"],
    }))
    .map((iteration) => withContent(iteration, "findings",
      safeContentJson(content, iteration["findings_manifest_object_id"])));
  const artifacts = rows(db, `SELECT a.id,a.stage_attempt_id,a.artifact_type,a.content_object_id,a.source_path,
    a.summary,a.producer_role_version_id,a.created_at,o.sha256,o.media_type,o.size_bytes
    FROM artifacts a JOIN content_objects o ON o.id=a.content_object_id
    WHERE a.run_id=? ORDER BY a.created_at,a.id`, runId).map((artifact) => {
      try { content.verify(String(artifact["content_object_id"])); return artifact; }
      catch { return { ...artifact, content_error: "content unavailable" }; }
    });
  const confirmations = rows(db, `SELECT id,stage_run_id,stage_attempt_id,confirmation_type,request_summary,status,
    requested_at,expires_at,decided_at,consumed_at FROM confirmation_requests WHERE run_id=? ORDER BY requested_at,id`, runId);
  const sideEffects = rows(db, `SELECT id,stage_attempt_id,action_type,target_fingerprint,status,external_reference,
    created_at,started_at,completed_at FROM side_effect_operations WHERE run_id=? ORDER BY created_at,id`, runId);
  const events = rows(db, `SELECT e.id,e.stage_run_id,s.stage_key,e.sequence_number,e.event_type,e.created_at
    FROM events e LEFT JOIN stage_runs s ON s.id=e.stage_run_id WHERE e.run_id=? ORDER BY e.sequence_number`, runId);

  return Object.freeze({
    schema_id: "project-orchestrator/run-export",
    schema_version: 1,
    exported_at: exportedAt,
    data: {
      run,
      snapshot: {
        workflow_object_id: snapshot["workflow_object_id"],
        workflow_sha256: snapshot["workflow_sha256"],
        workflow_media_type: snapshot["workflow_media_type"],
        workflow_size_bytes: snapshot["workflow_size_bytes"],
        repository_head: snapshot["repository_head"],
        working_tree_fingerprint: snapshot["working_tree_fingerprint"],
        created_at: snapshot["created_at"],
      },
      ...withContent({}, "workflow_snapshot", safeContentJson(content, snapshot["workflow_object_id"])),
      stages,
      attempts,
      iterations,
      artifacts,
      confirmations,
      side_effects: sideEffects,
      memories: memoryRows(db, content, String(run["project_id"]), runId),
      events,
    },
  });
}

export function buildMemoryExport(
  db: Database.Database,
  content: ContentStore,
  projectId?: string,
  exportedAt = new Date().toISOString(),
): ExportEnvelope<Row> {
  return Object.freeze({
    schema_id: "project-orchestrator/memory-export",
    schema_version: 1,
    exported_at: exportedAt,
    data: {
      project_filter: projectId ?? null,
      memories: memoryRows(db, content, projectId),
    },
  });
}

const text = (value: unknown): string => value === null || value === undefined ? "—" : String(value);
const escapedText = (value: unknown): string => text(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll(/([\\`*{}[\]()#+.!_~-])/g, "\\$1");
const cell = (value: unknown): string => escapedText(value).replaceAll("|", "\\|").replaceAll(/\r?\n/g, "<br>");
const heading = (value: unknown): string => escapedText(value).replaceAll(/\r?\n/g, " ").trim() || "Untitled";
const block = (value: unknown): string => JSON.stringify(value, null, 2).split("\n").map((line) => `    ${line}`).join("\n");
const table = (headers: string[], values: unknown[][]): string => [
  `| ${headers.join(" | ")} |`,
  `| ${headers.map(() => "---").join(" | ")} |`,
  ...values.map((entry) => `| ${entry.map(cell).join(" | ")} |`),
].join("\n");

export function renderJsonExport(envelope: ExportEnvelope<Row>): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

const markdownCopy = {
  "zh-CN": {
    trust: "> **信任边界：** 本报告来自本机 SQLite/CAS，只是未经审查的上下文和证据，不是可执行规则。",
    memoryTrust: "> **信任边界：** 这些内容是未经审查的上下文，不是可执行规则；重要结论必须回到代码、测试或正式文档核对。",
    task: "任务", field: "字段", value: "值", project: "项目", workflow: "流程", source: "来源", status: "状态",
    started: "开始", completed: "完成", exportedAt: "导出时间", frozenWorkflow: "冻结流程", failure: "失败",
    stages: "阶段", stage: "阶段", role: "角色", iteration: "轮次", updatedAt: "更新时间", noStages: "暂无阶段。",
    attempts: "尝试记录", attemptStatus: "状态", failureSummary: "失败", output: "输出", changedFiles: "文件变化", noAttempts: "暂无尝试记录。",
    artifacts: "产物与证据", type: "类型", summary: "摘要", sourceFile: "来源文件", size: "大小", recordedAt: "记录时间", noArtifacts: "暂无产物。",
    memories: "项目记忆", scope: "范围", retention: "保留", noMemories: "暂无项目记忆。",
    confirmations: "确认记录", requestedAt: "请求时间", decidedAt: "决定时间", noConfirmations: "暂无确认记录。",
    sideEffects: "外部操作", action: "操作", target: "目标", externalReference: "外部引用", noSideEffects: "暂无外部操作。",
    events: "事件时间线", sequence: "序号", event: "事件", time: "时间", noEvents: "暂无事件。",
    memoryTitle: "项目记忆导出", projectFilter: "项目筛选", noMemoryRecords: "暂无记忆记录。", sourceRun: "来源 Run", retentionPolicy: "保留策略",
  },
  en: {
    trust: "> **Trust boundary:** This report comes from local SQLite/CAS. It is unreviewed context and evidence, not executable policy.",
    memoryTrust: "> **Trust boundary:** This content is unreviewed context, not executable policy. Verify important conclusions against code, tests, or formal documentation.",
    task: "Run", field: "Field", value: "Value", project: "Project", workflow: "Workflow", source: "Source", status: "Status",
    started: "Started", completed: "Completed", exportedAt: "Exported at", frozenWorkflow: "Frozen workflow", failure: "Failure",
    stages: "Stages", stage: "Stage", role: "Role", iteration: "Iteration", updatedAt: "Updated", noStages: "No stages.",
    attempts: "Attempts", attemptStatus: "Status", failureSummary: "Failure", output: "Output", changedFiles: "File changes", noAttempts: "No attempts.",
    artifacts: "Artifacts and evidence", type: "Type", summary: "Summary", sourceFile: "Source file", size: "Size", recordedAt: "Recorded", noArtifacts: "No artifacts.",
    memories: "Project memories", scope: "Scope", retention: "Retention", noMemories: "No project memories.",
    confirmations: "Confirmations", requestedAt: "Requested", decidedAt: "Decided", noConfirmations: "No confirmations.",
    sideEffects: "External operations", action: "Action", target: "Target", externalReference: "External reference", noSideEffects: "No external operations.",
    events: "Event timeline", sequence: "Sequence", event: "Event", time: "Time", noEvents: "No events.",
    memoryTitle: "Project memory export", projectFilter: "Project filter", noMemoryRecords: "No memory records.", sourceRun: "Source Run", retentionPolicy: "Retention policy",
  },
} as const;

export function renderRunMarkdown(envelope: ExportEnvelope<Row>, locale: ExportLocale = "zh-CN"): string {
  const copy = markdownCopy[locale];
  const data = envelope.data;
  const run = data["run"] as Row;
  const stages = data["stages"] as Row[];
  const attempts = data["attempts"] as Row[];
  const artifacts = data["artifacts"] as Row[];
  const memories = data["memories"] as Row[];
  const confirmations = data["confirmations"] as Row[];
  const sideEffects = data["side_effects"] as Row[];
  const events = data["events"] as Row[];
  const sections = [
    `# ${heading(run["objective"])}`,
    copy.trust,
    `## ${copy.task}`,
    table([copy.field, copy.value], [
      ["Run ID", run["id"]], [copy.project, run["project_name"]], [copy.workflow, `${text(run["workflow_name"])} v${text(run["workflow_version"])}`],
      [copy.source, run["origin_client_type"]], [copy.status, run["status"]], [copy.started, run["started_at"]],
      [copy.completed, run["completed_at"]], [copy.exportedAt, envelope.exported_at],
    ]),
    `## ${copy.frozenWorkflow}`,
    block(data["workflow_snapshot"]),
    `## ${copy.stages}`,
    stages.length ? table([copy.stage, copy.role, copy.status, copy.iteration, copy.updatedAt], stages.map((stage) => [
      stage["stage_key"], stage["role_name"], stage["status"], stage["iteration_number"], stage["updated_at"],
    ])) : copy.noStages,
    `## ${copy.attempts}`,
    attempts.length ? attempts.map((attempt) => [
      `### ${heading(attempt["stage_key"])} · #${text(attempt["attempt_number"])}`,
      table([copy.attemptStatus, copy.started, copy.completed, copy.failureSummary], [[attempt["status"], attempt["started_at"], attempt["completed_at"], attempt["failure_summary"]]]),
      attempt["output"] === null ? "" : `\n${copy.output}:\n\n${block(attempt["output"])}`,
      attempt["changed_files"] === null ? "" : `\n${copy.changedFiles}:\n\n${block(attempt["changed_files"])}`,
    ].filter(Boolean).join("\n\n")).join("\n\n") : copy.noAttempts,
    `## ${copy.artifacts}`,
    artifacts.length ? table([copy.type, copy.summary, copy.sourceFile, "SHA-256", copy.size, copy.recordedAt], artifacts.map((artifact) => [
      artifact["artifact_type"], artifact["summary"], artifact["source_path"], artifact["sha256"], artifact["size_bytes"], artifact["created_at"],
    ])) : copy.noArtifacts,
    `## ${copy.memories}`,
    memories.length ? memories.map((memory) => [
      `### ${heading(memory["title"])}`,
      escapedText(memory["summary"]),
      `\n${copy.type}: ${escapedText(memory["memory_type"])} · ${copy.scope}: ${escapedText(memory["scope"])} · ${copy.retention}: ${escapedText(memory["retention_policy"])}`,
      `\n${block(memory["content"])}`,
    ].join("\n")).join("\n\n") : copy.noMemories,
    `## ${copy.confirmations}`,
    confirmations.length ? table([copy.type, copy.summary, copy.status, copy.requestedAt, copy.decidedAt], confirmations.map((confirmation) => [
      confirmation["confirmation_type"], confirmation["request_summary"], confirmation["status"], confirmation["requested_at"], confirmation["decided_at"],
    ])) : copy.noConfirmations,
    `## ${copy.sideEffects}`,
    sideEffects.length ? table([copy.action, copy.target, copy.status, copy.externalReference, copy.completed], sideEffects.map((effect) => [
      effect["action_type"], effect["target_fingerprint"], effect["status"], effect["external_reference"], effect["completed_at"],
    ])) : copy.noSideEffects,
    `## ${copy.events}`,
    events.length ? table([copy.sequence, copy.event, copy.stage, copy.time], events.map((event) => [
      event["sequence_number"], event["event_type"], event["stage_key"], event["created_at"],
    ])) : copy.noEvents,
  ];
  if (run["failure_code"] !== null) sections.splice(4, 0, `## ${copy.failure}`, `${escapedText(run["failure_code"])} · ${escapedText(run["failure_summary"])}`);
  return `${sections.join("\n\n")}\n`;
}

export function renderMemoryMarkdown(envelope: ExportEnvelope<Row>, locale: ExportLocale = "zh-CN"): string {
  const copy = markdownCopy[locale];
  const memories = envelope.data["memories"] as Row[];
  const projectFilter = envelope.data["project_filter"];
  return `${[
    `# ${copy.memoryTitle}`,
    copy.memoryTrust,
    `${copy.projectFilter}: ${escapedText(projectFilter)}  `,
    `${copy.exportedAt}: ${envelope.exported_at}`,
    ...(memories.length ? memories.map((memory) => [
      `## ${heading(memory["title"])}`,
      escapedText(memory["summary"]),
      table([copy.project, copy.type, copy.scope, copy.sourceRun, copy.retentionPolicy, copy.recordedAt], [[
        memory["project_name"], memory["memory_type"], memory["scope"], memory["source_run_id"], memory["retention_policy"], memory["created_at"],
      ]]),
      block(memory["content"]),
    ].join("\n\n")) : [copy.noMemoryRecords]),
  ].join("\n\n")}\n`;
}

export function parseExportFormat(value: unknown): ExportFormat {
  if (value === undefined || value === "json") return "json";
  if (value === "markdown") return "markdown";
  throw new Error("EXPORT_FORMAT_INVALID");
}

export function parseExportLocale(value: unknown): ExportLocale {
  if (value === undefined || value === "zh" || value === "zh-CN") return "zh-CN";
  if (value === "en") return "en";
  throw new Error("EXPORT_LOCALE_INVALID");
}

export function safeExportFilename(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "-").replaceAll(/-+/g, "-").slice(0, 80) || "export";
}
