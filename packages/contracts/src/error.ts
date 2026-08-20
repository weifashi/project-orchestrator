export const ERROR_CODES = [
  'PROJECT_PATH_CHANGED',
  'REPOSITORY_HEAD_CHANGED',
  'WORKTREE_CHANGED',
  'RULE_BUNDLE_CHANGED',
  'ADAPTER_INCOMPATIBLE',
  'SAFETY_BASELINE_INCOMPATIBLE',
  'ARTIFACT_MISSING',
  'INVALID_TRANSITION',
  'STALE_LEASE',
  'IDEMPOTENCY_CONFLICT',
  'SCHEMA_INVALID',
  'POLICY_VIOLATION',
  'NOT_FOUND',
] as const;

export type ErrorCode = typeof ERROR_CODES[number];

export const ErrorEnvelopeSchema = Envelope('project-orchestrator/error', 1, Type.Object({
  code: Type.Union(ERROR_CODES.map((code) => Type.Literal(code))),
  message: Type.String(),
  retryable: Type.Boolean(),
}, { additionalProperties: false }));

export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;

export class OrchestratorError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'OrchestratorError';
  }
}
import { Type, type Static } from '@sinclair/typebox';
import { Envelope } from './envelope.js';
