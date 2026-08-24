import { expect, test } from "@playwright/test";
import { guardNetwork, mockApi } from "./fixtures";
test("run observation contains evidence and no execution surface", async ({
  page,
}) => {
  guardNetwork(page);
  await mockApi(page);
  await page.goto("/runs/run-1");
  await expect(page.locator(".notice").filter({ hasText: /Codex or Claude session|Codex 或 Claude 会话/ })).toBeVisible();
  await expect(page.getByText(/do not retry directly|禁止直接重试/)).toBeVisible();
  for (const tab of [
    /Timeline|时间线/,
    /Stages \/ attempts|阶段 \/ 尝试记录/,
    /Artifacts|产物/,
    /File changes|文件变化/,
    /Tests|测试/,
    /Memory|记忆/,
    /Diagnostics|诊断/,
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
