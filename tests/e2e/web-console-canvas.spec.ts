import { expect, test } from "@playwright/test";
import { guardNetwork, mockApi } from "./fixtures";

test("n8n style authoring opens a role market without exposing Run controls", async ({ page }) => {
  guardNetwork(page);
  await mockApi(page);
  await page.goto("/workflows/workflow-1");
  await expect(page.getByRole("region", { name: /Workflow canvas|编排画布/ })).toBeVisible();
  await expect(page.locator(".canvas-stage.n8n-canvas")).toBeVisible();
  await expect(page.locator(".workflow-node")).toHaveCount(2);
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
  await page.getByRole("button", { name: /Add node|添加节点/ }).first().click();
  await expect(page.getByRole("dialog", { name: /Add node|添加节点/ })).toBeVisible();
  await page.getByRole("searchbox", { name: /Search roles|搜索角色/ }).fill("architecture");
  await page.getByRole("button", { name: /Architecture/ }).click();
  await expect(page.getByRole("dialog", { name: /Add node|添加节点/ })).toHaveCount(0);
  for (const name of ["开始", "暂停", "恢复", "取消", "重试", "部署", "Start", "Pause", "Resume", "Cancel", "Retry", "Deploy"])
    await expect(page.getByRole("button", { name: new RegExp(`^${name}$`) })).toHaveCount(0);
});

test("dragging a workflow node follows the pointer and retains its released position", async ({ page }) => {
  guardNetwork(page);
  await mockApi(page);
  await page.goto("/workflows/workflow-1");
  const node = page.locator(".react-flow__node").first();
  const before = await node.boundingBox();
  if (!before) throw new Error("workflow node is not measurable");
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 120, before.y + before.height / 2 + 36, { steps: 8 });
  await expect.poll(async () => (await node.boundingBox())?.x ?? 0).toBeGreaterThan(before.x + 35);
  await page.mouse.up();
  await expect.poll(async () => (await node.boundingBox())?.x ?? 0).toBeGreaterThan(before.x + 35);
});
