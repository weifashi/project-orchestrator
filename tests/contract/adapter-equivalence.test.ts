import { describe, expect, it } from 'vitest';
import { createConservativeCapabilities, SessionGuard } from '../../packages/adapter-core/src/index.js';
import { AdapterRuntime } from '../../packages/mcp-adapter/src/server.js';

describe('cross-client adapter contract', () => {
  it('produces equivalent visible requests and responses apart from capability client identity', async () => {
    const sent: unknown[] = [];
    const make = (clientType: 'codex' | 'claude') => new AdapterRuntime({
      capabilities: createConservativeCapabilities(clientType, '0.1.0'),
      sessionGuard: new SessionGuard({ sessionId: `${clientType}-root` }),
      send: async (request) => {
        sent.push(request);
        const tool = (request as { tool: string }).tool;
        if (tool === 'create_run') return { runId: 'run-1', summary: 'created' };
        if (tool === 'claim_run') return { runId: 'run-1', summary: 'claimed', leaseToken: 'must-not-leak', leaseEpoch: 1, recoveryCredential: 'recover-secret' };
        return { runId: 'run-1', stageRunId: 'stage-1', summary: 'completed' };
      },
    });
    const request = {
      request_id: 'request-1', workflow_version_id: 'workflow-v1', project_id: 'project-1', objective: 'Build it',
      input: {}, workspace: { repository_head: 'abc', staged_patch: '', unstaged_patch: '', untracked_manifest: [], submodule_manifest: [] },
    };
    const codexRuntime = make('codex');
    const claudeRuntime = make('claude');
    const codex = [
      await codexRuntime.invoke('create_run', request),
      await codexRuntime.invoke('claim_run', { request_id: 'claim-1', run_id: 'run-1', mode: 'start', expected_status: 'created' }),
      await codexRuntime.invoke('complete_stage', {
        request_id: 'complete-1', run_id: 'run-1', stage_run_id: 'stage-1',
        output: { schema_id: 'project-orchestrator/stage-output', schema_version: 1, data: {
          status: 'succeeded', summary: 'done', artifact_object_ids: [], evidence_object_ids: [], risks: [], next_stage_notes: [],
        } },
        workspace: { repository_head: 'def', staged_patch: '', unstaged_patch: '', untracked_manifest: [], submodule_manifest: [] },
      }),
    ];
    const claude = [
      await claudeRuntime.invoke('create_run', request),
      await claudeRuntime.invoke('claim_run', { request_id: 'claim-1', run_id: 'run-1', mode: 'start', expected_status: 'created' }),
      await claudeRuntime.invoke('complete_stage', {
        request_id: 'complete-1', run_id: 'run-1', stage_run_id: 'stage-1',
        output: { schema_id: 'project-orchestrator/stage-output', schema_version: 1, data: {
          status: 'succeeded', summary: 'done', artifact_object_ids: [], evidence_object_ids: [], risks: [], next_stage_notes: [],
        } },
        workspace: { repository_head: 'def', staged_patch: '', unstaged_patch: '', untracked_manifest: [], submodule_manifest: [] },
      }),
    ];
    expect(codex).toEqual(claude);
    expect(JSON.stringify(codex)).not.toMatch(/lease_token|leaseToken|recovery_credential|recoveryCredential|must-not-leak|recover-secret/);
    expect(sent.slice(0, 3)).toEqual(sent.slice(3, 6));
    expect(sent[2]).toMatchObject({ lease_epoch: 1, lease_token: 'must-not-leak' });
  });
});
