import { Type, type Static } from '@sinclair/typebox';

export const AgentToolNames = [
  'create_run', 'claim_run', 'heartbeat_run', 'begin_stage', 'complete_stage',
  'fail_stage', 'retry_stage', 'skip_stage', 'request_confirmation',
  'record_artifact', 'record_workspace_checkpoint', 'record_memory',
  'append_agent_note', 'prepare_side_effect', 'execute_side_effect',
  'reconcile_side_effect', 'pause_run', 'cancel_run', 'finalize_run',
] as const;
export type AgentToolName = typeof AgentToolNames[number];

export type VisibleWriteContext = Readonly<{ run_id: string; request_id: string }>;
const WriteContext = { run_id: Type.String({ minLength: 1 }), request_id: Type.String({ minLength: 1 }) };
export const BootstrapToolRequestSchema = Type.Object({ request_id: Type.String({ minLength: 1 }), workflow_version_id: Type.String({ minLength: 1 }), project_id: Type.String({ minLength: 1 }), objective: Type.String(), input: Type.Unknown() }, { additionalProperties: false });
export const ClaimToolRequestSchema = Type.Object({ ...WriteContext, mode: Type.Union(['start','resume','recover','retry'].map((value) => Type.Literal(value))), stage_run_id: Type.Optional(Type.String({ minLength: 1 })), recovery_credential: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const LeasedToolRequestSchema = Type.Object(WriteContext, { additionalProperties: false });
export const StageToolRequestSchema = Type.Object({ ...WriteContext, stage_run_id: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const AgentNoteRequestSchema = Type.Object({ ...WriteContext, note: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false });
export const ReadToolRequestSchema = Type.Object({ run_id: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export type BootstrapToolRequest = Static<typeof BootstrapToolRequestSchema>;
export type ClaimToolRequest = Static<typeof ClaimToolRequestSchema>;
export type LeasedToolRequest = Static<typeof LeasedToolRequestSchema>;
export type StageToolRequest = Static<typeof StageToolRequestSchema>;
