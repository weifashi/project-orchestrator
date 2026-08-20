/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EventType } from '@project-orchestrator/contracts';
export type EventRecord={id:string;runId:string;stageRunId:string|null;sequenceNumber:number;eventType:string;sourcePrincipalId:string;payload:unknown;createdAt:string};
export class EventRepository {
 constructor(readonly db:Database.Database){}
 append(runId:string,eventType:EventType,sourcePrincipalId:string,payload:unknown,stageRunId?:string):EventRecord {
  return this.db.transaction(() => {
  const row=this.db.prepare('SELECT next_event_sequence FROM runs WHERE id=?').get(runId) as {next_event_sequence:number}|undefined; if(!row) throw new Error(`NOT_FOUND: run ${runId}`);
  const advanced=this.db.prepare('UPDATE runs SET next_event_sequence=next_event_sequence+1 WHERE id=? AND next_event_sequence=?').run(runId,row.next_event_sequence); if(advanced.changes!==1) throw new Error('EVENT_SEQUENCE_CONFLICT');
  const record={id:randomUUID(),runId,stageRunId:stageRunId??null,sequenceNumber:row.next_event_sequence,eventType,sourcePrincipalId,payload,createdAt:new Date().toISOString()};
  this.db.prepare('INSERT INTO events(id,run_id,stage_run_id,sequence_number,event_type,source_principal_id,payload_envelope,created_at) VALUES(?,?,?,?,?,?,?,?)').run(record.id,runId,record.stageRunId,record.sequenceNumber,eventType,sourcePrincipalId,JSON.stringify(payload),record.createdAt); return record;
  }).immediate();
 }
 list(runId:string,after=0):EventRecord[]{return (this.db.prepare('SELECT * FROM events WHERE run_id=? AND sequence_number>? ORDER BY sequence_number').all(runId,after) as any[]).map((r)=>({id:r.id,runId:r.run_id,stageRunId:r.stage_run_id,sequenceNumber:r.sequence_number,eventType:r.event_type,sourcePrincipalId:r.source_principal_id,payload:JSON.parse(r.payload_envelope),createdAt:r.created_at}));}
}
