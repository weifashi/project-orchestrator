import type { ApiClient } from "../src/api/client";
import type {
  RoleDraft,
  RunDetail,
  SystemDiagnostics,
  WorkflowDraft,
} from "../src/api/types";
export const workflowDraft: WorkflowDraft = {
  entity_id: "workflow-1",
  revision: 2,
  updated_at: "2026-08-20T00:00:00Z",
  envelope: {
    schema_id: "project-orchestrator/workflow-version",
    schema_version: 1,
    data: {
      slug: "feature-development",
      version: 2,
      stages: [
        {
          key: "implementation",
          role_version_id: "role-implementation-v1",
          optional: false,
          mandatory_gate: false,
          failure_policy: "fail",
          max_attempts: 1,
          requires_confirmation: false,
        },
        {
          key: "testing",
          role_version_id: "role-testing-v1",
          optional: false,
          mandatory_gate: true,
          failure_policy: "retry_then_fail",
          max_attempts: 2,
          requires_confirmation: false,
        },
      ],
      edges: [{ from: "implementation", to: "testing", edge_type: "requires" }],
      iteration_groups: [],
    },
  },
};
const generic = {
  schema_id: "project-orchestrator/generic",
  schema_version: 1,
  data: { type: "object" },
};
export const roleDraft: RoleDraft = {
  entity_id: "role-1",
  revision: 1,
  updated_at: "2026-08-20T00:00:00Z",
  envelope: {
    schema_id: "project-orchestrator/role-version",
    schema_version: 1,
    data: {
      slug: "testing",
      display_name: "Testing",
      responsibilities: ["Verify behavior"],
      requested_capabilities: ["read-workspace"],
      forbidden_capabilities: ["production-shell"],
      input_schema: generic,
      output_schema: generic,
      completion_contract: {
        schema_id: "project-orchestrator/completion",
        schema_version: 1,
        data: {
          required_evidence: [{ artifact_type: "test_evidence", min_count: 1 }],
        },
      },
      body_markdown: "# Testing",
    },
  },
};
export const runDetail: RunDetail = {
  id: "run-1",
  project_id: "project-1",
  project_name: "Console",
  objective: "Implement safe console",
  workflow_version_id: "workflow-v1",
  workflow_name: "Feature Development",
  origin_client_type: "codex",
  status: "waiting_for_user",
  active_stages: ["testing", "security"],
  started_at: "2026-08-20T00:00:00Z",
  updated_at: "2026-08-20T00:02:00Z",
  completed_at: null,
  failure_code: null,
  failure_summary: null,
  is_retryable: 0,
  snapshot: { workflow_object_id: "object-1" },
  stages: [
    {
      id: "stage-testing",
      stage_key: "testing",
      iteration_number: 0,
      role_version_id: "role-v1",
      status: "running",
    },
  ],
  attempts: [
    {
      id: "attempt-1",
      attempt_number: 1,
      status: "running",
      started_at: "2026-08-20T00:01:00Z",
      changed_files_object_id: "files-1",
    },
  ],
  iterations: [],
  artifacts: [
    {
      id: "artifact-1",
      run_id: "run-1",
      artifact_type: "test_evidence",
      source_path: "report.html",
      summary: "42 tests passed",
      created_at: "2026-08-20T00:02:00Z",
    },
  ],
  confirmations: [{ id: "confirm-1", status: "pending" }],
  side_effects: [{ id: "op-1", status: "unknown" }],
  memories: [],
  events: [
    {
      id: "event-1",
      run_id: "run-1",
      stage_run_id: null,
      sequence_number: 1,
      event_type: "run_created",
      payload_envelope: { objective: "safe" },
      created_at: "2026-08-20T00:00:00Z",
    },
  ],
};
export const system: SystemDiagnostics = {
  status: "ok",
  version: "0.0.0",
  database_path: "/tmp/orchestrator.sqlite",
  cas_status: "verified",
  content_objects: 4,
  last_backup_at: null,
  web_listener: "127.0.0.1 · listening",
  control_socket: "Unix socket · listening",
  adapters: [],
  run_counts: { running: 1 },
};
export function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    workflows: {
      list: async () => [],
      getDraft: async () => workflowDraft,
      getVersion: async () => workflowDraft,
      saveDraft: async (_id, d) => ({
        ...workflowDraft,
        ...d,
        revision: d.revision + 1,
      }),
      publish: async () => ({}),
    },
    roles: {
      list: async () => [],
      create: async () => ({ roleId: "role-new", slug: "new-role" }),
      remove: async () => ({ removed: true }),
      restore: async () => ({ restored: true }),
      resetBuiltin: async () => ({ versionNumber: 2 }),
      getDraft: async () => roleDraft,
      saveDraft: async (_id, d) => ({
        ...roleDraft,
        ...d,
        revision: d.revision + 1,
      }),
      publish: async () => ({}),
    },
    runs: {
      list: async () => [],
      get: async () => runDetail,
      exportUrl: (id, format, lang) => `/api/read/run-exports/${encodeURIComponent(id)}?format=${format}&lang=${lang}`,
    },
    events: { list: async () => [] },
    artifacts: {
      list: async () => [],
      downloadUrl: (id) => `/api/read/artifact-content/${id}`,
    },
    memories: {
      list: async () => [],
      exportUrl: (projectId, format, lang) => {
        const query = new URLSearchParams({ format, lang });
        if (projectId) query.set("project_id", projectId);
        return `/api/read/memory-exports?${query}`;
      },
    },
    system: { diagnostics: async () => system },
    ...overrides,
  } as ApiClient;
}
