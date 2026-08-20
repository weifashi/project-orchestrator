import type Database from 'better-sqlite3';
import type {
  InternalIpcRequest,
  InternalPrincipal,
} from '@project-orchestrator/contracts/internal-ipc';
import type {
  AdapterPrincipal,
  ConfirmationService,
  LeaseProof,
  LeaseService,
  OperationService,
  RunService,
  WorkspaceState,
} from '@project-orchestrator/orchestrator-service';
import type { AgentDispatcher, ConfirmationDispatcher } from './agent-listener.js';

type RuntimeServices = {
  db: Database.Database;
  runs: RunService;
  leases: LeaseService;
  confirmations: ConfirmationService;
  operations: OperationService;
};

const requiredString = (payload: Record<string, unknown>, key: string): string => String(payload[key]);
const workspace = (value: unknown): WorkspaceState => {
  const state = value as Record<string, unknown>;
  return {
    repositoryHead: String(state['repository_head']),
    stagedPatch: String(state['staged_patch']),
    unstagedPatch: String(state['unstaged_patch']),
    untrackedManifest: state['untracked_manifest'],
    submoduleManifest: state['submodule_manifest'],
  };
};

function derivePrincipal(db: Database.Database, internal: InternalPrincipal): AdapterPrincipal {
  const installation = db.prepare("SELECT client_type FROM client_installations WHERE id=? AND status='active'")
    .get(internal.installation_id) as { client_type: 'codex' | 'claude' } | undefined;
  if (installation === undefined) throw new Error('UNAUTHENTICATED');
  return Object.freeze({
    installationId: internal.installation_id,
    sessionId: internal.session_id,
    rootSessionId: internal.root_session_id,
    clientType: installation.client_type,
    canonicalProjectPath: internal.canonical_project_path,
  });
}

function leaseProof(request: InternalIpcRequest, payload: Record<string, unknown>): LeaseProof {
  if (!('lease_epoch' in request) || !('lease_token' in request)) throw new Error('STALE_LEASE');
  return {
    runId: requiredString(payload, 'run_id'),
    leaseEpoch: Number(request.lease_epoch),
    leaseToken: String(request.lease_token),
  };
}

function requireAttemptRole(db: Database.Database, runId: string, attemptId: string): string {
  const row = db.prepare(`SELECT sr.role_version_id FROM stage_attempts sa
    JOIN stage_runs sr ON sr.id=sa.stage_run_id WHERE sa.id=? AND sr.run_id=?`)
    .get(attemptId, runId) as { role_version_id: string } | undefined;
  if (row === undefined) throw new Error('NOT_FOUND: stage attempt');
  return row.role_version_id;
}

