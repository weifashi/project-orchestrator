import type { WorkflowVersionEnvelope } from '@project-orchestrator/contracts';
export type WorkflowData = WorkflowVersionEnvelope['data'];
function violation(message: string): never { throw new Error(`POLICY_VIOLATION: ${message}`); }
export function validateWorkflowGraph(workflow: WorkflowData): string[] {
  const keys = workflow.stages.map((stage) => stage.key);
  if (new Set(keys).size !== keys.length) violation('duplicate stage key');
  const stages = new Map(workflow.stages.map((stage) => [stage.key, stage]));
  const adjacency = new Map(keys.map((key) => [key, [] as string[]]));
  const indegree = new Map(keys.map((key) => [key, 0]));
  for (const edge of workflow.edges) {
    if (!stages.has(edge.from) || !stages.has(edge.to)) violation('edge references missing stage');
    adjacency.get(edge.from)?.push(edge.to); indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    const gate = stages.get(edge.to); if (gate?.mandatory_gate && edge.condition !== undefined) violation(`mandatory gate ${gate.key} has conditional dependency`);
  }
  const ready = keys.filter((key) => indegree.get(key) === 0).sort();
  if (ready.length === 0) violation('workflow dependency cycle');
  if (ready.length !== 1) violation('workflow must have exactly one root');
  const order: string[] = [];
  while (ready.length) { const key = ready.shift() as string; order.push(key); for (const next of (adjacency.get(key) ?? []).sort()) { const degree=(indegree.get(next) ?? 0)-1; indegree.set(next,degree); if (degree===0) { ready.push(next); ready.sort(); } } }
  if (order.length !== keys.length) violation('workflow dependency cycle or unreachable stage');
  const groupKeys = new Set<string>();
  for (const group of workflow.iteration_groups) {
    if (groupKeys.has(group.key)) violation('duplicate iteration group'); groupKeys.add(group.key);
    if (group.max_iterations < 1 || group.max_iterations > 3) violation('max_iterations outside 1..3');
    if (!stages.has(group.entry_stage_key) || group.gate_stage_keys.length === 0 || group.gate_stage_keys.includes(group.entry_stage_key)) violation('invalid iteration entry/gates');
    for (const gateKey of group.gate_stage_keys) { const gate=stages.get(gateKey); if (!gate || !gate.mandatory_gate || gate.optional || gate.condition !== undefined) violation(`mandatory gate ${gateKey} is bypassable`); }
  }
  for (const stage of workflow.stages) {
    if (stage.mandatory_gate && (stage.optional || stage.condition !== undefined)) violation(`mandatory gate ${stage.key} is bypassable`);
    if (stage.iteration_group_key !== undefined && !groupKeys.has(stage.iteration_group_key)) violation(`missing iteration group ${stage.iteration_group_key}`);
  }
  return order;
}
