import { expect, test } from "@playwright/test";
import { guardNetwork, mockApi } from "./fixtures";
test("run observation contains evidence and no execution surface", async ({
  page,
}) => {
  guardNetwork(page);
  await mockApi(page);
  await page.goto("/runs/run-1");
  await expect(page.getByText(/Codex\/Claude 会话完成确认/)).toBeVisible();
  await expect(page.getByText(/禁止直接重试/)).toBeVisible();
  for (const tab of [
    "时间线",
    "阶段 / Attempts",
    "产物",
    "文件变化",
    "测试",
    "记忆",
    "诊断",
  ])
    await page.getByRole("tab", { name: tab }).click();
  const forbidden =
    /^(start|pause|resume|cancel|retry|skip|approve|reject|deploy|开始|暂停|恢复|取消|重试|跳过|批准|拒绝|部署)$/i;
  for (const element of await page.locator("button,a,input,form").all())
    expect(
      (await element.getAttribute("aria-label")) ??
        (await element.textContent()) ??
        "",
    ).not.toMatch(forbidden);
});
