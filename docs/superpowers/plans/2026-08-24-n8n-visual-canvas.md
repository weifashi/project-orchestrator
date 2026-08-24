# n8n Visual Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复首次打开画布空白，并把编排与运行画布统一为 n8n 风格的暗色编辑体验。

**Architecture:** `WorkflowCanvas` 负责以容器尺寸稳定后的单次 `fitView` 恢复节点可见性，并保留用户手动视角。CSS token 层提供石墨灰表面、橙色主操作和统一状态色；画布、节点、抽屉及运行观察复用这些 token。

**Tech Stack:** React 19、@xyflow/react、TypeScript、Vitest、Playwright、CSS variables。

---

### Task 1: 首次定位和真实空状态

**Files:**
- Modify: `apps/web-console/src/components/workflow-canvas.tsx`
- Test: `apps/web-console/test/workflow-canvas.test.tsx`
- Test: `tests/e2e/web-console-canvas.spec.ts`

- [ ] **Step 1: 写失败测试**

```tsx
it("fits a populated canvas after the React Flow instance becomes ready", async () => {
  render(<WorkflowCanvas envelope={workflowWithStages} roles={[]} label={(key) => key} />);
  await expect(screen.getByText("implementation")).toBeVisible();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run --project web-unit apps/web-console/test/workflow-canvas.test.tsx --maxWorkers=1`

Expected: FAIL，因为当前组件没有稳定尺寸后的 `fitView` 调度。

- [ ] **Step 3: 实现最小定位逻辑**

```tsx
const hasFitted = useRef(false);
const fitCanvas = useCallback(() => {
  void flow.current?.fitView({ padding: 0.18, duration: 180 });
}, []);
useEffect(() => {
  if (hasFitted.current || envelope.data.canvas?.viewport_zoom || !nodes.length) return;
  const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
    hasFitted.current = true;
    fitCanvas();
  }));
  return () => cancelAnimationFrame(frame);
}, [envelope.data.canvas?.viewport_zoom, fitCanvas, nodes.length]);
```

并在 `nodes.length === 0` 时渲染居中的空状态和“添加节点”按钮。

- [ ] **Step 4: 运行针对性测试**

Run: `pnpm vitest run --project web-unit apps/web-console/test/workflow-canvas.test.tsx --maxWorkers=1`

Expected: PASS。

### Task 2: n8n 风格 token、布局、节点

**Files:**
- Modify: `apps/web-console/src/styles/tokens.css`
- Modify: `apps/web-console/src/styles/app.css`
- Modify: `apps/web-console/src/components/workflow-canvas.tsx`
- Test: `tests/e2e/web-responsive.spec.ts`

- [ ] **Step 1: 写失败视觉/结构测试**

```ts
await expect(page.locator(".canvas-empty-state")).toHaveCount(0);
await expect(page.locator(".workflow-node")).toHaveCount(2);
await expect(page.locator(".canvas-stage")).toHaveCSS("background-color", "rgb(30, 30, 30)");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec playwright test tests/e2e/web-console-canvas.spec.ts --reporter=line`

Expected: FAIL，因为没有 `canvas-empty-state` 和 n8n token。

- [ ] **Step 3: 实现主题**

```css
:root { --canvas: #1e1e1e; --surface: #2b2b2b; --accent: #ff6d5a; }
.canvas-stage { background: var(--canvas); }
.workflow-node { background: var(--surface); border-radius: 10px; }
.button.primary { background: var(--accent); color: #fff; }
```

保留安全门、成功、失败、运行状态的语义色；将控制器定位到右下，工具条定位到左上，节点使用角色圆标记。

- [ ] **Step 4: 运行针对性 E2E**

Run: `pnpm -C apps/web-console build && pnpm exec playwright test tests/e2e/web-console-canvas.spec.ts tests/e2e/web-responsive.spec.ts --reporter=line`

Expected: PASS。

### Task 3: 运行画布和完整验证

**Files:**
- Modify: `apps/web-console/src/pages/run-detail.tsx`
- Test: `tests/e2e/web-run-readonly.spec.ts`
- Modify: `README.md`

- [ ] **Step 1: 写失败测试**

```ts
await expect(page.getByRole("region", { name: /Live Run canvas|实时运行画布/ })).toBeVisible();
await expect(page.locator("button", { hasText: /Start|开始|Retry|重试/ })).toHaveCount(0);
```

- [ ] **Step 2: 实现只读复用与说明**

让运行画布复用主题和自动定位；README 写入“适应画布、自动恢复与无节点空状态”的使用说明。

- [ ] **Step 3: 统一验证**

Run:
```bash
pnpm lint
pnpm -C apps/web-console typecheck
pnpm vitest run --project unit --project web-unit --maxWorkers=1 --testTimeout=30000
pnpm test:integration
pnpm -C apps/web-console build
pnpm exec playwright test --reporter=line
pnpm diff-check
git diff --check
```

Expected: 全部通过。
