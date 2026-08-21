import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiContext } from "../src/api/context";
import { WorkflowEditorPage } from "../src/pages/workflow-editor";
import { fakeApi, workflowDraft } from "./fixtures";
describe("workflow editor", () => {
  it("keeps mandatory gates locked and separates saving from publication", async () => {
    const saveDraft = vi.fn(async () => ({ ...workflowDraft, revision: 3 })),
      publish = vi.fn(async () => ({})),
      api = fakeApi({
        workflows: {
          list: async () => [],
          getDraft: async () => workflowDraft,
          saveDraft,
          publish,
        },
      });
    render(
      <ApiContext.Provider value={api}>
        <MemoryRouter initialEntries={["/workflows/workflow-1"]}>
          <Routes>
            <Route path="/workflows/:id" element={<WorkflowEditorPage />} />
          </Routes>
        </MemoryRouter>
      </ApiContext.Provider>,
    );
    expect(
      await screen.findByLabelText("强制安全门，无法关闭"),
    ).toBeInTheDocument();
    expect(screen.getAllByLabelText("可选阶段")[1]).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(saveDraft).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "发布新版本" }));
    expect(publish).toHaveBeenCalledOnce();
    expect(await screen.findByText(/现有任务不受影响/)).toBeInTheDocument();
  });
});
