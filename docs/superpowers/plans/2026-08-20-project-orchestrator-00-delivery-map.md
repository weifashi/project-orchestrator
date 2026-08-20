# Project Orchestrator Delivery Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a local-first, self-developed project orchestrator that lets Codex or Claude execute versioned multi-role workflows while a loopback Web console only arranges future templates/roles and observes Runs.

**Architecture:** A TypeScript monorepo separates immutable contracts, SQLite/CAS persistence, deterministic workflow runtime, client adapters, Web control plane, and OS installers. The five implementation plans below are ordered dependency slices; each slice ends in one integrated verification and one commit, matching the workspace rule to write the slice completely before running checks.

**Tech Stack:** Node.js 22, TypeScript, pnpm workspaces, better-sqlite3, TypeBox/Ajv, Fastify, MCP TypeScript SDK, React, Vite, Vitest, fast-check, Playwright, shell, systemd user service, macOS LaunchAgent.

---

## Confirmed source of truth

- Product and technical design: `docs/superpowers/specs/2026-08-20-project-orchestrator-design.md`
- HTML review prototype: `/home/weifashi/www/project_orchestrator/index.html`
- This index defines delivery order only; exact files, tests, commands, and commit boundaries live in the five linked plans.
- The accepted design wins if a plan sentence is ambiguous. If implementation reveals a true contradiction, stop and amend the design before changing behavior.

## Local execution rule

The machine-wide rule overrides the generic per-step verification template:

1. Within one numbered plan, create all tests first and then all implementation files.
2. Do not run per-task test commands while writing the slice.
3. Run the numbered plan's complete verification matrix once after all its files are written.
4. Fix every failure, rerun the complete matrix, then make the single slice commit.
5. Do not claim a slice complete based on a subset of its checks.

## Final repository map

```text
project-orchestrator/
├─ apps/
│  ├─ control-server/
│  │  ├─ package.json
│  │  └─ src/
│  │     ├─ app.ts
│  │     ├─ config.ts
│  │     ├─ main.ts
│  │     ├─ ipc/agent-listener.ts
│  │     └─ http/
│  │        ├─ web-listener.ts
│  │        ├─ sse.ts
│  │        └─ routes/{config,read,system}.ts
│  └─ web-console/
│     ├─ package.json
│     ├─ index.html
│     ├─ vite.config.ts
│     └─ src/
│        ├─ main.tsx
│        ├─ app.tsx
│        ├─ api/{client,events,types}.ts
│        ├─ components/
│        ├─ pages/
│        └─ styles/app.css
├─ packages/
│  ├─ contracts/src/
│  ├─ sqlite-store/{migrations,src}/
│  ├─ content-store/src/
│  ├─ workflow-engine/src/
│  ├─ orchestrator-service/src/
│  ├─ adapter-core/src/
│  └─ mcp-adapter/src/
├─ skills/
│  ├─ project-orchestrator/
│  ├─ requirements/
│  ├─ research/
│  ├─ architecture/
│  ├─ ui-design/
│  ├─ implementation/
│  ├─ code-review/
│  ├─ testing/
│  ├─ security/
│  ├─ operations/
│  └─ memory-docs/
├─ adapters/
│  ├─ codex/project-orchestrator/
│  └─ claude/project-orchestrator/
├─ installer/{linux,macos}/
├─ scripts/
├─ tests/{contract,integration,e2e,security,install}/
├─ package.json
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ eslint.config.mjs
├─ vitest.workspace.ts
└─ playwright.config.ts
```

## Plan order and independent exit criteria

```text
01 Foundation
   contracts + SQLite + CAS + immutable configuration
                │
                ▼
02 Runtime
   DAG + Run state + leases + evidence + confirmations + local server
                │
                ▼
03 Agent integration
   common Skills + MCP adapter + Codex plugin + Claude plugin
                │
                ├──────────────┐
                ▼              ▼
04 Web console             05 Distribution & QA
   arrange + observe           autostart + backup + security + E2E
                └──────────────┬──────────────┘
                               ▼
                         release candidate
```

| Order | Detailed plan | Exit criterion | Commit |
|---|---|---|---|
| 1 | `2026-08-20-project-orchestrator-01-foundation.md` | Fresh DB migrates; CAS is immutable; built-in roles/templates publish; later draft edits cannot mutate published versions | `feat: add orchestrator foundation` |
| 2 | `2026-08-20-project-orchestrator-02-runtime.md` | Simulated Run completes, retries, iterates, interrupts/resumes, and fences stale writers; dangerous operation requires one-time confirmation | `feat: add deterministic run runtime` |
| 3 | `2026-08-20-project-orchestrator-03-agent-integration.md` | Codex and Claude adapters expose equivalent MCP contracts; ten Skills pass metadata/pressure fixtures; no subagent can write Run state | `feat: add codex and claude adapters` |
| 4 | `2026-08-20-project-orchestrator-04-web-console.md` | Web saves/publishes future configuration and observes Runs over SSE; no Web route, button, or client method can control a Run | `feat: add local orchestration console` |
| 5 | `2026-08-20-project-orchestrator-05-distribution-and-qa.md` | Linux/macOS login autostart, backup/migration, real adapter smoke, security suite, and full release checks pass | `feat: package and verify local orchestrator` |

