import { Type, type Static } from '@sinclair/typebox';

export const HostCapabilityManifestSchema = Type.Object({
  clientType: Type.Union([Type.Literal('codex'), Type.Literal('claude')]),
  adapterVersion: Type.String({ minLength: 1 }),
  trustedRootSessionIdentity: Type.Boolean(),
  parallelSubagentIsolation: Type.Boolean(),
  trustedInteractiveConfirmation: Type.Boolean(),
  managedOperationExecution: Type.Boolean(),
}, { additionalProperties: false });

export type HostCapabilityManifest = Static<typeof HostCapabilityManifestSchema>;
