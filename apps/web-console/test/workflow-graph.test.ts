import { describe, expect, it } from "vitest";
import type { WorkflowVersionEnvelope } from "@project-orchestrator/contracts";
import { insertStageAfter, validateGraph } from "../src/components/workflow-graph";
const stage = (key: string, gate = false) => ({ key, role_version_id: `role-${key}`, optional: false, mandatory_gate: gate, failure_policy: "pause" as const, max_attempts: 1, requires_confirmation: false });
const workflow = (): WorkflowVersionEnvelope => ({ schema_id: "project-orchestrator/workflow-version", schema_version: 1, data: { slug: "demo", version: 1, stages: [stage("requirements"), stage("testing", true), stage("operations")], edges: [{ from: "requirements", to: "testing", edge_type: "requires" }, { from: "testing", to: "operations", edge_type: "requires" }], iteration_groups: [] } });
describe("workflow canvas graph", () => {
  it("inserts a palette role between selected node and downstream nodes", () => { const next = insertStageAfter(workflow(), "requirements", stage("architecture")); expect(next.data.edges).toEqual(expect.arrayContaining([{ from: "requirements", to: "architecture", edge_type: "requires" }, { from: "architecture", to: "testing", edge_type: "requires" }, { from: "testing", to: "operations", edge_type: "requires" }])); });
  it("reports a bypass around a mandatory gate", () => { const input = workflow(); input.data.edges.push({ from: "requirements", to: "operations", edge_type: "requires" }); expect(validateGraph(input.data.stages, input.data.edges).some((item) => item.code === "gate-bypass")).toBe(true); });
});
