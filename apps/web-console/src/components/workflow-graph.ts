import type { WorkflowEdge, WorkflowStage, WorkflowVersionEnvelope } from "@project-orchestrator/contracts";

export type CanvasPosition = { x: number; y: number };
export type GraphDiagnostic = { code: "cycle" | "missing-edge" | "no-entry" | "unreachable" | "gate-bypass"; stageKeys: string[] };

export const nodePositions = (data: WorkflowVersionEnvelope["data"]): Record<string, CanvasPosition> => {
  const saved = new Map((data.canvas?.nodes ?? []).map((node) => [node.stage_key, { x: node.x, y: node.y }]));
  const incoming = new Map(data.stages.map((stage) => [stage.key, 0]));
  for (const edge of data.edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const queue = data.stages.filter((stage) => incoming.get(stage.key) === 0).map((stage) => stage.key);
  const rank = new Map<string, number>();
  queue.forEach((key) => rank.set(key, 0));
  while (queue.length) {
    const key = queue.shift()!;
    for (const edge of data.edges.filter((item) => item.from === key)) {
      rank.set(edge.to, Math.max(rank.get(edge.to) ?? 0, (rank.get(key) ?? 0) + 1));
      incoming.set(edge.to, (incoming.get(edge.to) ?? 1) - 1);
      if (incoming.get(edge.to) === 0) queue.push(edge.to);
    }
  }
  const rows = new Map<number, number>();
  return Object.fromEntries(data.stages.map((stage, index) => {
    const x = rank.get(stage.key) ?? index;
    const row = rows.get(x) ?? 0;
    rows.set(x, row + 1);
    return [stage.key, saved.get(stage.key) ?? { x: 42 + x * 245, y: 48 + row * 142 }];
  }));
};

export const updateCanvas = (envelope: WorkflowVersionEnvelope, positions: Record<string, CanvasPosition>): WorkflowVersionEnvelope => ({
  ...envelope,
  data: {
    ...envelope.data,
    canvas: { ...envelope.data.canvas, nodes: envelope.data.stages.map((stage) => ({ stage_key: stage.key, ...positions[stage.key]! })) },
  },
});

const reachable = (roots: string[], edges: WorkflowEdge[], omitted?: string) => {
  const seen = new Set<string>(); const todo = [...roots];
  while (todo.length) { const key = todo.shift()!; if (key === omitted || seen.has(key)) continue; seen.add(key); for (const edge of edges) if (edge.from === key && edge.to !== omitted) todo.push(edge.to); }
  return seen;
};

export const validateGraph = (stages: WorkflowStage[], edges: WorkflowEdge[]): GraphDiagnostic[] => {
  const keys = new Set(stages.map((stage) => stage.key));
  const diagnostics: GraphDiagnostic[] = [];
  const bad = edges.filter((edge) => !keys.has(edge.from) || !keys.has(edge.to) || edge.from === edge.to);
  if (bad.length) diagnostics.push({ code: "missing-edge", stageKeys: [...new Set(bad.flatMap((edge) => [edge.from, edge.to]))] });
  const valid = edges.filter((edge) => keys.has(edge.from) && keys.has(edge.to) && edge.from !== edge.to);
  const roots = stages.filter((stage) => !valid.some((edge) => edge.to === stage.key)).map((stage) => stage.key);
  if (!roots.length) diagnostics.push({ code: "no-entry", stageKeys: stages.map((stage) => stage.key) });
  const seen = reachable(roots, valid);
  const unreachable = stages.filter((stage) => !seen.has(stage.key)).map((stage) => stage.key);
  if (unreachable.length) diagnostics.push({ code: "unreachable", stageKeys: unreachable });
  const visiting = new Set<string>(), visited = new Set<string>(), cycle = new Set<string>();
  const walk = (key: string) => { if (visiting.has(key)) { cycle.add(key); return; } if (visited.has(key)) return; visiting.add(key); valid.filter((edge) => edge.from === key).forEach((edge) => walk(edge.to)); visiting.delete(key); visited.add(key); };
  stages.forEach((stage) => walk(stage.key));
  if (cycle.size) diagnostics.push({ code: "cycle", stageKeys: [...cycle] });
  const target = stages.find((stage) => stage.key === "operations");
  if (target) for (const gate of stages.filter((stage) => stage.mandatory_gate)) if (reachable(roots, valid, gate.key).has(target.key)) diagnostics.push({ code: "gate-bypass", stageKeys: [gate.key, target.key] });
  return diagnostics;
};

export const insertStageAfter = (envelope: WorkflowVersionEnvelope, selected: string | undefined, stage: WorkflowStage) => {
  const outgoing = selected ? envelope.data.edges.filter((edge) => edge.from === selected) : [];
  const retained = selected ? envelope.data.edges.filter((edge) => edge.from !== selected) : envelope.data.edges;
  const edges = selected
    ? [...retained, { from: selected, to: stage.key, edge_type: "requires" as const }, ...outgoing.map((edge) => ({ ...edge, from: stage.key }))]
    : retained;
  return { ...envelope, data: { ...envelope.data, stages: [...envelope.data.stages, stage], edges } };
};
