import { expect, test } from "@playwright/test";

test("public bootstrap uses account login without exposing a Web token", async ({ page }) => {
  await page.goto("http://localhost:4173/bootstrap?lang=en");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByText("Web token")).toHaveCount(0);
  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password").fill("twelve-char-password");
  await Promise.all([page.waitForURL("http://localhost:4173/"), page.getByRole("button", { name: "Sign in" }).click()]);
  await expect(page.getByRole("heading", { name: /工作台总览|Workspace overview/ })).toBeVisible();
});
