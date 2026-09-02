import { Type, type Static } from '@sinclair/typebox';
import { Envelope } from './envelope.js';

const Hash = () => Type.String({ pattern: '^[0-9a-f]{64}$' });
const Count = (maximum: number) => Type.Integer({ minimum: 0, maximum });

export const ProjectIndexSymbolSchema = Type.Object({
  kind: Type.String({ minLength: 1, maxLength: 32 }),
  name: Type.String({ minLength: 1, maxLength: 512 }),
  line: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

export const ProjectIndexFileSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  language: Type.String({ minLength: 1, maxLength: 32 }),
  size_bytes: Type.Integer({ minimum: 0, maximum: 1024 * 1024 }),
  content_sha256: Hash(),
  imports: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { uniqueItems: true, maxItems: 256 }),
  symbols: Type.Array(ProjectIndexSymbolSchema, { maxItems: 1024 }),
}, { additionalProperties: false });

export const ProjectIndexEnvelopeSchema = Envelope(
  'project-orchestrator/project-index',
  1,
  Type.Object({
    source_head: Type.String({ minLength: 1, maxLength: 256 }),
    tree_fingerprint: Hash(),
    generated_at: Type.String({ format: 'date-time' }),
    files: Type.Array(ProjectIndexFileSchema, { maxItems: 20_000 }),
    skipped: Type.Object({
      binary: Type.Integer({ minimum: 0 }),
      generated_or_dependency: Type.Integer({ minimum: 0 }),
      sensitive: Type.Integer({ minimum: 0 }),
      too_large: Type.Integer({ minimum: 0 }),
      unsupported_or_missing: Type.Integer({ minimum: 0 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
);

const ProjectIndexQuerySymbolSchema = Type.Object({
  kind: Type.String({ minLength: 1, maxLength: 32 }),
  name: Type.String({ minLength: 1, maxLength: 256 }),
  line: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

export const ProjectIndexQueryFileSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1024 }),
  language: Type.String({ minLength: 1, maxLength: 32 }),
  imports: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { uniqueItems: true, maxItems: 10 }),
  symbols: Type.Array(ProjectIndexQuerySymbolSchema, { maxItems: 20 }),
  import_count: Count(256),
  symbol_count: Count(1024),
  path_truncated: Type.Boolean(),
  details_truncated: Type.Boolean(),
}, { additionalProperties: false });

export const ProjectIndexQueryReadyResultSchema = Type.Object({
  status: Type.Literal('ready'),
  project_index_object_id: Type.String({ format: 'uuid' }),
  source_head: Type.String({ minLength: 1, maxLength: 256 }),
  tree_fingerprint: Hash(),
  freshness: Type.Literal('frozen'),
  bound_at: Type.String({ format: 'date-time' }),
  file_count: Count(20_000),
  changed_file_count: Count(40_000),
  skipped_file_count: Count(20_000),
  matched_file_count: Count(20_000),
  cursor: Count(20_000),
  files: Type.Array(ProjectIndexQueryFileSchema, { maxItems: 20 }),
  next_cursor: Type.Union([Count(20_000), Type.Null()]),
}, { additionalProperties: false });

export const ProjectIndexQueryUnavailableResultSchema = Type.Object({
  status: Type.Literal('unavailable'),
  reason: Type.Union([
    Type.Literal('PROJECT_INDEX_UNAVAILABLE'),
    Type.Literal('PROJECT_INDEX_CORRUPT'),
  ]),
}, { additionalProperties: false });

export const ProjectIndexQueryResultSchema = Type.Union([
  ProjectIndexQueryReadyResultSchema,
  ProjectIndexQueryUnavailableResultSchema,
]);

export type ProjectIndexSymbol = Static<typeof ProjectIndexSymbolSchema>;
export type ProjectIndexFile = Static<typeof ProjectIndexFileSchema>;
export type ProjectIndexEnvelope = Static<typeof ProjectIndexEnvelopeSchema>;
export type ProjectIndexQueryFile = Static<typeof ProjectIndexQueryFileSchema>;
export type ProjectIndexQueryReadyResult = Static<typeof ProjectIndexQueryReadyResultSchema>;
export type ProjectIndexQueryUnavailableResult = Static<typeof ProjectIndexQueryUnavailableResultSchema>;
export type ProjectIndexQueryResult = Static<typeof ProjectIndexQueryResultSchema>;
