import { Type, type Static } from '@sinclair/typebox';
import { Envelope } from './envelope.js';

export const StageOutputDataSchema = Type.Object({
  status: Type.Union([Type.Literal('succeeded'), Type.Literal('failed')]),
  summary: Type.String(),
  artifact_object_ids: Type.Array(Type.String()),
  evidence_object_ids: Type.Array(Type.String()),
  changed_file_manifest_object_id: Type.Optional(Type.String()),
  risks: Type.Array(Type.String()),
  next_stage_notes: Type.Array(Type.String()),
}, { additionalProperties: false });

export const StageOutputEnvelopeSchema = Envelope(
  'project-orchestrator/stage-output',
  1,
  StageOutputDataSchema,
);

const RequestIdentitySchema = {
  request_id: Type.String({ minLength: 1 }),
};

const RunRequestIdentitySchema = {
  ...RequestIdentitySchema,
  run_id: Type.String({ minLength: 1 }),
};

const StageRequestIdentitySchema = {
  ...RunRequestIdentitySchema,
  stage_run_id: Type.String({ minLength: 1 }),
};

export const CreateRunRequestEnvelopeSchema = Envelope('project-orchestrator/create-run-request', 1, Type.Object({
  ...RequestIdentitySchema,
  workflow_version_id: Type.String({ minLength: 1 }),
  project_id: Type.String({ minLength: 1 }),
}, { additionalProperties: false }));

export const ClaimRunRequestEnvelopeSchema = Envelope('project-orchestrator/claim-run-request', 1, Type.Object({
  ...RunRequestIdentitySchema,
  mode: Type.Union([Type.Literal('start'), Type.Literal('resume'), Type.Literal('recover'), Type.Literal('retry')]),
  stage_run_id: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false }));

export const BeginStageRequestEnvelopeSchema = Envelope('project-orchestrator/begin-stage-request', 1, Type.Object(
  StageRequestIdentitySchema,
  { additionalProperties: false },
));

export const CompleteStageRequestEnvelopeSchema = Envelope('project-orchestrator/complete-stage-request', 1, Type.Object({
  ...StageRequestIdentitySchema,
  output: StageOutputEnvelopeSchema,
}, { additionalProperties: false }));

export const FailStageRequestEnvelopeSchema = Envelope('project-orchestrator/fail-stage-request', 1, Type.Object({
  ...StageRequestIdentitySchema,
  error_code: Type.String({ minLength: 1 }),
  summary: Type.String(),
  evidence_object_ids: Type.Array(Type.String()),
}, { additionalProperties: false }));

export const ConfirmationRequestEnvelopeSchema = Envelope('project-orchestrator/confirmation-request', 1, Type.Object({
  ...StageRequestIdentitySchema,
  exact_action_hash: Type.String({ minLength: 1 }),
  summary: Type.String({ minLength: 1 }),
}, { additionalProperties: false }));

export const CommandResponseEnvelopeSchema = Envelope('project-orchestrator/command-response', 1, Type.Object({
  request_id: Type.String({ minLength: 1 }),
  accepted: Type.Boolean(),
  run_id: Type.Optional(Type.String()),
  stage_run_id: Type.Optional(Type.String()),
}, { additionalProperties: false }));

export const MODEL_VISIBLE_WRITE_ENVELOPE_SCHEMAS = [
  { name: 'create-run', schema: CreateRunRequestEnvelopeSchema },
  { name: 'claim-run', schema: ClaimRunRequestEnvelopeSchema },
  { name: 'begin-stage', schema: BeginStageRequestEnvelopeSchema },
  { name: 'complete-stage', schema: CompleteStageRequestEnvelopeSchema },
  { name: 'fail-stage', schema: FailStageRequestEnvelopeSchema },
  { name: 'confirmation-request', schema: ConfirmationRequestEnvelopeSchema },
] as const;

export type StageOutputData = Static<typeof StageOutputDataSchema>;
export type StageOutputEnvelope = Static<typeof StageOutputEnvelopeSchema>;
export type CreateRunRequestEnvelope = Static<typeof CreateRunRequestEnvelopeSchema>;
export type ClaimRunRequestEnvelope = Static<typeof ClaimRunRequestEnvelopeSchema>;
export type BeginStageRequestEnvelope = Static<typeof BeginStageRequestEnvelopeSchema>;
export type CompleteStageRequestEnvelope = Static<typeof CompleteStageRequestEnvelopeSchema>;
export type FailStageRequestEnvelope = Static<typeof FailStageRequestEnvelopeSchema>;
export type ConfirmationRequestEnvelope = Static<typeof ConfirmationRequestEnvelopeSchema>;
export type CommandResponseEnvelope = Static<typeof CommandResponseEnvelopeSchema>;
