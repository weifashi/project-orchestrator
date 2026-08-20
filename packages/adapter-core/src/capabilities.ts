import type { HostCapabilityManifest } from '@project-orchestrator/contracts';

export type HostCapabilities = HostCapabilityManifest;

export function createConservativeCapabilities(
  clientType: HostCapabilities['clientType'],
  adapterVersion: string,
  overrides: Partial<Pick<HostCapabilities, 'trustedInteractiveConfirmation' | 'managedOperationExecution'>> = {},
): HostCapabilities {
  return Object.freeze({
    clientType,
    adapterVersion,
    trustedRootSessionIdentity: true,
    parallelSubagentIsolation: false,
    trustedInteractiveConfirmation: overrides.trustedInteractiveConfirmation ?? false,
    managedOperationExecution: overrides.managedOperationExecution ?? true,
  });
}
