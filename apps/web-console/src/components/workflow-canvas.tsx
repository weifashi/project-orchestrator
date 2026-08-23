import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background, Controls, Handle, MiniMap, Position, ReactFlow,
  type Connection, type Edge, type Node, type NodeProps, type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { WorkflowStage, WorkflowVersionEnvelope } from "@project-orchestrator/contracts";
import type { RoleSummary } from "../api/types";
import { insertStageAfter, nodePositions, updateCanvas, validateGraph } from "./workflow-graph";

type NodeData = { stage: WorkflowStage; label: string; selected?: boolean; state?: string; onQuickAdd?: (key: string) => void };
type Props = {
  envelope: WorkflowVersionEnvelope;
  roles: RoleSummary[];
  label: (value: string) => string;
  readonly?: boolean;
  stageStates?: Record<string, string>;
  onChange?: (envelope: WorkflowVersionEnvelope) => void;
  onSelect?: (key?: string) => void;
};

function StageNode({ data }: NodeProps<Node<NodeData>>) {
  const { stage, label, selected, state, onQuickAdd } = data;
  return <div className={`workflow-node ${stage.mandatory_gate ? "is-gate" : ""} ${selected ? "is-selected" : ""} ${state ? `is-${state}` : ""}`}>
    <Handle type="target" position={Position.Left} />
    <div className="workflow-node-title"><span>{label}</span>{stage.mandatory_gate && <small>●</small>}</div>
    <div className="workflow-node-meta">{state ?? (stage.mandatory_gate ? "安全门" : stage.optional ? "可选" : "阶段")}</div>
    {onQuickAdd && <button className="node-quick-add" title="在此后添加角色" aria-label={`在 ${label} 后添加角色`} onClick={(event) => { event.stopPropagation(); onQuickAdd(stage.key); }}>＋</button>}
    <Handle type="source" position={Position.Right} />
  </div>;
}
const nodeTypes = { stage: StageNode };
const defaultStage = (key: string, roleVersionId: string): WorkflowStage => ({ key, role_version_id: roleVersionId, optional: false, mandatory_gate: false, failure_policy: "pause", max_attempts: 1, requires_confirmation: false });
const uniqueKey = (base: string, stages: WorkflowStage[]) => { let count = 1, key = base; const all = new Set(stages.map((stage) => stage.key)); while (all.has(key)) key = `${base}-${++count}`; return key; };

export function WorkflowCanvas({ envelope, roles, label, readonly = false, stageStates = {}, onChange, onSelect }: Props) {
  const [selected, setSelected] = useState<string>();
  const positions = useMemo(() => nodePositions(envelope.data), [envelope.data]);
  const diagnostics = useMemo(() => validateGraph(envelope.data.stages, envelope.data.edges), [envelope.data.stages, envelope.data.edges]);
  const nodes = useMemo<Node<NodeData>[]>(() => envelope.data.stages.map((stage) => ({
    id: stage.key, type: "stage", position: positions[stage.key]!, data: { stage, label: label(stage.key), selected: selected === stage.key, state: stageStates[stage.key] ?? "queued", ...(!readonly ? { onQuickAdd: (key: string) => setSelected(key) } : {}) },
  })), [envelope.data.stages, label, positions, readonly, selected, stageStates]);
  const edges = useMemo<Edge[]>(() => envelope.data.edges.map((edge, index) => ({ id: `${edge.from}-${edge.to}-${index}`, source: edge.from, target: edge.to, type: "smoothstep", animated: Boolean(stageStates[edge.from] === "running"), ...(edge.edge_type === "on_success" ? { label: "成功后" } : {}), ...(stageStates[edge.from] === "failed" ? { className: "edge-failed" } : {}) })), [envelope.data.edges, stageStates]);
  useEffect(() => { if (selected && !envelope.data.stages.some((stage) => stage.key === selected)) setSelected(undefined); }, [envelope.data.stages, selected]);
  const select = useCallback((key?: string) => { setSelected(key); onSelect?.(key); }, [onSelect]);
  const writePositions = (changes: NodeChange<Node<NodeData>>[]) => {
    if (readonly || !onChange) return;
    const moved = changes.filter((change): change is Extract<NodeChange<Node<NodeData>>, { type: "position" }> => change.type === "position" && Boolean(change.position) && !change.dragging);
    if (!moved.length) return;
    const next = { ...positions };
    for (const change of moved) next[change.id] = change.position!;
    onChange(updateCanvas(envelope, next));
  };
  const addRole = (role: RoleSummary) => {
    if (readonly || !onChange || !role.current_version_id) return;
    const stage = defaultStage(uniqueKey(role.slug, envelope.data.stages), role.current_version_id);
    let next = insertStageAfter(envelope, selected, stage);
    const from = selected ? positions[selected] : undefined;
    const nextPositions = { ...positions, [stage.key]: from ? { x: from.x + 245, y: from.y } : { x: 46 + Object.keys(positions).length * 20, y: 70 + Object.keys(positions).length * 20 } };
    next = updateCanvas(next, nextPositions);
    onChange(next); select(stage.key);
  };
  const onConnect = (connection: Connection) => {
    if (readonly || !onChange || !connection.source || !connection.target || connection.source === connection.target || envelope.data.edges.some((edge) => edge.from === connection.source && edge.to === connection.target)) return;
    onChange({ ...envelope, data: { ...envelope.data, edges: [...envelope.data.edges, { from: connection.source, to: connection.target, edge_type: "requires" }] } });
  };
  return <div className={`workflow-canvas-layout ${readonly ? "is-readonly" : ""}`}>
    {!readonly && <aside className="role-palette" aria-label="角色库">
      <div><strong>角色库</strong><small>选中节点后点「＋」会自动插入并连接；未选中时只添加节点。</small></div>
      <div className="palette-list">{roles.filter((role) => role.status === "active" && role.current_version_id).map((role) => <button className="palette-role" key={role.id} onClick={() => addRole(role)}><span><strong>{role.name}</strong><small>{role.slug}</small></span><b aria-hidden>＋</b></button>)}</div>
    </aside>}
    <section className="canvas-stage" aria-label={readonly ? "实时运行画布" : "编排画布"}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.22 }} nodesDraggable={!readonly} nodesConnectable={!readonly} elementsSelectable onNodeClick={(_, node) => select(node.id)} onPaneClick={() => select(undefined)} onNodesChange={writePositions} onConnect={onConnect}>
        <Background gap={18} size={1} /><Controls showInteractive={false} /><MiniMap pannable zoomable />
      </ReactFlow>
      {diagnostics.length > 0 && !readonly && <div className="canvas-diagnostics" role="status">{diagnostics.map((item) => <span key={`${item.code}-${item.stageKeys.join()}`}>● {item.code === "cycle" ? "存在循环依赖" : item.code === "unreachable" ? "有节点未连接到入口" : item.code === "gate-bypass" ? "安全门可被绕过" : item.code === "no-entry" ? "请保留至少一个起点" : "存在无效连线"}：{item.stageKeys.map(label).join("、")}</span>)}</div>}
    </section>
  </div>;
}
