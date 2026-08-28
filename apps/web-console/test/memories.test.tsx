import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { ApiContext } from "../src/api/context";
import { LocaleProvider } from "../src/i18n";
import { MemoriesPage } from "../src/pages/memories";
import { fakeApi } from "./fixtures";

afterEach(() => cleanup());

it("keeps the selected project in JSON and Markdown memory export URLs", async () => {
  window.localStorage.setItem("po-locale", "zh-CN");
  render(
    <LocaleProvider>
      <ApiContext.Provider value={fakeApi()}>
        <MemoriesPage />
      </ApiContext.Provider>
    </LocaleProvider>,
  );
  const project = screen.getByLabelText("项目 ID");
  await userEvent.type(project, "project one");
  expect(screen.getByRole("link", { name: "导出 JSON" })).toHaveAttribute(
    "href",
    "/api/read/memory-exports?format=json&lang=zh-CN&project_id=project+one",
  );
  expect(screen.getByRole("link", { name: "导出 Markdown" })).toHaveAttribute(
    "href",
    "/api/read/memory-exports?format=markdown&lang=zh-CN&project_id=project+one",
  );
});
