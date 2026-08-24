import { Type, type Static } from '@sinclair/typebox';
import { Envelope } from './envelope.js';

export type ConditionExpression =
  | { op: 'eq' | 'ne'; path: string; value: string | number | boolean | null }
  | { op: 'in'; path: string; values: Array<string | number | boolean> }
  | { op: 'exists'; path: string }
  | { op: 'all' | 'any'; items: ConditionExpression[] }
  | { op: 'not'; item: ConditionExpression };

const scalarJsonSchema = { type: ['string', 'number', 'boolean'] };
const conditionJsonSchema = {
      oneOf: [
        {
          type: 'object', additionalProperties: false, required: ['op', 'path', 'value'],
          properties: { op: { enum: ['eq', 'ne'] }, path: { type: 'string', minLength: 1 }, value: { type: ['string', 'number', 'boolean', 'null'] } },
        },
        {
          type: 'object', additionalProperties: false, required: ['op', 'path', 'values'],
          properties: { op: { const: 'in' }, path: { type: 'string', minLength: 1 }, values: { type: 'array', items: scalarJsonSchema } },
        },
        {
          type: 'object', additionalProperties: false, required: ['op', 'path'],
          properties: { op: { const: 'exists' }, path: { type: 'string', minLength: 1 } },
        },
        {
          type: 'object', additionalProperties: false, required: ['op', 'items'],
          properties: { op: { enum: ['all', 'any'] }, items: { type: 'array', minItems: 1, items: { $ref: '#/$defs/condition' } } },
        },
        {
          type: 'object', additionalProperties: false, required: ['op', 'item'],
          properties: { op: { const: 'not' }, item: { $ref: '#/$defs/condition' } },
        },
      ],
};

export const ConditionExpressionSchema = Type.Unsafe<ConditionExpression>({
  ...conditionJsonSchema,
  $defs: { condition: conditionJsonSchema },
});

const EmbeddedConditionExpressionSchema = Type.Unsafe<ConditionExpression>({
  $ref: '#/$defs/condition',
});

export const WorkflowStageSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  role_version_id: Type.String({ minLength: 1 }),
  optional: Type.Boolean(),
  mandatory_gate: Type.Boolean(),
  condition: Type.Optional(EmbeddedConditionExpressionSchema),
  failure_policy: Type.Union([
    Type.Literal('pause'), Type.Literal('fail'), Type.Literal('retry_then_fail'), Type.Literal('trigger_iteration'),
  ]),
  max_attempts: Type.Integer({ minimum: 1 }),
  iteration_group_key: Type.Optional(Type.String({ minLength: 1 })),
  requires_confirmation: Type.Boolean(),
}, { additionalProperties: false });

export const WorkflowEdgeSchema = Type.Object({
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
  edge_type: Type.Union([Type.Literal('requires'), Type.Literal('on_success')]),
  condition: Type.Optional(EmbeddedConditionExpressionSchema),
}, { additionalProperties: false });

export const WorkflowIterationGroupSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  entry_stage_key: Type.String({ minLength: 1 }),
  gate_stage_keys: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
  aggregation_policy: Type.Literal('collect_all'),
  max_iterations: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

export const WorkflowCanvasNodeSchema = Type.Object({
  stage_key: Type.String({ minLength: 1 }),
  x: Type.Number(),
  y: Type.Number(),
}, { additionalProperties: false });

export const WorkflowCanvasGroupSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  stage_keys: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
  collapsed: Type.Boolean(),
}, { additionalProperties: false });

export const WorkflowCanvasSchema = Type.Object({
  nodes: Type.Array(WorkflowCanvasNodeSchema, { 'x-uniqueBy': 'stage_key' }),
  viewport_x: Type.Optional(Type.Number()),
  viewport_y: Type.Optional(Type.Number()),
  viewport_zoom: Type.Optional(Type.Number({ minimum: 0.1, maximum: 4 })),
  groups: Type.Optional(Type.Array(WorkflowCanvasGroupSchema, { 'x-uniqueBy': 'id' })),
}, { additionalProperties: false });

export const WorkflowVersionDataSchema = Type.Object({
  slug: Type.String({ minLength: 1 }),
  version: Type.Integer({ minimum: 1 }),
  stages: Type.Array(WorkflowStageSchema, { minItems: 1, uniqueItems: true, 'x-uniqueBy': 'key' }),
  edges: Type.Array(WorkflowEdgeSchema),
  iteration_groups: Type.Array(WorkflowIterationGroupSchema),
  // Visual-only positions. The runtime continues to use stages and edges.
  canvas: Type.Optional(WorkflowCanvasSchema),
}, { additionalProperties: false });

const WorkflowVersionEnvelopeBaseSchema = Envelope(
  'project-orchestrator/workflow-version',
  1,
  WorkflowVersionDataSchema,
);

export const WorkflowVersionEnvelopeSchema = Type.Unsafe<Static<typeof WorkflowVersionEnvelopeBaseSchema>>({
  ...WorkflowVersionEnvelopeBaseSchema,
  $defs: { condition: conditionJsonSchema },
});

export type WorkflowStage = Static<typeof WorkflowStageSchema>;
export type WorkflowEdge = Static<typeof WorkflowEdgeSchema>;
export type WorkflowIterationGroup = Static<typeof WorkflowIterationGroupSchema>;
export type WorkflowCanvasNode = Static<typeof WorkflowCanvasNodeSchema>;
export type WorkflowCanvasGroup = Static<typeof WorkflowCanvasGroupSchema>;
export type WorkflowCanvas = Static<typeof WorkflowCanvasSchema>;
export type WorkflowVersionEnvelope = Static<typeof WorkflowVersionEnvelopeSchema>;
