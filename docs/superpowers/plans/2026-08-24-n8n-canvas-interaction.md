# n8n Canvas Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workflow authoring and Run observation use a canvas-first, n8n-style interaction model without granting Web any runtime control.

**Architecture:** Workflow stages and edges remain the execution source of truth. Optional canvas metadata stores only viewport, groups and collapsed subflow presentation. A reusable `WorkflowCanvas` owns authoring gestures and has a readonly observer variant; drawers and toolbars belong to the page shell.

**Tech Stack:** React 19, TypeScript strict mode, @xyflow/react, Vite, Vitest, Testing Library, Playwright.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/workflow.ts` | Optional versioned viewport/group metadata, backward compatible with old envelope content |
| `apps/web-console/src/components/workflow-graph.ts` | Pure, safety-aware graph mutations, groups, history helpers and auto layout |
| `apps/web-console/src/components/canvas-drawer.tsx` | Accessible overlay drawer and focus restoration |
| `apps/web-console/src/components/workflow-canvas.tsx` | React Flow controlled surface, palette, quick add, selection and keyboard hooks |
| `apps/web-console/src/pages/workflow-editor.tsx` | Full-bleed authoring workspace, history, save and publish |
| `apps/web-console/src/pages/run-detail.tsx` | Full-bleed readonly observer focused on active, waiting and failed work |
| `apps/web-console/src/styles/app.css` | Drawer, canvas, group, focus, reduced-motion and responsive styles |
| `apps/web-console/src/i18n.tsx` | 中文和 English interface copy |
| `apps/web-console/test/*`, `tests/e2e/web-console-canvas.spec.ts` | Unit, component and browser proof |

### Task 1: Versioned canvas metadata and pure graph operations

**Files:**
- Modify: `packages/contracts/src/workflow.ts`
- Modify: `apps/web-console/src/components/workflow-graph.ts`
- Modify: `packages/contracts/test/workflow.test.ts`
- Modify: `apps/web-console/test/workflow-graph.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("accepts old canvas data and preserves viewport and groups", () => {
  expect(WorkflowVersionEnvelopeSchema.parse(oldEnvelope)).toBeTruthy();
  expect(WorkflowVersionEnvelopeSchema.parse(groupedEnvelope).data.canvas).toMatchObject({
    viewport: { x: 40, y: -12, zoom: 0.9 },
    groups: [{ id: "design", label: "设计", stage_keys: ["architecture", "ui-design"], collapsed: true }],
  });
});
it("does not delete mandatory nodes or mandatory dependency edges", () => {
  expect(removeGraphSelection(workflow(), ["testing"], [])).toBe(workflow());
});
```

- [ ] **Step 2: Implement contract and graph helpers**

```ts
export type CanvasViewport = { x: number; y: number; zoom: number };
export type CanvasGroup = { id: string; label: string; stage_keys: string[]; collapsed: boolean };
export const updateCanvasViewport = (envelope, viewport) => ({
  ...envelope, data: { ...envelope.data, canvas: { ...envelope.data.canvas, viewport } },
});
```

Implement `addStageAt`, `connectStages`, `removeGraphSelection`, `createGroup`, `toggleGroup`, `renameGroup`, `expandGroupForStage` and `autoLayout`. Invalid, duplicate, self, mandatory-gate, mandatory-edge and safety-bypass mutations return the unchanged envelope.

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/workflow.ts packages/contracts/test/workflow.test.ts \
  apps/web-console/src/components/workflow-graph.ts apps/web-console/test/workflow-graph.test.ts
git commit -m "feat: add canvas metadata and safe graph editing"
```

### Task 2: Reusable n8n canvas surface

**Files:**
- Create: `apps/web-console/src/components/canvas-drawer.tsx`
- Modify: `apps/web-console/src/components/workflow-canvas.tsx`
- Modify: `apps/web-console/src/styles/app.css`
- Test: `apps/web-console/test/workflow-canvas.test.tsx`

- [ ] **Step 1: Write the failing interaction tests**

```tsx
it("opens a searchable add-node drawer and adds the selected role", async () => {
  renderCanvas();
  await user.click(screen.getByRole("button", { name: "添加节点" }));
  await user.type(screen.getByRole("searchbox", { name: "搜索角色" }), "测试");
  await user.click(screen.getByRole("button", { name: /测试验证.*添加/ }));
  expect(onChange).toHaveBeenCalled();
});
it("uses Escape to clear selection and restores focus after closing a drawer", async () => {
  renderCanvas(); await user.click(screen.getByText("架构设计")); await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "节点设置" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Implement gestures and accessibility**

Use controlled React Flow nodes/edges plus `onDrop`, `onDragOver`, `onConnect`, `onSelectionChange`, `onMoveEnd`, `onNodeDragStop`, `onEdgesDelete` and `onNodesDelete`. Persist a position/viewport only after a completed gesture. Add the floating `添加节点` action, searchable category palette, drag cards, quick add, minimap, fit view, auto layout and visual group overlays.

`CanvasDrawer` is `<aside role="dialog">`, closes on Escape, and restores focus. Every drag action has a keyboard route. Delete/Backspace applies only to ordinary selected elements. Apply no edge animation under `prefers-reduced-motion: reduce`.

- [ ] **Step 3: Commit**

```bash
git add apps/web-console/src/components/canvas-drawer.tsx \
  apps/web-console/src/components/workflow-canvas.tsx apps/web-console/src/styles/app.css \
  apps/web-console/test/workflow-canvas.test.tsx
git commit -m "feat: add n8n style canvas interactions"
```

### Task 3: Canvas-first template editor and role market

**Files:**
- Modify: `apps/web-console/src/pages/workflow-editor.tsx`
- Modify: `apps/web-console/src/i18n.tsx`
- Modify: `apps/web-console/src/styles/app.css`
- Modify: `apps/web-console/test/workflow-editor.test.tsx`

- [ ] **Step 1: Write editor tests**

```tsx
it("keeps canvas full width until a node is selected", async () => {
  renderEditor();
  expect(screen.queryByRole("dialog", { name: "节点设置" })).not.toBeInTheDocument();
  await user.click(screen.getByText("架构设计"));
  expect(screen.getByRole("dialog", { name: "节点设置" })).toBeVisible();
});
it("saves a future draft but has no runtime controls", async () => {
  renderEditor(); await user.keyboard("{Control>}s{/Control}");
  expect(saveDraft).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: /开始|暂停|恢复|重试|部署/ })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Implement editor workspace**

Replace the page grid with a full-bleed `canvas-workspace`. Keep a compact sticky header: template name, dirty status, undo, redo, auto-layout, fit, save and publish. Use a bounded in-memory envelope history; reset after server load/save. Move common stage settings into the drawer; put contract/version/iteration data in collapsed advanced details. Palette groups active local roles by category and shows recent usage; it is a drawer, never a permanent narrow column.

- [ ] **Step 3: Translate visible strings**

Add the same Chinese and English keys for add node, search roles, recent roles, categories, group, collapse, subflow entry/exit, undo, redo, fit canvas, auto layout, node settings, close panel, saved state, readonly canvas and focus current path. Preserve role/user content verbatim.

- [ ] **Step 4: Commit**

```bash
git add apps/web-console/src/pages/workflow-editor.tsx apps/web-console/src/i18n.tsx \
  apps/web-console/src/styles/app.css apps/web-console/test/workflow-editor.test.tsx
git commit -m "feat: make workflow authoring canvas first"
```

### Task 4: Focused readonly Run canvas

**Files:**
- Modify: `apps/web-console/src/pages/run-detail.tsx`
- Modify: `apps/web-console/src/components/workflow-canvas.tsx`
- Modify: `apps/web-console/src/styles/app.css`
- Modify: `apps/web-console/test/run-detail.test.tsx`

- [ ] **Step 1: Write readonly tests**

```tsx
it("shows active work first and expands the complete frozen workflow on request", async () => {
  renderRunDetail({ active_stages: ["testing"], status: "running" });
  expect(await screen.findByText("当前关注")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "查看全部流程" }));
  expect(screen.getByLabelText("实时运行画布")).toBeVisible();
});
it("never renders a runtime control", () => {
  renderRunDetail();
  expect(screen.queryByRole("button", { name: /开始|暂停|恢复|取消|重试|批准|拒绝|部署/ })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Implement observer workspace**

Reuse pan, zoom, minimap and a readonly node detail drawer. On first load fit to active/waiting/failed nodes and immediate dependencies; provide `查看全部流程`. SSE updates only status/data for affected nodes and never reset user viewport. Present status, current iteration, artifacts, failure and “回 Codex / Claude 处理” in the drawer.

- [ ] **Step 3: Commit**

```bash
git add apps/web-console/src/pages/run-detail.tsx apps/web-console/src/components/workflow-canvas.tsx \
  apps/web-console/src/styles/app.css apps/web-console/test/run-detail.test.tsx
git commit -m "feat: focus realtime run canvas on active work"
```

### Task 5: Browser, visual and safety proof

**Files:**
- Create: `tests/e2e/web-console-canvas.spec.ts`
- Modify: `apps/web-console/test/app-shell-visual.test.tsx`
- Modify: `README.md`

- [ ] **Step 1: Add E2E proof**

```ts
test("authoring canvas adds, connects, groups, saves and publishes without controlling a run", async ({ page }) => {
  await page.goto("/workflows/new-project");
  await page.getByRole("button", { name: "添加节点" }).click();
  await page.getByRole("searchbox", { name: "搜索角色" }).fill("架构");
  await page.getByRole("button", { name: /架构设计.*添加/ }).click();
  await expect(page.getByLabel("编排画布")).toBeVisible();
  await expect(page.getByRole("button", { name: /开始|暂停|部署/ })).toHaveCount(0);
});
```

Add 1440px and 375px visual assertions, verify no horizontal document overflow, assert drawers overlay rather than narrow the canvas, and prove that publishing a new template version does not alter an existing Run snapshot.

- [ ] **Step 2: Document use**

Add authoring/observer entry points, gestures, keyboard alternatives, and the explicit Web-no-run-control rule to `README.md`.

- [ ] **Step 3: Run unified verification after all code is written**

```bash
pnpm lint && pnpm typecheck && pnpm test -- --maxWorkers=1 --testTimeout=30000 && \
pnpm test:integration && pnpm test:e2e && pnpm build && pnpm diff-check && git diff --check
```

Expected: every command exits `0`; unit/integration/E2E all pass; generated assets build; only intended tracked files change.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/web-console-canvas.spec.ts apps/web-console/test/app-shell-visual.test.tsx README.md
git commit -m "test: verify n8n canvas authoring and observation"
```

## Plan self-review

```text
Canvas-first layout and n8n gestures        Task 2 + Task 3
Role market, groups and subflow presentation Task 1 + Task 2 + Task 3
Safety and immutable execution boundary      Task 1 + Task 3 + Task 5
Readonly live Run canvas                     Task 4
I18n, accessibility, responsiveness          Task 2 + Task 3 + Task 5
Final verification                           Task 5
```

No task adds a Web Run-control route; all canvas metadata remains display-only.
