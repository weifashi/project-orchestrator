import { expect, test } from "@playwright/test";
import { mockApi } from "./fixtures";
for (const width of [390, 768, 1280, 1568])
  test(`no page overflow at ${width}px`, async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await mockApi(page);
    for (const path of [
      "/",
      "/workflows",
      "/workflows/workflow-1",
      "/roles",
      "/roles/role-testing",
      "/runs",
      "/runs/run-1",
      "/memories",
      "/system",
    ]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const size = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(size.scroll, `${path} overflow at ${width}`).toBeLessThanOrEqual(
        size.client,
      );
      const tables = page.locator("table");
      for (let index = 0; index < (await tables.count()); index += 1)
        await expect(tables.nth(index).locator("xpath=..")).toHaveClass(
          /table-scroll/,
        );
      if (path.includes("/workflows/") || path.includes("/roles/")) {
        await page.keyboard.press("Tab");
        expect(
          await page.evaluate(() => document.activeElement?.tagName),
        ).not.toBe("BODY");
      }
    }
    await page.close();
  });
