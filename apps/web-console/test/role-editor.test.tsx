import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it } from "vitest";
import { ApiContext } from "../src/api/context";
import { RoleEditorPage } from "../src/pages/role-editor";
import { fakeApi } from "./fixtures";
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
