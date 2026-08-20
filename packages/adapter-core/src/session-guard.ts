import type { AgentToolName } from '@project-orchestrator/contracts';
import type { RecoveryCredentialStore } from './session-state-store.js';

export type RootInvocation = Readonly<{ kind: 'root'; sessionId: string }>;
export type SubagentInvocation = Readonly<{ kind: 'subagent'; sessionId: string; rootSessionId: string }>;
export type InvocationPrincipal = RootInvocation | SubagentInvocation;
export type LeaseMaterial = Readonly<{ leaseEpoch: number; leaseToken: string }>;

type ToolEnvelope = Readonly<{
  kind: 'tool';
  tool: AgentToolName;
  payload: Readonly<Record<string, unknown>>;
}>;

export class SessionGuard {
  readonly #rootSessionId: string;
  readonly #leases = new Map<string, LeaseMaterial>();
  readonly #recoveryCredentials = new Map<string, string>();
  readonly #recoveryStore: RecoveryCredentialStore | undefined;

  constructor(input: { sessionId: string; recoveryStore?: RecoveryCredentialStore }) {
    if (input.sessionId.length === 0) throw new Error('ROOT_SESSION_ID_REQUIRED');
    this.#rootSessionId = input.sessionId;
    this.#recoveryStore = input.recoveryStore;
  }

  rootPrincipal(): RootInvocation {
    return Object.freeze({ kind: 'root', sessionId: this.#rootSessionId });
  }

  assertCanWrite(principal: InvocationPrincipal, tool: AgentToolName): void {
    if (tool.length === 0) throw new Error('TOOL_NAME_REQUIRED');
    if (principal.kind !== 'root' || principal.sessionId !== this.#rootSessionId) {
      throw new Error('SUBAGENT_WRITE_FORBIDDEN');
    }
  }

  rememberLease(runId: string, lease: LeaseMaterial): void {
    if (!Number.isInteger(lease.leaseEpoch) || lease.leaseEpoch < 1 || lease.leaseToken.length === 0) {
      throw new Error('INVALID_LEASE_MATERIAL');
    }
    this.#leases.set(runId, Object.freeze({ ...lease }));
  }

  rememberRecoveryCredential(runId: string, credential: string): void {
    if (credential.length > 0) {
      this.#recoveryCredentials.set(runId, credential);
      this.#recoveryStore?.set(runId, credential);
    }
  }

  recoveryCredential(runId: string): string | undefined {
    return this.#recoveryCredentials.get(runId) ?? this.#recoveryStore?.get(runId);
  }

  expectedLeaseEpoch(runId: string): number {
    return this.#leases.get(runId)?.leaseEpoch ?? 0;
  }

  attachLease(principal: InvocationPrincipal, envelope: ToolEnvelope): ToolEnvelope & {
    lease_epoch: number;
    lease_token: string;
  } {
    this.assertCanWrite(principal, envelope.tool);
    const runId = String(envelope.payload['run_id'] ?? '');
    const lease = this.#leases.get(runId);
    if (lease === undefined) throw new Error('LEASE_NOT_AVAILABLE');
    return Object.freeze({ ...envelope, lease_epoch: lease.leaseEpoch, lease_token: lease.leaseToken });
  }

  forgetRun(runId: string): void {
    this.#leases.delete(runId);
    this.#recoveryCredentials.delete(runId);
    this.#recoveryStore?.delete(runId);
  }
}
