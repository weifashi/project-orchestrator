import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { ApiContext } from "../src/api/context";
import { RunDetailPage } from "../src/pages/run-detail";
import { fakeApi } from "./fixtures";
import { LocaleProvider } from "../src/i18n";
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
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
  expect(await screen.findByText("测试验证")).toBeInTheDocument();
  expect(await screen.findByText("排队中")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "导出 JSON" })).toHaveAttribute(
    "href",
    "/api/read/run-exports/run-1?format=json&lang=zh-CN",
  );
  expect(screen.getByRole("link", { name: "导出 Markdown" })).toHaveAttribute(
    "href",
    "/api/read/run-exports/run-1?format=markdown&lang=zh-CN",
  );
  expect(screen.queryByText("当前阶段")).not.toBeInTheDocument();
  expect(screen.queryByText("阶段状态")).not.toBeInTheDocument();
  expect(screen.queryByText("冻结快照")).not.toBeInTheDocument();
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

it("marks a long Run objective as a compact two-line title while preserving the full text", async () => {
  const objective = "在 /workspace/ttpos-control-panel 按 develop 分支构建 2.28.6，构建成功后自动更新 node01，并触发开始一键更新；同时提供完整的 HTML 改动汇报。";
  const base = fakeApi();
  const api = fakeApi({
    runs: {
      ...base.runs,
      get: async () => ({
        ...(await base.runs.get("run-1")),
        objective,
      }),
    },
  });
  render(
    <ApiContext.Provider value={api}>
      <MemoryRouter initialEntries={["/runs/run-1"]}>
        <Routes><Route path="/runs/:id" element={<RunDetailPage />} /></Routes>
      </MemoryRouter>
    </ApiContext.Provider>,
  );

  const heading = await screen.findByRole("heading", { level: 1, name: objective });
  expect(heading).toHaveClass("run-objective-title");
  expect(heading).toHaveAttribute("title", objective);
  expect(heading.closest(".page-head")).toHaveClass("run-detail-head");
});

it("refreshes the complete Run snapshot after a live event", async () => {
  let reads = 0;
  const base = fakeApi();
  const api = fakeApi({
    runs: {
      ...base.runs,
      get: async () => ({
        ...(await base.runs.get("run-1")),
        status: reads++ === 0 ? "created" : "running",
        stages: [{ id: "stage-testing", stage_key: "testing", iteration_number: 0, role_version_id: "role-v1", status: reads === 1 ? "queued" : "running" }],
      }),
    },
    events: {
      list: async () => [{ id: "live-2", run_id: "run-1", stage_run_id: "stage-testing", sequence_number: 2, event_type: "stage_started", payload_envelope: {}, created_at: "2026-08-20T00:03:00Z" }],
    },
  });
  const { container } = render(
    <ApiContext.Provider value={api}>
      <MemoryRouter initialEntries={["/runs/run-1"]}>
        <Routes><Route path="/runs/:id" element={<RunDetailPage />} /></Routes>
      </MemoryRouter>
    </ApiContext.Provider>,
  );

  expect(await screen.findByText("执行中")).toBeInTheDocument();
  expect(container.querySelector(".workflow-node.is-running")).toBeInTheDocument();
  fireEvent.click(container.querySelector(".workflow-node.is-running") as HTMLElement);
  expect(screen.getByRole("dialog", { name: "节点设置" })).toHaveTextContent(/状态.*执行中/);
  expect(reads).toBeGreaterThanOrEqual(2);
});

it("translates artifact download actions in English", async () => {
  window.localStorage.setItem("po-locale", "en");
  render(
    <LocaleProvider>
      <ApiContext.Provider value={fakeApi()}>
        <MemoryRouter initialEntries={["/runs/run-1"]}>
          <Routes><Route path="/runs/:id" element={<RunDetailPage />} /></Routes>
        </MemoryRouter>
      </ApiContext.Provider>
    </LocaleProvider>,
  );
  await screen.findByText("Implement safe console");
  await userEvent.click(screen.getByRole("tab", { name: "Artifacts" }));
  expect(screen.getByRole("link", { name: "Download" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: "Tests" }));
  expect(screen.getByRole("link", { name: "Download evidence" })).toBeInTheDocument();
});
