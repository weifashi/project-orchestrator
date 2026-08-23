# Workflow and Run Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the workflow form editor and Run detail table with a safe n8n-style template canvas and live read-only Run canvas.

**Architecture:** Add an optional, versioned `canvas` presentation object to the workflow envelope. Build a pure graph layer for layout, canvas editing, validation, and Run status projection; React views only render and dispatch graph changes. The existing ConfigService remains the final validator, while the existing read/SSE APIs remain the only Run data path.

**Tech Stack:** React 19, TypeScript, `@xyflow/react` (MIT), TypeBox, Vitest, Fastify, existing SQLite/CAS/MCP stack.

---

### Task 1: Add versioned canvas presentation data

**Files:**
- Modify: `package.json`
- Modify: `packages/contracts/src/workflow.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `apps/web-console/src/api/types.ts`

- [ ] Add `@xyflow/react` to the root dependencies; do not add any hosted orchestration dependency.
- [ ] Define `WorkflowCanvasNodeSchema` with `stage_key`, finite numeric `x` and `y`; define `WorkflowCanvasSchema` with unique node positions and optional finite viewport fields.
- [ ] Add optional `canvas` to `WorkflowVersionDataSchema`, retaining `additionalProperties: false` and leaving old envelopes valid.
- [ ] Add a contract test accepting an old workflow envelope, accepting valid coordinates, and rejecting duplicate stage keys or non-finite coordinates.
- [ ] Define UI-only `CanvasNodePosition`, `CanvasViewport`, and enriched workflow draft types in the Web API types.

### Task 2: Implement pure graph conversion, layout, editing and validation

**Files:**
- Create: `apps/web-console/src/workflow/graph.ts`
- Create: `apps/web-console/test/workflow-graph.test.ts`

- [ ] Write tests for deterministic left-to-right layout, preserving valid saved positions, adding a stage after a selected stage, and creating an edge.
- [ ] Write tests that return diagnostic objects for cycle, unreachable node, and a missing mandatory-gate path; diagnostics expose involved stage keys/edges and human-readable codes.
- [ ] Implement `workflowToCanvas`, `autoLayout`, `addStageAfter`, `connectStages`, `removeStage`, and `validateWorkflowGraph` as pure functions operating on workflow envelope data.
- [ ] Keep the client validator advisory; no client function may decide that an invalid graph can publish.

### Task 3: Build reusable n8n-style canvas components

**Files:**
- Create: `apps/web-console/src/workflow/canvas-types.ts`
- Create: `apps/web-console/src/workflow/workflow-canvas.tsx`
- Create: `apps/web-console/src/workflow/workflow-node.tsx`
- Create: `apps/web-console/src/workflow/node-inspector.tsx`
- Create: `apps/web-console/src/workflow/role-palette.tsx`
- Modify: `apps/web-console/src/styles/app.css`
- Test: `apps/web-console/test/workflow-canvas.test.tsx`

- [ ] Write a component test that clicking a role-card `＋` calls quick-add after the selected stage; clicking an ordinary node quick-add opens a role picker; no selection inserts an unconnected node and shows a connection hint.
- [ ] Write a component test that a mandatory gate cannot be removed and that an invalid edge has an accessible error description.
- [ ] Implement a controlled React Flow canvas with background, controls, minimap, keyboard-selectable custom nodes, custom edge state, and `onConnect` wiring.
- [ ] Implement the role palette with both drag source and per-role `＋`; palette contains current active role versions only.
- [ ] Implement node inspector fields for role, optional, session confirmation, failure behavior, and iteration group. Place IDs/JSON/Schema in a collapsed advanced section.
- [ ] Add responsive canvas CSS with no page-level horizontal overflow and visible keyboard focus rings.

### Task 4: Replace the workflow editor without changing publish authority

**Files:**
- Modify: `apps/web-console/src/pages/workflow-editor.tsx`
- Modify: `apps/web-console/src/api/client.ts`
- Modify: `apps/web-console/src/i18n.tsx`
- Test: `apps/web-console/test/workflow-editor.test.tsx`

- [ ] Load active roles alongside the workflow draft and pass their current role versions to the palette.
- [ ] Replace stage cards, raw edges, and iteration-group forms with the canvas and inspector; preserve save draft, restore published, publish, and optimistic revision conflict behavior.
- [ ] On save/publish, write `canvas` position data into the envelope. Keep service response errors visible in a publish result panel and preserve server-side policy validation.
- [ ] Make i18n cover palette, quick-add, graph diagnostics, node state, minimap and canvas controls in Chinese and English.
- [ ] Assert tests still find no Web Run-control button or request.

### Task 5: Add frozen workflow retrieval and pure Run projection

**Files:**
- Modify: `apps/web-console/src/api/client.ts`
- Create: `apps/web-console/src/run/run-projection.ts`
- Create: `apps/web-console/test/run-projection.test.ts`

- [ ] Add `workflows.getVersion(versionId)` that calls the existing read-only version route, rather than abusing draft endpoints.
- [ ] Write a projection test for latest iteration selection and status priority: failed, waiting, running, ready, queued, succeeded/skipped.
- [ ] Implement `projectRunCanvas(workflow, stages, attempts, events)` returning graph nodes with user-facing status, current activity, artifacts/events references, and no raw credential or lease fields.
- [ ] Treat unknown or incomplete server data as read-only `unknown`, never as successful.

### Task 6: Replace Run detail with a live read-only execution canvas

**Files:**
- Create: `apps/web-console/src/run/run-canvas.tsx`
- Create: `apps/web-console/src/run/run-node-inspector.tsx`
- Modify: `apps/web-console/src/pages/run-detail.tsx`
- Modify: `apps/web-console/src/styles/app.css`
- Test: `apps/web-console/test/run-detail.test.tsx`

- [ ] Write a test that status changes from an SSE event update the corresponding node without creating Web control buttons.
- [ ] Write a test that selected node details use plain-language status, output, next step, artifact links and recent event information.
- [ ] Render the frozen workflow graph with live status color, edge state, minimap, zoom/pan, selected-node inspector and existing Run alerts.
- [ ] Keep all status mutation outside this page; `run-detail` may only call `/api/read/*` and EventSource.

### Task 7: Full verification, release and local deployment

**Files:**
- Modify only generated plugin manifests if `pnpm build:plugins` changes them.

- [ ] Run `pnpm install --frozen-lockfile` in the worktree.
- [ ] Run targeted Web unit tests, contract tests, lint, root typecheck, root tests, integration tests, build, diff-check and `git diff --check`.
- [ ] Build `pnpm release`, install the generated release with `--both`, restart the local system services, and run `project-orchestrator doctor`.
- [ ] Verify `/bootstrap` returns HTTP 200 and that the deployed static bundle includes the canvas dependency.
- [ ] Commit implementation with a concise feature message; do not push without a separate user request.
