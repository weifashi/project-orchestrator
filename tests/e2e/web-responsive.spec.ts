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

test("workflow canvas owns the desktop viewport instead of creating a document scrollbar", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1568, height: 900 } });
  await mockApi(page);
  await page.goto("/workflows/workflow-1");
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(900);
  await page.close();
});

test("workflow canvas uses the full desktop workspace", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 2400, height: 900 } });
  await mockApi(page);
  await page.goto("/workflows/workflow-1");
  await expect(page.locator(".canvas-stage")).toBeVisible();
  const size = await page.evaluate(() => {
    const main = document.querySelector("main")?.getBoundingClientRect();
    const canvas = document.querySelector(".canvas-stage")?.getBoundingClientRect();
    return { main: main?.width ?? 0, canvas: canvas?.width ?? 0 };
  });
  expect(size.canvas).toBeGreaterThanOrEqual(size.main - 112);
  await page.close();
});

test("long role directories scroll inside the application shell", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1568, height: 900 } });
  await mockApi(page);
  await page.goto("/roles");
  await page.waitForLoadState("networkidle");
  const size = await page.evaluate(() => ({ document: document.documentElement.scrollHeight, viewport: document.documentElement.clientHeight, main: document.querySelector("main")?.scrollHeight ?? 0, mainViewport: document.querySelector("main")?.clientHeight ?? 0 }));
  expect(size.document).toBeLessThanOrEqual(size.viewport);
  expect(size.main).toBeGreaterThanOrEqual(size.mainViewport);
  await page.close();
});

test("mobile header controls stay inside the header and never overlap navigation", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await mockApi(page);
  await page.goto("/workflows/workflow-1");
  const bounds = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".topbar")!;
    const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
    const headerRect = header.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    return {
      headerClientHeight: header.clientHeight,
      headerScrollHeight: header.scrollHeight,
      headerBottom: headerRect.bottom,
      sidebarTop: sidebarRect.top,
    };
  });
  expect(bounds.headerScrollHeight).toBeLessThanOrEqual(bounds.headerClientHeight);
  expect(bounds.headerBottom).toBeLessThanOrEqual(bounds.sidebarTop + 1);
  await page.close();
});

test("long Run objectives use at most two compact lines and preserve the full text", async ({ browser }) => {
  const objective = "在 /workspace/ttpos-control-panel 按 develop 分支构建 2.28.6，构建成功后自动更新 node01，并触发开始一键更新；同时提供完整的 HTML 改动汇报。";
  const page = await browser.newPage({ viewport: { width: 1568, height: 900 } });
  await mockApi(page, { runObjective: objective });
  await page.goto("/runs/run-1");
  const title = page.locator(".run-objective-title");
  await expect(title).toHaveAttribute("title", objective);
  const metrics = await title.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      lineClamp: style.webkitLineClamp,
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
    };
  });
  expect(metrics.lineClamp).toBe("2");
  expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight * 2 + 1);
  await page.close();
});
