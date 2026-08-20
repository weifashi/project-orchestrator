import type { WorkflowVersionEnvelope } from '@project-orchestrator/contracts';
export type WorkflowData = WorkflowVersionEnvelope['data'];
function violation(message: string): never { throw new Error(`POLICY_VIOLATION: ${message}`); }

export function validateWorkflowGraph(workflow: WorkflowData): string[] {
  const keys = workflow.stages.map((stage) => stage.key);
  if (new Set(keys).size !== keys.length) violation('duplicate stage key');
  const stages = new Map(workflow.stages.map((stage) => [stage.key, stage]));
  const adjacency = new Map(keys.map((key) => [key, [] as string[]]));
  const indegree = new Map(keys.map((key) => [key, 0]));
  const edgeKeys = new Set<string>();
  for (const edge of workflow.edges) {
    if (!stages.has(edge.from) || !stages.has(edge.to)) violation('edge references missing stage');
    const edgeKey = `${edge.from}\0${edge.to}\0${edge.edge_type}`;
    if (edgeKeys.has(edgeKey)) violation('duplicate edge');
    edgeKeys.add(edgeKey);
    adjacency.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    if (stages.get(edge.to)?.mandatory_gate && edge.condition !== undefined) violation(`mandatory gate ${edge.to} has conditional dependency`);
  }
  const ready = keys.filter((key) => indegree.get(key) === 0).sort();
  if (ready.length === 0) violation('workflow dependency cycle');
  if (ready.length !== 1) violation('workflow must have exactly one root');
  const root = ready[0] as string;
  const order: string[] = [];
  while (ready.length > 0) {
    const key = ready.shift() as string;
    order.push(key);
    for (const next of (adjacency.get(key) ?? []).sort()) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) { ready.push(next); ready.sort(); }
    }
  }
  if (order.length !== keys.length) violation('workflow dependency cycle or unreachable stage');
  const reachable = (from: string, to: string): boolean => {
    const pending = [from]; const visited = new Set<string>();
    while (pending.length > 0) {
      const key = pending.pop() as string;
      if (key === to) return true;
      if (visited.has(key)) continue;
      visited.add(key); pending.push(...(adjacency.get(key) ?? []));
    }
    return false;
  };
  if (workflow.stages.some((stage) => !reachable(root, stage.key))) violation('unreachable stage');

  const groupKeys = new Set<string>();
  for (const group of workflow.iteration_groups) {
    if (groupKeys.has(group.key)) violation('duplicate iteration group');
    groupKeys.add(group.key);
    if (group.max_iterations < 1 || group.max_iterations > 3) violation('max_iterations outside 1..3');
    if (group.gate_stage_keys.length === 0 || new Set(group.gate_stage_keys).size !== group.gate_stage_keys.length
      || group.gate_stage_keys.includes(group.entry_stage_key)) violation('invalid iteration entry/gates');
    const entry = stages.get(group.entry_stage_key);
    if (!entry || entry.optional || entry.condition !== undefined || entry.iteration_group_key !== group.key
      || entry.failure_policy !== 'trigger_iteration') violation('invalid iteration entry');
    const members = new Set([group.entry_stage_key, ...group.gate_stage_keys]);
    for (const gateKey of group.gate_stage_keys) {
      const gate = stages.get(gateKey);
      if (!gate || !gate.mandatory_gate || gate.optional || gate.condition !== undefined
        || gate.iteration_group_key !== group.key || gate.failure_policy !== 'trigger_iteration'
        || !reachable(group.entry_stage_key, gateKey)) violation(`mandatory gate ${gateKey} is bypassable`);
    }
    const exits = workflow.edges.filter((edge) => members.has(edge.from) && !members.has(edge.to)).map((edge) => edge.to);
    for (const exit of new Set(exits)) {
      for (const gateKey of group.gate_stage_keys) {
        const required = workflow.edges.some((edge) => edge.from === gateKey && edge.to === exit
          && edge.edge_type === 'on_success' && edge.condition === undefined);
        if (!required) violation(`mandatory gate ${gateKey} can be bypassed before ${exit}`);
      }
    }
  }
  for (const stage of workflow.stages) {
    if (stage.mandatory_gate && (stage.optional || stage.condition !== undefined || stage.iteration_group_key === undefined)) {
      violation(`mandatory gate ${stage.key} is bypassable`);
    }
    if (stage.iteration_group_key !== undefined && !groupKeys.has(stage.iteration_group_key)) violation(`missing iteration group ${stage.iteration_group_key}`);
    if (stage.iteration_group_key !== undefined) {
      const group = workflow.iteration_groups.find((candidate) => candidate.key === stage.iteration_group_key);
      if (group && stage.key !== group.entry_stage_key && !group.gate_stage_keys.includes(stage.key)) violation(`undeclared iteration member ${stage.key}`);
    }
  }
  return order;
}
