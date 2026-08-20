import { describe, expect, it } from 'vitest';
import {
  ContractValidator,
  CompleteStageRequestEnvelopeSchema,
  CreateRunRequestEnvelopeSchema,
  MODEL_VISIBLE_WRITE_ENVELOPE_SCHEMAS,
  StageOutputEnvelopeSchema,
  WorkflowVersionEnvelopeSchema,
} from '../src/index.js';

const validator = new ContractValidator();

describe('contract envelopes', () => {
  it('accepts a versioned workflow envelope', () => {
    const input = {
      schema_id: 'project-orchestrator/workflow-version',
      schema_version: 1,
      data: {
        slug: 'new-project',
        version: 1,
        stages: [{
          key: 'research',
          role_version_id: 'role-v1',
          optional: false,
          mandatory_gate: false,
          failure_policy: 'fail',
          max_attempts: 1,
          requires_confirmation: false,
        }],
        edges: [],
        iteration_groups: [],
      },
    };

    expect(validator.check(WorkflowVersionEnvelopeSchema, input)).toEqual(input);
  });

  it('rejects an unversioned stage output', () => {
    expect(() => validator.check(StageOutputEnvelopeSchema, { status: 'succeeded' }))
      .toThrow(/schema_id/);
  });

  it('rejects invalid condition expressions and unexpected properties', () => {
    const invalid = {
      schema_id: 'project-orchestrator/workflow-version',
      schema_version: 1,
      data: {
        slug: 'bad', version: 1, edges: [], iteration_groups: [],
        stages: [{
          key: 'x', role_version_id: 'role-v1', optional: false, mandatory_gate: false,
          failure_policy: 'fail', max_attempts: 1, requires_confirmation: false,
          condition: { op: 'exec', path: 'process.env' },
        }],
      },
    };
    expect(() => validator.check(WorkflowVersionEnvelopeSchema, invalid)).toThrow(/condition/);
  });

  it('rejects duplicate stage keys even when the stage definitions differ', () => {
    const stage = {
      key: 'duplicate', role_version_id: 'role-v1', optional: false, mandatory_gate: false,
      failure_policy: 'fail', max_attempts: 1, requires_confirmation: false,
    };
    const input = {
      schema_id: 'project-orchestrator/workflow-version', schema_version: 1,
      data: {
        slug: 'duplicate-keys', version: 1, edges: [], iteration_groups: [],
        stages: [stage, { ...stage, role_version_id: 'role-v2' }],
      },
    };
    expect(() => validator.check(WorkflowVersionEnvelopeSchema, input)).toThrow(/x-uniqueBy/);
  });

  it('keeps lease secrets out of model-visible contracts', () => {
    const serialized = JSON.stringify(CreateRunRequestEnvelopeSchema);
    expect(serialized).not.toContain('lease_token');
    expect(serialized).not.toContain('lease_epoch');
    expect(() => validator.check(CreateRunRequestEnvelopeSchema, {
      schema_id: 'project-orchestrator/create-run-request',
      schema_version: 1,
      data: { request_id: 'request-1', workflow_version_id: 'workflow-v1', project_id: 'project-1', lease_token: 'secret' },
    })).toThrow(/additionalProperties/);
  });

  it('keeps lease secrets out of every model-visible write contract', () => {
    expect(MODEL_VISIBLE_WRITE_ENVELOPE_SCHEMAS.map(({ name }) => name)).toEqual([
      'create-run', 'claim-run', 'begin-stage', 'complete-stage', 'fail-stage', 'confirmation-request',
    ]);
    for (const { name, schema } of MODEL_VISIBLE_WRITE_ENVELOPE_SCHEMAS) {
      const serialized = JSON.stringify(schema);
      expect(serialized, name).not.toContain('lease_token');
      expect(serialized, name).not.toContain('lease_epoch');
    }
  });

  it('rejects a failed output submitted through complete-stage', () => {
    expect(() => validator.check(CompleteStageRequestEnvelopeSchema, {
      schema_id: 'project-orchestrator/complete-stage-request',
      schema_version: 1,
      data: {
        request_id: 'request-1', run_id: 'run-1', stage_run_id: 'stage-1',
        output: {
          schema_id: 'project-orchestrator/stage-output', schema_version: 1,
          data: {
            status: 'failed', summary: 'failed', artifact_object_ids: [], evidence_object_ids: [],
            risks: [], next_stage_notes: [],
          },
        },
      },
    })).toThrow(/const/);
  });
});
