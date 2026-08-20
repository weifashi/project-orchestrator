import type { WorkflowVersionEnvelope } from '@project-orchestrator/contracts';
import { evaluateCondition, type EvaluationContext } from './condition.js';
import { validateWorkflowGraph } from './graph.js';
export type StageProjection=Readonly<{stageKey:string;status:'queued'|'ready'|'running'|'waiting_for_user'|'succeeded'|'failed'|'skipped'|'cancelled'|'interrupted';iterationNumber?:number}>;
export type Frontier={ready:string[];blocked:Array<{stageKey:string;reason:string}>;skipped:string[];waitingForUser:string[]};
export function deriveFrontier(workflow:WorkflowVersionEnvelope['data'], projections:readonly StageProjection[], context:EvaluationContext):Frontier {
 const order=validateWorkflowGraph(workflow); const rank=new Map(order.map((key,index)=>[key,index])); const current=new Map(projections.map((p)=>[p.stageKey,p]));
 const result:Frontier={ready:[],blocked:[],skipped:[],waitingForUser:[]};
 for(const stage of workflow.stages){ const p=current.get(stage.key); if(p?.status==='waiting_for_user'){result.waitingForUser.push(stage.key);continue;} if(p && p.status!=='queued'&&p.status!=='ready')continue;
  const incoming=workflow.edges.filter((edge)=>edge.to===stage.key); const unsatisfied:string[]=[];
  for(const edge of incoming){const source=current.get(edge.from)?.status;
   if(source===undefined||['queued','ready','running','waiting_for_user'].includes(source)){unsatisfied.push(edge.from);continue;}
   if(!evaluateCondition(edge.condition,context))continue;
   if(edge.edge_type==='on_success'?source!=='succeeded':!['succeeded','skipped'].includes(source))unsatisfied.push(edge.from);
  }
  if(unsatisfied.length>0){result.blocked.push({stageKey:stage.key,reason:`dependencies:${unsatisfied.join(',')}`});continue;}
  if(!evaluateCondition(stage.condition,context)){ if(stage.optional) result.skipped.push(stage.key); else result.blocked.push({stageKey:stage.key,reason:'condition_false'}); continue; }
  result.ready.push(stage.key);
 }
 const sorter=(a:string,b:string)=>(rank.get(a)??999)-(rank.get(b)??999); result.ready.sort(sorter); result.skipped.sort(sorter); result.waitingForUser.sort(sorter); result.blocked.sort((a,b)=>sorter(a.stageKey,b.stageKey)); return result;
}
