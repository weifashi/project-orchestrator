export type OperationDriver = {
  actionType: string;
  executable: string;
  allowedParameterKeys: string[];
  fixedArgs: string[];
  timeoutMs: number;
  credentialFile?: string;
  reconcileArgs?: string[];
};
export type OperationRequest =
  | { kind: 'execute'; actionType: string; targetFingerprint: string; parameters: Record<string, unknown> }
  | { kind: 'reconcile'; actionType: string; targetFingerprint: string; operationId: string; externalReference?: string };
export type OperationResult = { status: 'succeeded' | 'unknown'; externalReference?: string; evidence: { exitCode: number | null; stdout: string; stderr: string; truncated: boolean } };
