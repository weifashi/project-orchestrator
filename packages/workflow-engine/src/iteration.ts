import type { WorkflowIterationGroup } from '@project-orchestrator/contracts';
export type IterationProjection=Readonly<{iterationNumber:number;status:'running'|'succeeded'|'failed'}>;
export type IterationDecision=Readonly<{createIteration?:number;createStageRuns:string[];markIteration?:'succeeded'|'failed';markRunFailed:boolean}>;
export function reduceIteration(group:WorkflowIterationGroup, current:IterationProjection, gateStatuses:Readonly<Record<string,string>>):IterationDecision {
 if(current.status!=='running') return {createStageRuns:[],markRunFailed:false};
 const statuses=group.gate_stage_keys.map((key)=>gateStatuses[key]); if(statuses.some((s)=>s===undefined||['queued','ready','running','waiting_for_user'].includes(s))) return {createStageRuns:[],markRunFailed:false};
 if(statuses.every((s)=>s==='succeeded')) return {createStageRuns:[],markIteration:'succeeded',markRunFailed:false};
 if(current.iterationNumber>=group.max_iterations) return {createStageRuns:[],markIteration:'failed',markRunFailed:true};
 return {createIteration:current.iterationNumber+1,createStageRuns:[group.entry_stage_key,...group.gate_stage_keys],markIteration:'failed',markRunFailed:false};
}
