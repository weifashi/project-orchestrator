import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { SucceededStageOutputEnvelopeSchema } from './run.js';

export const AgentToolNames = [
  'create_run', 'claim_run', 'heartbeat_run', 'begin_stage', 'complete_stage',
  'fail_stage', 'retry_stage', 'skip_stage', 'request_confirmation',
  'record_artifact', 'record_workspace_checkpoint', 'record_memory',
  'append_agent_note', 'prepare_side_effect', 'execute_side_effect',
  'reconcile_side_effect', 'pause_run', 'cancel_run', 'finalize_run',
] as const;
export type AgentToolName = typeof AgentToolNames[number];

export type VisibleWriteContext = Readonly<{ run_id: string; request_id: string }>;

export const MEMORY_TYPES = ['decision', 'rule', 'fact', 'lesson', 'delivery_evidence'] as const;
export const MEMORY_SCOPES = ['project', 'run'] as const;
export const MEMORY_RETENTION_POLICIES = ['keep', 'review', 'expire_after_run'] as const;
export type MemoryType = typeof MEMORY_TYPES[number];
export type MemoryScope = typeof MEMORY_SCOPES[number];
export type MemoryRetentionPolicy = typeof MEMORY_RETENTION_POLICIES[number];

const Id = () => Type.String({ minLength: 1 });
const Request = () => ({ request_id: Id() });
const RunRequest = () => ({ ...Request(), run_id: Id() });
const StageRequest = () => ({ ...RunRequest(), stage_run_id: Id() });
const closed = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });

export const WorkspaceStateSchema = closed({
  repository_head: Type.String(),
  staged_patch: Type.String(),
  unstaged_patch: Type.String(),
  untracked_manifest: Type.Unknown(),
  submodule_manifest: Type.Unknown(),
});

export const CreateRunToolRequestSchema = closed({
  ...Request(), workflow_slug: Id(), objective: Type.String(), input: Type.Unknown(),
});
export const CreateRunInternalPayloadSchema = closed({
  ...Request(), workflow_slug: Id(), objective: Type.String(), input: Type.Unknown(), workspace: WorkspaceStateSchema,
});
export const ClaimRunToolRequestSchema = closed({
  ...RunRequest(),
  mode: Type.Union(['start', 'resume', 'recover', 'retry'].map((value) => Type.Literal(value))),
  expected_status: Type.Union(['created', 'paused', 'interrupted', 'failed'].map((value) => Type.Literal(value))),
  stage_run_id: Type.Optional(Id()),
  current_workspace: Type.Optional(WorkspaceStateSchema),
});
export const HeartbeatRunToolRequestSchema = closed({ ...RunRequest() });
export const BeginStageToolRequestSchema = closed({ ...StageRequest(), stage_input: Type.Optional(Type.Unknown()) });
export const CompleteStageToolRequestSchema = closed({
  ...StageRequest(), output: SucceededStageOutputEnvelopeSchema,
  workspace: WorkspaceStateSchema,
  changed_files: Type.Optional(Type.Unknown()),
});
export const FailStageToolRequestSchema = closed({
  ...StageRequest(), error_code: Id(), summary: Type.String(),
});
export const RetryStageToolRequestSchema = closed({ ...StageRequest(), stage_input: Type.Optional(Type.Unknown()) });
export const SkipStageToolRequestSchema = closed({ ...StageRequest() });
export const RequestConfirmationToolRequestSchema = closed({
  ...StageRequest(), confirmation_type: Id(), summary: Id(),
  exact_action_hash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  ttl_ms: Type.Optional(Type.Integer({ minimum: 1 })),
});
export const RecordArtifactToolRequestSchema = closed({
  ...RunRequest(), stage_attempt_id: Id(), source_path: Id(),
  artifact_type: Type.Union([
    'document', 'log', 'test_evidence', 'file_manifest', 'ui_prototype',
    'deployment_record', 'rollback_record', 'other',
  ].map((value) => Type.Literal(value))),
  summary: Type.String(), metadata: Type.Optional(Type.Unknown()),
});
export const RecordWorkspaceCheckpointToolRequestSchema = closed({
  ...RunRequest(), stage_attempt_id: Type.Optional(Id()),
  checkpoint_kind: Type.Union(['run_start', 'before_attempt', 'progress', 'after_attempt'].map((value) => Type.Literal(value))),
  baseline_fingerprint: Id(), workspace: WorkspaceStateSchema,
});
export const RecordMemoryToolRequestSchema = closed({
  ...StageRequest(),
  memory_type: Type.Union(MEMORY_TYPES.map((value) => Type.Literal(value))),
  scope: Type.Union(MEMORY_SCOPES.map((value) => Type.Literal(value))),
  title: Id(), summary: Type.String(), content: Type.Unknown(),
  retention_policy: Type.Union(MEMORY_RETENTION_POLICIES.map((value) => Type.Literal(value))),
});
export const AppendAgentNoteToolRequestSchema = closed({
  ...RunRequest(), note: Type.String({ minLength: 1, maxLength: 4096 }),
});
export const PrepareSideEffectToolRequestSchema = closed({
  ...RunRequest(), stage_attempt_id: Id(), action_type: Id(), target_fingerprint: Id(),
  parameters: Type.Record(Type.String(), Type.Unknown()), summary: Id(),
  ttl_ms: Type.Optional(Type.Integer({ minimum: 1 })),
});
export const ExecuteSideEffectToolRequestSchema = closed({ ...RunRequest(), operation_id: Id() });
export const ReconcileSideEffectToolRequestSchema = closed({ ...RunRequest(), operation_id: Id() });
export const PauseRunToolRequestSchema = closed({ ...RunRequest() });
export const CancelRunToolRequestSchema = closed({ ...RunRequest() });
export const FinalizeRunToolRequestSchema = closed({ ...RunRequest() });