## Cross-plan invariants

Every implementation slice must preserve these rules:

1. **Agent-only execution:** only authenticated Codex/Claude adapters can create, claim, progress, retry, pause, cancel, or finalize Runs.
2. **Web boundary:** Web has config-write and Run-read capabilities only; it has no Run-control or confirmation route.
3. **Snapshot isolation:** a Run references immutable workflow, role bundle, rule bundle, safety baseline, adapter capability, and worktree objects.
4. **Single writer:** the root session holds the lease; lease secrets are injected by the adapter and never enter model-visible schemas; subagents return results only.
5. **Bounded rework:** delivery rework creates a new iteration and new StageRuns; it never reopens historical successful records and never exceeds three rounds in the built-in new-project template.
6. **Independent evidence:** implementation cannot self-certify review, testing, or security gates.
7. **Controlled side effects:** a managed dangerous action is executed only by the isolated operation helper after consuming an exact-action confirmation once.
8. **Local-only control plane:** Web listens on `127.0.0.1`; agent writes use stdio MCP to a `0600` Unix socket; credentials are distinct.
9. **No background coding:** closing the originating Agent stops progression; daemon and Web retain state but do not call models.
10. **Vendor-neutral core:** shared contracts contain no Codex- or Claude-only types.

## Design-to-plan coverage

| Design section | Implementation owner |
|---|---|
| 1–3 Summary, decisions, scope | This delivery map, invariants, and final definition of done |
| 4 Core concepts | Plan 01 Tasks 2–5; Plan 02 Tasks 3–4 |
| 5 Architecture | Plan 01 Task 1; Plan 02 Task 6; Plans 03–05 package remaining components |
| 6 Complete Run flow/templates | Plan 01 Task 5; Plan 02 Tasks 2–4; Plan 03 Task 3 |
| 7 Ten roles | Plan 03 Task 4 |
| 8 State/ownership/iteration | Plan 02 Tasks 2–5; Plan 03 Tasks 1–2 and 7 |
| 9 Web console | Plan 04 Tasks 1–8 |
| 10 Service/capability boundary | Plan 02 Task 6; Plan 03 Tasks 1–2; Plan 04 Task 7 |
| 11 SQLite/CAS schema | Plan 01 Tasks 3–4; Plan 02 Tasks 1 and 3–5 |
| 12 Local install/autostart/backup | Plan 05 Tasks 1–5 |
| 13 Security | Plan 02 Tasks 5–6; Plan 03 Tasks 1–2; Plan 04 Tasks 7–8; Plan 05 Task 6 |
| 14 Errors/recovery | Plan 02 Tasks 3–5; Plan 05 Tasks 5 and 7 |
| 15 Technology choices | Plan 01 Task 1 and the dependency policy below |
| 16 Test strategy | Each plan's final verification; Plan 05 Tasks 6–8 |
| 17 Acceptance criteria | Plan 05 Task 8 maps all sixteen rows to evidence |
| 18–20 Order, risks, conclusion | Dependency graph, invariants, and final definition of done |

## Dependency policy

Open-source packages may provide transport, schema validation, database bindings, UI rendering, and test infrastructure. They must not own workflow state transitions, safety decisions, role contracts, Run authorization, or template semantics.

Initial package installation command in Plan 01 deliberately resolves current compatible releases and commits `pnpm-lock.yaml` as the reproducibility boundary:

```bash
pnpm install
```

Do not add a hosted workflow engine, cloud database, external analytics, remote font, CDN asset, or third-party orchestration SaaS.

## Global verification matrix

Plan 05 runs this exact matrix after all code is written:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:security
pnpm test:e2e
pnpm build
pnpm validate:skills
pnpm validate:plugins
bash tests/install/linux-smoke.sh
bash tests/install/macos-static-smoke.sh
```

Expected result: every command exits `0`; Vitest and Playwright report zero failures; plugin and Skill validators report every package valid; install smoke reports loopback-only listener, correct permissions, and successful uninstall cleanup.

## Definition of done

- [ ] All five detailed plan commits exist in order after design commit `2a23c9d`.
- [ ] `git status --short` is empty.
- [ ] All sixteen acceptance items in design section 17 map to automated evidence or a named manual smoke step.
- [ ] The HTML prototype's three screens match implemented navigation and wording.
- [ ] A fresh Linux user can install, log in, open Web, start a simulated Run from Codex, interrupt, recover, and finish it.
- [ ] A fresh macOS user can install the LaunchAgent and pass the same local API/adapter contract smoke.
- [ ] Claude creates a RunSnapshot structurally equivalent to Codex for the same template.
- [ ] Direct Web attempts against Agent IPC fail; Web source contains no Run-control API method.
- [ ] Production credentials are absent from Control Server, adapter, root session, logs, SQLite, and Web processes.
- [ ] Release notes state v1 exclusions: Windows, cloud, multi-user/RBAC, Web Run control, cross-client takeover, and execution after Agent exit.

## Execution handoff rule

Start with Plan 01 in a new isolated worktree created via `using-git-worktrees`. Execute one numbered plan at a time. After each slice's unified verification and commit, perform spec-compliance review first and code-quality review second before starting the next plan.