export function createControlDispatcher(services: RuntimeServices): {
  dispatch: AgentDispatcher;
  submitConfirmation: ConfirmationDispatcher;
} {
  const dispatch: AgentDispatcher = async (request, internalPrincipal) => {
    const payload = request.payload as Record<string, unknown>;
    const principal = derivePrincipal(services.db, internalPrincipal);
    const requestId = requiredString(payload, 'request_id');
    switch (request.tool) {
      case 'create_run':
        return services.runs.createRun({
          requestId,
          workflowSlug: requiredString(payload, 'workflow_slug'),
          objective: requiredString(payload, 'objective'),
          runInput: payload['input'],
          principal,
          workspace: workspace(payload['workspace']),
        });
      case 'claim_run': {
        if (!('expected_lease_epoch' in request)) throw new Error('SCHEMA_INVALID: missing expected lease epoch');
        const current = payload['current_workspace'];
        return services.runs.claimRun({
          requestId,
          runId: requiredString(payload, 'run_id'),
          mode: payload['mode'] as 'start' | 'resume' | 'recover' | 'retry',
          expectedStatus: requiredString(payload, 'expected_status') as 'created' | 'paused' | 'interrupted' | 'failed',
          expectedLeaseEpoch: Number(request.expected_lease_epoch),
          principal,
          ...('recovery_credential' in request && request.recovery_credential !== undefined
            ? { recoveryCredential: String(request.recovery_credential) } : {}),
          ...(payload['stage_run_id'] === undefined ? {} : { stageRunId: requiredString(payload, 'stage_run_id') }),
          ...(current === undefined ? {} : { currentWorkspace: workspace(current) }),
        });
      }
      case 'heartbeat_run': {
        const proof = leaseProof(request, payload);
        return services.runs.heartbeat({ requestId, proof, principal });
      }
      case 'begin_stage': {
        const proof = leaseProof(request, payload);
        return services.runs.beginStage({
          requestId, proof, principal, stageRunId: requiredString(payload, 'stage_run_id'),
          ...(payload['stage_input'] === undefined ? {} : { stageInput: payload['stage_input'] }),
        });
      }
      case 'complete_stage': {
        const proof = leaseProof(request, payload);
        return services.runs.completeStage({
          requestId, proof, principal, stageRunId: requiredString(payload, 'stage_run_id'), output: payload['output'],
          workspace: workspace(payload['workspace']),
          ...(payload['changed_files'] === undefined ? {} : { changedFiles: payload['changed_files'] }),
        });
      }
      case 'fail_stage': {
        const proof = leaseProof(request, payload);
        return services.runs.failStage({
          requestId, proof, principal, stageRunId: requiredString(payload, 'stage_run_id'),
          errorCode: requiredString(payload, 'error_code'), summary: requiredString(payload, 'summary'),
        });
      }
      case 'retry_stage': {
        const proof = leaseProof(request, payload);
        return services.runs.retryStage({
          requestId, proof, principal, stageRunId: requiredString(payload, 'stage_run_id'),
          ...(payload['stage_input'] === undefined ? {} : { stageInput: payload['stage_input'] }),
        });
      }
      case 'skip_stage': {
        const proof = leaseProof(request, payload);
        return services.runs.skipStage({ requestId, proof, principal, stageRunId: requiredString(payload, 'stage_run_id') });
      }
      case 'request_confirmation': {
        const proof = leaseProof(request, payload);
        return services.runs.requestConfirmation({
          requestId, proof, principal, stageRunId: requiredString(payload, 'stage_run_id'),
          type: requiredString(payload, 'confirmation_type'), summary: requiredString(payload, 'summary'),
          exactActionHash: requiredString(payload, 'exact_action_hash'),
          ...(payload['ttl_ms'] === undefined ? {} : { ttlMs: Number(payload['ttl_ms']) }),
        });
      }
      case 'record_artifact': {
        const proof = leaseProof(request, payload);
        const stageAttemptId = requiredString(payload, 'stage_attempt_id');
        return services.runs.recordArtifact({
          requestId, proof, principal, stageAttemptId,
          sourcePath: requiredString(payload, 'source_path'),
          artifactType: payload['artifact_type'] as Parameters<RunService['recordArtifact']>[0]['artifactType'],
          summary: requiredString(payload, 'summary'),
          producerRoleVersionId: requireAttemptRole(services.db, proof.runId, stageAttemptId),
          ...(payload['metadata'] === undefined ? {} : { metadata: payload['metadata'] }),
        });
      }
      case 'record_workspace_checkpoint': {
        const proof = leaseProof(request, payload);
        return services.runs.recordWorkspaceCheckpoint({
          requestId, proof, principal,
          kind: payload['checkpoint_kind'] as Parameters<RunService['recordWorkspaceCheckpoint']>[0]['kind'],
          baselineFingerprint: requiredString(payload, 'baseline_fingerprint'),
          state: workspace(payload['workspace']),
          ...(payload['stage_attempt_id'] === undefined ? {} : { stageAttemptId: requiredString(payload, 'stage_attempt_id') }),
        });
      }
      case 'record_memory': {
        const proof = leaseProof(request, payload);
        return services.runs.recordMemory({
          requestId, proof, principal, stageRunId: requiredString(payload, 'stage_run_id'),
          memoryType: requiredString(payload, 'memory_type') as Parameters<RunService['recordMemory']>[0]['memoryType'],
          scope: requiredString(payload, 'scope') as Parameters<RunService['recordMemory']>[0]['scope'], title: requiredString(payload, 'title'),
          summary: requiredString(payload, 'summary'), content: payload['content'],
          retentionPolicy: requiredString(payload, 'retention_policy') as Parameters<RunService['recordMemory']>[0]['retentionPolicy'],
        });
      }
      case 'append_agent_note': {
        const proof = leaseProof(request, payload);
        return services.runs.appendAgentNote({ requestId, proof, principal, note: requiredString(payload, 'note') });
      }
      case 'prepare_side_effect': {
        const proof = leaseProof(request, payload);
        const stageAttemptId = requiredString(payload, 'stage_attempt_id');
        return services.operations.prepare({
          requestId, proof, principal, stageAttemptId, actionType: requiredString(payload, 'action_type'),
          targetFingerprint: requiredString(payload, 'target_fingerprint'),
          parameters: payload['parameters'] as Record<string, unknown>,
          summary: requiredString(payload, 'summary'),
          ...(payload['ttl_ms'] === undefined ? {} : { ttlMs: Number(payload['ttl_ms']) }),
        });
      }
      case 'execute_side_effect': {
        const proof = leaseProof(request, payload);
        const operationId = requiredString(payload, 'operation_id');
        return services.operations.execute({ requestId, proof, principal, operationId });
      }
      case 'reconcile_side_effect': {
        const proof = leaseProof(request, payload);
        const operationId = requiredString(payload, 'operation_id');
        return services.operations.reconcile({ requestId, proof, principal, operationId });
      }
      case 'pause_run': {
        const proof = leaseProof(request, payload);
        return services.runs.pauseRun({ requestId, proof, principal });
      }
      case 'cancel_run': {
        const proof = leaseProof(request, payload);
        return services.runs.cancelRun({ requestId, proof, principal });
      }
      case 'finalize_run': {
        const proof = leaseProof(request, payload);
        return services.runs.finalizeRun({ requestId, proof, principal });
      }
    }
  };

  const submitConfirmation: ConfirmationDispatcher = (request, internalPrincipal) => {
    const principal = derivePrincipal(services.db, internalPrincipal);
    const payload = request.payload;
    const row = services.db.prepare('SELECT expires_at FROM confirmation_requests WHERE id=?')
      .get(payload.confirmation_request_id) as { expires_at: string } | undefined;
    if (row === undefined) throw new Error('NOT_FOUND: confirmation');
    if (row.expires_at !== payload.expires_at) throw new Error('POLICY_VIOLATION: confirmation expiry mismatch');
    return services.confirmations.submitDecision({
      confirmationRequestId: payload.confirmation_request_id,
      nonce: payload.nonce,
      exactActionHash: payload.exact_action_hash,
      decision: payload.decision,
      principal: { ...principal, trustedInteractive: true },
    });
  };

  return { dispatch, submitConfirmation };
}
