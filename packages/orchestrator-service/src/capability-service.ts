import type Database from 'better-sqlite3';
import {
  ContractValidator,
  HostCapabilityManifestSchema,
  type HostCapabilityManifest,
} from '@project-orchestrator/contracts';
import type { ContentStore } from '@project-orchestrator/content-store';

export function readRunCapabilities(
  db: Database.Database,
  content: ContentStore,
  runId: string,
): HostCapabilityManifest {
  const row = db.prepare('SELECT adapter_capability_object_id FROM run_snapshots WHERE run_id=?')
    .get(runId) as { adapter_capability_object_id: string } | undefined;
  if (!row) throw new Error('NOT_FOUND: run capability snapshot');
  try {
    content.verify(row.adapter_capability_object_id);
    const value = JSON.parse(Buffer.from(content.read(row.adapter_capability_object_id)).toString('utf8')) as unknown;
    return new ContractValidator().check(HostCapabilityManifestSchema, value);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('NOT_FOUND: run capability snapshot')) throw error;
    throw new Error(`ADAPTER_CAPABILITY_INVALID: ${error instanceof Error ? error.message : 'invalid manifest'}`);
  }
}

export function requireTrustedConfirmation(capability: HostCapabilityManifest): void {
  if (!capability.trustedInteractiveConfirmation) throw new Error('TRUSTED_CONFIRMATION_UNAVAILABLE');
}

export function requireManagedOperations(capability: HostCapabilityManifest): void {
  if (!capability.managedOperationExecution) throw new Error('MANAGED_OPERATION_UNAVAILABLE');
}
