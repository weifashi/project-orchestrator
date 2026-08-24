import type { WorkflowCanvasGroup, WorkflowEdge, WorkflowStage, WorkflowVersionEnvelope } from "@project-orchestrator/contracts";

export type CanvasPosition = { x: number; y: number };
export type GraphDiagnostic = { code: "cycle" | "missing-edge" | "no-entry" | "unreachable" | "gate-bypass"; stageKeys: string[] };
type CanvasNodePositionChange = { id?: string; type: string; position?: CanvasPosition; dragging?: boolean };

export const trackCanvasNodePositions = (current: Record<string, CanvasPosition>, changes: readonly CanvasNodePositionChange[], stageKeys: readonly string[]) => {
  const validKeys = new Set(stageKeys);
  const moved = changes.filter((change): change is CanvasNodePositionChange & { id: string; position: CanvasPosition } => {
    const id = change.id;
    return change.type === "position" && typeof id === "string" && Boolean(change.position) && validKeys.has(id);
  });
  if (!moved.length) return undefined;
  const positions = { ...current };
  for (const change of moved) positions[change.id] = change.position;
  return { positions, commit: moved.some((change) => !change.dragging) };
};

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

export const autoLayout = (envelope: WorkflowVersionEnvelope): WorkflowVersionEnvelope => {
  const withoutPositions = { ...envelope, data: { ...envelope.data, canvas: { ...envelope.data.canvas, nodes: [] } } };
  return updateCanvas(envelope, nodePositions(withoutPositions.data));
};

const canvas = (envelope: WorkflowVersionEnvelope) => ({ nodes: envelope.data.canvas?.nodes ?? [], groups: envelope.data.canvas?.groups ?? [] });
const withCanvas = (envelope: WorkflowVersionEnvelope, patch: Partial<NonNullable<WorkflowVersionEnvelope["data"]["canvas"]>>): WorkflowVersionEnvelope => ({
  ...envelope,
  data: { ...envelope.data, canvas: { ...canvas(envelope), ...envelope.data.canvas, ...patch } },
});

export const updateCanvasViewport = (envelope: WorkflowVersionEnvelope, viewport: { x: number; y: number; zoom: number }) =>
  withCanvas(envelope, { viewport_x: viewport.x, viewport_y: viewport.y, viewport_zoom: viewport.zoom });

export const createCanvasGroup = (envelope: WorkflowVersionEnvelope, id: string, label: string, stageKeys: string[]) => {
  const valid = [...new Set(stageKeys)].filter((key) => envelope.data.stages.some((stage) => stage.key === key));
  if (!id.trim() || !label.trim() || !valid.length || canvas(envelope).groups.some((group) => group.id === id)) return envelope;
  return withCanvas(envelope, { groups: [...canvas(envelope).groups, { id, label, stage_keys: valid, collapsed: false }] });
};

export const toggleCanvasGroup = (envelope: WorkflowVersionEnvelope, id: string) => {
  const groups = canvas(envelope).groups;
  if (!groups.some((group) => group.id === id)) return envelope;
  return withCanvas(envelope, { groups: groups.map((group) => group.id === id ? { ...group, collapsed: !group.collapsed } : group) });
};

export const renameCanvasGroup = (envelope: WorkflowVersionEnvelope, id: string, label: string) => {
  if (!label.trim() || !canvas(envelope).groups.some((group) => group.id === id)) return envelope;
  return withCanvas(envelope, { groups: canvas(envelope).groups.map((group) => group.id === id ? { ...group, label: label.trim() } : group) });
};

export const removeGraphSelection = (envelope: WorkflowVersionEnvelope, stageKeys: string[], edgeIds: string[]) => {
  const stages = new Set(stageKeys);
  const protectedStage = envelope.data.stages.some((stage) => stages.has(stage.key) && stage.mandatory_gate);
  const indexedEdges = envelope.data.edges.map((edge, index) => ({ edge, id: `${edge.from}-${edge.to}-${index}` }));
  if (protectedStage) return envelope;
  const removableStages = envelope.data.stages.filter((stage) => !stages.has(stage.key));
  if (!removableStages.length) return envelope;
  const edges = indexedEdges
    .filter(({ edge, id }) => !edgeIds.includes(id) && !stages.has(edge.from) && !stages.has(edge.to))
    .map(({ edge }) => edge);
  return withCanvas({ ...envelope, data: { ...envelope.data, stages: removableStages, edges } }, {
    nodes: canvas(envelope).nodes.filter((node) => !stages.has(node.stage_key)),
    groups: canvas(envelope).groups
      .map((group) => ({ ...group, stage_keys: group.stage_keys.filter((key) => !stages.has(key)) }))
      .filter((group) => group.stage_keys.length > 0),
  });
};

export const groupForStage = (groups: WorkflowCanvasGroup[] | undefined, stageKey: string) => groups?.find((group) => group.stage_keys.includes(stageKey));

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
