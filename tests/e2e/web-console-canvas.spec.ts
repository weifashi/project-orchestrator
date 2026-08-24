import { expect, test } from "@playwright/test";
import { guardNetwork, mockApi } from "./fixtures";

test("n8n style authoring opens a role market without exposing Run controls", async ({ page }) => {
  guardNetwork(page);
  await mockApi(page);
  await page.goto("/workflows/workflow-1");
  await expect(page.getByRole("region", { name: /Workflow editor|流程编辑器/ })).toBeVisible();
  await page.getByRole("button", { name: /Add node|添加节点/ }).first().click();
  await expect(page.getByRole("dialog", { name: /Add node|添加节点/ })).toBeVisible();
  await page.getByRole("searchbox", { name: /Search roles|搜索角色/ }).fill("architecture");
  await page.getByRole("button", { name: /Architecture/ }).click();
  await expect(page.getByRole("dialog", { name: /Add node|添加节点/ })).toHaveCount(0);
  for (const name of ["开始", "暂停", "恢复", "取消", "重试", "部署", "Start", "Pause", "Resume", "Cancel", "Retry", "Deploy"])
    await expect(page.getByRole("button", { name: new RegExp(`^${name}$`) })).toHaveCount(0);
});
