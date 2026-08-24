import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowVersionEnvelope } from "@project-orchestrator/contracts";
import { WorkflowCanvas } from "../src/components/workflow-canvas";

const emptyWorkflow: WorkflowVersionEnvelope = {
  schema_id: "project-orchestrator/workflow-version",
  schema_version: 1,
  data: { slug: "empty", version: 1, stages: [], edges: [], iteration_groups: [] },
};

const connectedWorkflow: WorkflowVersionEnvelope = {
  schema_id: "project-orchestrator/workflow-version",
  schema_version: 1,
  data: {
    slug: "connected", version: 1,
    stages: [
      { key: "architecture", role_version_id: "role-architecture", optional: false, mandatory_gate: false, failure_policy: "pause", max_attempts: 1, requires_confirmation: false },
      { key: "testing", role_version_id: "role-testing", optional: false, mandatory_gate: false, failure_policy: "pause", max_attempts: 1, requires_confirmation: false },
    ],
    edges: [{ from: "architecture", to: "testing", edge_type: "requires" }],
    iteration_groups: [],
  },
};

describe("workflow canvas", () => {
  it("shows a centered first-node action instead of an empty editing surface", () => {
    render(<WorkflowCanvas envelope={emptyWorkflow} roles={[]} label={(key) => key} onChange={() => undefined} />);
    expect(screen.getByTestId("canvas-empty-state")).toBeVisible();
    expect(screen.getByRole("button", { name: "添加节点" })).toBeVisible();
  });

  it("uses an in-app context menu to delete a node instead of the browser menu", async () => {
    const onChange = vi.fn();
    const { container } = render(<WorkflowCanvas envelope={connectedWorkflow} roles={[]} label={(key) => key} onChange={onChange} />);
    await waitFor(() => expect(container.querySelector(".react-flow__node")).toBeTruthy());

    fireEvent.contextMenu(screen.getByText("architecture"), { clientX: 220, clientY: 160 });
    expect(await screen.findByRole("menuitem", { name: "删除节点" })).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "删除节点" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stages: [expect.objectContaining({ key: "testing" })], edges: [] }),
    }));
  });

});
