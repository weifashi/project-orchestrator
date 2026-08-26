import type {
  RoleVersionEnvelope,
  WorkflowVersionEnvelope,
} from "@project-orchestrator/contracts";
export type WorkflowDraft = {
  entity_id: string;
  revision: number;
  envelope: WorkflowVersionEnvelope;
  updated_at: string;
};
export type WorkflowSummary = {
  id: string;
  slug: string;
  name: string;
  task_type: "new_project" | "feature" | "bugfix";
  status: "active" | "disabled" | "archived";
  current_version_id: string | null;
  version_number: number | null;
  stage_count: number;
  updated_at: string;
  versions?: Array<{
    id: string;
    version_number: number;
    description: string;
    published_at: string;
  }>;
};
export type RoleDraft = {
  entity_id: string;
  revision: number;
  envelope: RoleVersionEnvelope;
  updated_at: string;
};
export type RoleSummary = {
  id: string;
  slug: string;
  name: string;
  status: "active" | "disabled" | "archived";
  current_version_id: string | null;
  version_number: number | null;
  updated_at: string;
  removed_at?: string | null;
  is_builtin?: boolean;
  requested_capabilities?: string[];
  effective_capabilities?: string[];
  forbidden_capabilities?: string[];
  versions?: Array<{
    id: string;
    version_number: number;
    published_at: string;
    status: string;
  }>;
};
export type RunSummary = {
  id: string;
  project_id: string;
  project_name?: string;
  objective: string;
  workflow_version_id: string;
  workflow_name?: string;
  origin_client_type: "codex" | "claude";
  status: string;
  active_stages: string[];
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
  failure_code: string | null;
  failure_summary: string | null;
  is_retryable: number;
};
export type RunEvent = {
  id: string;
  run_id: string;
  stage_run_id: string | null;
  sequence_number: number;
  event_type: string;
  payload_envelope: string | Record<string, unknown>;
  created_at: string;
};
export type ArtifactSummary = {
  id: string;
  run_id: string;
  artifact_type: string;
  source_path: string | null;
  summary: string;
  created_at: string;
};
export type MemorySummary = {
  id: string;
  project_id: string;
  project_name?: string;
  source_run_id: string;
  memory_type: string;
  scope: string;
  title: string;
  summary: string;
  retention_policy: string;
  created_at: string;
};
export type RunDetail = RunSummary & {
  snapshot: Record<string, unknown> | null;
  stages: Array<Record<string, unknown>>;
  attempts: Array<Record<string, unknown>>;
  iterations: Array<Record<string, unknown>>;
  artifacts: ArtifactSummary[];
  confirmations: Array<Record<string, unknown>>;
  side_effects: Array<Record<string, unknown>>;
  memories: MemorySummary[];
  events: RunEvent[];
};
export type SystemDiagnostics = {
  status: "ok" | "degraded";
  version: string;
  database_path: string;
  cas_status: string;
  content_objects: number;
  last_backup_at: string | null;
  web_listener: string;
  control_socket: string;
  adapters: Array<{
    id: string;
    client_type: string;
    adapter_version: string;
    status: string;
    last_seen_at: string;
    capability_manifest?: unknown;
  }>;
  run_counts: Record<string, number>;
};
