export type OperationDriver={actionType:string;executable:string;allowedParameterKeys:string[];fixedArgs:string[];timeoutMs:number};
export type OperationRequest={actionType:string;targetFingerprint:string;parameters:Record<string,unknown>};
export type OperationResult={status:'succeeded'|'unknown';externalReference?:string;evidence:{exitCode:number|null;stdout:string;stderr:string;truncated:boolean}};
