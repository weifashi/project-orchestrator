import { Type, type Static, type TSchema } from '@sinclair/typebox';
import {
  AgentToolNames,
  CreateRunInternalPayloadSchema,
  MODEL_VISIBLE_TOOL_SCHEMAS,
  type AgentToolName,
} from './tool-contracts.js';

export const InternalPrincipalSchema = Type.Object({
  installation_id: Type.String({ minLength: 1 }),
  root_session_id: Type.String({ minLength: 1 }),
  session_id: Type.String({ minLength: 1 }),
  canonical_project_path: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const AgentBootstrapSchema = Type.Object({
  kind: Type.Literal('bootstrap'),
  credential: Type.String({ minLength: 1 }),
  channel: Type.Union([Type.Literal('agent'), Type.Literal('trusted_confirmation')]),
  scope: Type.Union([Type.Literal('root'), Type.Literal('subagent')]),
  canonical_project_path: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const AgentSessionBindingSchema = Type.Object({
  kind: Type.Literal('bind_root_session'),
  challenge: Type.String({ minLength: 1 }),
  session_id: Type.String({ minLength: 1 }),
  proof: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const bootstrap = <T extends TSchema>(tool: AgentToolName, payload: T, extra: Record<string, TSchema> = {}) => Type.Object({
  kind: Type.Literal('tool'), tool: Type.Literal(tool), payload, ...extra,
}, { additionalProperties: false });
const leased = <T extends TSchema>(tool: AgentToolName, payload: T) => bootstrap(tool, payload, {
  lease_epoch: Type.Integer({ minimum: 1 }),
  lease_token: Type.String({ minLength: 1 }),
});

export const INTERNAL_TOOL_REQUEST_SCHEMAS = {
  create_run: bootstrap('create_run', CreateRunInternalPayloadSchema),
  claim_run: bootstrap('claim_run', MODEL_VISIBLE_TOOL_SCHEMAS.claim_run, {
    expected_lease_epoch: Type.Integer({ minimum: 0 }),
    recovery_credential: Type.Optional(Type.String({ minLength: 1 })),
  }),
  heartbeat_run: leased('heartbeat_run', MODEL_VISIBLE_TOOL_SCHEMAS.heartbeat_run),
  begin_stage: leased('begin_stage', MODEL_VISIBLE_TOOL_SCHEMAS.begin_stage),
  query_project_index: leased('query_project_index', MODEL_VISIBLE_TOOL_SCHEMAS.query_project_index),
  complete_stage: leased('complete_stage', MODEL_VISIBLE_TOOL_SCHEMAS.complete_stage),
  fail_stage: leased('fail_stage', MODEL_VISIBLE_TOOL_SCHEMAS.fail_stage),
  retry_stage: leased('retry_stage', MODEL_VISIBLE_TOOL_SCHEMAS.retry_stage),
  skip_stage: leased('skip_stage', MODEL_VISIBLE_TOOL_SCHEMAS.skip_stage),
  request_confirmation: leased('request_confirmation', MODEL_VISIBLE_TOOL_SCHEMAS.request_confirmation),
  record_artifact: leased('record_artifact', MODEL_VISIBLE_TOOL_SCHEMAS.record_artifact),
  record_workspace_checkpoint: leased('record_workspace_checkpoint', MODEL_VISIBLE_TOOL_SCHEMAS.record_workspace_checkpoint),
  record_memory: leased('record_memory', MODEL_VISIBLE_TOOL_SCHEMAS.record_memory),
  append_agent_note: leased('append_agent_note', MODEL_VISIBLE_TOOL_SCHEMAS.append_agent_note),
  prepare_side_effect: leased('prepare_side_effect', MODEL_VISIBLE_TOOL_SCHEMAS.prepare_side_effect),
  execute_side_effect: leased('execute_side_effect', MODEL_VISIBLE_TOOL_SCHEMAS.execute_side_effect),
  reconcile_side_effect: leased('reconcile_side_effect', MODEL_VISIBLE_TOOL_SCHEMAS.reconcile_side_effect),
  pause_run: leased('pause_run', MODEL_VISIBLE_TOOL_SCHEMAS.pause_run),
  cancel_run: leased('cancel_run', MODEL_VISIBLE_TOOL_SCHEMAS.cancel_run),
  finalize_run: leased('finalize_run', MODEL_VISIBLE_TOOL_SCHEMAS.finalize_run),
} as const satisfies Record<AgentToolName, TSchema>;

export const InternalIpcRequestSchema = Type.Union(AgentToolNames.map((tool) => INTERNAL_TOOL_REQUEST_SCHEMAS[tool]));
export const InternalConfirmationDecisionSchema = Type.Object({
  kind: Type.Literal('submit_confirmation'),
  payload: Type.Object({
    confirmation_request_id: Type.String({ minLength: 1 }),
    nonce: Type.String({ minLength: 1 }),
    exact_action_hash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    expires_at: Type.String({ format: 'date-time' }),
    decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')]),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export type AgentBootstrap = Static<typeof AgentBootstrapSchema>;
export type AgentSessionBinding = Static<typeof AgentSessionBindingSchema>;
export type InternalPrincipal = Static<typeof InternalPrincipalSchema>;
export type InternalIpcRequest = Static<typeof InternalIpcRequestSchema>;
export type InternalConfirmationDecision = Static<typeof InternalConfirmationDecisionSchema>;
