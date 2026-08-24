import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, Controls, Handle, Position, ReactFlow, useNodesState,
  type Connection, type Edge, type Node, type NodeChange, type OnMoveEnd, type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { WorkflowStage, WorkflowVersionEnvelope } from "@project-orchestrator/contracts";
import type { RoleSummary } from "../api/types";
import { CanvasDrawer } from "./canvas-drawer";
import { autoLayout, type CanvasPosition, insertStageAfter, nodePositions, removeGraphSelection, toggleCanvasGroup, trackCanvasNodePositions, updateCanvas, updateCanvasViewport, validateGraph } from "./workflow-graph";
import { useI18n } from "../i18n";

type NodeData = { stage: WorkflowStage; label: string; meta: string; quickAddLabel: string; selected?: boolean; state?: string; onQuickAdd?: (key: string) => void };
type GroupData = { label: string; count: number; summary: string; expandLabel: string; onExpand?: () => void };
type Props = {
  envelope: WorkflowVersionEnvelope;
  roles: RoleSummary[];
  label: (value: string) => string;
  readonly?: boolean;
  stageStates?: Record<string, string>;
  onChange?: (envelope: WorkflowVersionEnvelope) => void;
  onSelect?: (key?: string) => void;
};

const StageNode = memo(function StageNode({ data }: { data: NodeData }) {
  const { stage, label, meta, quickAddLabel, selected, state, onQuickAdd } = data;
  const openQuickAdd = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    onQuickAdd?.(stage.key);
  };
  return <div className={`workflow-node ${stage.mandatory_gate ? "is-gate" : ""} ${selected ? "is-selected" : ""} ${state ? `is-${state}` : ""}`}>
    <Handle type="target" position={Position.Left} className="node-input-handle" />
    <div className="workflow-node-title"><span className="workflow-node-avatar" aria-hidden>{label.slice(0, 1).toUpperCase()}</span><span>{label}</span>{stage.mandatory_gate && <small aria-label={meta}>●</small>}</div>
    <div className="workflow-node-meta">{state ?? meta}</div>
    <Handle type="source" position={Position.Right} className="node-output-handle" title={quickAddLabel} aria-label={quickAddLabel} role={onQuickAdd ? "button" : undefined} tabIndex={onQuickAdd ? 0 : undefined} onClick={onQuickAdd ? openQuickAdd : undefined} onKeyDown={onQuickAdd ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openQuickAdd(event); } } : undefined} />
  </div>;
});
const GroupNode = memo(function GroupNode({ data }: { data: GroupData }) {
  return <button className="workflow-group-node nodrag" type="button" onClick={data.onExpand} aria-label={data.expandLabel}><strong>{data.label}</strong><span>{data.summary}</span></button>;
});
const nodeTypes = { stage: StageNode, group: GroupNode };
const emptyStageStates: Record<string, string> = {};
const defaultStage = (key: string, roleVersionId: string): WorkflowStage => ({ key, role_version_id: roleVersionId, optional: false, mandatory_gate: false, failure_policy: "pause", max_attempts: 1, requires_confirmation: false });
const uniqueKey = (base: string, stages: WorkflowStage[]) => { let count = 1, key = base; const all = new Set(stages.map((stage) => stage.key)); while (all.has(key)) key = `${base}-${++count}`; return key; };
const category = (slug: string) => slug.includes("research") || slug.includes("require") ? "categoryResearch" : slug.includes("architecture") || slug.includes("ui") ? "categoryDesign" : slug.includes("test") || slug.includes("review") || slug.includes("security") ? "categoryQuality" : slug.includes("operation") ? "categoryDelivery" : slug.includes("memory") ? "categoryMemory" : "categoryDevelopment";
const interactiveTarget = (target: EventTarget | null) => target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);

