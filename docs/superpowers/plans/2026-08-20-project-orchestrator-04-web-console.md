# Local Web Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local Web console for publishing future workflow/role versions and read-only observation of Runs, with no execution, retry, confirmation, or side-effect capability.

**Architecture:** A static React application consumes only `/api/config/*`, `/api/read/*`, and `/api/stream/events`. Draft editors use optimistic revisions and server validation; published versions are immutable. Run pages project events, stages, artifacts, files, tests, failures, and waiting items without registering any mutating Run action in UI code or server routes.

**Tech Stack:** React, React Router, Vite, TypeScript, CSS, Vitest, Testing Library, Playwright, SSE.

---

## Scope and file map

**Create:**

```text
apps/web-console/package.json
apps/web-console/tsconfig.json
apps/web-console/vite.config.ts
apps/web-console/index.html
apps/web-console/src/main.tsx
apps/web-console/src/app.tsx
apps/web-console/src/api/{client,events,types}.ts
apps/web-console/src/components/{app-shell,badge,empty-state,error-panel,version-banner}.tsx
apps/web-console/src/pages/{overview,workflow-list,workflow-editor,role-list,role-editor,run-list,run-detail,memories,system}.tsx
apps/web-console/src/styles/{tokens,app}.css
apps/web-console/test/{client,workflow-editor,role-editor,run-detail,no-run-control}.test.tsx
tests/e2e/{web-workflow,web-role,web-run-readonly}.spec.ts
playwright.config.ts
```

Modify Control Server to serve the built Web assets and issue the Web session/CSRF tokens.

## Task 1: Bootstrap the Web application and boundary-safe API client

- [ ] **Step 1: Author client boundary tests first**

Create `client.test.ts` with a fake fetch and assert only these method groups exist:

```ts
expect(Object.keys(api.workflows).sort()).toEqual(['getDraft', 'list', 'publish', 'saveDraft']);
expect(Object.keys(api.roles).sort()).toEqual(['getDraft', 'list', 'publish', 'saveDraft']);
expect(Object.keys(api.runs).sort()).toEqual(['get', 'list']);
expect(Object.keys(api.events).sort()).toEqual(['list']);
expect(Object.keys(api.artifacts).sort()).toEqual(['downloadUrl', 'list']);
expect(Object.keys(api.system).sort()).toEqual(['diagnostics']);
```

Assert config writes include CSRF header and reads never include adapter credentials.

- [ ] **Step 2: Create Web package and Vite config**

Use React, React DOM, React Router, Vite, Testing Library, jsdom, and Playwright. `vite.config.ts` builds to `dist`, proxies `/api` only in development, and does not load CDN assets.

- [ ] **Step 3: Implement the API client**

`api/client.ts` has one private request helper with `credentials:'same-origin'`, JSON size limit, stable error decoding, and CSRF header on POST/PUT. It exposes exactly the tested groups; there is no generic public `post(path)` escape hatch.

`api/types.ts` derives UI types from `@project-orchestrator/contracts` rather than redefining Run statuses or version shapes.

- [ ] **Step 4: Implement SSE reconnect**

`events.ts` tracks last event id, reconnects with bounded exponential backoff, de-duplicates `(run_id, sequence_number)`, fetches missed events before applying live ones, and closes on component unmount. It never sends an event or opens an Agent socket.

## Task 2: Build the shared shell and accessibility baseline

- [ ] **Step 1: Author navigation/accessibility tests**

Assert keyboard navigation reaches every top-level page, active route uses `aria-current`, focus moves to page heading, error/empty states are announced, and no control has only color as its status signal.

- [ ] **Step 2: Implement layout matching the accepted prototype**

Use the accepted HTML prototype's visual hierarchy: local-only app bar, left navigation, cards, neutral/green/orange/violet status accents, 900px reading width with full-width application frames. Routes:

```text
/                       overview
/workflows              workflow list
/workflows/:id           workflow editor
/roles                   role list
/roles/:id               role editor
/runs                    run list
/runs/:id                read-only run detail
/memories                read-only memories
/system                  read-only diagnostics
```

Global header displays `127.0.0.1 · Local only`. No external font, analytics, script, image, or network request is permitted.

## Task 3: Implement overview and system diagnostics

- [ ] **Step 1: Author rendering tests**

Fixtures cover healthy/degraded daemon, SQLite path, last backup, Codex/Claude adapter state, active/waiting/interrupted Runs, and absent data.

- [ ] **Step 2: Implement pages**

`overview.tsx` renders counts and links only; it has no quick-start button. `system.tsx` renders service version, DB path, CAS verification status, backup timestamp, socket/Web listener status, and adapter capability manifests. Diagnostics are read-only; do not add daemon restart, Run control, credential reveal, or operation execution.

## Task 4: Implement workflow drafts and publication

- [ ] **Step 1: Author workflow editor tests**

Test save-vs-publish semantics, optimistic conflict, new immutable version, mandatory gate lock, safe stage reorder, parallel group display, condition builder, failure policy, confirmation-point configuration, server validation errors, and active Run unaffected.

- [ ] **Step 2: Implement workflow list**

Show template name, task type, current version, status, stage count, and modified time. Allowed actions: create draft, copy to draft, edit draft, inspect published versions. There is no “run”, “start”, “test live”, “retry”, or “deploy” action.

- [ ] **Step 3: Implement constrained workflow editor**

