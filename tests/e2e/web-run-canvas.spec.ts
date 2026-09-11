import { expect, test } from "@playwright/test";
import { guardNetwork, mockApi } from "./fixtures";

// 回归守卫：只读运行画布过去在普通文档流里拿不到确定高度，React Flow 容器塌成 0 高，
// 节点在 DOM 里存在却不绘制，整块画布空白。断言容器有真实高度且节点画出来。
test("the read-only run canvas has a real height and paints its nodes", async ({ page }) => {
  guardNetwork(page);
  await mockApi(page);
  await page.goto("/runs/run-1");

  const canvas = page.locator(".run-canvas-card .react-flow");
  await expect(canvas).toBeVisible();

  // 冻结流程快照有两个阶段；它们必须真的渲染，而不是停在"暂时无法读取"占位。
  await expect(page.locator(".run-canvas-card .react-flow__node")).toHaveCount(2);
  await expect(page.getByText(/暂时无法读取|workflow snapshot/i)).toHaveCount(0);

  const height = await canvas.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(height).toBeGreaterThan(400);

  // 节点被真正绘制：有非零尺寸且未被隐藏。
  const node = page.locator(".run-canvas-card .react-flow__node").first();
  const box = await node.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(0);
  await expect(node).toBeVisible();
});
