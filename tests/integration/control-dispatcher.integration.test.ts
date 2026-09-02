import { expect, it } from 'vitest';
import { AgentToolNames } from '@project-orchestrator/contracts';
import type { InternalIpcRequest } from '@project-orchestrator/contracts/internal-ipc';
import { createControlDispatcher } from '@project-orchestrator/control-server';

const workspace = {
  repository_head: 'head', staged_patch: '', unstaged_patch: '',
  untracked_manifest: [], submodule_manifest: [],
};
const base = { request_id: 'request', run_id: 'run' };
const payloads: Record<(typeof AgentToolNames)[number], Record<string, unknown>> = {
  create_run: { request_id: 'request', workflow_version_id: 'workflow', project_id: 'project', objective: 'ship', input: {}, workspace },
  claim_run: { ...base, mode: 'start', expected_status: 'created' },
  heartbeat_run: base,
  begin_stage: { ...base, stage_run_id: 'stage' },
  query_project_index: { ...base, query: 'order', language: 'typescript', cursor: 0, limit: 10 },
  complete_stage: { ...base, stage_run_id: 'stage', workspace, output: { schema_id: 'project-orchestrator/stage-output', schema_version: 1, data: { status: 'succeeded', summary: '', artifact_object_ids: [], evidence_object_ids: [], risks: [], next_stage_notes: [] } } },
  fail_stage: { ...base, stage_run_id: 'stage', error_code: 'FAILED', summary: '' },
  retry_stage: { ...base, stage_run_id: 'stage' },
  skip_stage: { ...base, stage_run_id: 'stage' },
  request_confirmation: { ...base, stage_run_id: 'stage', confirmation_type: 'release', summary: 'release', exact_action_hash: 'a'.repeat(64) },
  record_artifact: { ...base, stage_attempt_id: 'attempt', source_path: 'report.txt', artifact_type: 'document', summary: '' },
  record_workspace_checkpoint: { ...base, checkpoint_kind: 'progress', baseline_fingerprint: 'fingerprint', workspace },
  record_memory: { ...base, memory_type: 'fact', scope: 'project', title: 'title', summary: '', content: {}, retention_policy: 'keep' },
  append_agent_note: { ...base, note: 'note' },
  prepare_side_effect: { ...base, stage_attempt_id: 'attempt', action_type: 'deploy', target_fingerprint: 'node', parameters: {}, summary: 'deploy' },
  execute_side_effect: { ...base, operation_id: 'operation' },
  reconcile_side_effect: { ...base, operation_id: 'operation' },
  pause_run: base,
  cancel_run: base,
  finalize_run: base,
};

it('dispatches all twenty capabilities to their server-owned service method', async () => {
  const calls: string[] = [];
  const methodByTool: Record<(typeof AgentToolNames)[number], string> = {
    create_run: 'createRun', claim_run: 'claimRun', heartbeat_run: 'heartbeat', begin_stage: 'beginStage',
    query_project_index: 'queryProjectIndex',
    complete_stage: 'completeStage', fail_stage: 'failStage', retry_stage: 'retryStage', skip_stage: 'skipStage',
    request_confirmation: 'requestConfirmation', record_artifact: 'recordArtifact',
    record_workspace_checkpoint: 'recordWorkspaceCheckpoint', record_memory: 'recordMemory',
    append_agent_note: 'appendAgentNote', prepare_side_effect: 'prepare', execute_side_effect: 'execute',
    reconcile_side_effect: 'reconcile', pause_run: 'pauseRun', cancel_run: 'cancelRun', finalize_run: 'finalizeRun',
  };
  const makeService = (methods: string[]) => Object.fromEntries(methods.map((method) => [method, () => {
    calls.push(method); return { method };
  }]));
  const db = {
    prepare: (sql: string) => ({
      get: () => sql.includes('client_installations') ? { client_type: 'codex' } : { role_version_id: 'role-v1' },
    }),
  };
  const runs = makeService(Object.values(methodByTool).filter((method) => !['prepare','execute','reconcile'].includes(method)));
  const operations = makeService(['prepare','execute','reconcile']);
  const dispatcher = createControlDispatcher({
    db, runs, leases: {}, confirmations: {}, operations,
  } as never);
  const principal = { installation_id: 'installation', root_session_id: 'root', session_id: 'root', canonical_project_path: '/project' };
  for (const tool of AgentToolNames) {
    const request = (tool === 'create_run'
      ? { kind: 'tool', tool, payload: payloads[tool] }
      : tool === 'claim_run'
        ? { kind: 'tool', tool, payload: payloads[tool], expected_lease_epoch: 0 }
      : { kind: 'tool', tool, payload: payloads[tool], lease_epoch: 1, lease_token: 'hidden' }) as InternalIpcRequest;
    await dispatcher.dispatch(request, principal);
  }
  expect(calls).toEqual(AgentToolNames.map((tool) => methodByTool[tool]));
});
