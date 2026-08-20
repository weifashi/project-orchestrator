import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it } from "vitest";
import { AppShell } from "../src/components/app-shell";

it("renders a polished local-console shell with semantic text navigation", () => {
  render(
    <MemoryRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<h1 tabIndex={-1}>工作台总览</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  expect(screen.getByText("Local control plane")).toBeInTheDocument();
  expect(screen.getByText("Template orchestration · read-only Runs")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "跳到主内容" })).toHaveAttribute("href", "#main-content");
  expect(screen.getByLabelText("主导航")).toHaveClass("sidebar");
  expect(screen.getByRole("link", { name: /总览 Dashboard/ })).toBeInTheDocument();
  expect(screen.getByText("Web 不执行任务，只观察与编排模板")).toBeInTheDocument();
});
