import { expect, test } from "@playwright/test";

test("public bootstrap uses account login without exposing a Web token", async ({ page }) => {
  await page.goto("/bootstrap");
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await expect(page.getByLabel("账号名")).toBeVisible();
  await expect(page.getByLabel("密码")).toBeVisible();
  await expect(page.getByText("Web token")).toHaveCount(0);
  await page.getByLabel("账号名").fill("owner");
  await page.getByLabel("密码").fill("twelve-char-password");
  await Promise.all([page.waitForURL("**/"), page.getByRole("button", { name: "登录" }).click()]);
  await expect(page.getByRole("heading", { name: /工作台总览|Workspace overview/ })).toBeVisible();
});
