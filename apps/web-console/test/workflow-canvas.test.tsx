import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WorkflowVersionEnvelope } from "@project-orchestrator/contracts";
import { WorkflowCanvas } from "../src/components/workflow-canvas";

const emptyWorkflow: WorkflowVersionEnvelope = {
  schema_id: "project-orchestrator/workflow-version",
  schema_version: 1,
  data: { slug: "empty", version: 1, stages: [], edges: [], iteration_groups: [] },
};

describe("workflow canvas", () => {
  it("shows a centered first-node action instead of an empty editing surface", () => {
    render(<WorkflowCanvas envelope={emptyWorkflow} roles={[]} label={(key) => key} onChange={() => undefined} />);
    expect(screen.getByTestId("canvas-empty-state")).toBeVisible();
    expect(screen.getByRole("button", { name: "添加节点" })).toBeVisible();
  });
});
