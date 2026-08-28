import { describe, expect, it } from "vitest";
import type { WorkflowVersionEnvelope } from "@project-orchestrator/contracts";
import { createCanvasGroup, insertStageAfter, removeGraphSelection, toggleCanvasGroup, trackCanvasNodePositions, validateGraph } from "../src/components/workflow-graph";
const stage = (key: string, gate = false) => ({ key, role_version_id: `role-${key}`, optional: false, mandatory_gate: gate, failure_policy: "pause" as const, max_attempts: 1, requires_confirmation: false });
const workflow = (): WorkflowVersionEnvelope => ({ schema_id: "project-orchestrator/workflow-version", schema_version: 1, data: { slug: "demo", version: 1, stages: [stage("requirements"), stage("testing", true), stage("operations")], edges: [{ from: "requirements", to: "testing", edge_type: "requires" }, { from: "testing", to: "operations", edge_type: "requires" }], iteration_groups: [] } });
describe("workflow canvas graph", () => {
  it("inserts a palette role between selected node and downstream nodes", () => { const next = insertStageAfter(workflow(), "requirements", stage("architecture")); expect(next.data.edges).toEqual(expect.arrayContaining([{ from: "requirements", to: "architecture", edge_type: "requires" }, { from: "architecture", to: "testing", edge_type: "requires" }, { from: "testing", to: "operations", edge_type: "requires" }])); });
  it("reports a bypass around a mandatory gate", () => { const input = workflow(); input.data.edges.push({ from: "requirements", to: "operations", edge_type: "requires" }); expect(validateGraph(input.data.stages, input.data.edges).some((item) => item.code === "gate-bypass")).toBe(true); });
  it("adds and collapses visual-only canvas groups", () => {
    const grouped = createCanvasGroup(workflow(), "quality", "质量门", ["testing"]);
    expect(grouped.data.canvas?.groups).toEqual([{ id: "quality", label: "质量门", stage_keys: ["testing"], collapsed: true }]);
    expect(toggleCanvasGroup(grouped, "quality").data.canvas?.groups?.[0]?.collapsed).toBe(false);
    expect(grouped.data.stages).toHaveLength(3);
  });
  it("keeps a mandatory gate but permits editing a selected connection", () => {
    const input = workflow();
    expect(removeGraphSelection(input, ["testing"], [])).toBe(input);
    expect(removeGraphSelection(input, [], ["testing-operations-1"]).data.edges).toEqual([{ from: "requirements", to: "testing", edge_type: "requires" }]);
  });
  it("keeps drag positions inside the canvas until the pointer is released", () => {
    const moving = trackCanvasNodePositions({}, [
      { id: "requirements", type: "position", position: { x: 320, y: 48 }, dragging: true },
    ], ["requirements", "testing", "operations"]);
    expect(moving).toEqual({ positions: { requirements: { x: 320, y: 48 } }, commit: false });
    const released = trackCanvasNodePositions(moving!.positions, [
      { id: "requirements", type: "position", position: { x: 360, y: 66 }, dragging: false },
    ], ["requirements", "testing", "operations"]);
    expect(released).toEqual({ positions: { requirements: { x: 360, y: 66 } }, commit: true });
  });
});