export function WorkflowCanvas({ envelope, roles, label, readonly = false, stageStates: stageStatesInput, onChange, onSelect }: Props) {
  const stageStates = stageStatesInput ?? emptyStageStates;
  const { t } = useI18n();
  const [selected, setSelected] = useState<string>();
  const [paletteOpen, setPaletteOpen] = useState(false), [query, setQuery] = useState("");
  const flow = useRef<ReactFlowInstance | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const livePositionsRef = useRef<Record<string, CanvasPosition>>({});
  const positions = useMemo(() => nodePositions(envelope.data), [envelope.data]);
  const diagnostics = useMemo(() => validateGraph(envelope.data.stages, envelope.data.edges), [envelope.data.stages, envelope.data.edges]);
  const collapsed = useMemo(() => envelope.data.canvas?.groups?.filter((group) => group.collapsed) ?? [], [envelope.data.canvas?.groups]);
  const groupFor = useCallback((key: string) => collapsed.find((group) => group.stage_keys.includes(key)), [collapsed]);
  const endpoint = useCallback((key: string) => groupFor(key)?.id ?? key, [groupFor]);
  const authoredNodes = useMemo<Node[]>(() => {
    const stages = envelope.data.stages.filter((stage) => !groupFor(stage.key)).map((stage) => ({
      id: stage.key, type: "stage", position: positions[stage.key]!, data: { stage, label: label(stage.key), selected: selected === stage.key, state: stageStates[stage.key] ?? "queued", meta: stage.mandatory_gate ? t("mandatoryGate") : stage.optional ? t("optionalStage") : t("stage"), quickAddLabel: t("addNode"), ...(!readonly ? { onQuickAdd: (key: string) => { setSelected(key); setPaletteOpen(true); } } : {}) },
    }));
    const summaries = collapsed.map((group) => {
      const memberPositions = group.stage_keys.map((key) => positions[key]).filter((value): value is CanvasPosition => value !== undefined);
      const position = memberPositions.reduce<CanvasPosition>((sum, item) => ({ x: sum.x + item.x, y: sum.y + item.y }), { x: 0, y: 0 });
      return { id: group.id, type: "group", position: { x: memberPositions.length ? position.x / memberPositions.length : 42, y: memberPositions.length ? position.y / memberPositions.length : 48 }, draggable: false, connectable: false, data: { label: group.label, count: group.stage_keys.length, summary: `${group.stage_keys.length} · ${t("expandGroup")}`, expandLabel: `${t("expandGroup")} ${group.label}`, onExpand: () => { onChange?.(toggleCanvasGroup(envelope, group.id)); } } };
    });
    return [...stages, ...summaries];
  }, [collapsed, envelope, groupFor, label, onChange, positions, readonly, selected, stageStates, t]);
  const [nodes, setNodes, applyNodeChanges] = useNodesState<Node>([]);
  useEffect(() => { setNodes(authoredNodes); }, [authoredNodes, setNodes]);
  const edges = useMemo<Edge[]>(() => {
    const unique = new Set<string>();
    return envelope.data.edges.flatMap((edge, index) => {
      const source = endpoint(edge.from), target = endpoint(edge.to), id = `${source}-${target}-${index}`;
      if (source === target || unique.has(`${source}-${target}`)) return [];
      unique.add(`${source}-${target}`);
      const reducedMotion = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      return [{ id, source, target, type: "smoothstep", animated: !reducedMotion && Boolean(stageStates[edge.from] === "running"), ...(edge.edge_type === "on_success" ? { label: t("onSuccess") } : {}), ...(stageStates[edge.from] === "failed" ? { className: "edge-failed" } : {}) }];
    });
  }, [endpoint, envelope.data.edges, stageStates, t]);
  const select = useCallback((key?: string) => { setSelected(key); onSelect?.(key); }, [onSelect]);
  const writePositions = (changes: NodeChange<Node>[]) => {
    if (readonly) return;
    applyNodeChanges(changes);
    if (!onChange) return;
    const tracked = trackCanvasNodePositions(livePositionsRef.current, changes, envelope.data.stages.map((stage) => stage.key));
    if (!tracked) return;
    livePositionsRef.current = tracked.positions;
    if (!tracked.commit) return;
    onChange(updateCanvas(envelope, { ...positions, ...tracked.positions }));
    livePositionsRef.current = {};
  };
  const addRole = (role: RoleSummary, position?: { x: number; y: number }) => {
    if (readonly || !onChange || !role.current_version_id) return;
    const stage = defaultStage(uniqueKey(role.slug, envelope.data.stages), role.current_version_id);
    let next = insertStageAfter(envelope, selected, stage);
    const from = selected ? positions[selected] : undefined;
    next = updateCanvas(next, { ...positions, [stage.key]: position ?? (from ? { x: from.x + 245, y: from.y } : flow.current?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) ?? { x: 180, y: 120 }) });
    onChange(next); select(stage.key); setPaletteOpen(false); setQuery("");
  };
  const onConnect = (connection: Connection) => {
    if (readonly || !onChange || !connection.source || !connection.target || connection.source === connection.target || connection.source.startsWith("group-") || connection.target.startsWith("group-") || envelope.data.edges.some((edge) => edge.from === connection.source && edge.to === connection.target)) return;
    onChange({ ...envelope, data: { ...envelope.data, edges: [...envelope.data.edges, { from: connection.source, to: connection.target, edge_type: "requires" }] } });
  };
  const onMoveEnd: OnMoveEnd = (_, viewport) => { if (!readonly && onChange) onChange(updateCanvasViewport(envelope, viewport)); };
  const filteredRoles = roles.filter((role) => role.status === "active" && role.current_version_id && `${role.name} ${role.slug}`.toLowerCase().includes(query.toLowerCase()));
  const groups = [...new Set(filteredRoles.map((role) => category(role.slug)))];
  const hasSavedViewport = Boolean(envelope.data.canvas?.viewport_zoom && Number.isFinite(envelope.data.canvas.viewport_zoom));
  const initialHasSavedViewport = useRef(hasSavedViewport);
  const fitCanvas = useCallback(() => { void flow.current?.fitView({ padding: 0.18, duration: 180 }); }, []);
  useEffect(() => {
    if (initialHasSavedViewport.current || !nodes.length || typeof ResizeObserver === "undefined") return;
    const target = stageRef.current;
    if (!target) return;
    let frame = 0;
    const fitWhenSized = () => {
      if (!flow.current || target.clientWidth < 80 || target.clientHeight < 80) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitCanvas);
    };
    const observer = new ResizeObserver(fitWhenSized);
    observer.observe(target);
    fitWhenSized();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [fitCanvas, nodes.length]);
  useEffect(() => { if (selected && !envelope.data.stages.some((stage) => stage.key === selected)) select(undefined); }, [envelope.data.stages, select, selected]);
  return <div className={`workflow-canvas-layout ${readonly ? "is-readonly" : ""}`}>
    <section ref={stageRef} className="canvas-stage n8n-canvas" aria-label={readonly ? t("runCanvas") : t("workflowEditor")} tabIndex={0} onKeyDown={(event) => {
      if (interactiveTarget(event.target)) return;
      if (event.key === "Escape") { event.preventDefault(); setPaletteOpen(false); select(undefined); }
      if (!readonly && event.key.toLowerCase() === "f") { event.preventDefault(); void flow.current?.fitView({ padding: 0.16, duration: 180 }); }
      if (!readonly && (event.key === "Delete" || event.key === "Backspace") && selected) { event.preventDefault(); const next = removeGraphSelection(envelope, [selected], []); if (next !== envelope) { onChange?.(next); select(undefined); } }
    }}>
      {!readonly && nodes.length > 0 && <div className="canvas-floating-actions"><button className="button primary" type="button" onClick={() => setPaletteOpen(true)}>{t("addNode")}</button><button className="button ghost" type="button" onClick={() => onChange?.(autoLayout(envelope))}>{t("autoLayout")}</button><button className="button ghost" type="button" onClick={fitCanvas}>{t("fitCanvas")}</button></div>}
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView={false} defaultViewport={{ x: envelope.data.canvas?.viewport_x ?? 0, y: envelope.data.canvas?.viewport_y ?? 0, zoom: envelope.data.canvas?.viewport_zoom ?? 1 }} onInit={(instance) => { flow.current = instance; if (!initialHasSavedViewport.current && nodes.length) requestAnimationFrame(fitCanvas); }} nodesDraggable={!readonly} nodesConnectable={!readonly} elementsSelectable onNodeClick={(_, node) => { if (node.type === "stage") select(node.id); }} onPaneClick={() => select(undefined)} onNodesChange={writePositions} onNodesDelete={(deleted) => { if (!readonly) onChange?.(removeGraphSelection(envelope, deleted.map((node) => node.id), [])); }} onEdgesDelete={(deleted) => { if (!readonly) onChange?.(removeGraphSelection(envelope, [], deleted.map((edge) => edge.id))); }} onConnect={onConnect} onMoveEnd={onMoveEnd} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("application/project-orchestrator-role"); const role = roles.find((item) => item.id === id); if (role) addRole(role, flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY })); }} onDragOver={(event) => { if (!readonly) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}>
        <Background gap={18} size={1} /><Controls showInteractive={false} />
      </ReactFlow>
      {!readonly && !nodes.length && <div className="canvas-empty-state" data-testid="canvas-empty-state"><span className="canvas-empty-mark" aria-hidden>＋</span><h2>{t("emptyCanvasTitle")}</h2><p>{t("emptyCanvasDescription")}</p><button className="button primary" type="button" onClick={() => setPaletteOpen(true)}>{t("addNode")}</button></div>}
      {diagnostics.length > 0 && nodes.length > 0 && !readonly && <div className="canvas-diagnostics" role="status">{diagnostics.map((item) => <span key={`${item.code}-${item.stageKeys.join()}`}>● {t(`graph_${item.code}`)}：{item.stageKeys.map(label).join("、")}</span>)}</div>}
    </section>
      {paletteOpen && !readonly && <CanvasDrawer title={t("addNode")} onClose={() => setPaletteOpen(false)} className="role-market"><label className="field"><span>{t("searchRoles")}</span><input autoFocus type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("searchRoles")} /></label>{groups.map((name) => <section className="role-market-group" key={name}><h3>{t(name)}</h3>{filteredRoles.filter((role) => category(role.slug) === name).map((role) => <button className="palette-role" type="button" draggable key={role.id} onDragStart={(event) => event.dataTransfer.setData("application/project-orchestrator-role", role.id)} onClick={() => addRole(role)}><span><strong>{role.name}</strong><small>{role.slug}</small></span><b aria-hidden>＋</b></button>)}</section>)}{!filteredRoles.length && <p className="muted">{t("noData")}</p>}</CanvasDrawer>}
  </div>;
}
