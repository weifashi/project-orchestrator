import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it } from "vitest";
import { AppShell } from "../src/components/app-shell";
import { LocaleProvider } from "../src/i18n";

it("switches all shell navigation to English without duplicating Chinese labels", async () => {
  window.localStorage.setItem("po-locale", "zh-CN");
  render(
    <LocaleProvider>
      <MemoryRouter>
        <Routes><Route element={<AppShell />}><Route index element={<h1>总览</h1>} /></Route></Routes>
      </MemoryRouter>
    </LocaleProvider>,
  );
  await userEvent.selectOptions(screen.getByLabelText("切换界面语言"), "en");
  expect(screen.getByRole("link", { name: "Workflows" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Roles" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "流程模板" })).not.toBeInTheDocument();
});
