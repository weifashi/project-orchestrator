import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";
import { ApiContext } from "../src/api/context";
import { WorkflowListPage } from "../src/pages/workflow-list";
import { fakeApi } from "./fixtures";

it("filters workflow templates by name, slug, and task type", async () => {
  const api = fakeApi({ workflows: { list: async () => [
    { id: "workflow-1", name: "Feature", slug: "feature-development", task_type: "feature", current_version_id: "version-1", version_number: 2, stage_count: 4, status: "active", updated_at: "2026-08-24T00:00:00Z" },
    { id: "workflow-2", name: "Bug", slug: "bug-fix", task_type: "bugfix", current_version_id: "version-2", version_number: 1, stage_count: 3, status: "active", updated_at: "2026-08-24T00:00:00Z" },
  ], getDraft: async () => { throw new Error("unused"); }, getVersion: async () => { throw new Error("unused"); }, saveDraft: async () => { throw new Error("unused"); }, publish: async () => {} } });
  const { container } = render(<ApiContext.Provider value={api}><MemoryRouter><WorkflowListPage /></MemoryRouter></ApiContext.Provider>);
  expect(await screen.findByText("功能开发")).toBeVisible();
  expect(container.querySelector(".workflow-list")).toBeInTheDocument();
  expect(container.querySelector("table")).not.toBeInTheDocument();
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索模板" }), "bug");
  expect(screen.queryByText("功能开发")).not.toBeInTheDocument();
  expect(screen.getByText("缺陷修复")).toBeVisible();
});
