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

  expect(screen.getByText("本机控制台")).toBeInTheDocument();
  expect(screen.getByText("模板编排 · 任务仅查看")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "跳到主内容" })).toHaveAttribute("href", "#main-content");
  expect(screen.getByLabelText("总览")).toHaveClass("sidebar");
  expect(screen.getByRole("link", { name: "总览" })).toBeInTheDocument();
  expect(screen.getByText("网页不执行任务，只观察与编排模板")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "退出登录" })).toHaveAttribute("type", "submit");
  expect(screen.getByRole("button", { name: "退出登录" }).closest("form")).toHaveAttribute("action", "/logout");
});
