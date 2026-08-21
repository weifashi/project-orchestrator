import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it } from "vitest";
import { ApiContext } from "../src/api/context";
import { RunDetailPage } from "../src/pages/run-detail";
import { fakeApi } from "./fixtures";
it("renders active stages, waits, attempts, artifacts and unknown side effects without controls", async () => {
  render(
    <ApiContext.Provider value={fakeApi()}>
      <MemoryRouter initialEntries={["/runs/run-1"]}>
        <Routes>
          <Route path="/runs/:id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>
    </ApiContext.Provider>,
  );
  expect(
    await screen.findByText(/Codex 或 Claude 会话完成确认/),
  ).toBeInTheDocument();
  expect(screen.getByText(/禁止直接重试/)).toBeInTheDocument();
  expect(screen.getAllByText("测试验证")).not.toHaveLength(0);
  await userEvent.click(screen.getByRole("tab", { name: "产物" }));
  expect(screen.getByRole("link", { name: "下载" })).toHaveAttribute(
    "href",
    "/api/read/artifact-content/artifact-1",
  );
  for (const name of [
    "开始",
    "暂停",
    "恢复",
    "取消",
    "重试",
    "跳过",
    "批准",
    "拒绝",
    "部署",
  ])
    expect(
      screen.queryByRole("button", { name: new RegExp(name) }),
    ).not.toBeInTheDocument();
});
