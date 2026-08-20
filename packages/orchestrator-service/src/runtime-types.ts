export type AdapterPrincipal=Readonly<{installationId:string;sessionId:string;rootSessionId:string;clientType:'codex'|'claude';canonicalProjectPath:string;trustedInteractive?:boolean}>;
export type LeaseProof=Readonly<{runId:string;leaseEpoch:number;leaseToken:string}>;
export type WorkspaceState=Readonly<{repositoryHead:string;stagedPatch:string;unstagedPatch:string;untrackedManifest:unknown;submoduleManifest:unknown}>;
export type AuthenticatedAdapterContext=Readonly<{canonicalProjectPath:string}>;
