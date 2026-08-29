import { expect, test } from "@playwright/test";
import { guardNetwork, mockApi } from "./fixtures";

type CanvasEnvelope = {
  envelope: {
    data: {
      stages: Array<{ key: string }>;
      canvas?: {
        nodes?: Array<{ stage_key: string }>;
        groups?: Array<{ id: string; stage_keys: string[] }>;
      };
    };
  };
};

// 节点检查器的「移除这个角色」曾自己拼 stages/edges，漏清 canvas.nodes 与 groups[].stage_keys。
// 界面上看不出来——孤儿条目要到点「保存草稿」时才被写进去，所以这里断言提交的 payload。
test("removing a stage also clears its canvas position and group membership", async ({ page }) => {
  guardNetwork(page);
  await mockApi(page);

  const saved: CanvasEnvelope[] = [];
  page.on("request", (request) => {
    if (!request.url().includes("/api/config/workflow-drafts/workflow-1")) return;
    const body = request.postData();
    if (body) saved.push(JSON.parse(body) as CanvasEnvelope);
  });

  await page.goto("/workflows/workflow-1");
  await expect(page.locator('.canvas-stage[data-canvas-ready="true"]')).toBeVisible();

  // 拖一下，让该阶段在 canvas.nodes 里留下位置条目。
  const node = page.locator(".react-flow__node", { hasText: "开发实现" });
  const box = await node.boundingBox();
  if (!box) throw new Error("implementation node is not measurable");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 40);
  await page.mouse.up();

  // 建分组后展开，让该阶段既属于某个分组、又能被单独选中。
  await node.click();
  await page.getByRole("button", { name: /Create group|建立分组/ }).click();
  await expect(page.locator(".workflow-group-node")).toHaveCount(1);
  await page.locator(".workflow-group-node").click();
  await expect(page.locator(".workflow-group-node")).toHaveCount(0);

  await node.click();
  await page.getByRole("button", { name: /Remove role|移除这个角色/ }).click();
  await expect(page.locator(".react-flow__node", { hasText: "开发实现" })).toHaveCount(0);

  await page.getByRole("button", { name: /Save draft|保存草稿/ }).click();
  await expect.poll(() => saved.length).toBeGreaterThan(0);

  const canvas = saved.at(-1)!.envelope.data.canvas;
  expect(saved.at(-1)!.envelope.data.stages.map((stage) => stage.key)).not.toContain("implementation");
  // 位置条目不能留下
  expect(canvas?.nodes?.map((item) => item.stage_key) ?? []).not.toContain("implementation");
  // 分组成员不能留下；这个分组只有它一个成员，整组应当消失
  expect((canvas?.groups ?? []).flatMap((group) => group.stage_keys)).not.toContain("implementation");
  expect(canvas?.groups ?? []).toHaveLength(0);
});
