import { Type, type Static } from '@sinclair/typebox';
import { Envelope, GenericEnvelopeSchema } from './envelope.js';

export const CompletionArtifactRequirementSchema = Type.Object({
  artifact_type: Type.Union([
    'document', 'log', 'test_evidence', 'file_manifest', 'ui_prototype',
    'deployment_record', 'rollback_record', 'other',
  ].map((value) => Type.Literal(value))),
  min_count: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

export const CompletionContractEnvelopeSchema = Type.Object({
  schema_id: Type.String({ minLength: 1 }),
  schema_version: Type.Integer({ minimum: 1 }),
  data: Type.Object({
    required_artifacts: Type.Optional(Type.Array(CompletionArtifactRequirementSchema)),
    required_evidence: Type.Optional(Type.Array(CompletionArtifactRequirementSchema)),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const RoleVersionDataSchema = Type.Object({
  slug: Type.String({ minLength: 1 }),
  display_name: Type.String({ minLength: 1 }),
  responsibilities: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  requested_capabilities: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  forbidden_capabilities: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  input_schema: GenericEnvelopeSchema,
  output_schema: GenericEnvelopeSchema,
  completion_contract: CompletionContractEnvelopeSchema,
  body_markdown: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const RoleVersionEnvelopeSchema = Envelope(
  'project-orchestrator/role-version',
  1,
  RoleVersionDataSchema,
);

export type RoleVersionEnvelope = Static<typeof RoleVersionEnvelopeSchema>;
export type RoleVersionData = Static<typeof RoleVersionDataSchema>;
