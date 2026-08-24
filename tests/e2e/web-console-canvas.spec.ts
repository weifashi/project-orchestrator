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
  const samples: number[] = [];
  for (const distance of [30, 60, 90, 120]) {
    await page.mouse.move(before.x + before.width / 2 + distance, before.y + before.height / 2 + 36);
    await page.waitForTimeout(20);
    samples.push((await node.boundingBox())?.x ?? 0);
  }
  expect(samples[3]).toBeGreaterThan(samples[0] + 25);
  expect(samples[2]).toBeGreaterThan(samples[1]);
  expect(samples[1]).toBeGreaterThan(samples[0]);
  await page.mouse.up();
  await expect.poll(async () => (await node.boundingBox())?.x ?? 0).toBeGreaterThan(before.x + 35);
});

test("node output plus is centered and flush with its node edge", async ({ page }) => {
  guardNetwork(page);
  await mockApi(page);
  await page.goto("/workflows/workflow-1");

  const offset = await page.locator(".workflow-node").first().evaluate((node) => {
    const quickAdd = node.querySelector<HTMLElement>(".node-output-handle");
    if (!quickAdd) throw new Error("output plus is missing");
    const nodeRect = node.getBoundingClientRect();
    const quickAddRect = quickAdd.getBoundingClientRect();
    return {
      vertical: Math.abs(quickAddRect.top + quickAddRect.height / 2 - (nodeRect.top + nodeRect.height / 2)),
      rightGap: quickAddRect.left - nodeRect.right,
    };
  });

  expect(offset.vertical).toBeLessThanOrEqual(1);
  expect(offset.rightGap).toBeGreaterThanOrEqual(-2);
  expect(offset.rightGap).toBeLessThanOrEqual(2);
});

test("the output plus can be dragged to another node to create a dependency", async ({ page }) => {
  guardNetwork(page);
  await mockApi(page);
  await page.goto("/workflows/workflow-1");

  const source = page.locator(".react-flow__node", { hasText: "测试验证" }).locator(".node-output-handle");
  const target = page.locator(".react-flow__node", { hasText: "开发实现" }).locator(".node-input-handle");
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  await source.dragTo(target);

  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
});

test("clicking the output plus still opens quick role add", async ({ page }) => {
  guardNetwork(page);
  await mockApi(page);
  await page.goto("/workflows/workflow-1");

  await page.locator(".react-flow__node").first().locator(".node-output-handle").click();
  await expect(page.getByRole("dialog", { name: /Add node|添加节点/ })).toBeVisible();
});