Use accessible move-up/move-down controls and dependency selectors rather than an unrestricted canvas. A stage panel edits role version, optional flag, limited condition DSL, failure policy, max attempts, iteration group, and confirmation point. Mandatory gates render a lock icon and cannot be unset client-side; server remains authoritative.

Toolbar has exactly:

```text
Copy template | Save draft | Publish new version
```

Save updates revision only. Publish shows validation summary and creates an immutable version. A persistent notice says changes affect future Runs only.

## Task 5: Implement role drafts and publication

- [ ] **Step 1: Author role editor tests**

Cover all ten role cards, draft revision conflict, requested/effective capability difference, forbidden capability denial, input/output Schema parsing, completion contract, disable/archive states, and historical version inspection.

- [ ] **Step 2: Implement role list/editor**

Role list must display requirements, research, architecture, UI, implementation, code review, testing, security, operations, and memory docs. Editor sections are responsibility, allowed tools requested, forbidden tools, input Schema, output Schema, required artifacts, completion checks, and status.

Toolbar has `Restore built-in`, `Save draft`, and `Publish new version`. Publishing shows the server-computed effective capability set; Web cannot select an older safety baseline or grant a platform-forbidden capability.

## Task 6: Implement read-only Run observation

- [ ] **Step 1: Author Run list/detail tests**

Cover Codex/Claude origin, current active stage set, parallel stages, attempt history, iteration history, event timeline, logs, test evidence, changed files, artifacts, waiting confirmation, failed stage, interrupted recovery notice, and unknown side effect.

For every fixture assert absence of buttons/links/forms named:

```text
start, pause, resume, cancel, retry, skip, approve, reject, deploy,
开始, 暂停, 恢复, 取消, 重试, 跳过, 批准, 拒绝, 部署
```

- [ ] **Step 2: Implement Run list**

Filters are project, source client, status, template, and date. Actions are only filter, open detail, and export read-only report. Run row displays active stage set derived by server, never a mutable current-stage field.

- [ ] **Step 3: Implement Run detail**

Tabs: overview, timeline, stages/attempts, artifacts, file changes, tests, memories, diagnostics. Waiting state displays “请回到发起本次任务的 Codex/Claude 会话完成确认.” Failure state displays evidence and “请回原客户端会话重试.” Unknown side effect displays “先在原会话对账，禁止直接重试.”

Artifact links use server-provided safe download URLs and never inject artifact HTML/SVG into the credentialed page.

## Task 7: Serve Web safely from Control Server

- [ ] **Step 1: Author CSP/session tests**

Assert loopback bind, Host/Origin validation, CSP without external sources, HttpOnly/SameSite cookie, CSRF, no token in URL/localStorage, active-content attachment, cache policy for hashed assets, and SPA history fallback that never shadows `/api`.

- [ ] **Step 2: Integrate static assets**

Control Server serves `apps/web-console/dist`; development uses Vite proxy. Generate Web token on first install, exchange it for an HttpOnly cookie through a loopback bootstrap page, rotate on explicit local maintenance command, and redact it from logs.

CSP minimum:

```text
default-src 'self'; script-src 'self'; style-src 'self';
img-src 'self' data:; connect-src 'self'; object-src 'none';
base-uri 'none'; frame-ancestors 'none'; form-action 'self'
```

## Task 8: Add Web E2E coverage

- [ ] **Step 1: Workflow and role E2E**

Start Control Server with temporary DB/CAS, open Web, edit a workflow draft, save, publish v2, edit a role draft, publish v2, and verify existing fixture Run still references v1.

- [ ] **Step 2: Read-only Run E2E**

Open running, waiting, failed, interrupted, and completed fixture Runs. Inspect all menus, buttons, links, forms, network requests, and keyboard shortcuts. Fail the test if any request method/path can mutate a Run or confirmation.

Use this network guard:

```ts
page.on('request', request => {
  const forbidden = /^\/api\/(run-control|confirmations|operations)/.test(new URL(request.url()).pathname);
  expect(forbidden, `forbidden Web request ${request.method()} ${request.url()}`).toBe(false);
});
```

- [ ] **Step 3: Responsive/overflow E2E**

Run at 390, 768, 1280, and 1568 widths. Assert `document.documentElement.scrollWidth <= document.documentElement.clientWidth`, tables have local scroll containers, and editor cards remain operable by keyboard.

## Task 9: Run the slice verification once and commit

- [ ] **Step 1: Install Web dependencies**

```bash
pnpm install
pnpm exec playwright install chromium
```

- [ ] **Step 2: Run all Web and repository checks**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
```

Expected: zero failures; E2E finds no Run-control surface; all four widths have no page-level overflow; built assets contain no remote URL.

- [ ] **Step 3: Run explicit forbidden-surface scan**

```bash
if rg -n "(/api/run-control|/api/confirmations|/api/operations|create_run|claim_run|retry_stage|pause_run|cancel_run|submit_confirmation)" apps/web-console/src; then
  echo "forbidden Web execution surface found" >&2
  exit 1
fi
```

Expected: command exits `0` without a match.

- [ ] **Step 4: Commit**

```bash
git add apps/web-console apps/control-server playwright.config.ts tests/e2e package.json pnpm-lock.yaml
GIT_AUTHOR_NAME="weifashi" GIT_AUTHOR_EMAIL="weifashi@ttpos.com" \
  git commit -m "feat: add local orchestration console"
```
