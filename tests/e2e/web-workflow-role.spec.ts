import { expect, test } from "@playwright/test";
import { bootstrap, guardNetwork } from "./fixtures";
test("workflow and role drafts publish only future immutable versions", async ({
  page,
}) => {
  test.setTimeout(60_000);
  guardNetwork(page);
  await bootstrap(page);
  const originalWorkflowVersion = await page.evaluate(async () => {
    const response = await fetch("/api/read/runs/e2e-run");
    return ((await response.json()) as { workflow_version_id: string })
      .workflow_version_id;
  });
  await page.goto("/workflows/builtin-workflow-feature-development");
  await expect(
    page.getByRole("region", { name: /Workflow canvas|编排画布/ }),
  ).toBeVisible();
  await page.getByText("开发实现").click();
  await page.getByLabel("最大尝试次数").fill("2");
  const workflowSave = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/config/workflow-drafts/"),
  );
  await page.getByRole("button", { name: "保存草稿" }).click();
  expect((await workflowSave).ok()).toBe(true);
  await expect(page.getByRole("status")).toContainText(/(?:revision|修订) 1/);
  const workflowPublish = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/config\/workflows\/[^/]+\/publish$/.test(response.url()),
  );
  await page.getByRole("button", { name: "发布新版本" }).click();
  expect((await workflowPublish).ok()).toBe(true);
  await expect(page.getByText(/现有.*不受影响|Existing Runs are unchanged/)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const response = await fetch("/api/read/runs/e2e-run");
        return ((await response.json()) as { workflow_version_id: string })
          .workflow_version_id;
      }),
    )
    .toBe(originalWorkflowVersion);
  await page.goto("/roles");
  await expect(page.locator(".role-card")).toHaveCount(10);
  await page.goto("/roles/builtin-role-testing");
  await page.getByLabel("显示名称").fill("Testing E2E");
  const rolePublish = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/config\/roles\/[^/]+\/publish$/.test(response.url()),
  );
  await page.getByRole("button", { name: "发布新版本" }).click();
  expect((await rolePublish).ok()).toBe(true);
  await expect(page.getByRole("status")).toContainText(
    /已发布不可变新版本|Published a new immutable version/,
  );
  await expect(page.getByLabel("显示名称")).toHaveValue("Testing E2E");
});