export const MODEL_VISIBLE_TOOL_SCHEMAS = {
  create_run: CreateRunToolRequestSchema,
  claim_run: ClaimRunToolRequestSchema,
  heartbeat_run: HeartbeatRunToolRequestSchema,
  begin_stage: BeginStageToolRequestSchema,
  complete_stage: CompleteStageToolRequestSchema,
  fail_stage: FailStageToolRequestSchema,
  retry_stage: RetryStageToolRequestSchema,
  skip_stage: SkipStageToolRequestSchema,
  request_confirmation: RequestConfirmationToolRequestSchema,
  record_artifact: RecordArtifactToolRequestSchema,
  record_workspace_checkpoint: RecordWorkspaceCheckpointToolRequestSchema,
  record_memory: RecordMemoryToolRequestSchema,
  append_agent_note: AppendAgentNoteToolRequestSchema,
  prepare_side_effect: PrepareSideEffectToolRequestSchema,
  execute_side_effect: ExecuteSideEffectToolRequestSchema,
  reconcile_side_effect: ReconcileSideEffectToolRequestSchema,
  pause_run: PauseRunToolRequestSchema,
  cancel_run: CancelRunToolRequestSchema,
  finalize_run: FinalizeRunToolRequestSchema,
} as const satisfies Record<AgentToolName, TSchema>;

// Compatibility exports retained for the adapter slice while it migrates to the per-tool map.
export const BootstrapToolRequestSchema = CreateRunToolRequestSchema;
export const ClaimToolRequestSchema = ClaimRunToolRequestSchema;
export const LeasedToolRequestSchema = HeartbeatRunToolRequestSchema;
export const StageToolRequestSchema = SkipStageToolRequestSchema;
export const AgentNoteRequestSchema = AppendAgentNoteToolRequestSchema;
export const ReadToolRequestSchema = Type.Object({ run_id: Id() }, { additionalProperties: false });
export type BootstrapToolRequest = Static<typeof BootstrapToolRequestSchema>;
export type ClaimToolRequest = Static<typeof ClaimToolRequestSchema>;
export type LeasedToolRequest = Static<typeof LeasedToolRequestSchema>;
export type StageToolRequest = Static<typeof StageToolRequestSchema>;
