/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'; import type Database from 'better-sqlite3'; import type { AdapterPrincipal,LeaseProof } from './runtime-types.js';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const equalHash=(plain:string,digest:string):boolean=>{const a=Buffer.from(hash(plain),'hex'),b=Buffer.from(digest,'hex');return a.length===b.length&&timingSafeEqual(a,b);};
export type ClaimedLease=Readonly<{leaseEpoch:number;leaseToken:string;recoveryCredential:string;expiresAt:string}>;
export class LeaseService {
 constructor(readonly db:Database.Database,readonly serverEpoch:number=Date.now(),readonly ttlMs=30_000){}
 claim(runId:string,principal:AdapterPrincipal,mode:'start'|'resume'|'recover'|'retry',recoveryCredential?:string):ClaimedLease {
  if(principal.sessionId!==principal.rootSessionId) throw new Error('POLICY_VIOLATION: subagent cannot claim run');
  return this.db.transaction(()=>{const run=this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as any;if(!run)throw new Error('NOT_FOUND: run');if(run.client_installation_id!==principal.installationId)throw new Error('POLICY_VIOLATION: wrong installation');
   const expected=mode==='start'?['created']:mode==='resume'?['paused']:mode==='recover'?['interrupted']:['failed']; if(!expected.includes(run.status))throw new Error(`INVALID_TRANSITION: ${run.status} claim ${mode}`);
   if(mode!=='start'&&(!recoveryCredential||!run.recovery_credential_hash||!equalHash(recoveryCredential,run.recovery_credential_hash)))throw new Error('STALE_LEASE: recovery credential mismatch');
   if(mode==='retry'&&!run.is_retryable)throw new Error('INVALID_TRANSITION: run is not retryable');
   const leaseToken=randomBytes(32).toString('base64url'), recovery=randomBytes(32).toString('base64url'), epoch=run.lease_epoch+1, expiresAt=new Date(Date.now()+this.ttlMs).toISOString();
   this.db.prepare("UPDATE runs SET status='running',lease_epoch=?,server_epoch=?,lease_token_hash=?,lease_expires_at=?,lease_holder_session_id=?,recovery_credential_hash=?,updated_at=? WHERE id=?").run(epoch,this.serverEpoch,hash(leaseToken),expiresAt,principal.rootSessionId,hash(recovery),new Date().toISOString(),runId);
   return Object.freeze({leaseEpoch:epoch,leaseToken,recoveryCredential:recovery,expiresAt});
  }).immediate();
 }
 validate(proof:LeaseProof,principal:AdapterPrincipal):void {if(principal.sessionId!==principal.rootSessionId)throw new Error('POLICY_VIOLATION: subagent write rejected');const run=this.db.prepare('SELECT * FROM runs WHERE id=?').get(proof.runId) as any;if(!run||run.client_installation_id!==principal.installationId||run.lease_holder_session_id!==principal.rootSessionId||run.lease_epoch!==proof.leaseEpoch||run.server_epoch!==this.serverEpoch||!run.lease_token_hash||!equalHash(proof.leaseToken,run.lease_token_hash)||!run.lease_expires_at||Date.parse(run.lease_expires_at)<=Date.now())throw new Error('STALE_LEASE');}
 heartbeat(proof:LeaseProof,principal:AdapterPrincipal):string {this.validate(proof,principal);const expiresAt=new Date(Date.now()+this.ttlMs).toISOString();const r=this.db.prepare('UPDATE runs SET lease_expires_at=?,updated_at=? WHERE id=? AND lease_epoch=? AND server_epoch=?').run(expiresAt,new Date().toISOString(),proof.runId,proof.leaseEpoch,this.serverEpoch);if(r.changes!==1)throw new Error('STALE_LEASE');return expiresAt;}
 release(runId:string):void{this.db.prepare('UPDATE runs SET lease_token_hash=NULL,lease_expires_at=NULL,lease_holder_session_id=NULL WHERE id=?').run(runId);}
}
