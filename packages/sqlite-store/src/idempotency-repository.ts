/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto'; import type Database from 'better-sqlite3';
export type IdempotencyResult={kind:'new';id:string}|{kind:'replay';response:unknown};
export class IdempotencyRepository {
 constructor(readonly db:Database.Database){}
 begin(principalId:string,operation:string,requestId:string,requestHash:string):IdempotencyResult {
  const row=this.db.prepare('SELECT id,request_hash,response_envelope,status,error_envelope FROM idempotency_requests WHERE principal_id=? AND operation=? AND request_id=?').get(principalId,operation,requestId) as any;
  if(row){if(row.request_hash!==requestHash) throw new Error('IDEMPOTENCY_CONFLICT'); if(row.status==='completed') return {kind:'replay',response:JSON.parse(row.response_envelope)}; if(row.status==='failed') throw new Error(`IDEMPOTENT_FAILURE: ${row.error_envelope??''}`); throw new Error('IDEMPOTENCY_IN_PROGRESS');}
  const id=randomUUID(); this.db.prepare("INSERT INTO idempotency_requests(id,principal_id,operation,request_id,request_hash,status,created_at) VALUES(?,?,?,?,?,'in_progress',?)").run(id,principalId,operation,requestId,requestHash,new Date().toISOString()); return {kind:'new',id};
 }
 complete(id:string,response:unknown):void{const r=this.db.prepare("UPDATE idempotency_requests SET status='completed',response_envelope=? WHERE id=? AND status='in_progress'").run(JSON.stringify(response),id);if(r.changes!==1)throw new Error('IDEMPOTENCY_INVALID_STATE');}
 fail(id:string,error:unknown):void{this.db.prepare("UPDATE idempotency_requests SET status='failed',error_envelope=? WHERE id=? AND status='in_progress'").run(JSON.stringify(error),id);}
}
