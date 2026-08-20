import type Database from 'better-sqlite3';
export type RunRow={id:string;project_id:string;workflow_version_id:string;objective:string;input_envelope:string;client_installation_id:string;origin_session_id:string;lease_holder_session_id:string|null;status:string;lease_epoch:number;lease_token_hash:string|null;lease_expires_at:string|null;recovery_credential_hash:string|null;next_event_sequence:number;is_retryable:number;updated_at:string};
export type StageRunRow={id:string;run_id:string;stage_key:string;iteration_group_key:string|null;iteration_number:number;role_version_id:string;status:string;latest_attempt_id:string|null;max_attempts:number};
export class RunRepository {
 constructor(readonly db:Database.Database){}
 transaction<T>(work:()=>T):T{return this.db.transaction(work).immediate();}
 getRun(id:string):RunRow|undefined{return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as RunRow|undefined;}
 getStageRun(id:string):StageRunRow|undefined{return this.db.prepare('SELECT * FROM stage_runs WHERE id=?').get(id) as StageRunRow|undefined;}
 listStageRuns(runId:string):StageRunRow[]{return this.db.prepare('SELECT * FROM stage_runs WHERE run_id=? ORDER BY created_at,id').all(runId) as StageRunRow[];}
 updateRunState(id:string,expected:string,next:string,fields:Record<string,unknown>={}):void{const entries=Object.entries(fields);const sql=`UPDATE runs SET status=?,updated_at=?${entries.map(([k])=>`,${k}=?`).join('')} WHERE id=? AND status=?`;const result=this.db.prepare(sql).run(next,new Date().toISOString(),...entries.map(([,v])=>v),id,expected);if(result.changes!==1)throw new Error(`INVALID_TRANSITION: run ${expected} -> ${next}`);}
 updateStageState(id:string,expected:string,next:string,fields:Record<string,unknown>={}):void{const entries=Object.entries(fields);const sql=`UPDATE stage_runs SET status=?,updated_at=?${entries.map(([k])=>`,${k}=?`).join('')} WHERE id=? AND status=?`;const result=this.db.prepare(sql).run(next,new Date().toISOString(),...entries.map(([,v])=>v),id,expected);if(result.changes!==1)throw new Error(`INVALID_TRANSITION: stage ${expected} -> ${next}`);}
}
