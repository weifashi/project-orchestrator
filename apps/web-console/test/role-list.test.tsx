import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ApiContext } from "../src/api/context";
import type { RoleSummary } from "../src/api/types";
import { RoleListPage } from "../src/pages/role-list";
import { fakeApi } from "./fixtures";

// 这个 setup 没开 vitest globals，RTL 的自动清理挂不上去；
// 本文件有多个用例，必须手动清理，否则上一例的 DOM 会留在下一例里。
afterEach(cleanup);

const role = (overrides: Partial<RoleSummary> = {}): RoleSummary => ({
  id: "role-testing",
  slug: "testing",
  name: "Testing",
  status: "active",
  current_version_id: "version-1",
  version_number: 1,
  updated_at: "2026-08-26T00:00:00Z",
  effective_capabilities: ["read-workspace"],
  is_builtin: true,
  removed_at: null,
  ...overrides,
});

const mount = (api: ReturnType<typeof fakeApi>) =>
  render(
    <ApiContext.Provider value={api}>
      <MemoryRouter>
        <RoleListPage />
      </MemoryRouter>
    </ApiContext.Provider>,
  );

it("keeps removed roles hidden until the compact toggle is used", async () => {
  const api = fakeApi({
    roles: {
      ...fakeApi().roles,
      list: async () => [
        role(),
        role({ id: "role-gone", slug: "research", removed_at: "2026-08-26T01:00:00Z" }),
      ],
    },
  });
  mount(api);

  expect(await screen.findByText("测试验证")).toBeVisible();
  expect(screen.getByRole("link", { name: "编辑" })).toBeVisible();
  expect(screen.queryByText("版本化角色协议")).not.toBeInTheDocument();
  expect(screen.queryByText("历史版本")).not.toBeInTheDocument();
  expect(screen.queryByText(/· v1/)).not.toBeInTheDocument();
  const toggle = screen.getByRole("button", { name: "已移除角色 (1)" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("代码调查")).not.toBeInTheDocument();

  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("region", { name: "已移除角色" })).toBeVisible();
  expect(screen.getByText("代码调查")).toBeVisible();

  await userEvent.click(toggle);
  expect(screen.queryByText("代码调查")).not.toBeInTheDocument();
});

it("shows a custom role by its name, not its raw slug", async () => {
  const api = fakeApi({
    roles: {
      ...fakeApi().roles,
      list: async () => [
        role(),                                                     // 内置：有译文，显示译文
        role({ id: "role-custom", slug: "release-notes", name: "Release Notes", is_builtin: false }),
        role({ id: "role-gone", slug: "audit-trail", name: "Audit Trail", is_builtin: false, removed_at: "2026-08-29T00:00:00Z" }),
      ],
    },
  });
  mount(api);

  expect(await screen.findByText("测试验证")).toBeVisible();       // label() 命中译文
  expect(screen.getByText("Release Notes")).toBeVisible();          // 无译文 → 回退 name
  expect(screen.queryByRole("heading", { name: "release-notes" })).not.toBeInTheDocument();

  // 已移除区同样兜底（现在收在折叠开关后面）
  await userEvent.click(screen.getByRole("button", { name: "已移除角色 (1)" }));
  expect(screen.getByText("Audit Trail")).toBeVisible();
  expect(screen.queryByText("audit-trail")).not.toBeInTheDocument();
});

it("warns that removal keeps history and is not a security revocation", async () => {
  const remove = vi.fn(async () => ({ removed: true }));
  const api = fakeApi({
    roles: { ...fakeApi().roles, list: async () => [role()], remove },
  });
  mount(api);
  await screen.findByText("测试验证");

  await userEvent.click(screen.getByRole("button", { name: "移除" }));
  expect(screen.getByText(/历史任务记录和历史配置全部保留/)).toBeVisible();
  expect(screen.getByText(/这不是安全撤销/)).toBeVisible();

  // 确认面板取代了原来的「移除」按钮，页面上此刻只剩确认那一个。
  await userEvent.click(screen.getByRole("button", { name: "移除" }));
  expect(remove).toHaveBeenCalledWith("role-testing");
});

it("creates a role only once slug, name, and a responsibility are present", async () => {
  const create = vi.fn(async () => ({ roleId: "role-new", slug: "release-notes" }));
  const api = fakeApi({
    roles: { ...fakeApi().roles, list: async () => [role()], create },
  });
  mount(api);
  await screen.findByText("测试验证");

  await userEvent.click(screen.getByRole("button", { name: "新建角色" }));
  const submit = screen.getByRole("button", { name: "创建" });
  expect(submit).toBeDisabled();

  await userEvent.type(screen.getByLabelText("标识 slug"), "release-notes");
  await userEvent.type(screen.getByLabelText("显示名称"), "Release Notes");
  await userEvent.type(screen.getByLabelText(/职责/), "Summarise the release");
  expect(submit).toBeEnabled();

  await userEvent.click(submit);
  expect(create).toHaveBeenCalledWith({
    slug: "release-notes",
    display_name: "Release Notes",
    responsibilities: ["Summarise the release"],
    requested_capabilities: ["read-workspace"],
  });
});

it("opens the form in a drawer so the catalog stays on screen", async () => {
  const api = fakeApi({ roles: { ...fakeApi().roles, list: async () => [role()] } });
  mount(api);
  await screen.findByText("测试验证");

  await userEvent.click(screen.getByRole("button", { name: "新建角色" }));
  expect(screen.getByRole("dialog", { name: "新建自定义角色" })).toBeVisible();
  // 抽屉是覆盖层，不挤占目录
  expect(screen.getByText("测试验证")).toBeVisible();

  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("keeps the create button disabled for an invalid slug", async () => {
  const api = fakeApi({ roles: { ...fakeApi().roles, list: async () => [role()] } });
  mount(api);
  await screen.findByText("测试验证");

  await userEvent.click(screen.getByRole("button", { name: "新建角色" }));
  await userEvent.type(screen.getByLabelText("标识 slug"), "Release Notes");
  await userEvent.type(screen.getByLabelText("显示名称"), "Release Notes");
  await userEvent.type(screen.getByLabelText(/职责/), "Summarise");

  expect(screen.getByRole("button", { name: "创建" })).toBeDisabled();
});

it("offers a factory reset only for removed built-in roles", async () => {
  const resetBuiltin = vi.fn(async () => ({ versionNumber: 2 }));
  const api = fakeApi({
    roles: {
      ...fakeApi().roles,
      resetBuiltin,
      list: async () => [
        role({ id: "role-gone", slug: "research", removed_at: "2026-08-26T01:00:00Z" }),
        role({ id: "role-custom", slug: "release-notes", is_builtin: false, removed_at: "2026-08-26T01:00:00Z" }),
      ],
    },
  });
  mount(api);
  await userEvent.click(await screen.findByRole("button", { name: "已移除角色 (2)" }));

  expect(screen.getAllByRole("button", { name: "恢复" })).toHaveLength(2);
  const resets = screen.getAllByRole("button", { name: "恢复为内置默认" });
  expect(resets).toHaveLength(1);

  await userEvent.click(resets[0]!);
  expect(resetBuiltin).toHaveBeenCalledWith("role-gone");
});
