import { Type, type Static } from '@sinclair/typebox';
import { Envelope, GenericEnvelopeSchema } from './envelope.js';

export const RoleVersionDataSchema = Type.Object({
  slug: Type.String({ minLength: 1 }),
  display_name: Type.String({ minLength: 1 }),
  responsibilities: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  requested_capabilities: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  forbidden_capabilities: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  input_schema: GenericEnvelopeSchema,
  output_schema: GenericEnvelopeSchema,
  completion_contract: GenericEnvelopeSchema,
  body_markdown: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const RoleVersionEnvelopeSchema = Envelope(
  'project-orchestrator/role-version',
  1,
  RoleVersionDataSchema,
);

export type RoleVersionEnvelope = Static<typeof RoleVersionEnvelopeSchema>;
export type RoleVersionData = Static<typeof RoleVersionDataSchema>;
