import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { CanvasDrawer } from "../src/components/canvas-drawer";

it("closes an overlay drawer with Escape and restores focus to its trigger", async () => {
  const close = vi.fn();
  render(<><button autoFocus>添加节点</button><CanvasDrawer title="节点设置" onClose={close}><p>设置内容</p></CanvasDrawer></>);
  expect(screen.getByRole("dialog", { name: "节点设置" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "添加节点" })).toHaveFocus();
});
