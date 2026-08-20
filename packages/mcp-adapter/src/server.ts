import {
  ContractValidator,
  type AgentToolName,
} from '@project-orchestrator/contracts';
import { INTERNAL_TOOL_REQUEST_SCHEMAS } from '@project-orchestrator/contracts/internal-ipc';
import type { HostCapabilities, InvocationPrincipal, SessionGuard } from '@project-orchestrator/adapter-core';
import { createToolRegistry, type ToolDefinition } from './tool-registry.js';

type WorkspaceState = Readonly<{
  repositoryHead: string;
  stagedPatch: string;
  unstagedPatch: string;
  untrackedManifest: unknown;
  submoduleManifest: unknown;
}>;

const HIDDEN_KEYS = new Set([
  'lease_token', 'lease_epoch', 'recovery_credential',
  'leaseToken', 'leaseEpoch', 'recoveryCredential',
  'credential', 'nonce',
]);

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !HIDDEN_KEYS.has(key))
    .map(([key, child]) => [snakeCase(key), stripSecrets(child)]));
}

function wireWorkspace(state: WorkspaceState): Record<string, unknown> {
  return {
    repository_head: state.repositoryHead,
    staged_patch: state.stagedPatch,
    unstaged_patch: state.unstagedPatch,
    untracked_manifest: state.untrackedManifest,
    submodule_manifest: state.submoduleManifest,
  };
}

export class AdapterRuntime {
  readonly capabilities: HostCapabilities;
  readonly #guard: SessionGuard;
  readonly #send: (request: unknown) => Promise<unknown>;
  readonly #principal: InvocationPrincipal;
  readonly #workspace: () => WorkspaceState;
  readonly #validator = new ContractValidator();

  constructor(input: {
    capabilities: HostCapabilities;
    sessionGuard: SessionGuard;
    send: (request: unknown) => Promise<unknown>;
    principal?: InvocationPrincipal;
    workspace?: () => WorkspaceState;
  }) {
    this.capabilities = input.capabilities;
    this.#guard = input.sessionGuard;
    this.#send = input.send;
    this.#principal = input.principal ?? input.sessionGuard.rootPrincipal();
    this.#workspace = input.workspace ?? (() => {
      throw new Error('WORKSPACE_SNAPSHOT_UNAVAILABLE');
    });
  }

  tools(): ToolDefinition[] {
    return createToolRegistry({ invoke: (name, payload) => this.invoke(name, payload) });
  }

  async invoke(tool: AgentToolName, payload: Record<string, unknown>): Promise<unknown> {
    this.#guard.assertCanWrite(this.#principal, tool);
    if (['request_confirmation', 'prepare_side_effect', 'execute_side_effect'].includes(tool)
      && !this.capabilities.trustedInteractiveConfirmation) {
      throw new Error('HOST_CONFIRMATION_UNAVAILABLE');
    }
    let internal: Record<string, unknown>;
    if (tool === 'create_run') {
      internal = { kind: 'tool', tool, payload: { ...payload, workspace: wireWorkspace(this.#workspace()) } };
    } else if (tool === 'claim_run') {
      const runId = String(payload['run_id']);
      const recoveryCredential = this.#guard.recoveryCredential(runId);
      internal = {
        kind: 'tool', tool, payload,
        expected_lease_epoch: this.#guard.expectedLeaseEpoch(runId),
        ...(recoveryCredential === undefined ? {} : { recovery_credential: recoveryCredential }),
      };
    } else {
      internal = this.#guard.attachLease(this.#principal, { kind: 'tool', tool, payload });
    }
    this.#validator.check(INTERNAL_TOOL_REQUEST_SCHEMAS[tool], internal);
    const result = await this.#send(internal);
    this.#rememberSecrets(tool, payload, result);
    return stripSecrets(result);
  }

  #rememberSecrets(tool: AgentToolName, payload: Record<string, unknown>, result: unknown): void {
    if (result === null || typeof result !== 'object') return;
    const record = result as Record<string, unknown>;
    const runId = typeof record['run_id'] === 'string' ? record['run_id'] : String(payload['run_id'] ?? '');
    if (runId.length === 0) return;
    const recoveryCredential = record['recovery_credential'] ?? record['recoveryCredential'];
    if (typeof recoveryCredential === 'string') {
      this.#guard.rememberRecoveryCredential(runId, recoveryCredential);
    }
    const leaseToken = record['lease_token'] ?? record['leaseToken'];
    const leaseEpoch = record['lease_epoch'] ?? record['leaseEpoch'];
    if (typeof leaseToken === 'string' && Number.isInteger(leaseEpoch)) {
      this.#guard.rememberLease(runId, {
        leaseEpoch: Number(leaseEpoch),
        leaseToken,
      });
    }
    if (tool === 'cancel_run' || tool === 'finalize_run') this.#guard.forgetRun(runId);
  }
}
