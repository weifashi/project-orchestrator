import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { ApiContext } from "../src/api/context";
import { RoleEditorPage } from "../src/pages/role-editor";
import { fakeApi } from "./fixtures";
afterEach(cleanup);
it("shows requested capability selection and the server-owned effective intersection", async () => {
  render(
    <ApiContext.Provider value={fakeApi()}>
      <MemoryRouter initialEntries={["/roles/role-1"]}>
        <Routes>
          <Route path="/roles/:id" element={<RoleEditorPage />} />
        </Routes>
      </MemoryRouter>
    </ApiContext.Provider>,
  );
  expect(
    await screen.findAllByText(/发布时的有效能力/),
  ).not.toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "全选" }));
  expect(screen.getAllByRole("checkbox")).toHaveLength(5);
  expect(screen.getByText(/网页不能授权平台禁用能力/)).toBeInTheDocument();
});

it("reloads the editable role after resetting a built-in role", async () => {
  let draftReads = 0;
  const api = fakeApi({
    roles: {
      ...fakeApi().roles,
      list: async () => [{ id: "role-1", slug: "testing", name: "Testing", status: "active", is_builtin: true, current_version_id: "role-v1", version_number: 1, effective_capabilities: [], updated_at: "2026-08-20T00:00:00Z" }],
      getDraft: async () => ({
        ...(await fakeApi().roles.getDraft("role-1")),
        revision: ++draftReads,
        envelope: {
          ...(await fakeApi().roles.getDraft("role-1")).envelope,
          data: {
            ...(await fakeApi().roles.getDraft("role-1")).envelope.data,
            display_name: draftReads === 1 ? "Testing" : "Testing reset",
          },
        },
      }),
      resetBuiltin: async () => ({ versionNumber: 2 }),
    },
  });
  render(
    <ApiContext.Provider value={api}>
      <MemoryRouter initialEntries={["/roles/role-1"]}>
        <Routes><Route path="/roles/:id" element={<RoleEditorPage />} /></Routes>
      </MemoryRouter>
    </ApiContext.Provider>,
  );
  expect(await screen.findByLabelText("显示名称")).toHaveValue("Testing");
  await userEvent.click(await screen.findByRole("button", { name: "恢复为内置默认" }));
  expect(await screen.findByLabelText("显示名称")).toHaveValue("Testing reset");
  expect(screen.getByRole("button", { name: "恢复为内置默认" })).toBeEnabled();
});
